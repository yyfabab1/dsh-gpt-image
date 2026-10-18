/**
 * 把本地文件变成「公网可访问的 URL」。
 *
 * 为什么需要它：Agnes 视频接口的 first_frame / images / audios 要的是**公网 URL**，
 * 不是本地路径、也不保证收 data: URL（文档原文：「所有媒体 URL 都应当可由 Agnes AI
 * 服务公开访问」）。而用户手上的素材全是本地文件 —— 「导入图片生成视频」的卡点就在这里。
 *
 * 于是这里做一条按优先级排的策略链，逐家试到通为止：
 *   0. 本来就是 http(s):// / data: → 原样返回（不做多余动作）
 *   1. 自建/自配的 publicBaseUrl → 走插件自己的 HTTP 服务（有隧道/反代时最稳、不外泄素材）
 *   2. 自配的 uploadEndpoint（自己的图床/对象存储）
 *   3. 内置免费匿名图床（uguu / litterbox / tmpfiles / catbox / 0x0）
 *
 * 两件必须说清的事：
 *   - 上传 = 把素材交给第三方。默认只上传「确实需要公网 URL 才能干活」的那几个文件，
 *     并且把用了哪家、什么时候过期如实回报，不含糊。
 *   - 免费图床都是临时的（小时级）。视频任务通常几分钟内就取完素材，够用；
 *     但如果任务排队很久，链接可能已过期 —— 所以 expiresAt 要带回给调用方。
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from './util.js'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export function mimeFor(file) {
  return MIME_BY_EXT[path.extname(String(file ?? '')).toLowerCase()] ?? 'application/octet-stream'
}

/** 已经是公网 URL（或 data:）就别动它。 */
export function isRemoteUrl(value) {
  return /^(https?:\/\/|data:)/i.test(String(value ?? '').trim())
}

/**
 * 内置免费匿名图床。
 * `field` 是 multipart 的文件字段名；`fields` 是附带的普通字段；
 * `pick` 从响应文本里挑出可用的公网 URL（挑不到就返回 null，视为这家不可用）。
 */
