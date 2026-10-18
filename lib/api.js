/**
 * 请求驱动：把 protocol.js 构造出来的请求真正发出去，并处理
 *   - 同步 Images API
 *   - 异步提交 + 轮询（sb2api 那类）
 *   - Responses API 模式（apiMode: "responses"）
 *   - 404 自动补 /v1 重试（中转站最常见的坑）
 * 全程把「实际发出的提示词与参数」回吐给上层，用于可视化留痕。
 */
import {
  DEFAULT_RESULT,
  buildRequest,
  extractImages,
  extractVideos,
  interpolate,
  normalizeProvider,
  providerCapabilities,
  resolveFirstPath,
  resolvePath,
  resolveValue,
} from './protocol.js'
import { briefError, candidateBases, httpBinary, httpRequest, joinUrl, rootOf, sleep } from './util.js'

export function isThrottle(status, payload) {
  if (status === 429 || status === 503) return true
  const text = typeof payload === 'string' ? payload : briefError(payload)
  return /rate ?limit|too many requests|quota|overloaded|繁忙|限流|频率|请求过多|capacity/i.test(text)
}

/**
 * 是否是「重试一下就好」的错误（限流 + 上游瞬时故障）。
 *
 * 与 isThrottle 的区别：isThrottle 只认限流关键词，用于决定「要不要降并发/冷却」；
 * 这里还包括上游瞬时故障（如 Agnes 的 do_request_failed / 网关 5xx / 连接中断），
 * 它们是「再试一次多半能成」，不该被当成永久失败 —— 一次抽风就判死等于白丢一次出图。
 * 注意：与 isThrottle 不同，这里不看 4xx 的语义错误（那类重试也是白试）。
 */
export function isRetryable(status, payload) {
  if (isThrottle(status, payload)) return true
  if (status >= 500) return true
  // status 0 = 网络层失败（超时/DNS/连接被重置）
  if (status === 0) return true
  const text = typeof payload === 'string' ? payload : briefError(payload)
  return /do_request_failed|failed to reach upstream|upstream|bad gateway|gateway time-?out|service unavailable|temporarily unavailable|please retry|try again|connection (reset|refused|closed)|socket hang ?up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|上游|重试|暂时/i.test(text)
}

/** 探测连通性：/models 是否可达（404 也算「服务可达但没暴露 models」）。 */
export async function probe({ profile, provider, timeoutMs = 8000 }) {
  const definition = normalizeProvider(provider ?? { id: profile?.provider ?? 'openai' })
  const bases = candidateBases(definition.baseUrl || profile?.baseUrl)
  if (bases.length === 0) return { ok: false, code: 'NO_BASE_URL', message: '没有可用的 baseUrl' }
  const headers = profile?.apiKey ? { authorization: `${definition.authScheme ?? 'Bearer'} ${profile.apiKey}` } : {}
  let last = null
  for (const base of bases) {
    const res = await httpRequest(joinUrl(base, 'models'), { headers, timeoutMs })
    if (res.ok) {
      const ids = Array.isArray(res.json?.data) ? res.json.data.map((item) => item?.id).filter(Boolean) : []
      return {
        ok: true,
        status: res.status,
        baseUrlUsed: base,
        ms: res.ms,
        models: ids.slice(0, 40),
        ...(base !== bases[0] ? { suggestedBaseUrl: base, note: `原 baseUrl(${bases[0]}) 404，已自动改用 ${base}` } : {}),
      }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'UNAUTHORIZED', status: res.status, baseUrlUsed: base, message: '服务可达，但 Key 无效或无权限', detail: briefError(res.json ?? res.text) }
    }
    last = { res, base }
  }
  if (last?.res?.status === 404) {
    return { ok: true, status: 404, baseUrlUsed: last.base, note: `没找到 /models（已试 ${bases.join(' / ')}），很多中转站不暴露它；只有真正出图才能验证` }
  }
  return { ok: false, code: last?.res?.timedOut ? 'TIMEOUT' : 'HTTP_ERROR', status: last?.res?.status ?? 0, message: last?.res?.error || briefError(last?.res?.json ?? last?.res?.text) }
}

