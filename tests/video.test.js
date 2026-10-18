/**
 * 视频生成测试：Agnes Video 2.5 Flash（异步建任务 + 轮询 + mp4 落盘）。
 * 全部离线：不碰真实网络，靠假上游与纯函数断言。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test, { beforeEach } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRequest, extractVideos, normalizeProvider } from '../lib/protocol.js'
import { isVideoQueueFull, normalizeVideoParams, runVideo, validateVideoArgs, resetVideoRateLimit } from '../lib/video.js'
import { rootOf } from '../lib/util.js'

/* 限流冷却是模块级状态（按配置档隔离）：前一个用例模拟 429，不清理就会把后面用例也挡住。
 * 测试之间必须隔离 —— 否则失败原因看起来像"功能坏了"，实际是状态漏到了下一个用例。 */
beforeEach(() => {
  resetVideoRateLimit()
})

const VIDEO_PROFILE = { id: 'v', provider: 'agnes-video', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-test', model: 'agnes-video-2.5-flash' }
const providerDef = () => normalizeProvider({ id: 'agnes-video' })

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

// ---- 请求构造 ----

test('建任务：POST /v1/videos，seconds 是字符串，size 固定 720P', () => {
  const params = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { prompt: 'p', seconds: 4, mode: 'text', aspect_ratio: '16:9' } })
  const req = buildRequest({ provider: providerDef(), profile: VIDEO_PROFILE, params, prompt: 'a coin spinning' })
  assert.equal(req.url, 'https://apihub.agnes-ai.com/v1/videos')
  assert.equal(req.body.model, 'agnes-video-2.5-flash')
  assert.equal(req.body.seconds, '4', 'seconds 必须是字符串')
  assert.equal(req.body.size, '720P')
  assert.equal(req.body.mode, 'text')
  assert.equal(req.body.aspect_ratio, '16:9')
})

test('seconds 被夹在 4-12 之间（上游对超范围直接 400）', () => {
  assert.equal(normalizeVideoParams({ profile: VIDEO_PROFILE, args: { seconds: 1 } }).seconds, '4')
  assert.equal(normalizeVideoParams({ profile: VIDEO_PROFILE, args: { seconds: 99 } }).seconds, '12')
  assert.equal(normalizeVideoParams({ profile: VIDEO_PROFILE, args: {} }).seconds, '5', '默认 5 秒')
})

test('mode 专属字段只在该模式下发出（避免上游因多余字段报错）', () => {
  const text = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { mode: 'text', first_frame: 'https://x/a.png' } })
  assert.equal(text.first_frame, undefined, 'text 模式不该带 first_frame')
  const kf = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { mode: 'keyframe', first_frame: 'https://x/a.png' } })
  assert.equal(kf.first_frame, 'https://x/a.png')
  const ref = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { mode: 'reference', images: ['https://x/a.png'] } })
  assert.deepEqual(ref.images, ['https://x/a.png'])
})

test('参考图/音频数量被截到上限（5 图 / 3 音）', () => {
  const many = Array.from({ length: 9 }, (_, i) => `https://x/${i}.png`)
  const params = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { mode: 'reference', images: many, audios: ['a', 'b', 'c', 'd', 'e'] } })
  assert.equal(params.images.length, 5)
  assert.equal(params.audios.length, 3)
})

// ---- 参数校验 ----

test('非法参数在本地挡住，不浪费一次请求', () => {
  const bad = [
    { mode: 'keyframe' },
    { mode: 'reference' },
    { mode: 'nope' },
  ]
  for (const args of bad) {
    const params = normalizeVideoParams({ profile: VIDEO_PROFILE, args })
    assert.ok(validateVideoArgs({ args, params }).length > 0, `${JSON.stringify(args)} 应被判为非法`)
  }
})

test('size 必须是 720P；Flash 不支持参考视频', () => {
  const params = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { size: '1080P' } })
  const errors = validateVideoArgs({ args: {}, params })
  assert.ok(errors.some((e) => e.includes('720P')))
  const withVideos = validateVideoArgs({ args: { videos: [{ url: 'x' }] }, params: normalizeVideoParams({ profile: VIDEO_PROFILE, args: {} }) })
  assert.ok(withVideos.some((e) => e.includes('参考视频')))
})