export const UPLOAD_HOSTS = [
  {
    id: 'uguu',
    name: 'uguu.se（约 3 小时后失效）',
    url: 'https://uguu.se/upload?output=text',
    field: 'files[]',
    ttlMinutes: 180,
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
  {
    id: 'litterbox',
    name: 'litterbox（1 小时）',
    url: 'https://litterbox.catbox.moe/resources/internals/api.php',
    field: 'fileToUpload',
    fields: { reqtype: 'fileupload', time: '1h' },
    ttlMinutes: 60,
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
  {
    id: 'tmpfiles',
    name: 'tmpfiles.org（1 小时）',
    url: 'https://tmpfiles.org/api/v1/upload',
    field: 'file',
    ttlMinutes: 60,
    pick: (text) => {
      try {
        const url = JSON.parse(text)?.data?.url
        // tmpfiles 给的是预览页地址，直链要插 /dl/
        return url ? String(url).replace('tmpfiles.org/', 'tmpfiles.org/dl/') : null
      } catch { return null }
    },
  },
  {
    id: 'catbox',
    name: 'catbox（长期）',
    url: 'https://catbox.moe/user/api.php',
    field: 'fileToUpload',
    fields: { reqtype: 'fileupload' },
    ttlMinutes: 0, // 0 = 不过期
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
  {
    id: '0x0',
    name: '0x0.st（长期，上游可能已停收）',
    url: 'https://0x0.st',
    field: 'file',
    ttlMinutes: 0,
    pick: (text) => (/^https?:\/\//.test(text.trim()) ? text.trim() : null),
  },
]

/** 组装 multipart（不依赖任何第三方库）。 */
function buildForm({ host, buffer, mime, filename, extraFields }) {
  const form = new FormData()
  for (const [key, value] of Object.entries({ ...(host.fields ?? {}), ...(extraFields ?? {}) })) {
    form.set(key, String(value))
  }
  form.set(host.field, new Blob([buffer], { type: mime }), filename)
  return form
}

async function uploadTo(host, { buffer, mime, filename, timeoutMs, extraFields }) {
  let response
  try {
    response = await fetch(host.url, {
      method: 'POST',
      body: buildForm({ host, buffer, mime, filename, extraFields }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, host: host.id, error: `连不上：${String(error?.message ?? error)}` }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return { ok: false, host: host.id, status: response.status, error: `HTTP ${response.status}：${text.slice(0, 200).replace(/\s+/g, ' ')}` }
  }
  const url = host.pick(text)
  if (!url) return { ok: false, host: host.id, status: response.status, error: `拿不到 URL：${text.slice(0, 200)}` }
  return { ok: true, host: host.id, hostName: host.name, url, ttlMinutes: host.ttlMinutes ?? 0 }
}

/**
 * 把一个本地文件（或已有的公网 URL）解析成「公网可访问的 URL」。
 *
 * @param {string} value 本地路径 / http(s) URL / data: URL
 * @param {object} options
 * @param {number} [options.maxBytes] 单文件上限，默认 20MB（Agnes 图片单张 <15MB）
 * @param {string[]} [options.only] 只用这几家（调试用）
 * @param {string} [options.endpoint] 自配上传端点（形如 https://…/upload，multipart 字段 file）
 * @param {string} [options.publicBaseUrl] 自建公网前缀；设了它就走插件自己的服务，不交给第三方
 * @param {object} [options.health] 复用花费/健康记录，跳掉刚失败的图床（避免每次都等超时）
 * @param {number} [options.timeoutMs]
 */
export async function resolvePublicUrl(value, options = {}) {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: false, error: '空路径' }
  if (isRemoteUrl(raw)) {
    return { ok: true, url: raw, via: raw.startsWith('data:') ? 'inline-data' : 'as-is', already: true }
  }

  const file = path.resolve(raw)
  let info
  try {
    info = await stat(file)
  } catch {
    return { ok: false, error: `文件不存在：${file}` }
  }
  if (!info.isFile()) return { ok: false, error: `不是文件：${file}` }
  const maxBytes = Number(options.maxBytes ?? 20 * 1024 * 1024)
  if (info.size > maxBytes) {
    return { ok: false, error: `文件 ${(info.size / 1048576).toFixed(1)}MB 超过上限 ${(maxBytes / 1048576).toFixed(0)}MB；Agnes 图片单张要求 <15MB` }
  }
  if (info.size === 0) return { ok: false, error: `文件是空的：${file}` }

  const buffer = await readFile(file)
  const mime = mimeFor(file)
  const filename = path.basename(file)

  // 1. 自建公网前缀：不外泄素材，也不受第三方图床死活影响
  const publicBaseUrl = String(options.publicBaseUrl ?? '').trim().replace(/\/+$/, '')
  if (publicBaseUrl) {
    const url = `${publicBaseUrl}/api/file?path=${encodeURIComponent(file)}`
    const reachable = await verifyReachable(url, options.timeoutMs ?? 20000)
    if (reachable.ok) {
      return { ok: true, url, via: 'publicBaseUrl', localFile: file, verified: true, ttlMinutes: 0 }
    }
    // 自建的不通就继续往下试图床，但把原因带上
    options._baseUrlFailure = `自建公网前缀不可用（${reachable.error}）`
  }

  // 2/3. 自配端点 → 内置图床，按顺序试到通
  const tried = []
  if (options._baseUrlFailure) tried.push({ host: 'publicBaseUrl', error: options._baseUrlFailure })

  if (options.endpoint) {
    const custom = {
      id: 'custom',
      name: '自定义上传端点',
      url: String(options.endpoint),
      field: String(options.field ?? 'file'),
      ttlMinutes: Number(options.ttlMinutes ?? 0),
      pick: (text) => {
        const direct = text.trim()
        if (/^https?:\/\//.test(direct)) return direct
        try {
          const parsed = JSON.parse(text)
          for (const candidate of [parsed?.url, parsed?.data?.url, parsed?.link, parsed?.data?.link]) {
            if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate
          }
        } catch { /* 不是 JSON 就算了 */ }
        return null
      },
    }
    const result = await uploadTo(custom, { buffer, mime, filename, timeoutMs: options.timeoutMs ?? 120000, extraFields: options.extraFields })
    if (result.ok) return { ...result, via: 'custom-endpoint', localFile: file, bytes: info.size }
    tried.push({ host: 'custom', error: result.error })
  }

  const health = options.health ?? {}
  const fresh = Date.now() - 10 * 60 * 1000
  const hosts = options.only?.length
    ? UPLOAD_HOSTS.filter((host) => options.only.includes(host.id))
    : UPLOAD_HOSTS

  // 刚失败过的排到最后，而不是直接删掉：图床经常只是短暂抽风
  const ordered = [...hosts].sort((a, b) => {
    const aBad = health[a.id]?.ok === false && (health[a.id]?.at ?? 0) > fresh ? 1 : 0
    const bBad = health[b.id]?.ok === false && (health[b.id]?.at ?? 0) > fresh ? 1 : 0
    return aBad - bBad
  })

  for (const host of ordered) {
    const result = await uploadTo(host, { buffer, mime, filename, timeoutMs: options.timeoutMs ?? 120000 })
    health[host.id] = { ok: result.ok, at: Date.now(), error: result.error }
    if (result.ok) {
      return { ...result, via: `upload:${host.id}`, localFile: file, bytes: info.size }
    }
    tried.push({ host: host.id, error: result.error })
  }

  return {
    ok: false,
    localFile: file,
    tried,
    error: `本地文件传不出去，拿不到公网 URL：${tried.map((item) => `${item.host}（${item.error}）`).join('；')}`,
    hint: 'Agnes 要的是公网可访问的 URL。可以：① 换个网络环境再试（部分免费图床在境内不可达）；'
      + '② 在 profiles.json 里配 publicBaseUrl（把 DSH 的 HTTP 服务通过隧道/反代暴露出去）或 uploadEndpoint（自己的图床/对象存储）；'
      + '③ 直接给一个已经能公网访问的图片 URL。',
    tried_hosts: tried.map((item) => item.host),
  }
}

/** 批量解析：把 first_frame / last_frame / images / audios 里的本地路径都换成公网 URL。 */
export async function resolveAllPublicUrls(values, options = {}) {
  const list = (Array.isArray(values) ? values : [values]).filter((item) => item !== undefined && item !== null && String(item).trim() !== '')
  const resolved = []
  const failures = []
  for (const value of list) {
    const result = await resolvePublicUrl(value, options)
    if (result.ok) resolved.push(result)
    else failures.push({ input: String(value), ...result })
  }
  return { resolved, failures }
}

/** 自己先 GET 一下，确认链接真的能被外部访问（别把「传上去了」当成「人家取得到」）。 */
export async function verifyReachable(url, timeoutMs = 20000) {
  if (/^data:/i.test(url)) return { ok: true, inline: true }
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    const contentType = response.headers.get('content-type') ?? ''
    // 有些图床返回 200 但内容是「链接已过期」的 HTML —— 这种当失败
    if (/text\/html/i.test(contentType)) return { ok: false, status: response.status, error: '返回的是网页而不是媒体（链接可能已失效）' }
    return { ok: true, status: response.status, contentType }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 记录一次上传结果，供 /api/video 与面板展示「素材传到哪了」。 */
export function describeUpload(result) {
  if (!result) return null
  return {
    input: result.localFile ?? result.url,
    url: result.url,
    via: result.via,
    host: result.hostName ?? result.host,
    bytes: result.bytes,
    ttl_minutes: result.ttlMinutes ?? 0,
    uploaded_at: nowIso(),
  }
}
