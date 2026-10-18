/**
 * 探针：导入图片生成视频能不能走通。
 *
 * 要回答两个问题（都是猜不出来、只能真打的）：
 *   A. Agnes 视频接口的 first_frame 能不能收 data: URL（本地图片直接内联）
 *      —— 文档写的是「媒体 URL 应当可公开访问」，但没说 data: 一定被拒。
 *   B. 如果不行，本机能不能把一个本地文件传到免费匿名图床拿到公网 URL，
 *      哪几家现在是通的（这是「导入本地图片」唯一现实的落地方式）。
 *
 * 用法：node scripts/probe-i2v.mjs [本地图片路径]
 * 只创建少量任务；Agnes 视频当前免费，不产生费用。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ProfileStore } from '../lib/store.js'

const OUTPUT_ROOT = 'D:\\AHC\\aishengtu图片地址'

function findSampleImage() {
  if (process.argv[2]) return process.argv[2]
  const stack = [OUTPUT_ROOT]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { stack.push(full); continue }
      if (/\.png$/i.test(entry) && !/_labeled|_slice/.test(entry) && st.size > 1024) return full
    }
  }
  return null
}

const sample = findSampleImage()
if (!sample) { console.error('找不到样例图片'); process.exit(1) }
const buf = readFileSync(sample)
const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
console.log(`样例图片：${sample}（${buf.length} 字节）`)

// 从 profiles.json 里拿 agnes 的 baseUrl / apiKey（不写死密钥）
const profiles = await ProfileStore.load()
const anyAgnes = profiles.profiles.find((p) => /agnes/i.test(p.baseUrl ?? '') && p.apiKey)
if (!anyAgnes) { console.error('profiles.json 里找不到带 Key 的 agnes 配置档'); process.exit(1) }
const baseUrl = anyAgnes.baseUrl.replace(/\/+$/, '')
const key = anyAgnes.apiKey
console.log(`用配置档 ${anyAgnes.id} 的 baseUrl=${baseUrl}\n`)

const CREATE = `${baseUrl}/videos`

async function createTask(label, body) {
  const started = Date.now()
  try {
    const res = await fetch(CREATE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 非 JSON 就保留原文 */ }
    console.log(`\n=== ${label} ===`)
    console.log(`HTTP ${res.status}  ${Date.now() - started}ms`)
    if (res.ok) {
      console.log(`  video_id=${parsed?.video_id}  status=${parsed?.status}  size=${parsed?.size}  seconds=${parsed?.seconds}`)
    } else {
      console.log(`  body: ${text.slice(0, 600)}`)
    }
    return { ok: res.ok, status: res.status, body: parsed ?? text }
  } catch (error) {
    console.log(`\n=== ${label} ===\n  请求异常：${String(error?.message ?? error)}`)
    return { ok: false, error: String(error?.message ?? error) }
  }
}

const SHORT = '一枚金币在深色石面上缓慢旋转，镜头缓缓推近，柔和轮廓光'

// ---- A. data: URL 直传能否被接受 ----
const dataUrlResult = await createTask('A. keyframe + data:URL', {
  model: 'agnes-video-2.5-flash',
  prompt: SHORT,
  seconds: '4',
  mode: 'keyframe',
  size: '720P',
  aspect_ratio: '16:9',
  first_frame: dataUrl,
})

// ---- B. 公网 HTTP URL 作为对照（example.com 一定存在但不是图片）----
const bogusUrlResult = await createTask('B. keyframe + 普通 https URL（对照：域名存在但不是图片）', {
  model: 'agnes-video-2.5-flash',
  prompt: SHORT,
  seconds: '4',
  mode: 'keyframe',
  size: '720P',
  aspect_ratio: '16:9',
  first_frame: 'https://example.com/nope.png',
})

// ---- C. 免费匿名图床可达性 ----
const HOSTS = [
  {
    id: 'catbox',
    url: 'https://catbox.moe/user/api.php',
    form: () => { const f = new FormData(); f.set('reqtype', 'fileupload'); f.set('fileToUpload', new Blob([buf], { type: 'image/png' }), 'probe.png'); return f },
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
  {
    id: 'litterbox-1h',
    url: 'https://litterbox.catbox.moe/resources/internals/api.php',
    form: () => { const f = new FormData(); f.set('reqtype', 'fileupload'); f.set('time', '1h'); f.set('fileToUpload', new Blob([buf], { type: 'image/png' }), 'probe.png'); return f },
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
  {
    id: '0x0.st',
    url: 'https://0x0.st',
    form: () => { const f = new FormData(); f.set('file', new Blob([buf], { type: 'image/png' }), 'probe.png'); return f },
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
  {
    id: 'tmpfiles.org',
    url: 'https://tmpfiles.org/api/v1/upload',
    form: () => { const f = new FormData(); f.set('file', new Blob([buf], { type: 'image/png' }), 'probe.png'); return f },
    pick: (text) => { try { const j = JSON.parse(text); return j?.data?.url ? String(j.data.url).replace('tmpfiles.org/', 'tmpfiles.org/dl/') : null } catch { return null } },
  },
  {
    id: 'uguu.se',
    url: 'https://uguu.se/upload?output=text',
    form: () => { const f = new FormData(); f.set('files[]', new Blob([buf], { type: 'image/png' }), 'probe.png'); return f },
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
]

const uploads = []
console.log('\n=== C. 免费匿名图床可达性 ===')
for (const host of HOSTS) {
  const started = Date.now()
  try {
    const res = await fetch(host.url, { method: 'POST', body: host.form(), signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    const url = res.ok ? host.pick(text) : null
    console.log(`${host.id.padEnd(14)} HTTP ${res.status}  ${Date.now() - started}ms  ->  ${url ?? text.slice(0, 160).replace(/\s+/g, ' ')}`)
    if (url) uploads.push({ host: host.id, url })
  } catch (error) {
    console.log(`${host.id.padEnd(14)} 异常：${String(error?.message ?? error)}`)
  }
}

// ---- D. 用真图床 URL 建 keyframe 任务（证实「导入本地图片」这条路走得通）----
if (uploads.length > 0) {
  await createTask(`D. keyframe + ${uploads[0].host} 的真实公网 URL`, {
    model: 'agnes-video-2.5-flash',
    prompt: SHORT,
    seconds: '4',
    mode: 'keyframe',
    size: '720P',
    aspect_ratio: '16:9',
    first_frame: uploads[0].url,
  })
} else {
  console.log('\n=== D. 跳过：没有任何图床可用 ===')
}

console.log('\n=== 结论 ===')
console.log(`data: URL 被接受：${dataUrlResult.ok ? '是' : `否（HTTP ${dataUrlResult.status}）`}`)
console.log(`普通（非图片）https URL 被接受：${bogusUrlResult.ok ? '是（说明建任务阶段不校验媒体可访问性）' : `否（HTTP ${bogusUrlResult.status}）`}`)
console.log(`可用图床：${uploads.map((u) => u.host).join(', ') || '无'}`)
process.exit(0)
