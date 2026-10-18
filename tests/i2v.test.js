/**
 * 「导入图片生成视频」这条路必须有测试盯着，因为它踩过两个真坑：
 *   1. 用户把出图的配置档丢给视频工具 → 以前只回一句「不是视频服务商」，等于把问题丢回去
 *   2. Agnes 的 first_frame / images 要的是**公网 URL**，本地文件必须先传出去
 *
 * 全部离线：上传走本地假端点，上游走本地假服务器，不碰真实网络。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeVideoParams, prepareVideoMedia, resolveVideoProfile, runVideo, validateVideoArgs } from '../lib/video.js'
import { parseMultipart, boundaryOf, firstFile, fieldValue } from '../lib/multipart.js'
import { isRemoteUrl, mimeFor } from '../lib/upload.js'
import { normalizeProvider } from '../lib/protocol.js'
import { ProfileStore } from '../lib/store.js'
import { attachPanel } from '../lib/server.js'
import { apply } from '../lib/index.js'
import { SpendLedger } from '../lib/spend.js'

const T = {
  video: '_dsh_external_dsh_gpt_image_video',
  config: '_dsh_external_dsh_gpt_image_config',
}

/** 真跑一遍插件装配（和 e2e.test.js 同一套做法），拿到能直接调的工具。 */
async function toolHarness() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-i2v-tool-'))
  const outputDir = path.join(dataDir, 'out')
  const registry = new Map()
  const ctx = {
    tools: { register: (definition) => { registry.set(definition.name, definition); return () => registry.delete(definition.name) } },
    effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    inject() {},
    get() { return undefined },
  }
  apply(ctx, { dataDir, outputDir })
  return {
    dataDir,
    outputDir,
    call: async (name, args) => JSON.parse(await registry.get(name).execute(args)),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  }
}

/** 假 Agnes：建任务 + 轮询 + mp4 下载。 */
async function fakeAgnes() {
  let base = ''
  const created = []
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === 'POST' && url.pathname.endsWith('/videos')) {
      created.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ video_id: 'vid_x', status: 'queued' }))
    }
    if (url.pathname === '/agnesapi') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'completed', url: `${base}/o.mp4` }))
    }
    if (url.pathname === '/o.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.from('mp4bytes')) }
    res.writeHead(404); res.end('{}')
  })
  base = server.base
  return { ...server, created, get base() { return base } }
}