test('合法参数校验通过', () => {
  const params = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { mode: 'text' } })
  assert.deepEqual(validateVideoArgs({ args: {}, params }), [])
})

// ---- 轮询地址 ----

test('轮询走站点根 /agnesapi（不在 /v1 下），带 video_id 与 model_name', () => {
  const def = providerDef()
  assert.equal(def.poll.rootRelative, true)
  assert.equal(def.poll.path, 'agnesapi?video_id={task_id}&model_name={model}')
  assert.equal(rootOf('https://apihub.agnes-ai.com/v1'), 'https://apihub.agnes-ai.com')
})

test('rootOf 对异常输入不炸', () => {
  assert.equal(rootOf(''), '')
  assert.equal(rootOf('not a url'), 'not a url')
  assert.equal(rootOf('https://h/v1/'), 'https://h')
})

// ---- 结果解析 ----

test('视频地址从顶层 url 解析出来', () => {
  const payload = { id: 'task_1', status: 'completed', url: 'https://cdn/x.mp4', seconds: '4', size: '720P', progress: 100 }
  assert.deepEqual(extractVideos(payload), [{ url: 'https://cdn/x.mp4' }])
})

test('视频地址也支持 data[].url 这类嵌套写法', () => {
  const payload = { data: [{ url: 'https://cdn/a.mp4' }, { url: 'https://cdn/b.mp4' }] }
  assert.equal(extractVideos(payload).length, 2)
})

test('没有地址时返回空数组（不会编一个假地址）', () => {
  assert.deepEqual(extractVideos({ status: 'completed' }), [])
  assert.deepEqual(extractVideos(null), [])
})

// ---- 队列满识别 ----

test('队列满被识别为可重试；限流与参数错误不算队列满', () => {
  assert.equal(isVideoQueueFull(503, { code: 'video_queue_full', message: 'video queue is full, please retry later' }), true)
  assert.equal(isVideoQueueFull(503, 'video queue is full'), true)
  assert.equal(isVideoQueueFull(429, { error: { code: 'rate_limit_exceeded' } }), false)
  assert.equal(isVideoQueueFull(400, { detail: 'size must be 720P' }), false)
})

test('免费档视频限流被单独识别（重试没用，要等额度或升级）', async () => {
  const { isVideoRateLimited } = await import('../lib/video.js')
  const real = { error: { message: "You've reached the API rate limit for free users. Upgrade to a Token Plan to unlock higher limits.", type: 'AgnesAI_error', code: 'rate_limit_exceeded' } }
  assert.equal(isVideoRateLimited(429, real), true)
  assert.equal(isVideoRateLimited(503, { code: 'video_queue_full' }), false)
  assert.equal(isVideoRateLimited(400, { detail: 'size must be 720P' }), false)
})

