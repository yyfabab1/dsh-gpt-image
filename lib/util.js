/**
 * dsh-gpt-image — 通用工具（零依赖，只用 node: 内置模块）。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)))
export const nowIso = () => new Date().toISOString()

export const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex')
export const shortHash = (text, length = 12) => sha256(text).slice(0, Math.max(1, length))

/** 稳定序列化（键排序），用于指纹与模板指纹。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** 读文本并去掉 UTF-8 BOM（记事本/PowerShell 存 UTF8 会带 BOM）。 */
export async function readTextFile(file) {
  const text = await readFile(file, 'utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readTextFile(file))
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file, obj) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** 文件名/目录名安全化（防路径穿越与非法字符）。 */
export function safeSegment(text, fallback = 'image') {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return cleaned || fallback
}

/** 只允许写/读在根目录内（防 ../ 逃逸）。 */
export function resolveInside(rawPath, roots) {
  if (!rawPath) return ''
  const resolved = path.resolve(String(rawPath))
  for (const root of roots) {
    if (!root) continue
    const base = path.resolve(root)
    if (resolved === base || resolved.startsWith(base + path.sep)) return resolved
  }
  return ''
}

/** 同源栅栏：带 Origin 头的跨站请求一律拒绝（防 CSRF 改配置/写 Key）；无 Origin 的本地调用放行。 */
export function isSameOrigin(req) {
  const origin = req?.headers?.origin
  if (!origin) return true
  const host = req?.headers?.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** fetch + 超时；不抛网络异常，用 { ok:false, error } 表达，便于上层退避重试。
 *  传对象 body 会自动 JSON 序列化并补 content-type（fetch 只接受字符串/FormData/Blob/Buffer）。 */
export async function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 120000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, timeoutMs))
  const started = Date.now()
  let payload = body
  let finalHeaders = headers
  const isStreamBody = body == null
    || typeof body === 'string'
    || Buffer.isBuffer(body)
    || body instanceof FormData
    || body instanceof URLSearchParams
    || (typeof Blob !== 'undefined' && body instanceof Blob)
    || body instanceof ArrayBuffer
  if (!isStreamBody && typeof body === 'object') {
    payload = JSON.stringify(body)
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    if (!hasContentType) finalHeaders = { ...headers, 'content-type': 'application/json' }
  }
  try {
    const res = await fetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal })
    const contentType = res.headers.get('content-type') ?? ''
    if (/^(image|audio|video)\//i.test(contentType)) {
      const buffer = Buffer.from(await res.arrayBuffer())
      return { ok: res.ok, status: res.status, buffer, contentType, ms: Date.now() - started }
    }
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { ok: res.ok, status: res.status, text, json, contentType, ms: Date.now() - started }
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''))
    return {
      ok: false,
      status: 0,
      text: '',
      json: undefined,
      error: aborted ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error),
      timedOut: aborted,
      ms: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 二进制下载（图片走这里，避免被当文本读坏）。 */
export async function httpBinary(url, { headers = {}, timeoutMs = 120000 } = {}) {
  const res = await httpRequest(url, { headers, timeoutMs })
  if (!res.ok) return res
  if (res.buffer) return res
  return { ...res, ok: false, error: `响应不是二进制（${res.contentType || 'unknown'}）` }
}

/** 把上游错误压成一行短文本，避免把整页 HTML 灌进模型上下文。 */
export function briefError(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload.slice(0, 400)
  const message = payload?.error?.message ?? payload?.message ?? payload?.error ?? payload?.detail ?? payload?.msg
  if (typeof message === 'string') return message.slice(0, 400)
  try {
    return JSON.stringify(payload).slice(0, 400)
  } catch {
    return String(payload).slice(0, 400)
  }
}

/** 把 baseUrl 归一成候选列表：中转站经常必须带 /v1。 */
export function candidateBases(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return []
  const list = [base]
  if (!/\/v\d+$/i.test(base) && !/\/(api|openai)$/i.test(base)) list.push(`${base}/v1`)
  return list
}

export function joinUrl(base, tail) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(tail || '').replace(/^\/+/, '')}`
}

/** 站点根（协议 + 主机）：`https://host/v1` → `https://host`，用于不在 base 路径下的端点。 */
export function rootOf(base) {
  const text = String(base || '').replace(/\/+$/, '')
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}`
  } catch {
    // 不是合法 URL（或相对路径）时退回原值，交给 joinUrl 处理
    return text
  }
}
