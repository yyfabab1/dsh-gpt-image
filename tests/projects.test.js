/**
 * 项目分类修复的回归测试：
 *  ① 服务端必须给出 project_summaries（否则卡片上「哪个项目是哪个」没有内容可显示）
 *  ② 没选项目时也要返回 projects（不能因为没选就把项目列表也吞掉）
 *  ③ 客户端筛选必须在「选中项目」后重新拉数据，并且 gameRoot 不能进 useEffect 依赖
 *     （否则每敲一个字就重建定时器，表现就是「点了没反应」）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { apply } from '../lib/index.js'
import { projectSummaries } from '../lib/server.js'
import { ProfileStore } from '../lib/store.js'
import { Gallery } from '../lib/store.js'

test('projectSummaries：按项目汇总数量/最近时间/素材名/成功失败', () => {
  const summaries = projectSummaries([
    { project: 'doomsday-ember', name: 'wx_clear_tile', status: 'ok', ts: '2026-10-02T08:00:00Z', kind: 'generate', labeled: ['a_labeled.png'] },
    { project: 'doomsday-ember', name: 'i_skull', status: 'failed', ts: '2026-10-02T09:00:00Z', kind: 'generate' },
    { project: 'starcraft-rts', name: 'terran_marine', status: 'ok', ts: '2026-10-01T10:00:00Z', kind: 'edit' },
    { project: '', name: 'orphan', status: 'ok', ts: '2026-10-01T11:00:00Z' },
  ])
  assert.deepEqual(Object.keys(summaries).sort(), ['doomsday-ember', 'images', 'starcraft-rts'])
  const ember = summaries['doomsday-ember']
  assert.equal(ember.count, 2)
  assert.equal(ember.ok, 1)
  assert.equal(ember.failed, 1)
  assert.equal(ember.latest_name, 'i_skull', '最近一条要取时间最大的')
  assert.deepEqual(ember.names, ['wx_clear_tile', 'i_skull'])
  assert.equal(ember.latest_text.length, 16)
  assert.equal(summaries['starcraft-rts'].count, 1)
  assert.deepEqual(summaries['starcraft-rts'].kinds, ['edit'])
})

/** 造一份最小的历史，让真实 HTTP 接口能返回数据。 */
async function seed(dataDir) {
  const profiles = await ProfileStore.load(dataDir)
  const gallery = await Gallery.load(dataDir)
  gallery.records.unshift(
    { id: 'r1', ts: '2026-10-02T08:00:00Z', project: 'doomsday-ember', name: 'wx_clear_tile', status: 'ok', kind: 'generate', model: 'm', provider: 'openai', prompt: 'p', params: { size: '40x60', quality: 'low' }, files: [], labeled: [] },
    { id: 'r2', ts: '2026-10-01T08:00:00Z', project: 'starcraft-rts', name: 'terran_marine', status: 'ok', kind: 'generate', model: 'm', provider: 'openai', prompt: 'p', params: {}, files: [], labeled: [] },
    { id: 'r3', ts: '2026-09-30T08:00:00Z', project: '连通性测试', name: 'probe_apple', status: 'ok', kind: 'generate', model: 'm', provider: 'openai', prompt: 'p', params: {}, files: [], labeled: [] },
  )
  await gallery.save()
  profiles.data.outputDir = path.join(dataDir, 'out')
  await profiles.save()
}

async function startPanel() {
  await mkdtemp(path.join(os.tmpdir(), 'gpt-image-panel-'))
  return null
}

function fakeCtx() {
  const routes = new Map()
  return {
    routes,
    tools: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: (names, fn) => { if (names.includes('webServer')) fn({ webServer: { register: (route) => { routes.set(route.path, route); return () => {} } }, effect: (f) => { f(); return () => {} } }) },
    get: () => undefined,
  }
}

async function callRoute(route, urlPath) {
  let status = 0
  let body = ''
  const req = { method: 'GET', url: urlPath, headers: { host: '127.0.0.1' } }
  const res = {
    writeHead(code) { status = code; return this },
    end(chunk) { if (chunk !== undefined) body += chunk.toString() },
  }
  await route.handler(req, res)
  return { status, body }
}

test('接口：没选项目时也返回 projects + project_summaries（筛选才有内容可显示）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-proj-'))
  try {
    await seed(dataDir)
    const ctx = fakeCtx()
    apply(ctx, { dataDir, outputDir: path.join(dataDir, 'out') })
    const route = ctx.routes.get('/gpt-image')
    assert.ok(route, '面板路由要注册')

    const all = await callRoute(route, '/gpt-image/api/check')
    assert.equal(all.status, 200)
    const payload = JSON.parse(all.body)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.projects, ['连通性测试', 'doomsday-ember', 'starcraft-rts'], '项目列表不能为空（中文按 zh-Hans-CN 排序，排在拉丁字母前）')
    assert.ok(payload.project_summaries['doomsday-ember'], '要有每个项目的概况')
    assert.equal(payload.project_summaries['doomsday-ember'].count, 1)
    assert.equal(payload.project_summaries['doomsday-ember'].latest_name, 'wx_clear_tile')

    const one = await callRoute(route, '/gpt-image/api/check?project=doomsday-ember')
    const single = JSON.parse(one.body)
    assert.equal(single.project, 'doomsday-ember')
    assert.deepEqual(single.projects, ['连通性测试', 'doomsday-ember', 'starcraft-rts'])
    assert.ok(single.project_summaries['starcraft-rts'], '选了项目后其它项目的概况也要在（方便切换）')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('客户端：选中项目后必须重新拉数据；gameRoot 不能进 useEffect 依赖', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  // 依赖数组只能是 [project, tick] —— 把 gameRoot 放进去会导致每敲一个字就重建定时器（表现为「点了没反应」）
  const effect = source.match(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[([^\]]*)\]\)/)
  assert.ok(effect, '要能找到数据拉取的 useEffect')
  assert.match(effect[1], /project/)
  assert.doesNotMatch(effect[1], /gameRoot/, 'gameRoot 进了依赖 = 输入时不断重建，必须移除')
  assert.match(source, /setProject/, '必须真的能切换项目')
  assert.match(source, /project_summaries/, '卡片要读项目概况')
  assert.match(source, /dshimg-chip/, '项目要渲染成卡片（能看出是哪个项目）')
  assert.match(source, /localeCompare\(String\(b\), 'zh-Hans-CN'\)/, '中文项目名要按中文排序')
})