test('限流时的 hint 指向额度问题，而不是让用户去查配置', async () => {
  let calls = 0
  const { base, close } = await startServer(async (req, res) => {
    calls += 1
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'API rate limit for free users' } }))
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vid5-'))
  try {
    const profiles = { get: () => ({ ...VIDEO_PROFILE, baseUrl: `${base}/v1` }), provider: () => null, profiles: [{ id: 'v' }] }
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({
      profiles, gallery, settings: { outputDir: dir },
      args: { profile: 'v', prompt: 'p', queue_retries: 1 }, // 限流不该被当成队列满重试
    })
    assert.equal(result.ok, false)
    assert.equal(result.rate_limited, true)
    assert.equal(result.queue_full, false)
    assert.ok(result.hint.includes('限流'), result.hint)
    assert.equal(calls, 1, '限流不是队列满，不该重试')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- 端到端：假上游跑完整流程 ----

test('端到端：建任务 → 轮询 → 下载 mp4 落盘', async () => {
  const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  let createBody = null
  let polls = 0
  // base 在 handler 里用来拼下载地址（handler 是同步注册的，close 时才用到它）
  let base = ''
  const { base: started, close } = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, 'http://x')
    // 建任务
    if (req.method === 'POST' && url.pathname.endsWith('/videos')) {
      createBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'task_1', video_id: 'vid_1', status: 'queued' }))
      return
    }
    // 轮询（站点根 /agnesapi）
    if (url.pathname === '/agnesapi') {
      polls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      if (polls < 2) return res.end(JSON.stringify({ status: 'processing', progress: 40 }))
      return res.end(JSON.stringify({ id: 'task_1', status: 'completed', url: `${base}/out.mp4`, seconds: '4', size: '720P', progress: 100 }))
    }
    // 下载 mp4
    if (url.pathname === '/out.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      return res.end(mp4)
    }
    res.writeHead(404); res.end('{}')
  })
  base = started
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vid-'))
  try {
    const profiles = {
      get: () => ({ ...VIDEO_PROFILE, baseUrl: `${base}/v1` }),
      provider: () => null,
      profiles: [{ id: 'v' }],
    }
    const records = []
    const gallery = { add: (r) => { records.push(r); return { id: 'g1', ...r } }, list: () => records, records: [] }
    const result = await runVideo({
      profiles,
      gallery,
      settings: { outputDir: dir, timeoutMs: 20000 },
      args: { profile: 'v', prompt: 'a coin', seconds: 4, project: 'vidproj', name: 'clip', wait_s: 20, poll_interval_ms: 250 },
    })
    assert.equal(result.ok, true, `应成功，实际：${result.error}`)
    assert.equal(createBody.model, 'agnes-video-2.5-flash')
    assert.equal(createBody.seconds, '4')
    assert.equal(createBody.size, '720P')
    assert.equal(result.files.length, 1)
    assert.ok(result.files[0].endsWith('clip_1.mp4'), `落盘应是 .mp4：${result.files[0]}`)
    const info = await stat(result.files[0])
    assert.equal(info.size, mp4.length, '落盘内容应与下载一致')
    assert.equal(result.meta.size, '720P')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：队列满会自动退避重试，队列空了就成功', async () => {
  let attempts = 0
  let base = ''
  const { base: started, close } = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'POST' && url.pathname.endsWith('/videos')) {
      attempts += 1
      if (attempts === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ code: 'video_queue_full', message: 'video queue is full, please retry later' }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: 't', video_id: 'vid_2', status: 'queued' }))
    }
    if (url.pathname === '/agnesapi') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'completed', url: `${base}/v.mp4` }))
    }
    if (url.pathname === '/v.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.from('mp4')) }
    res.writeHead(404); res.end('{}')
  })
  base = started
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vid2-'))
  try {
    const profiles = { get: () => ({ ...VIDEO_PROFILE, baseUrl: `${base}/v1` }), provider: () => null, profiles: [{ id: 'v' }] }
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({
      profiles, gallery, settings: { outputDir: dir, timeoutMs: 20000 },
      args: { profile: 'v', prompt: 'p', project: 'q', name: 'c', wait_s: 20, poll_interval_ms: 200, queue_retries: 2 },
    })
    assert.equal(attempts, 2, '第一次队列满，应重试第二次')
    assert.equal(result.ok, true, `重试后应成功：${result.error}`)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：配置档不是视频服务商时给出明确提示，不发请求', async () => {
  let hit = 0
  const { base, close } = await startServer(async (req, res) => { hit += 1; res.writeHead(200); res.end('{}') })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vid3-'))
  try {
    const profiles = {
      get: () => ({ id: 'img', provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'k', model: 'gpt-image-2' }),
      provider: () => null,
      profiles: [{ id: 'img' }],
    }
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({ profiles, gallery, settings: { outputDir: dir }, args: { profile: 'img', prompt: 'p' } })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('不是视频服务商'), result.error)
    assert.equal(hit, 0, '不该发出任何请求')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：非法参数被本地拦下，不发请求', async () => {
  let hit = 0
  const { base, close } = await startServer(async (req, res) => { hit += 1; res.writeHead(200); res.end('{}') })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vid4-'))
  try {
    const profiles = { get: () => ({ ...VIDEO_PROFILE, baseUrl: `${base}/v1` }), provider: () => null, profiles: [{ id: 'v' }] }
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({
      profiles, gallery, settings: { outputDir: dir },
      args: { profile: 'v', prompt: 'p', mode: 'keyframe' }, // keyframe 缺首尾帧
    })
    assert.equal(result.ok, false)
    assert.equal(result.block_invalid, true)
    assert.equal(hit, 0, '参数不合法不该发请求')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})