/** 给用户/日志看的请求摘要（密钥永远不进摘要）。 */
export function describeRequest({ request, prompt, params, profile, provider }) {
  return {
    provider: provider?.id ?? profile?.provider,
    baseUrl: request.url.replace(/\/[^/]*$/, ''),
    method: request.method,
    url: request.url,
    contentType: request.contentType,
    prompt,
    params: Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    model: profile?.model,
    isEdit: request.isEdit,
    bodyKeys: request.contentType === 'json' && request.body && typeof request.body === 'object' && !(request.body instanceof FormData)
      ? Object.keys(request.body)
      : undefined,
  }
}

/** 响应式 API 模式（apiMode=responses）：单次请求的 body。 */
function buildResponsesRequest({ profile, params, prompt, inputImages = [], mask }) {
  const bases = candidateBases(profile.baseUrl)
  const isEdit = inputImages.length > 0
  const dataUrls = inputImages.map((buffer) => `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`)
  const input = dataUrls.length === 0
    ? prompt
    : [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...dataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
        ],
      }]
  const tool = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    output_format: params.output_format ?? 'png',
    moderation: params.moderation ?? 'auto',
  }
  if (params.size) tool.size = params.size
  if (params.quality) tool.quality = params.quality
  if (String(params.output_format ?? 'png').toLowerCase() !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }
  if (params.background === 'transparent') tool.background = 'transparent'
  if (mask) tool.input_image_mask = { image_url: `data:image/png;base64,${Buffer.from(mask).toString('base64')}` }
  const body = { model: profile.model, input, tools: [tool], tool_choice: 'required' }
  if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
  return { bases, path: 'responses', url: joinUrl(bases[0], 'responses'), method: 'POST', headers: { 'content-type': 'application/json' }, body }
}

/**
 * 从 Responses 响应里取图：只认 output[].type === 'image_generation_call'，
 * result 可能是裸 base64 字符串，也可能是 { b64_json | base64 | image | data } 对象。
 */
export function extractResponsesImages(payload) {
  const out = []
  const items = Array.isArray(payload?.output) ? payload.output : []
  for (const item of items) {
    if (item?.type !== 'image_generation_call') continue
    const result = item.result
    if (typeof result === 'string' && result.length > 32) out.push({ b64: result, revisedPrompt: item.revised_prompt })
    else if (result && typeof result === 'object') {
      const b64 = result.b64_json ?? result.base64 ?? result.image ?? result.data
      const url = result.url
      if (typeof b64 === 'string' && b64.length > 32) out.push({ b64 })
      else if (typeof url === 'string' && url) out.push({ url })
    }
  }
  if (out.length === 0) {
    for (const item of Array.isArray(payload?.data) ? payload.data : []) {
      if (item?.b64_json) out.push({ b64: item.b64_json })
      else if (item?.url) out.push({ url: item.url })
    }
  }
  return out
}

/** Responses 模式：n>1 时并发发 n 个单张请求（Playground 同样不发 n）。 */
async function runResponses({ profile, params, prompt, inputImages, mask, timeoutMs, emit }) {
  const started = Date.now()
  const n = Math.max(1, Math.min(10, Number(params.n ?? 1) || 1))
  const request = buildResponsesRequest({ profile, params, prompt, inputImages, mask })
  emit('request', { ...describeRequest({ request, prompt, params, profile, provider: { id: profile?.provider ?? 'openai' } }), apiMode: 'responses', parallel: n })
  const shoot = async () => {
    const res = await sendWithBaseFallback({ request, headers: request.headers, body: request.body, timeoutMs })
    if (!res.ok) return failure(res, started)
    const images = extractResponsesImages(res.json)
    if (images.length === 0) return { ok: false, status: res.status, error: 'responses 响应里没有 image_generation_call 结果', payload: briefError(res.json) }
    return { ok: true, images, status: res.status }
  }
  const settled = n === 1 ? [await shoot()] : await Promise.all(Array.from({ length: n }, () => shoot()))
  const images = settled.flatMap((item) => item.images ?? [])
  if (images.length === 0) {
    const first = settled.find((item) => !item.ok) ?? {}
    return { ok: false, ms: Date.now() - started, status: first.status, error: first.error ?? 'responses 出图失败', payload: first.payload, throttled: first.throttled, timedOut: first.timedOut }
  }
  return {
    ok: true,
    images,
    ms: Date.now() - started,
    status: settled[0]?.status,
    apiMode: 'responses',
    request: describeRequest({ request, prompt, params, profile, provider: { id: profile?.provider ?? 'openai' } }),
    partial_failures: settled.filter((item) => !item.ok).length,
  }
}

