/**
 * 端到端：模拟 DSH 的 ctx，注册插件 → 用本地假上游跑「配置档 → 文生图 → 落盘 → 清单」，
 * 并核对工具 schema 契约、导入导出 Playground 配置、路径穿越防护。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title',
])

function assertSupportedSchema(node, where, seen = new Set()) {
  if (node === null || typeof node !== 'object') throw new Error(`${where} 必须是 schema 对象`)
  if (seen.has(node)) throw new Error(`${where} 循环`)
  seen.add(node)
  for (const key of Object.keys(node)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${where}.${key} 不在 dsh-tools 支持的子集里`)
  }
  if (node.type && node.oneOf) throw new Error(`${where} 不能同时有 type 和 oneOf`)
  if (node.oneOf) node.oneOf.forEach((child, index) => assertSupportedSchema(child, `${where}.oneOf[${index}]`, seen))
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) assertSupportedSchema(child, `${where}.properties.${key}`, seen)
  }
  if (node.items) assertSupportedSchema(node.items, `${where}.items`, seen)
  if (node.required) {
    assert.ok(Array.isArray(node.required), `${where}.required 必须是数组`)
    node.required.forEach((key) => assert.ok(node.properties[key], `${where}.required 指向了不存在的字段 ${key}`))
  }
  seen.delete(node)
}

function fakeCtx() {
  const registry = new Map()
  return {
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject() {},
    get() {
      return undefined
    },
    registry,
  }
}

function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: Array.from({ length: Math.max(1, body.n ?? 1) }, () => ({ b64_json: PNG_B64 })) }))
        })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

async function harness() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-gpt-image-'))
  const outputDir = path.join(dataDir, 'out')
  const ctx = fakeCtx()
  apply(ctx, { dataDir, outputDir })
  return {
    dataDir,
    outputDir,
    ctx,
    call: async (tool, args) => JSON.parse(await ctx.registry.get(tool).execute(args)),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  }
}

const T = {
  list: '_dsh_external_dsh_gpt_image_list',
  generate: '_dsh_external_dsh_gpt_image_generate',
  edit: '_dsh_external_dsh_gpt_image_edit',
  video: '_dsh_external_dsh_gpt_image_video',
  balance: '_dsh_external_dsh_gpt_image_balance',
  assets: '_dsh_external_dsh_gpt_image_assets',
  reprocess: '_dsh_external_dsh_gpt_image_reprocess',
  quality: '_dsh_external_dsh_gpt_image_quality',
  studio: '_dsh_external_dsh_gpt_image_studio',
  auto: '_dsh_external_dsh_gpt_image_auto',
  job: '_dsh_external_dsh_gpt_image_job',
  pool: '_dsh_external_dsh_gpt_image_pool',
  batch: '_dsh_external_dsh_gpt_image_batch',
  install: '_dsh_external_dsh_gpt_image_install',
  screenshot: '_dsh_external_dsh_gpt_image_screenshot',
  style: '_dsh_external_dsh_gpt_image_style',
  review: '_dsh_external_dsh_gpt_image_review',
  register: '_dsh_external_dsh_gpt_image_register',
  pipeline: '_dsh_external_dsh_gpt_image_pipeline',
  prompts: '_dsh_external_dsh_gpt_image_prompts',
  sheet: '_dsh_external_dsh_gpt_image_sheet',
  approval: '_dsh_external_dsh_gpt_image_approval',
  cross_style: '_dsh_external_dsh_gpt_image_cross_style',
  audio: '_dsh_external_dsh_gpt_image_audio',
  rig: '_dsh_external_dsh_gpt_image_rig',
  adapter: '_dsh_external_dsh_gpt_image_adapter',
  spritesheet: '_dsh_external_dsh_gpt_image_spritesheet',
  audit: '_dsh_external_dsh_gpt_image_audit',
  config: '_dsh_external_dsh_gpt_image_config',
}

test('客户端半边：语法可编译；对话按钮 + 侧栏图标 + 主区域整页 三处注册（同一个插件）', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  // 编译即校验语法；不执行（客户端模块靠 window.__ModuleLoader__ 装配）
  assert.doesNotThrow(() => new Function('window', 'require', source), 'client.js 必须能通过语法编译')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, /id: '@dsh-external\/dsh-gpt-image'/)
  // 对话/轨迹那一行
  assert.match(source, /ctx\.slots\.inject\('conversation\.session\.header\.actions'/)
  // 左侧栏图标 + 主区域整页（"在侧栏放给我看"）
  assert.match(source, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /id: 'gallery'/)
  assert.match(source, /ctx\.slots\.inject\('main'/)
  assert.match(source, /key: 'gallery'/)
  // 数据源：历史 + 核对
  assert.match(source, /\/gpt-image\/api/)
  assert.match(source, /require\('react'\)/)
  assert.match(source, /exports\.apply = apply/)
  assert.match(source, /exports\.inject = inject/)
  const pkg = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
})

test('侧栏每个 panellist id 都必须有对应的 main 面板（否则点了没反应）', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  // DSH 契约（dsh-client-ui-sidebar README）："The same id addresses the component
  // registered in the layout's root-scoped main keyed slot; selecting a missing main
  // entry throws without changing the current selection." —— 缺了就是「点不动」。
  const sideIds = [...source.matchAll(/inject\('sidebar\.panellist'[\s\S]{0,240}?id:\s*'([^']+)'/g)].map((m) => m[1])
  const mainKeys = [...source.matchAll(/inject\('main'[\s\S]{0,240}?key:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(sideIds.length >= 2, `侧栏应注册至少生图/生视频两项，实际：${JSON.stringify(sideIds)}`)
  assert.ok(mainKeys.length >= 2, `主区域应注册至少生图/生视频两页，实际：${JSON.stringify(mainKeys)}`)
  for (const id of sideIds) {
    assert.ok(mainKeys.includes(id), `侧栏「${id}」没有对应的 main 面板 → 点击会抛错且选不中（当前 main: ${mainKeys.join(', ')}）`)
  }
  // 生视频必须两边都在，且挂在生图后面
  assert.ok(sideIds.includes('video'), '侧栏应有生视频项')
  assert.ok(mainKeys.includes('video'), '主区域应有生视频页')
  // 余额也要有整页（与生图/生视频一致），否则侧栏「余额」同样点不动
  assert.ok(sideIds.includes('balance'), '侧栏应有余额项')
  assert.ok(mainKeys.includes('balance'), '主区域应有余额页')
  const orderOf = (id) => Number((source.match(new RegExp("id: '" + id + "',\\s*\\n\\s*order: (\\d+)")) ?? [])[1] ?? NaN)
  assert.ok(orderOf('video') > orderOf('gallery'), '生视频的 order 应排在生图之后（显示在下面）')
  assert.ok(orderOf('balance') < orderOf('gallery'), '余额的 order 应排在生图之前（先看到能不能花钱）')
})

test('生视频 UI 三处入口齐全：头部浮层 / 侧栏图标 / 主区域整页', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  for (const fn of ['VideoForm', 'VideoPanel', 'VideoPage', 'VideoButton', 'VideoIcon']) {
    assert.match(source, new RegExp(`function\\s+${fn}\\s*\\(`), `缺少组件 ${fn}`)
  }
  // 浮层与整页共用同一份表单（避免两处逻辑漂移）
  assert.match(source, /React\.createElement\(VideoForm, \{ onClose \}\)/, '浮层应复用 VideoForm')
  assert.match(source, /React\.createElement\(VideoForm, \{\}\)/, '整页应复用 VideoForm')
  // 提交走 /api/video
  assert.match(source, /API \+ '\/video'/, '前端应提交到 /api/video')
})

test('余额显示：徽章注册在会话头部，且生图/生视频页头部也带上', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  // 组件齐全
  for (const fn of ['useBalance', 'BalanceBadge', 'BalancePanel', 'toneOf']) {
    assert.match(source, new RegExp(`function\\s+${fn}\\s*\\(`), `缺少余额组件 ${fn}`)
  }
  // 注册进会话头部，且 order 排在生图(30)之前 → 用户先看到「还能不能花钱」
  const balBlock = source.match(/inject\('conversation\.session\.header\.actions'[\s\S]{0,260}?BalanceBadge/)
  assert.ok(balBlock, '余额徽章应注册进会话头部 actions')
  const order = Number((balBlock[0].match(/order:\s*(\d+)/) ?? [])[1])
  assert.ok(order < 30, `余额徽章的 order 应早于生图(30)，实际 ${order}`)
  // 徽章轮询只查本地（remote=0），详情才拉上游
  assert.match(source, /API \+ '\/balance\?remote=0'/, '徽章轮询应带 remote=0 省外网请求')
  assert.match(source, /jget\(API \+ '\/balance'\)/, '详情应拉完整报告（含上游）')
  // 两个页面头部都带徽章
  const badgeUses = (source.match(/createElement\(BalanceBadge/g) ?? []).length
  assert.ok(badgeUses >= 3, `余额徽章至少要在头部注册 + 生图页 + 生视频页出现 3 次，实际 ${badgeUses}`)
})

test('余额接口存在，并说明为什么要区分本地闸门与上游账户', async () => {
  const server = await readFile(path.join(import.meta.dirname, '..', 'lib', 'server.js'), 'utf8')
  assert.match(server, /sub === '\/api\/balance'/, 'server 应提供 /api/balance')
  assert.match(server, /buildBalanceReport\(/, 'server 应调用 buildBalanceReport')
  const balance = await readFile(path.join(import.meta.dirname, '..', 'lib', 'balance.js'), 'utf8')
  // 占位额度必须被识别（否则会把 1e8 当成余额给用户看）
  assert.match(balance, /PLACEHOLDER_LIMIT/, '必须有「占位额度」判定')
  assert.match(balance, /balance_available/, '必须给出「有没有真实余额」的结论')
})

test('花钱闸门按「本次实际用的配置档」算价，不会被免费激活档放行（漏钱防护）', async () => {
  const upstream = await startUpstream()
  const h = await harness()
  try {
    // 建两个档：free（单价 0，设为激活）与 paid（0.04）
    await h.call(T.config, {
      action: 'import',
      payload: {
        profiles: [
          { id: 'free-one', name: '免费', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-t', model: 'm', isDefault: true, pricePerImage: 0 },
          { id: 'paid-one', name: '付费', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-t', model: 'm', pricePerImage: 0.04 },
        ],
      },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'free-one' })
    // 把日预算压到很低并「先花掉」，制造付费额度耗尽
    await h.call(T.config, { action: 'set_locks', patch: { dailyBudget: 0.01, confirmAboveImages: 1, perRunMaxImages: 12 } })

    // ① 激活档是免费：即便预算耗尽，免费档应当照跑
    const freeRun = await h.call(T.generate, { prompt: 'free cat', name: 'freecat', project: 'g' })
    assert.equal(freeRun.ok, true, `免费档应放行：${JSON.stringify(freeRun.refusals ?? freeRun.error)}`)
    assert.equal(freeRun.spend_guard, undefined)

    // ② 显式指定付费档：闸门必须按付费档 0.04 算 → 预算 0.01 必然不够，必须被拦
    const paidRun = await h.call(T.generate, { prompt: 'paid cat', name: 'paidcat', project: 'g', profile: 'paid-one', confirm: true })
    assert.equal(paidRun.spend_guard, true, '付费档必须被日预算拦下（不能因为是免费激活档就放行）')
    assert.ok((paidRun.refusals ?? []).some((t) => t.includes('日预算')), JSON.stringify(paidRun.refusals))
    assert.equal(paidRun.ok, undefined, '被拦下时不该产生出图结果')
  } finally {
    await upstream.close()
    await h.cleanup()
  }
})

test('免费与付费分开记账：免费只加张数、不加钱', async () => {
  const upstream = await startUpstream()
  const h = await harness()
  try {
    await h.call(T.config, {
      action: 'import',
      payload: {
        profiles: [
          { id: 'free-one', name: '免费', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-t', model: 'm', isDefault: true, pricePerImage: 0 },
        ],
      },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'free-one' })
    const run = await h.call(T.generate, { prompt: 'a free dot', name: 'dot', project: 'g' })
    assert.equal(run.ok, true, JSON.stringify(run))

    const bal = await h.call(T.balance, { check_remote: false })
    assert.equal(bal.quota, 'unlimited')
    assert.equal(bal.free_tier, true)
    assert.equal(bal.today.free_images, 1, '免费产出应单独计数')
    assert.equal(bal.today.paid_cost, 0, '免费不应产生任何花费')
    assert.equal(bal.today.cost, 0)
    assert.equal(bal.remaining_today, null, '免费=无限额度')
  } finally {
    await upstream.close()
    await h.cleanup()
  }
})

test('注册 29 个工具（含素材审核/余额/视频/审批流/图标集/跨项目风格/音频/拆件/引擎适配/多帧动画），schema 全部符合 dsh-tools 契约', async () => {
  const h = await harness()
  try {
    assert.deepEqual([...h.ctx.registry.keys()].sort(), Object.values(T).sort())
    for (const [name, definition] of h.ctx.registry) {
      assert.equal(typeof definition.description, 'string', `${name} 需要 description`)
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(definition.output.schema.type, 'string')
      assert.equal(definition.parameters.type, 'object')
      assertSupportedSchema(definition.parameters, `${name}.parameters`)
    }
  } finally {
    await h.cleanup()
  }
})

test('配置：set_profile / set_active / test / 输出目录，密钥打码且不会被 *** 覆盖', async () => {
  const upstream = await startUpstream()
  const h = await harness()
  try {
    const saved = await h.call(T.config, {
      action: 'set_profile',
      profile: { id: 'relay', name: '我的中转站', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-live-abcdefghijklmnop', model: 'gpt-image-2.5-sunburst', apiMode: 'images' },
    })
    assert.equal(saved.ok, true)
    const listed = saved.profiles.find((item) => item.id === 'relay')
    assert.equal(listed.apiKey, 'sk-li****mnop', '列表里必须打码')
    assert.equal(listed.hasApiKey, true)

    await h.call(T.config, { action: 'set_active', profile_id: 'relay' })
    await h.call(T.config, { action: 'set_profile', profile: { id: 'relay', apiKey: '****' } })
    const raw = JSON.parse(await readFile(path.join(h.dataDir, 'profiles.json'), 'utf8'))
    assert.equal(raw.profiles.find((p) => p.id === 'relay').apiKey, 'sk-live-abcdefghijklmnop', '*** 不应覆盖真实 Key')

    await h.call(T.config, { action: 'set_output', output_dir: h.outputDir })
    const test = await h.call(T.config, { action: 'test', profile_id: 'relay' })
    assert.equal(test.ok, true, '服务可达（哪怕没有 /models 也算可达）')
    assert.equal(test.probe.baseUrlUsed, `${upstream.base}/v1`)
  } finally {
    await h.cleanup()
    await upstream.close()
  }
})

test('端到端：文生图落盘到 <输出根>/<项目>/ 并生成图片清单.md', async () => {
  const upstream = await startUpstream()
  const h = await harness()
  try {
    await h.call(T.config, { action: 'set_profile', profile: { id: 'relay', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-test-123456', model: 'gpt-image-2.5-sunburst' } })
    await h.call(T.config, { action: 'set_active', profile_id: 'relay' })
    const result = await h.call(T.generate, { prompt: '一只红色苹果，白色背景，游戏素材', project: 'rpg-demo', name: 'apple', size: '1024x1024', quality: 'low' })
    assert.equal(result.ok, true)
    assert.equal(result.images, 1)
    assert.equal(result.provider, 'openai')
    assert.equal(result.model, 'gpt-image-2.5-sunburst')
    assert.match(result.files[0], /rpg-demo[\\/]apple_1\.png$/)

    const files = await readdir(path.join(h.outputDir, 'rpg-demo'))
    assert.ok(files.includes('apple_1.png'))
    assert.ok(files.includes('apple.json'), '单张参数侧车文件')
    assert.ok(files.includes('图片清单.md'), '项目图片清单')

    const index = await readFile(path.join(h.outputDir, 'rpg-demo', '图片清单.md'), 'utf8')
    assert.match(index, /rpg-demo/)
    assert.match(index, /一只红色苹果/)

    const sidecar = JSON.parse(await readFile(path.join(h.outputDir, 'rpg-demo', 'apple.json'), 'utf8'))
    assert.equal(sidecar.prompt, '一只红色苹果，白色背景，游戏素材')
    assert.equal(sidecar.model, 'gpt-image-2.5-sunburst')

    const gallery = await h.call(T.list, {})
    assert.equal(gallery.gallery.ok, 1)
    assert.equal(gallery.gallery.images, 1)
  } finally {
    await h.cleanup()
    await upstream.close()
  }
})

test('端到端：图生图（multipart image[] + mask）走 /images/edits', async () => {
  let seenUrl = ''
  let seenType = ''
  const server = http.createServer((req, res) => {
    seenUrl = req.url
    seenType = req.headers['content-type'] ?? ''
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const h = await harness()
  try {
    const ref = path.join(h.dataDir, 'ref.png')
    await mkdir(path.dirname(ref), { recursive: true })
    await writeFile(ref, Buffer.from(PNG_B64, 'base64'))
    await h.call(T.config, { action: 'set_profile', profile: { id: 'relay', provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-test', model: 'gpt-image-2.5-sunburst' } })
    await h.call(T.config, { action: 'set_active', profile_id: 'relay' })
    const result = await h.call(T.edit, { prompt: '把背景换成雪山', image: ref, project: 'rpg-demo', name: 'apple_snow' })
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'edit')
    assert.equal(seenUrl, '/v1/images/edits')
    assert.match(seenType, /multipart\/form-data/)
  } finally {
    await h.cleanup()
    await new Promise((done) => server.close(done))
  }
})

test('配置导入导出：兼容 GPT Image Playground 的 gpt-image-config.json', async () => {
  const h = await harness()
  try {
    const playgroundConfig = {
      customProviders: [{
        id: 'sb2api-async',
        name: 'sub2api（异步）',
        submit: { path: 'images/generations/async', method: 'POST', contentType: 'json', taskIdPath: 'task_id' },
        poll: { path: 'images/tasks/{task_id}', method: 'GET', intervalSeconds: 3, statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], errorPath: 'error.message' },
      }],
      profiles: [{ id: 'pg-1', name: 'Playground 导入', provider: 'sb2api-async', baseUrl: 'https://relay.example.com/v1', model: 'gpt-image-2.5-sunburst', apiMode: 'images', isDefault: true }],
    }
    const imported = await h.call(T.config, { action: 'import', payload: playgroundConfig })
    assert.equal(imported.ok, true)
    assert.equal(imported.customProviders, 1)

    const exported = await h.call(T.config, { action: 'export' })
    assert.ok(Array.isArray(exported.config.profiles))
    const roundTrip = exported.config.profiles.find((profile) => profile.id === 'pg-1')
    assert.equal(roundTrip.provider, 'sb2api-async')
    assert.equal(roundTrip.baseUrl, 'https://relay.example.com/v1')

    const state = await h.call(T.list, {})
    const provider = state.providers.find((item) => item.id === 'sb2api-async')
    assert.equal(provider.async, true, '自定义服务商能力矩阵要认出异步')
  } finally {
    await h.cleanup()
  }
})

test('异步任务：wait_s=0 提交后返回 task_id，job 工具可继续查', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ task_id: 'task_abc' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'processing' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const h = await harness()
  try {
    await h.call(T.config, { action: 'import', payload: { customProviders: [], profiles: [{ id: 'async-1', provider: 'sb2api-async', baseUrl: `${base}/v1`, apiKey: 'sk-t', model: 'm', isDefault: true }] } })
    await h.call(T.config, { action: 'set_active', profile_id: 'async-1' })
    const submitted = await h.call(T.generate, { prompt: '异步一张', project: 'async', wait_s: 0 })
    assert.equal(submitted.pending, true)
    assert.equal(submitted.task_id, 'task_abc')

    const status = await h.call(T.job, { task_id: 'task_abc', action: 'status' })
    assert.equal(status.status, 'processing')
    assert.equal(status.pending, true)
  } finally {
    await h.cleanup()
    await new Promise((done) => server.close(done))
  }
})
