/**
 * 探针 2：把「导入本地图片 → 生成视频」这条路彻底钉死。
 *
 * 上一轮只得到两条不确定的结论（队列满 503 挡在前面 / 免费档 429 限流），所以这一轮：
 *   1. 遇到 503（队列满）和 429（限流）就当「没结论」，退避重试 —— 只有 400 / 200 算结论
 *   2. 分别验证两条路：
 *        a) data: URL 直传（本地图片内联，最省事；文档说要公网 URL，但没实测过）
 *        b) 传到 uguu.se 拿公网 URL 再传（上一轮唯一通的图床）
 *   3. 额外确认取回的 URL 是不是真的能被外部访问（我们自己先 GET 一遍）
 *
 * 用法：node scripts/probe-i2v2.mjs [本地图片路径]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ProfileStore } from '../lib/store.js'

const OUTPUT_ROOT = 'D:\\AHC\\aishengtu图片地址'
const SHORT = '一枚金币在深色石面上缓慢旋转，镜头缓缓推近，柔和轮廓光'

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
const buf = readFileSync(sample)
const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
console.log(`样例图片：${sample}（${buf.length} 字节 → data URL ${dataUrl.length} 字符）`)

const profiles = await ProfileStore.load()
const anchor = profiles.profiles.find((p) => /agnes/i.test(p.baseUrl ?? '') && p.apiKey)
if (!anchor) { console.error('找不到 agnes 配置档'); process.exit(1) }
const baseUrl = anchor.baseUrl.replace(/\/+$/, '')
const key = anchor.apiKey
console.log(`baseUrl=${baseUrl}\n`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 建任务，直到拿到一个「有结论」的响应。
 * 503 队列满 / 429 限流 都视为无结论，退避重试。
 */
async function createTask(label, firstFrameValue, { maxAttempts = 8 } = {}) {
  console.log(`\n=== ${label} ===`)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res
    let text = ''
    try {
      res = await fetch(`${baseUrl}/videos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'agnes-video-2.5-flash',
          prompt: SHORT,
          seconds: '4',
          mode: 'keyframe',
          size: '720P',
          aspect_ratio: '16:9',
          first_frame: firstFrameValue,
        }),
        signal: AbortSignal.timeout(180000),
      })
      text = await res.text()
    } catch (error) {
      console.log(`  第 ${attempt} 次：请求异常 ${String(error?.message ?? error)}`)
      await sleep(15000)
      continue
    }

    if (res.status === 503 || res.status === 429) {
      const wait = Math.min(90000, 20000 * attempt)
      console.log(`  第 ${attempt} 次：HTTP ${res.status}（无结论，${Math.round(wait / 1000)}s 后重试）`)
      await sleep(wait)
      continue
    }

    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 保留原文 */ }
    console.log(`  第 ${attempt} 次：HTTP ${res.status}  ->  ${text.slice(0, 400)}`)
    return { conclusive: true, ok: res.ok, status: res.status, body: parsed ?? text }
  }
  console.log('  重试次数用尽，仍未得到有结论的响应')
  return { conclusive: false }
}

// ---- 1. data: URL 到底行不行 ----
const dataUrlResult = await createTask('1. keyframe + data:URL（本地图片内联）', dataUrl)

await sleep(20000)

// ---- 2. 传到 uguu.se 拿公网 URL ----
console.log('\n=== 2. uguu.se 上传 + 回读验证 ===')
let publicUrl = ''
try {
  const form = new FormData()
  form.set('files[]', new Blob([buf], { type: 'image/png' }), 'probe.png')
  const up = await fetch('https://uguu.se/upload?output=text', { method: 'POST', body: form, signal: AbortSignal.timeout(90000) })
  const text = (await up.text()).trim()
  console.log(`  上传 HTTP ${up.status}  ->  ${text.slice(0, 200)}`)
  if (/^https?:\/\//.test(text)) {
    publicUrl = text
    const back = await fetch(publicUrl, { signal: AbortSignal.timeout(60000) })
    const backBuf = Buffer.from(await back.arrayBuffer())
    console.log(`  回读 HTTP ${back.status}  type=${back.headers.get('content-type')}  ${backBuf.length} 字节  （原图 ${buf.length} 字节）`)
  }
} catch (error) {
  console.log(`  上传异常：${String(error?.message ?? error)}`)
}

await sleep(20000)

// ---- 3. 用公网 URL 建任务 ----
let publicUrlResult = { conclusive: false }
if (publicUrl) {
  publicUrlResult = await createTask('3. keyframe + uguu.se 公网 URL', publicUrl)
} else {
  console.log('\n=== 3. 跳过：没有拿到公网 URL ===')
}

console.log('\n========== 结论 ==========')
const judge = (r) => (r.conclusive ? (r.ok ? '接受（200，建了任务）' : `拒绝（HTTP ${r.status}）`) : '无结论（一直被队列满/限流挡住）')
console.log(`data:URL            ${judge(dataUrlResult)}`)
console.log(`uguu.se 公网 URL    ${judge(publicUrlResult)}`)
if (dataUrlResult.conclusive && !dataUrlResult.ok) {
  console.log('→ data: URL 不被接受，「导入本地图片」必须走上传换公网 URL 这条路。')
} else if (dataUrlResult.ok) {
  console.log('→ data: URL 可用：本地图片可以内联直传，不需要图床。')
}
process.exit(0)