/**
 * 跑一次出图/改图。
 * @param {number} [opts.retries] 同步接口的瞬时故障重试次数（默认 2；仅重试「没出图」的失败）
 * @returns {Promise<{ok:boolean, images?:Array, ms:number, status?:number, taskId?:string,
 *                    request?:object, error?:string, throttled?:boolean, timedOut?:boolean}>}
 */
export async function runGeneration({
  profile,
  provider,
  prompt,
  params = {},
  inputImages = [],
  mask,
  timeoutMs = 300000,
  waitS = 600,
  pollTimeoutMs,
  pollIntervalMs,
  retries = 2,
  onEvent,
}) {
  const definition = normalizeProvider(provider ?? { id: profile?.provider ?? 'openai' })
  const started = Date.now()
  const emit = (type, data) => {
    try {
      onEvent?.(type, data)
    } catch {
      /* 日志失败不影响出图 */
    }
  }
  const effectivePollTimeout = Number(pollTimeoutMs ?? (waitS > 0 ? waitS * 1000 : 900000))

  if (profile?.apiMode === 'responses') {
    return runResponses({ profile, params, prompt, inputImages, mask, timeoutMs, emit })
  }

  const request = buildRequest({ provider: definition, profile, params, prompt, inputImages, mask })
  emit('request', describeRequest({ request, prompt, params, profile, provider: definition }))

  // 同步接口的瞬时故障重试：上游偶尔抽风（Agnes 的 do_request_failed、网关 5xx、
  // 连接重置）不该让整次出图白费。只在「还没拿到图」时重试，不会重复出图多花钱：
  // 请求失败 = 上游没出图，重试的是这一次，不是额外再来一次。
  const maxAttempts = Math.max(1, Math.min(4, Number(retries ?? 0) + 1))
  let sent = null
  for (let attempt = 1; ; attempt += 1) {
    sent = await sendWithBaseFallback({ request, headers: request.headers, body: request.body, timeoutMs })
    if (sent.ok) break
    const payload = sent.json ?? sent.text
    if (attempt >= maxAttempts || !isRetryable(sent.status, payload)) break
    const delay = Math.min(8000, 700 * 2 ** (attempt - 1))
    emit('retry', { attempt, status: sent.status, delayMs: delay, error: briefError(payload) })
    await sleep(delay)
  }
  if (!sent.ok) return failure(sent, started)

  // 异步：先从提交响应里取 task_id，再轮询
  const submitSpec = request.isEdit ? definition.editSubmit : definition.submit
  const taskId = submitSpec?.taskIdPath ? resolveFirstPath(sent.json, [submitSpec.taskIdPath]) : undefined
  if (definition.poll && taskId) {
    emit('task', { taskId })
    if (Number(waitS) === 0) {
      // 只提交不等待：把 task_id 交出去，之后用 job 工具查/继续等
      return { ok: true, pending: true, taskId, ms: Date.now() - started, status: sent.status, request: describeRequest({ request, prompt, params, profile, provider: definition }) }
    }
    return pollTask({ profile, provider: definition, taskId, started, request: describeRequest({ request, prompt, params, profile, provider: definition }), timeoutMs: effectivePollTimeout, intervalMs: pollIntervalMs, emit })
  }

  const images = extractImages(sent.json, definition.result ?? DEFAULT_RESULT)
  if (images.length === 0) {
    return { ok: false, ms: Date.now() - started, status: sent.status, error: '响应里没有解析到图片（检查 provider 的 result.imageUrlPaths / b64JsonPaths）', payload: briefError(sent.json), request: describeRequest({ request, prompt, params, profile, provider: definition }) }
  }
  return { ok: true, images, ms: Date.now() - started, status: sent.status, taskId, request: describeRequest({ request, prompt, params, profile, provider: definition }) }
}

