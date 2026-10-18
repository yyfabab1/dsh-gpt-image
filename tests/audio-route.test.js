/**
 * 音频相关路由测试（回归：生图页曾把 .wav 记录当图片渲染成坏图标）。
 *
 * 用 tests/projects.test.js 同一套做法：拿 apply() 注册出来的面板路由，
 * 直接构造 req/res 调 handler —— 不用真的起服务器，快且不占端口。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

function fakeCtx() {
  const routes = new Map()
  return {
    routes,
    tools: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: (names, fn) => {
      if (names.includes('webServer')) fn({ webServer: { register: (route) => { routes.set(route.path, route); return () => {} } }, effect: (f) => { f(); return () => {} } })
    },
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
  return { status, body: body ? JSON.parse(body) : null }
}

/** 造一个既有图片记录、又有音频记录的历史库。 */
async function seed(dataDir) {
  const outDir = path.join(dataDir, 'out', 'game')
  await mkdir(outDir, { recursive: true })
  const pngFile = path.join(outDir, 'tower.png')
  const wavFile = path.join(outDir, 'audio', 'coin.wav')
  await mkdir(path.dirname(wavFile), { recursive: true })
  await writeFile(pngFile, Buffer.from('fake-png'))
  await writeFile(wavFile, Buffer.from('fake-wav'))
  const records = [
    {
      id: 'g_img', ts: '2026-10-18T01:00:00.000Z', kind: 'generate', media: 'image',
      profile: 'p', model: 'gpt-image-2', name: 'tower', project: 'game',
      prompt: '塔', files: [pngFile], labeled: [], images: 1, status: 'ok',
    },
    {
      id: 'g_audio_sfx', ts: '2026-10-18T02:00:00.000Z', kind: 'audio', media: 'audio',
      profile: '', model: 'voicestudio', name: 'coin_sfx', project: 'game',
      prompt: '', files: [wavFile], images: 0, status: 'ok', audio_action: 'sfx',
    },
    {
      id: 'g_audio_speak', ts: '2026-10-18T03:00:00.000Z', kind: 'audio', media: 'audio',
      profile: '', model: 'voicestudio', name: 'hero_line', project: 'game',
      prompt: '[愤怒] 你竟敢骗我', files: [wavFile], images: 0, status: 'ok', audio_action: 'speak',
    },
  ]
  await writeFile(path.join(dataDir, 'history.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records }, null, 2))
  return { pngFile, wavFile }
}

test('回归：/api/images **不能**返回音频记录（否则生图页把 .wav 当图片渲染成坏图标）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'audio-route-'))
  try {
    await seed(dataDir)
    const ctx = fakeCtx()
    apply(ctx, { dataDir, outputDir: path.join(dataDir, 'out') })
    const route = ctx.routes.get('/gpt-image')
    assert.ok(route, '面板路由要注册')

    const { status, body } = await callRoute(route, '/gpt-image/api/images')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const ids = body.records.map((r) => r.id)
    assert.ok(ids.includes('g_img'), '图片记录要保留')
    assert.ok(!ids.includes('g_audio_sfx'), '音频记录（sfx）必须被排除')
    assert.ok(!ids.includes('g_audio_speak'), '音频记录（speak）必须被排除')
    for (const record of body.records) {
      assert.notEqual(record.media, 'audio', `${record.id} 是音频，不该出现在生图页`)
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('/api/audio-recent 只返回音频记录，且每条带可直接播放的 URL', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'audio-route2-'))
  try {
    await seed(dataDir)
    const ctx = fakeCtx()
    apply(ctx, { dataDir, outputDir: path.join(dataDir, 'out') })
    const route = ctx.routes.get('/gpt-image')

    const { status, body } = await callRoute(route, '/gpt-image/api/audio-recent')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.count, 2, '两条音频记录都要在')
    const names = body.records.map((r) => r.name).sort()
    assert.deepEqual(names, ['coin_sfx', 'hero_line'])
    for (const record of body.records) {
      assert.ok(record.url.startsWith('/gpt-image/api/file?path='), `URL 要指向 /api/file：${record.url}`)
      assert.ok(record.url.includes(encodeURIComponent('audio')), 'URL 要指向 audio 目录')
      assert.ok(record.action === 'sfx' || record.action === 'speak', `action 要能看出来：${record.action}`)
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('/api/audio-recent?limit=N 会限制条数', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'audio-route3-'))
  try {
    await seed(dataDir)
    const ctx = fakeCtx()
    apply(ctx, { dataDir, outputDir: path.join(dataDir, 'out') })
    const route = ctx.routes.get('/gpt-image')
    const { body } = await callRoute(route, '/gpt-image/api/audio-recent?limit=1')
    assert.equal(body.count, 1)
    assert.equal(body.records.length, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