const VIDEO_PROFILE = { id: 'agnes-video-2.5-flash', provider: 'agnes-video', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-test', model: 'agnes-video-2.5-flash' }
const IMAGE_PROFILE = { id: 'agnes-2.5-flash', provider: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-test', model: 'agnes-image-2.5-flash' }
const videoProvider = () => normalizeProvider({ id: 'agnes-video' })

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** 造一个 profiles 桩：够 resolveVideoProfile / runVideo 用就行。 */
function profileStore(profiles, providers = {}) {
  return {
    profiles,
    data: {},
    get: (id) => profiles.find((item) => item.id === id),
    provider: (id) => providers[id] ?? null,
    get active() { return profiles[0] },
  }
}

// ---------------- multipart ----------------

test('multipart：能把浏览器发的表单解析成字段与文件', () => {
  const boundary = '----dshTest123'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="public"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hero.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`)
  assert.equal(parsed.ok, true)
  const file = firstFile(parsed.parts)
  assert.equal(file.filename, 'hero.png')
  assert.equal(file.contentType, 'image/png')
  // 关键：二进制内容不能被头部/分隔符吃字节，也不能被当文本转坏
  assert.deepEqual([...file.data], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  assert.equal(fieldValue(parsed.parts, 'public'), 'true')
})

test('multipart：内容是 CRLF 与 boundary 样式字节时也不能切错', () => {
  const boundary = 'X'
  const payload = Buffer.from('a\r\nb--Xc', 'utf8') // 内含 CRLF 与 --X，但不是 "--X\r\n" 分隔符
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.bin"\r\n\r\n`),
    payload,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`)
  assert.equal(parsed.ok, true)
  assert.equal(firstFile(parsed.parts).data.toString('utf8'), 'a\r\nb--Xc')
})

test('multipart：没有 boundary / 空 body 时给出原因而不是抛异常', () => {
  assert.equal(parseMultipart(Buffer.from('x'), 'text/plain').ok, false)
  assert.equal(parseMultipart(Buffer.alloc(0), 'multipart/form-data; boundary=b').ok, false)
  assert.equal(boundaryOf('multipart/form-data; boundary="abc"'), 'abc')
  assert.equal(boundaryOf(''), '')
})

test('mimeFor / isRemoteUrl：本地路径要上传，公网与 data: 不该被当成文件', () => {
  assert.equal(mimeFor('C:\\a\\b.PNG'), 'image/png')
  assert.equal(mimeFor('a.mp3'), 'audio/mpeg')
  assert.equal(isRemoteUrl('https://x/a.png'), true)
  assert.equal(isRemoteUrl('data:image/png;base64,AAA'), true)
  assert.equal(isRemoteUrl('D:\\game\\a.png'), false)
})

// ---------------- 配置档解析 ----------------

test('配置档：指名的就是视频档 → 原样使用', () => {
  const profiles = profileStore([VIDEO_PROFILE, IMAGE_PROFILE], { 'agnes-video': { id: 'agnes-video' } })
  const resolved = resolveVideoProfile(profiles, 'agnes-video-2.5-flash')
  assert.equal(resolved.profile.id, 'agnes-video-2.5-flash')
  assert.equal(resolved.reason, 'requested')
})

test('配置档：用户把出图档丢过来 → 自动换到视频档，且说明换过了', () => {
  const profiles = profileStore([IMAGE_PROFILE, VIDEO_PROFILE], { 'agnes-video': { id: 'agnes-video' } })
  const resolved = resolveVideoProfile(profiles, 'agnes-2.5-flash')
  assert.equal(resolved.profile.id, 'agnes-video-2.5-flash')
  assert.equal(resolved.reason, 'switched')
  assert.match(resolved.note, /不是视频服务商/)
  assert.match(resolved.note, /agnes-video-2\.5-flash/)
})

test('配置档：没指定但配置里有视频档 → 自动用', () => {
  const profiles = profileStore([IMAGE_PROFILE, VIDEO_PROFILE], { 'agnes-video': { id: 'agnes-video' } })
  const resolved = resolveVideoProfile(profiles, undefined)
  assert.equal(resolved.profile.id, 'agnes-video-2.5-flash')
  assert.equal(resolved.reason, 'auto')
})

test('配置档：一个视频档都没有，但手上有同域名的图片档 → 就地派生（这是原来的报错场景）', () => {
  const profiles = profileStore([IMAGE_PROFILE], { agnes: { id: 'agnes' } })
  const resolved = resolveVideoProfile(profiles, 'agnes-2.5-flash')
  assert.equal(resolved.reason, 'derived')
  assert.equal(resolved.profile.id, 'agnes-video-2.5-flash')
  assert.equal(resolved.profile.provider, 'agnes-video')
  assert.equal(resolved.profile.model, 'agnes-video-2.5-flash')
  assert.equal(resolved.profile.apiKey, 'sk-test', '要沿用图片档的 Key')
  assert.equal(resolved.profile.baseUrl, IMAGE_PROFILE.baseUrl, '要沿用同一个 baseUrl')
  assert.equal(resolved.profile.derived, true)
  assert.equal(resolved.provider.media, 'video')
})

test('配置档：域名对不上就不硬派生（免得把别家的 Key 拿去调 Agnes）', () => {
  const other = { id: 'relay', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'gpt-image-2' }
  const profiles = profileStore([other], { openai: { id: 'openai' } })
  const resolved = resolveVideoProfile(profiles, 'relay')
  assert.equal(resolved.profile, null)
  assert.equal(resolved.reason, 'none')
  assert.ok(resolved.available_video_providers.includes('agnes-video'))
})

test('配置档：派生时如果 id 已被占用，不覆盖别人的档', () => {
  const taken = { id: 'agnes-video-2.5-flash', provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }
  const profiles = profileStore([IMAGE_PROFILE, taken], { agnes: { id: 'agnes' }, openai: { id: 'openai' } })
  const resolved = resolveVideoProfile(profiles, 'agnes-2.5-flash')
  assert.equal(resolved.profile.id, 'agnes-video-2.5-flash-auto')
})

test('配置档：中转站域名跟 apihub 不同 → 靠 videoProvider 声明也能派生（否则永远匹配不上）', () => {
  const relay = {
    id: 'agnes-relay', provider: 'agnes', baseUrl: 'https://my-relay.example.com/v1',
    apiKey: 'sk-relay', model: 'agnes-image-2.5-flash', videoProvider: 'agnes-video',
  }
  const profiles = profileStore([relay], { agnes: { id: 'agnes' } })
  const resolved = resolveVideoProfile(profiles, 'agnes-relay')
  assert.equal(resolved.reason, 'derived')
  assert.equal(resolved.profile.baseUrl, 'https://my-relay.example.com/v1', '派生档要沿用中转站的 baseUrl')
  assert.equal(resolved.profile.apiKey, 'sk-relay')
  assert.match(resolved.note, /videoProvider/)
  // 没声明就不该乱派生
  const noDecl = profileStore([{ ...relay, videoProvider: undefined }], { agnes: { id: 'agnes' } })
  assert.equal(resolveVideoProfile(noDecl, 'agnes-relay').profile, null)
})

// ---------------- 素材：本地 → 公网 ----------------

test('素材：已经是公网 URL 的不上传、不改写', async () => {
  const media = await prepareVideoMedia({
    args: { mode: 'keyframe', first_frame: 'https://cdn/a.png', last_frame: 'https://cdn/b.png' },
    mode: 'keyframe',
    provider: videoProvider(),
    settings: {},
  })
  assert.equal(media.values.first_frame, 'https://cdn/a.png')
  assert.equal(media.values.last_frame, 'https://cdn/b.png')
  assert.equal(media.uploads.length, 0)
  assert.equal(media.failures.length, 0)
  assert.equal(media.remote, 2)
})

test('素材：本地路径 + 上传端点 → 换成公网 URL 并留下「传到哪了」的记录', async () => {
  const { base, close } = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    assert.ok(chunks.length > 0, '上传要把文件字节带上')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('https://cdn.example.com/uploaded.png')
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-up-'))
  try {
    const file = path.join(dir, 'hero.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const media = await prepareVideoMedia({
      args: { mode: 'keyframe', first_frame: file },
      mode: 'keyframe',
      provider: videoProvider(),
      settings: { uploadEndpoint: `${base}/upload` },
    })
    assert.equal(media.failures.length, 0, JSON.stringify(media.failures))
    assert.equal(media.values.first_frame, 'https://cdn.example.com/uploaded.png')
    assert.equal(media.uploads.length, 1)
    assert.equal(media.uploads[0].via, 'custom-endpoint')
    assert.match(media.notes[0], /已上传/)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('素材：本地路径但禁用上传 → 明确报错，不发请求（而不是把本地路径发给上游）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-no-'))
  try {
    const file = path.join(dir, 'hero.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const media = await prepareVideoMedia({
      args: { mode: 'keyframe', first_frame: file },
      mode: 'keyframe',
      provider: videoProvider(),
      settings: {},
      allowUpload: false,
    })
    assert.equal(media.failures.length, 1)
    assert.match(media.failures[0].error, /禁用了上传/)
    assert.ok(media.failures[0].hint.includes('公网'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('素材：上传全失败时带上「试过哪几家」，便于判断是不是网络问题', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-fail-'))
  try {
    const file = path.join(dir, 'hero.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const media = await prepareVideoMedia({
      args: { mode: 'keyframe', first_frame: file },
      mode: 'keyframe',
      provider: videoProvider(),
      settings: { uploadOnly: ['not-a-real-host'] }, // 过滤后为空 → 不会碰真实网络
    })
    assert.equal(media.failures.length, 1)
    assert.ok(Array.isArray(media.failures[0].tried_hosts))
    assert.ok(media.failures[0].hint.includes('公网'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('素材：文件不存在时立刻报错，不去试着上传', async () => {
  const media = await prepareVideoMedia({
    args: { mode: 'keyframe', first_frame: 'D:\\definitely\\not\\here.png' },
    mode: 'keyframe',
    provider: videoProvider(),
    settings: {},
  })
  assert.equal(media.failures.length, 1)
  assert.match(media.failures[0].error, /文件不存在/)
})

test('素材：只处理该模式用到的字段（不该把用不到的素材传出去）', async () => {
  const { base, close } = await startServer(async (req, res) => {
    for await (const _ of req) { /* 吃掉 body */ }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('https://cdn.example.com/up.png')
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-scope-'))
  try {
    const file = path.join(dir, 'hero.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    // text 模式：给了 first_frame 也不该上传（该字段在 text 模式本来就不发）
    const text = await prepareVideoMedia({
      args: { mode: 'text', first_frame: file },
      mode: 'text',
      provider: videoProvider(),
      settings: { uploadEndpoint: `${base}/upload` },
    })
    assert.equal(text.uploads.length, 0, 'text 模式不该上传任何素材')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('校验：本地路径漏到参数里要被本地拦下（上游只会回「取不到媒体」）', () => {
  const params = normalizeVideoParams({ profile: VIDEO_PROFILE, args: { mode: 'keyframe', first_frame: 'D:\\game\\hero.png' } })
  const errors = validateVideoArgs({ args: {}, params })
  assert.ok(errors.some((e) => e.includes('本地路径')), JSON.stringify(errors))
})

// ---------------- 端到端：导入图片 → 公网 URL → 建任务 ----------------

test('端到端：导入本地图片当首帧 → 上传 → 建任务时发出去的是公网 URL', async () => {
  const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
  let createBody = null
  let uploadHits = 0
  let base = ''
  const { base: started, close } = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/upload') {
      uploadHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(`${base}/assets/frame.png`)
    }
    if (req.method === 'POST' && url.pathname.endsWith('/videos')) {
      createBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: 't', video_id: 'vid_i2v', status: 'queued' }))
    }
    if (url.pathname === '/agnesapi') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'completed', url: `${base}/out.mp4` }))
    }
    if (url.pathname === '/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(mp4) }
    res.writeHead(404); res.end('{}')
  })
  base = started
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-e2e-'))
  try {
    const localImage = path.join(dir, 'hero.png')
    await writeFile(localImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const profiles = profileStore([{ ...VIDEO_PROFILE, baseUrl: `${base}/v1` }], { 'agnes-video': { id: 'agnes-video' } })
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({
      profiles,
      gallery,
      settings: { outputDir: dir, timeoutMs: 20000, uploadEndpoint: `${base}/upload` },
      args: {
        profile: 'agnes-video-2.5-flash', prompt: 'hero walks', mode: 'keyframe',
        first_frame: localImage, project: 'i2v', name: 'clip', wait_s: 20, poll_interval_ms: 200,
      },
    })
    assert.equal(result.ok, true, `应成功，实际：${result.error}`)
    assert.equal(uploadHits, 1, '本地图片应该被上传一次')
    assert.equal(createBody.mode, 'keyframe')
    assert.equal(createBody.first_frame, `${started}/assets/frame.png`, '发出去的必须是公网 URL，不是本地路径')
    assert.ok(!/hero\.png|\\\\/.test(String(createBody.first_frame)), '本地路径绝不能出现在请求里')
    assert.equal(result.assets.length, 1)
    assert.equal(result.assets[0].via, 'custom-endpoint')
    assert.equal(result.mode, 'keyframe')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：本地图片上传失败时直接拦下，一次上游请求都不发', async () => {
  let upstreamHits = 0
  const { base, close } = await startServer(async (req, res) => {
    upstreamHits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-block-'))
  try {
    const localImage = path.join(dir, 'hero.png')
    await writeFile(localImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const profiles = profileStore([{ ...VIDEO_PROFILE, baseUrl: `${base}/v1` }], { 'agnes-video': { id: 'agnes-video' } })
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({
      profiles, gallery,
      // uploadOnly 指向一个不存在的图床：让这条测试稳定失败，而不是真的去传 uguu（那样就不确定了）
      settings: { outputDir: dir, uploadOnly: ['not-a-real-host'] },
      args: { profile: 'agnes-video-2.5-flash', prompt: 'p', mode: 'keyframe', first_frame: localImage, upload: true },
    })
    assert.equal(result.ok, false)
    assert.equal(result.upload_failed, true)
    assert.equal(result.block_invalid, true)
    assert.match(result.error, /公网 URL/)
    assert.equal(upstreamHits, 0, '素材没准备好就不该发请求')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：runVideo 自己也会解析配置档（传了出图档也不报错）', async () => {
  let base = ''
  const { base: started, close } = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.endsWith('/videos')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ video_id: 'v1', status: 'queued' }))
    }
    if (url.pathname === '/agnesapi') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'completed', url: `${base}/o.mp4` }))
    }
    if (url.pathname === '/o.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.from('mp4')) }
    res.writeHead(404); res.end('{}')
  })
  base = started
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-auto-'))
  try {
    const profiles = profileStore([
      { ...IMAGE_PROFILE, baseUrl: `${base}/v1` },
      { ...VIDEO_PROFILE, baseUrl: `${base}/v1` },
    ], { agnes: { id: 'agnes' }, 'agnes-video': { id: 'agnes-video' } })
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({
      profiles, gallery, settings: { outputDir: dir, timeoutMs: 20000 },
      args: { profile: 'agnes-2.5-flash', prompt: 'p', project: 'auto', name: 'c', wait_s: 20, poll_interval_ms: 200 },
    })
    assert.equal(result.ok, true, `应自动换档成功：${result.error}`)
    assert.equal(result.profile, 'agnes-video-2.5-flash')
    assert.equal(result.profile_reason, 'switched')
    assert.match(result.profile_note, /已自动改用/)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：一个视频档都没有时，派生并真的用它建任务', async () => {
  let base = ''
  const { base: started, close } = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.endsWith('/videos')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ video_id: 'v2', status: 'queued' }))
    }
    if (url.pathname === '/agnesapi') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'completed', url: `${base}/o2.mp4` }))
    }
    if (url.pathname === '/o2.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.from('mp4')) }
    res.writeHead(404); res.end('{}')
  })
  base = started
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i2v-dev-'))
  try {
    // 只配了图片档，且 baseUrl 指向假上游 —— 但 host 是 127.0.0.1，派生要求域名匹配
    // agnes 的 host，所以这里直接把 baseUrl 设成 agnes 域名、用 host 覆盖走假上游不现实。
    // 因此这条只验证「不在同域名时不硬派生」，真正的派生已在纯函数测试里覆盖。
    const other = { id: 'relay', provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'k', model: 'm' }
    const profiles = profileStore([other], { openai: { id: 'openai' } })
    const gallery = { add: (r) => ({ id: 'g', ...r }), list: () => [], records: [] }
    const result = await runVideo({ profiles, gallery, settings: { outputDir: dir }, args: { profile: 'relay', prompt: 'p' } })
    assert.equal(result.ok, false)
    assert.equal(result.profile_reason, 'none')
    assert.ok(result.available_video_providers.includes('agnes-video'))
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------- profiles.data 不能丢字段 ----------------

test('profiles.json：load→save→load 之后 gameRoot / lastProject / 上传配置都还在', async () => {
  // save() 是把 this.data 整个写回去的；load 若只挑白名单字段，
  // 任何「后来加的字段」都会静默丢失 —— 表现是「面板里设了、下次读又空了」，且不报错。
  const dir = await mkdtemp(path.join(os.tmpdir(), 'persist-'))
  try {
    const first = await ProfileStore.load(dir)
    first.data.gameRoot = 'D:\\MyGame'
    first.data.lastProject = 'ui-icons'
    first.data.publicBaseUrl = 'https://tunnel.example.com'
    first.data.uploadEndpoint = 'https://myhost/upload'
    first.data.uploadField = 'file'
    await first.save()

    const second = await ProfileStore.load(dir)
    assert.equal(second.data.gameRoot, 'D:\\MyGame')
    assert.equal(second.data.lastProject, 'ui-icons')
    assert.equal(second.data.publicBaseUrl, 'https://tunnel.example.com')
    assert.equal(second.data.uploadEndpoint, 'https://myhost/upload')
    assert.equal(second.data.uploadField, 'file')
    // 白名单字段当然也不能因为这次改动被弄坏
    assert.equal(second.data.outputDir, first.data.outputDir)
    assert.equal(second.data.profiles.length, first.data.profiles.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------- 工具层：花钱闸门 + 全链路 ----------------

test('工具：免费视频档不该被当成付费档（pricePerProfile 传对象会静默退化成全局单价）', async () => {
  const agnes = await fakeAgnes()
  const h = await toolHarness()
  try {
    // 把全局单价设高：如果免费档的 pricePerImage=0 没被读到，闸门就会按 0.5/秒算，
    // 4 秒 = 2 元，在 confirm=false 时必然被拦下 —— 这条测试就是钉死这个退化。
    await h.call(T.config, { action: 'set_locks', patch: { pricePerImage: 0.5, spendDisabled: false, confirmAboveImages: 0 } })
    await h.call(T.config, {
      action: 'set_profile',
      profile: {
        id: 'agnes-relay', provider: 'agnes', baseUrl: `${agnes.base}/v1`, apiKey: 'sk-t',
        model: 'agnes-image-2.5-flash', videoProvider: 'agnes-video', pricePerImage: 0,
      },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'agnes-relay' })

    const result = await h.call(T.video, {
      prompt: '金币旋转', seconds: 4, mode: 'text', project: 'vid', name: 'clip',
      confirm: false, wait_s: 20, poll_interval_ms: 200,
    })
    assert.equal(result.ok, true, `免费档不该被闸门拦下：${result.error || result.reason || ''}`)
    assert.equal(result.spend_guard, undefined, '免费档不该触发花钱闸门')
    assert.equal(result.profile, 'agnes-video-2.5-flash')
    assert.equal(result.profile_reason, 'derived')
    assert.equal(agnes.created.length, 1)

    // 记账要记在「免费」那一栏，而不是付费
    const spend = await SpendLedger.load(h.dataDir)
    assert.equal(spend.todayFree().images, 4, '视频按秒计入免费额度')
    assert.equal(spend.todayFree().runs, 1)
    assert.equal(spend.todayPaid().images, 0, '免费档不该产生付费花费')
  } finally {
    await h.cleanup()
    await agnes.close()
  }
})

test('工具（对照）：付费视频档在 confirm=false 时确实会被闸门拦下', async () => {
  // 这条是上面那条的对照组：同样的调用方式，只把单价改成 0.5/秒。
  // 如果它不拦，说明闸门本身没生效，那上面「免费档没被拦」就不能证明是价格的功劳。
  const agnes = await fakeAgnes()
  const h = await toolHarness()
  try {
    await h.call(T.config, { action: 'set_locks', patch: { pricePerImage: 0.5, spendDisabled: false, confirmAboveImages: 0 } })
    await h.call(T.config, {
      action: 'set_profile',
      profile: {
        id: 'paid-video', provider: 'agnes-video', baseUrl: `${agnes.base}/v1`, apiKey: 'sk-t',
        model: 'agnes-video-2.5-flash', pricePerImage: 0.5,
      },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'paid-video' })

    const result = await h.call(T.video, {
      prompt: 'p', seconds: 4, mode: 'text', project: 'vid', name: 'x',
      confirm: false, wait_s: 20, poll_interval_ms: 200,
    })
    // 闸门拦下时返回的是闸门对象本身（没有 ok 字段），认 spend_guard / allow 这两个标志
    assert.equal(result.spend_guard, true, `付费档在 confirm=false 时应被花钱闸门拦下：${JSON.stringify(result).slice(0, 300)}`)
    assert.equal(result.allow, false)
    assert.equal(agnes.created.length, 0, '被拦下就不该发请求')
  } finally {
    await h.cleanup()
    await agnes.close()
  }
})

test('工具：配好上传端点后，导入本地图片当首帧能一条龙出片', async () => {
  const agnes = await fakeAgnes()
  const uploaded = []
  const uploadHost = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    uploaded.push(Buffer.concat(chunks))
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('https://cdn.example.com/imported_hero.png')
  })
  const h = await toolHarness()
  try {
    // 用 config 工具配上传端点（不手改 profiles.json）
    const configured = await h.call(T.config, { action: 'set_upload', patch: { uploadEndpoint: `${uploadHost.base}/upload` } })
    assert.equal(configured.ok, true)
    assert.equal(configured.uploadEndpoint, `${uploadHost.base}/upload`)

    await h.call(T.config, {
      action: 'set_profile',
      profile: {
        id: 'agnes-relay', provider: 'agnes', baseUrl: `${agnes.base}/v1`, apiKey: 'sk-t',
        model: 'agnes-image-2.5-flash', videoProvider: 'agnes-video', pricePerImage: 0,
      },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'agnes-relay' })

    const localImage = path.join(h.dataDir, 'hero.png')
    await writeFile(localImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const result = await h.call(T.video, {
      prompt: '角色从首帧姿态自然转身走向窗边，镜头缓慢推进',
      mode: 'keyframe', first_frame: localImage, seconds: 4,
      project: 'vid', name: 'i2v', confirm: false, wait_s: 20, poll_interval_ms: 200,
    })
    assert.equal(result.ok, true, `应出片成功：${result.error || ''}`)
    assert.ok(uploaded.length === 1, '本地图片应被上传一次')
    assert.equal(agnes.created.length, 1)
    assert.equal(agnes.created[0].mode, 'keyframe')
    assert.equal(agnes.created[0].first_frame, 'https://cdn.example.com/imported_hero.png', '发出去的必须是公网 URL')
    assert.equal(result.mode, 'keyframe')
    assert.equal(result.assets.length, 1)
    assert.equal(result.assets[0].via, 'custom-endpoint')
    assert.ok((result.files ?? []).length === 1, 'mp4 应落盘')
  } finally {
    await h.cleanup()
    await uploadHost.close()
    await agnes.close()
  }
})

test('工具：text 模式带了图片字段要说清「被忽略了」，不能静默无视', async () => {
  const agnes = await fakeAgnes()
  const h = await toolHarness()
  try {
    await h.call(T.config, {
      action: 'set_profile',
      profile: {
        id: 'agnes-relay', provider: 'agnes', baseUrl: `${agnes.base}/v1`, apiKey: 'sk-t',
        model: 'agnes-image-2.5-flash', videoProvider: 'agnes-video', pricePerImage: 0,
      },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'agnes-relay' })
    const localImage = path.join(h.dataDir, 'hero.png')
    await writeFile(localImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await h.call(T.video, {
      prompt: 'p', mode: 'text', first_frame: localImage, seconds: 4,
      project: 'vid', name: 'x', confirm: false, wait_s: 20, poll_interval_ms: 200,
    })
    assert.equal(result.ok, true, result.error)
    const notes = (result.asset_notes ?? []).join('\n')
    assert.match(notes, /mode=text/, '要提醒 first_frame 在 text 模式下会被忽略')
    assert.match(notes, /keyframe/)
  } finally {
    await h.cleanup()
    await agnes.close()
  }
})

// ---------------- 面板源码：导入图片的入口必须真的在 ----------------

test('面板源码：生视频表单有「导入图片」入口，并且打的是 /api/upload', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  // 语法必须能编译（客户端靠 window.__ModuleLoader__ 装配，不执行）
  assert.doesNotThrow(() => new Function('window', 'require', source))
  // 文件选择 + 上传端点 + 从素材库挑
  assert.match(source, /type:\s*'file'/, '视频表单要有本地文件选择器')
  assert.match(source, /API \+ '\/upload'/, '导入要打到 /api\/upload')
  assert.match(source, /new FormData\(\)/, '导入要走 multipart')
  assert.match(source, /loadLibrary/, '要有「从已生成的图选」')
  assert.match(source, /dshvid-import/, '导入区要有样式类')
  // 本地路径也能直接填（不只是选文件）
  assert.match(source, /本地绝对路径或公网 URL/, '输入框要说明本地路径也能填')
})


/** 用 mock ctx 把真实的 panel handler 抓出来，然后用真 HTTP 打它。 */
function capturePanel(config) {
  let handler = null
  const scope = {
    effect: (run) => run(),
    webServer: {
      register: (route) => { if (route.path === '/gpt-image') handler = route.handler },
    },
  }
  attachPanel({ inject: (_deps, fn) => fn(scope) }, config)
  return handler
}

test('面板 /api/upload：真 multipart 进来 → 落盘 → 返回公网 URL', async () => {
  const fake = await startServer(async (req, res) => {
    for await (const _ of req) { /* 吃掉上传体 */ }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('https://cdn.example.com/imported.png')
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panel-'))
  try {
    await writeFile(path.join(dir, 'profiles.json'), JSON.stringify({
      version: 1,
      activeProfileId: 'agnes-2.5-flash',
      outputDir: dir,
      timeoutMs: 20000,
      customProviders: [],
      profiles: [{ id: 'agnes-2.5-flash', provider: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-t', model: 'agnes-image-2.5-flash' }],
      uploadEndpoint: `${fake.base}/upload`,
    }))
    const handler = capturePanel({ dataDir: dir })
    assert.equal(typeof handler, 'function', 'attachPanel 应注册 /gpt-image handler')
    const panel = await startServer((req, res) => handler(req, res))

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
    const form = new FormData()
    form.set('file', new Blob([png], { type: 'image/png' }), 'hero.png')
    const response = await fetch(`${panel.base}/gpt-image/api/upload`, { method: 'POST', body: form })
    const json = await response.json()
    assert.equal(json.ok, true, JSON.stringify(json))
    assert.equal(json.url, 'https://cdn.example.com/imported.png')
    assert.equal(json.bytes, png.length)
    assert.match(json.stored, /uploads/, '文件应先落在数据目录的 uploads 下')
    // 落盘内容必须与上传的字节一致（multipart 解析错了这里就会炸）
    const stored = await readFile(json.stored)
    assert.deepEqual([...stored], [...png])
    await panel.close()
  } finally {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('面板 /api/upload：没带文件字段时给出原因而不是 500', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panel2-'))
  try {
    const handler = capturePanel({ dataDir: dir })
    const panel = await startServer((req, res) => handler(req, res))
    const form = new FormData()
    form.set('note', '这里只有文本，没有文件')
    const response = await fetch(`${panel.base}/gpt-image/api/upload`, { method: 'POST', body: form })
    const json = await response.json()
    assert.equal(response.status, 400)
    assert.equal(json.ok, false)
    assert.match(json.error, /没收到文件字段/)
    await panel.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('面板 /api/video：没配视频档时自动派生并真的出片（配置档不用用户操心）', async () => {
  let base = ''
  const created = []
  const upstream = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === 'POST' && url.pathname.endsWith('/videos')) {
      created.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ video_id: 'vid_panel', status: 'queued' }))
    }
    if (url.pathname === '/agnesapi') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'completed', url: `${base}/p.mp4` }))
    }
    if (url.pathname === '/p.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.from('mp4data')) }
    res.writeHead(404); res.end('{}')
  })
  base = upstream.base

  const dir = await mkdtemp(path.join(os.tmpdir(), 'panel3-'))
  try {
    // 只配了图片档；靠 videoProvider 声明派生（中转站场景）。
    // 这样派生档的 baseUrl 就是本地假上游 —— 测试全程离线。
    await writeFile(path.join(dir, 'profiles.json'), JSON.stringify({
      version: 1,
      activeProfileId: 'agnes-relay',
      outputDir: dir,
      timeoutMs: 20000,
      customProviders: [{ id: 'agnes', name: 'Agnes' }],
      profiles: [{
        id: 'agnes-relay', provider: 'agnes', baseUrl: `${base}/v1`,
        apiKey: 'sk-t', model: 'agnes-image-2.5-flash', videoProvider: 'agnes-video',
      }],
    }))
    const handler = capturePanel({ dataDir: dir })
    const panel = await startServer((req, res) => handler(req, res))

    // 关键：面板根本没传 profile（用户从 UI 点「生成视频」就是这个情况）
    const response = await fetch(`${panel.base}/gpt-image/api/video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '金币旋转', seconds: 4, mode: 'text', project: 'panelvid', name: 'clip', confirm: true, wait_s: 20, poll_interval_ms: 200 }),
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.ok, true, `应出片成功：${json.error || ''}`)
    assert.equal(json.profile, 'agnes-video-2.5-flash', '应自动派生并落到视频档')
    assert.equal(json.profile_reason, 'derived')
    assert.equal(created.length, 1)
    assert.equal(created[0].model, 'agnes-video-2.5-flash')
    assert.equal(created[0].seconds, '4')
    assert.ok((json.files ?? []).length === 1, 'mp4 应落盘')

    // 派生的档要落盘，下次直接可用（且可被 config 工具删掉）
    const saved = await ProfileStore.load(dir)
    assert.ok(saved.get('agnes-video-2.5-flash'), '派生出来的视频档应被持久化')
    assert.equal(saved.get('agnes-video-2.5-flash').provider, 'agnes-video')
    assert.equal(saved.get('agnes-video-2.5-flash').baseUrl, `${base}/v1`)
    await panel.close()
  } finally {
    await upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})