/** 从视频任务响应里挖出给用户看的元信息（时长/分辨率/进度）。 */
export function videoMeta(payload) {
  if (!payload || typeof payload !== 'object') return {}
  const meta = {}
  if (payload.seconds !== undefined) meta.seconds = String(payload.seconds)
  if (payload.size !== undefined) meta.size = String(payload.size)
  if (payload.progress !== undefined) meta.progress = Number(payload.progress)
  if (payload.video_id !== undefined) meta.video_id = String(payload.video_id)
  if (payload.id !== undefined) meta.task_id = String(payload.id)
  return meta
}

/** 轮询已提交的异步任务（job 工具用；generate 内部也走它）。once=true 时只查一次当前状态。
 *  与 Playground 对齐：首次立即查、之后按 interval（默认 5s，最小 1s）；408/429/5xx 与网络类错误重试。 */
export async function pollTask({ profile, provider, taskId, started = Date.now(), request, timeoutMs = 900000, intervalMs, emit = () => {}, once = false }) {
  const definition = normalizeProvider(provider ?? { id: profile?.provider ?? 'openai' })
  const poll = definition.poll
  if (!poll) return { ok: false, error: `服务商 ${definition.id} 没有轮询配置（不是异步模式）` }
  const bases = candidateBases(definition.baseUrl || profile?.baseUrl)
  const interval = Math.max(1000, Number(intervalMs ?? (Number(poll.intervalSeconds ?? 5) * 1000)))
  const headers = profile?.apiKey ? { authorization: `${definition.authScheme ?? 'Bearer'} ${profile.apiKey}` } : {}
  const deadline = Date.now() + Number(timeoutMs)
  const recoverable = (res) => [408, 429, 500, 502, 503, 504].includes(res.status)
    || res.status >= 500
    || res.timedOut
    || /fetch failed|network|load failed|timeout|abort|连接|断开|中断/i.test(String(res.error ?? ''))
  let lastStatus = 'pending'
  let first = true
  for (;;) {
    if (!once && !first && Date.now() >= deadline) break
    if (!once && !first) await sleep(interval)
    first = false
    const rawPath = String(resolveValue(poll.path, { task_id: taskId, profile }) ?? '')
    // Playground 对任务 id 做 URL 编码，避免特殊字符把路径打断
    // 除 task_id 外还支持 {video_id} / {model} / {address} / {key}：视频接口的查询串用它。
    const encodedId = encodeURIComponent(taskId)
    const substituted = rawPath
      .replace(/\{task_id\}/g, encodedId)
      .replace(/\{taskId\}/g, encodedId)
      .replace(/\{video_id\}/g, encodedId)
      .replace(/\{videoId\}/g, encodedId)
    const path = interpolate(substituted, {
      task_id: taskId, taskId, video_id: taskId, videoId: taskId, profile,
      key: profile?.apiKey, address: profile?.baseUrl, model: profile?.model,
      // 轮询时把任务 id 直接编进查询串（值要做 URL 编码，避免 & 断开参数）
      task_id_encoded: encodedId,
    })
    // rootRelative：轮询端点不在 baseUrl 下（如 Agnes 视频用 https://host/agnesapi?...，
    // 而不是 baseUrl(/v1) 底下的路径）。这时按站点根拼接，去掉 baseUrl 的路径部分。
    const pollUrl = poll.rootRelative ? joinUrl(rootOf(bases[0]), path) : joinUrl(bases[0], path)
    const res = await httpRequest(pollUrl, { method: poll.method ?? 'GET', headers, timeoutMs: 30000 })
    if (!res.ok) {
      if (recoverable(res)) {
        if (once) return { ok: true, pending: true, status: lastStatus, taskId, ms: Date.now() - started, note: `查询失败但可重试：${res.error || res.status}` }
        continue
      }
      return { ok: false, ms: Date.now() - started, status: res.status, taskId, error: res.error || briefError(res.json ?? res.text) }
    }
    const statusValue = poll.statusPaths ? resolveFirstPath(res.json, poll.statusPaths) : resolveFirstPath(res.json, [poll.statusPath ?? 'status'])
    const status = String(statusValue ?? '').toLowerCase()
    lastStatus = status || lastStatus
    emit('poll', { taskId, status: lastStatus, ms: Date.now() - started })
    if ((poll.successValues ?? []).map((value) => value.toLowerCase()).includes(status)) {
      // 视频接口完成时给的是顶层 url，图片给的是 data[].url / b64 —— 按媒体类型分别提取
      const media = definition.media ?? 'image'
      if (media === 'video') {
        const videos = extractVideos(res.json, poll.result ?? definition.videoResult)
        if (videos.length === 0) {
          return { ok: false, ms: Date.now() - started, status: res.status, taskId, media, error: '任务完成但没解析到视频地址', payload: briefError(res.json) }
        }
        return { ok: true, media, videos, images: videos, ms: Date.now() - started, status: res.status, taskId, request, meta: videoMeta(res.json) }
      }
      const images = extractImages(res.json, poll.result ?? definition.result ?? DEFAULT_RESULT)
      if (images.length === 0) return { ok: false, ms: Date.now() - started, status: res.status, taskId, error: '任务完成但没解析到图片', payload: briefError(res.json) }
      return { ok: true, media, images, ms: Date.now() - started, status: res.status, taskId, request }
    }
    if ((poll.failureValues ?? []).map((value) => value.toLowerCase()).includes(status)) {
      const error = poll.errorPath ? resolveFirstPath(res.json, [poll.errorPath]) : undefined
      return { ok: false, ms: Date.now() - started, status: res.status, taskId, error: String(error ?? `任务状态 ${status}`), payload: briefError(res.json) }
    }
    if (once) {
      // 只查一次：还没完成就把当前状态交回去
      return { ok: true, pending: true, status: lastStatus, taskId, ms: Date.now() - started, payload: res.json }
    }
  }
  return { ok: false, ms: Date.now() - started, taskId, status: lastStatus, pending: true, error: `轮询超时（任务状态仍是 ${lastStatus}），可用 job 工具继续等` }
}

/** 发送，并在 404 时自动换下一个候选 base（补 /v1）。 */
async function sendWithBaseFallback({ request, headers, body, timeoutMs }) {
  const bases = request.bases?.length ? request.bases : [request.url.replace(/\/[^/]*$/, '')]
  let last = null
  for (const base of bases) {
    const url = request.path ? joinUrl(base, request.path) : request.url
    const res = await httpRequest(url, { method: request.method, headers, body, timeoutMs })
    if (res.ok) return { ...res, baseUrlUsed: base, url }
    last = { ...res, baseUrlUsed: base, url }
    if (res.status !== 404) return last
  }
  return last
}

function failure(res, started) {
  const payload = res.json ?? res.text
  return {
    ok: false,
    ms: Date.now() - started,
    status: res.status,
    error: res.error || briefError(payload),
    throttled: isThrottle(res.status, payload),
    timedOut: Boolean(res.timedOut),
    upstream: res.status === 400 || res.status === 422 ? briefError(payload) : undefined,
    baseUrlUsed: res.baseUrlUsed,
  }
}

/** 把 {b64|url|buffer} 变成 Buffer。 */
export async function toBuffer(image) {
  if (!image) return null
  if (image.buffer) return image.buffer
  if (image.b64) return Buffer.from(image.b64, 'base64')
  if (image.url) {
    const res = await httpBinary(image.url)
    return res.ok ? res.buffer : null
  }
  return null
}

export { resolvePath }
