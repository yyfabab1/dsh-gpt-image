/**
 * 视频生成：Agnes Video 2.5 Flash 这类「异步建任务 + 轮询 + 下载 mp4」的流程。
 *
 * 与出图（run.js）分开的原因：
 *   - 视频是异步任务：POST /v1/videos 拿 video_id → GET /agnesapi?video_id=... 轮询
 *   - 结果是 mp4 文件（不是图片），落盘扩展名/预览方式都不同
 *   - 常用参数也完全不同（seconds / mode / aspect_ratio；size 固定 720P）
 *
 * 全程复用协议引擎的 provider 模板，所以换一家视频接口只要换模板。
 *
 * 「导入图片生成视频」的关键难点也在这里：Agnes 的 first_frame / images / audios 要的是
 * **公网可访问的 URL**，而用户手上的素材都是本地文件。所以先经过 upload.js 把本地路径
 * 换成公网 URL，再进参数归一化 —— 见 prepareVideoMedia。
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { httpBinary } from './util.js'
import { pollTask, runGeneration } from './api.js'
import { BUILTIN_PROVIDERS, normalizeProvider } from './protocol.js'
import { ensureDir, nowIso, safeSegment } from './util.js'
import { describeUpload, isRemoteUrl, resolvePublicUrl } from './upload.js'

/** 视频参数归一化：Agnes 的秒数必须是字符串 "4".."12"，size 固定 720P。 */
export const VIDEO_SECONDS_MIN = 4
export const VIDEO_SECONDS_MAX = 12

/** 视频模式的中文名，给提示语用。 */
export const VIDEO_MODE_LABELS = {
  text: '文生视频',
  keyframe: '首/尾帧控制（导入图片）',
  reference: '参考图/音频（导入图片）',
}

function hostOf(url) {
  try {
    return new URL(String(url ?? '')).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 找一个「真能生视频」的配置档。
 *
 * 为什么不能直接报错：用户（和面板）很容易把出图的配置档丢给视频工具 ——
 * 直接回一句「provider=agnes 不是视频服务商」等于把问题丢回给用户，而他只是想在
 * 同一个 Agnes Key 上生成一段视频。这里按三步自己解决：
 *   1. 指名的档就是视频档 → 用它
 *   2. 配置里已经有视频档 → 换过去（哪怕用户指错了档），并把「换过了」如实回报
 *   3. 一个视频档都没有，但手上有同域名的图片档（同一个 baseUrl / Key）→ 就地派生一个
 *
 * 派生的档只是**返回值**，不在这里落盘；调用方想持久化就自己 upsert（工具与面板都会）。
 * 这样这个函数保持纯粹、可单测。
 *
 * @returns {{profile:object|null, provider:object|null, reason:string, requested?:string, note?:string, candidates?:string[]}}
 */
export function resolveVideoProfile(profiles, requestedId) {
  const lookup = (providerId) => normalizeProvider(profiles.provider?.(providerId) ?? { id: providerId })
  const isVideo = (profile) => (lookup(profile?.provider).media ?? 'image') === 'video'

  const requested = requestedId ? profiles.get?.(requestedId) : null
  if (requested && isVideo(requested)) {
    return { profile: requested, provider: lookup(requested.provider), reason: 'requested' }
  }

  const candidates = (profiles.profiles ?? []).filter(isVideo)
  // 同是多视频档时优先挑 id 里带 video 的，避免选到某个旁路档
  const picked = candidates.find((item) => /video/i.test(item.id)) ?? candidates[0]
  if (picked) {
    return {
      profile: picked,
      provider: lookup(picked.provider),
      reason: requested ? 'switched' : 'auto',
      requested: requested?.id,
      note: requested
        ? `配置档 ${requested.id} 是出图档（provider=${requested.provider ?? '?'}，不是视频服务商），已自动改用视频配置档 ${picked.id}。`
        : `未指定配置档，已自动使用视频配置档 ${picked.id}。`,
    }
  }

  // 一个视频档都没有：看能不能顺着同一个 Key 就地派生一个
  const anchor = requested ?? profiles.active ?? (profiles.profiles ?? [])[0]
  const anchorHost = hostOf(anchor?.baseUrl)
  if (anchor?.baseUrl && anchor?.apiKey) {
    for (const definition of Object.values(BUILTIN_PROVIDERS)) {
      if ((definition.media ?? 'image') !== 'video') continue
      if (!definition.defaultModel) continue
      // 命中条件：同一个域名，或者这个档自己声明了 videoProvider。
      // 后者是给「中转站 / 自建代理」用的：Agnes 走的是自己的域名，
      // 但代理的域名跟 apihub 不同，光靠域名永远匹配不上。
      const sameHost = Boolean(definition.host) && definition.host.toLowerCase() === anchorHost
      const declared = anchor.videoProvider === definition.id
      if (!sameHost && !declared) continue
      const taken = profiles.get?.(definition.defaultModel)
      const id = taken ? `${definition.defaultModel}-auto` : definition.defaultModel
      return {
        profile: {
          id,
          name: `${definition.name}（自动派生）`,
          provider: definition.id,
          baseUrl: anchor.baseUrl,
          apiKey: anchor.apiKey,
          model: definition.defaultModel,
          apiMode: 'images',
          pricePerImage: 0,
          priceNote: definition.defaultPriceNote ?? '',
          derived: true,
        },
        provider: normalizeProvider(definition),
        reason: 'derived',
        requested: anchor.id,
        note: `你没有配视频配置档；已按 ${anchor.id} 的 baseUrl / Key 自动派生一个（provider=${definition.id}，model=${definition.defaultModel}）`
          + `${declared ? `（依据 ${anchor.id} 上声明的 videoProvider）` : '（依据同一个域名）'}。`,
      }
    }
  }

  return {
    profile: null,
    provider: null,
    reason: 'none',
    requested: requestedId,
    candidates: (profiles.profiles ?? []).map((item) => item.id),
    available_video_providers: Object.values(BUILTIN_PROVIDERS).filter((item) => (item.media ?? 'image') === 'video').map((item) => item.id),
  }
}

/**
 * 把模式用到的媒体字段从「本地路径」换成「公网 URL」。
 *
 * 关键判断：已经是 http(s)/data: 的原样放过；本地路径才需要上传，且**只上传该模式真正
 * 用到的字段** —— 不该为了一个用不到的字段把用户的素材传到第三方图床去。
 *
 * @returns {Promise<{values:object, uploads:Array, failures:Array, notes:string[], remote:number}>}
 */
export async function prepareVideoMedia({ args = {}, mode, provider, settings = {}, health, allowUpload = true }) {
  const constraints = provider?.videoConstraints ?? {}
  // 单个字符串也当「一张」处理：多模态调用方很容易把 images 写成字符串而不是数组，
  // 严格只收数组的话会静默变成「没有参考图」，然后被上游回一句 mode=reference 缺素材。
  const asList = (value, max) => {
    const list = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value])
    return list.slice(0, max)
  }
  const values = {
    first_frame: args.first_frame,
    last_frame: args.last_frame,
    images: asList(args.images, Number(constraints.maxImages ?? 5)),
    audios: asList(args.audios, Number(constraints.maxAudios ?? 3)),
  }
  const uploads = []
  const failures = []
  const notes = []
  let remote = 0

  const slot = {
    keyframe: [['first_frame', 'first_frame'], ['last_frame', 'last_frame']],
    reference: [['images', 'images'], ['audios', 'audios']],
  }[mode] ?? []

  const options = {
    maxBytes: Number(constraints.maxImageBytes ?? 15 * 1024 * 1024),
    publicBaseUrl: settings.publicBaseUrl,
    endpoint: settings.uploadEndpoint,
    field: settings.uploadField,
    timeoutMs: settings.uploadTimeoutMs,
    // 只允许用这几家图床（排障 / 单测用；不传就用全部）
    only: Array.isArray(settings.uploadOnly) ? settings.uploadOnly : undefined,
    health,
  }

  for (const [field] of slot) {
    const raw = values[field]
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    const next = []
    for (const item of list) {
      const text = String(item ?? '').trim()
      if (!text) continue
      if (isRemoteUrl(text)) {
        next.push(text)
        if (!text.startsWith('data:')) remote += 1
        else notes.push(`${field} 用了内联 data: URL —— Agnes 官方要求媒体可公网访问，内联可能取不到；不通就换成本地路径让插件上传。`)
        continue
      }
      if (!allowUpload) {
        failures.push({
          input: text,
          field,
          error: '这是本地路径，但本次调用禁用了上传（upload=false）',
          hint: 'Agnes 要的是公网可访问的 URL。要么允许上传（默认就是允许），要么自己先把文件放到公网再传 URL。',
        })
        continue
      }
      // 顺序上传：图床对并发不友好，而且失败信息要能对应到具体文件
      const result = await resolvePublicUrl(text, options)
      if (result.ok) {
        next.push(result.url)
        uploads.push(describeUpload(result))
        notes.push(`${field}：「${path.basename(text)}」已上传到 ${result.hostName ?? result.via} → ${result.url}${result.ttlMinutes ? `（约 ${result.ttlMinutes} 分钟后失效）` : ''}`)
      } else {
        failures.push({ input: text, field, ...result })
      }
    }
    values[field] = Array.isArray(raw) ? next : (next[0] ?? undefined)
  }

  return { values, uploads, failures, notes, remote }
}


export function normalizeVideoParams({ profile, args = {} }) {
  const provider = normalizeProvider({ id: args.providerId ?? profile?.provider ?? 'agnes-video' })
  const constraints = provider.videoConstraints ?? {}
  const params = {}

  // seconds：接口要字符串，且范围 4..12（超范围会让上游 400，这里先夹住）
  const rawSeconds = args.seconds ?? args.duration ?? constraints.defaultSeconds ?? 5
  const seconds = Math.max(
    Number(constraints.minSeconds ?? VIDEO_SECONDS_MIN),
    Math.min(Number(constraints.maxSeconds ?? VIDEO_SECONDS_MAX), Number(rawSeconds) || 5),
  )
  params.seconds = String(seconds)

  // size：Flash 只支持 720P（其他值上游直接 400）
  params.size = String(args.size || constraints.size || '720P')

  params.mode = String(args.mode || 'text')
  if (args.aspect_ratio) params.aspect_ratio = String(args.aspect_ratio)
  if (args.seed !== undefined && args.seed !== null && args.seed !== '') params.seed = Number(args.seed)

  // mode 专属字段：只有匹配的模式才发，避免上游因「不该出现的字段」报 400
  if (params.mode === 'keyframe') {
    if (args.first_frame) params.first_frame = String(args.first_frame)
    if (args.last_frame) params.last_frame = String(args.last_frame)
  }
  if (params.mode === 'reference') {
    if (Array.isArray(args.images) && args.images.length > 0) {
      params.images = args.images.slice(0, Number(constraints.maxImages ?? 5)).map(String)
    }
    if (Array.isArray(args.audios) && args.audios.length > 0) {
      params.audios = args.audios.slice(0, Number(constraints.maxAudios ?? 3)).map(String)
    }
  }
  return params
}

/** 校验参数，返回错误文本或空数组。让「上游 400」尽量在本地先挡住，别浪费时间与配额。 */
export function validateVideoArgs({ args = {}, params }) {
  const errors = []
  const mode = params.mode
  if (!['text', 'keyframe', 'reference'].includes(mode)) {
    errors.push(`mode 只能是 text / keyframe / reference（收到 ${mode}）`)
  }
  if (mode === 'keyframe' && !params.first_frame && !params.last_frame) {
    errors.push('mode=keyframe 至少要给一张首帧或尾帧（本地图片路径或公网 URL 都行，本地会自动上传）')
  }
  if (mode === 'reference' && !(params.images?.length || params.audios?.length)) {
    errors.push('mode=reference 至少要给一张参考图或一段参考音频（本地文件路径或公网 URL 都行，本地会自动上传）')
  }
  // 到了这里还留着本地路径 = 上传没走通却硬发出去，上游只会回一句「取不到媒体」。
  // 本地挡住，并说清是哪个字段、哪条路径。
  const leftovers = []
  for (const field of ['first_frame', 'last_frame']) {
    const value = params[field]
    if (value && !isRemoteUrl(value)) leftovers.push(`${field}=${value}`)
  }
  for (const field of ['images', 'audios']) {
    for (const value of params[field] ?? []) {
      if (value && !isRemoteUrl(value)) leftovers.push(`${field}[]=${value}`)
    }
  }
  if (leftovers.length > 0) {
    errors.push(`这些还是本地路径，Agnes 取不到（必须是公网 URL）：${leftovers.join('、')}`)
  }
  if (params.size !== '720P') {
    errors.push(`Agnes Video 2.5 Flash 的 size 固定为 "720P"（收到 ${params.size}）；要其他分辨率得换模型`)
  }
  if (args.videos && (Array.isArray(args.videos) ? args.videos.length : true)) {
    errors.push('Agnes Video 2.5 Flash 不支持参考视频输入（videos）')
  }
  return errors
}

/** 是否是「视频队列满」——这是瞬时状态，值得退避重试，不该当成失败。 */
export function isVideoQueueFull(status, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')
  return /video_queue_full|queue is full|队列.*满/i.test(text)
}

/** 是否是免费档的视频限流——这个重试没用，得等额度恢复或升级套餐。 */
export function isVideoRateLimited(status, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')
  return /rate_limit_exceeded|rate limit for free users|Token Plan/i.test(text)
}

/**
 * 生成视频。
 * @returns {Promise<{ok:boolean, videos?:Array, files?:string[], error?:string, taskId?:string, ...}>}
 */
export async function runVideo({
  profiles,
  gallery,
  settings,
  args = {},
  onEvent,
}) {
  // 配置档：指错了档不算错误，自动换到能生视频的那个（或就地派生一个）。
  const resolved = resolveVideoProfile(profiles, args.profile)
  if (!resolved.profile) {
    return {
      ok: false,
      error: args.profile
        ? `找不到可用的视频配置档（你指的是 ${args.profile}，它不是视频服务商）。`
        : '找不到可用的视频配置档。',
      hint: '在 profiles.json 里加一个 provider 为 "agnes-video" 的配置档，或先用 config 工具 import examples/agnes-config.json。'
        + '如果已经配了 Agnes 图片档（同一个 baseUrl / Key），正常情况下会自动派生视频档 —— 派生失败通常是 Key 或 baseUrl 缺失。',
      profile_reason: resolved.reason,
      available_profiles: resolved.candidates,
      available_video_providers: resolved.available_video_providers,
    }
  }
  const profile = resolved.profile
  const providerDef = resolved.provider

  const health = profiles.data?.uploadHealth ?? (profiles.data ? (profiles.data.uploadHealth = {}) : {})
  const mode = String(args.mode || 'text')
  const media = await prepareVideoMedia({
    args: { ...args, mode },
    mode,
    provider: providerDef,
    settings,
    health,
    allowUpload: args.upload !== false && args.no_upload !== true,
  })
  // text 模式带了媒体字段 = 用户以为在用图片，实际会被上游整段丢掉。
  // 这种「静默忽略」最坑人，所以明确说出来该改成哪个 mode。
  if (mode === 'text') {
    const ignored = []
    if (args.first_frame || args.last_frame) ignored.push('first_frame / last_frame（要 mode=keyframe）')
    if (args.images?.length) ignored.push('images（要 mode=reference）')
    if (args.audios?.length) ignored.push('audios（要 mode=reference）')
    if (ignored.length > 0) {
      media.notes.push(
        `注意：mode=text 时这些字段会被 Agnes 直接忽略，等于没用上 —— ${ignored.join('；')}。`
        + '想用导入的图片，请把 mode 改成 keyframe（首/尾帧）或 reference（参考图）。',
      )
    }
  }
  if (media.failures.length > 0) {
    const first = media.failures[0]
    return {
      ok: false,
      media: 'video',
      error: `导入的素材拿不到公网 URL，不能提交给 Agnes：${media.failures.map((item) => `${item.field ?? ''}「${item.input}」`).join('、')}`,
      upload_failed: true,
      failures: media.failures,
      tried_hosts: first.tried_hosts,
      hint: first.hint,
      block_invalid: true,
    }
  }

  const params = normalizeVideoParams({ profile, args: { ...args, ...media.values, mode, providerId: providerDef.id } })
  const errors = validateVideoArgs({ args, params })
  if (errors.length > 0) return { ok: false, error: `视频参数不合法：${errors.join('；')}`, params, block_invalid: true }

  const outputRoot = args.output || settings.outputDir
  const project = safeSegment(args.project || 'video', 'video')
  const name = safeSegment(args.name || `vid_${Date.now().toString(36)}`, 'video')
  const projectDir = path.join(outputRoot, project)
  await ensureDir(projectDir)

  const events = []
  const emit = (type, data) => {
    events.push({ ts: nowIso(), type, ...data })
    try { onEvent?.(type, data) } catch { /* 日志失败不影响出片 */ }
  }

  // 队列满要退避重试：这是 Agnes 免费档很常见的瞬时状态。
  const maxSubmitAttempts = Math.max(1, Math.min(6, Number(args.queue_retries ?? 3) + 1))
  let result = null
  for (let attempt = 1; ; attempt += 1) {
    result = await runGeneration({
      profile,
      provider: providerDef,
      prompt: args.prompt,
      params,
      timeoutMs: Number(args.timeout_ms ?? settings.timeoutMs ?? 300000),
      waitS: args.wait_s === undefined ? 900 : Number(args.wait_s),
      pollIntervalMs: Number(args.poll_interval_ms ?? 0) || undefined,
      retries: 0, // 视频建任务的失败语义不同，重试交给下面这段统一处理
      onEvent: emit,
    })
    if (result.ok || result.pending) break
    const payload = result.upstream ?? result.error ?? ''
    if (attempt >= maxSubmitAttempts || !isVideoQueueFull(result.status, payload)) break
    const delay = Math.min(60_000, 8000 * attempt)
    emit('queue_wait', { attempt, delayMs: delay, status: result.status })
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  const record = {
    kind: 'video',
    media: 'video',
    profile: profile.id,
    provider: providerDef.id,
    model: profile.model,
    name,
    project,
    prompt: args.prompt,
    params,
    ms: result.ms,
    status: result.ok ? (result.pending ? 'pending' : 'ok') : 'failed',
    error: result.error ?? '',
    taskId: result.taskId ?? '',
    images: 0,
    files: [],
    events,
    request: result.request,
    assets: media.uploads,
    mode,
  }

  // 这三样在每条返回路径上都要带上：自动换档 / 派生档说了什么、素材传到了哪。
  const provenance = {
    mode,
    profile_reason: resolved.reason,
    profile_note: resolved.note,
    profile_derived: Boolean(profile.derived),
    assets: media.uploads,
    asset_notes: media.notes,
  }

  if (result.pending) {
    const entry = gallery.add(record)
    return {
      ok: true,
      pending: true,
      media: 'video',
      task_id: result.taskId,
      gallery_id: entry.id,
      params,
      ...provenance,
      message: '已提交视频任务（未等待）；用 video 工具 action=status 带 task_id 查进度',
      request: result.request,
    }
  }
  if (!result.ok) {
    gallery.add(record)
    const blob = result.upstream ?? result.error ?? ''
    const queueFull = isVideoQueueFull(result.status, blob)
    const rateLimited = isVideoRateLimited(result.status, blob)
    return {
      ok: false,
      media: 'video',
      error: result.error,
      status: result.status,
      params,
      queue_full: queueFull,
      rate_limited: rateLimited,
      upstream: result.upstream,
      ...provenance,
      hint: queueFull
        ? 'Agnes 免费档的视频队列当前已满（503 video_queue_full）。实测这个状态可能持续很久（有一次连续 25 分钟、8 次退避重试全部撞在队列满上），'
          + '不是你的配置有问题：等一段时间再试，或调大 queue_retries 让它自己等，或升级 Token Plan。图片接口不受此影响。'
        : rateLimited
          ? 'Agnes 免费档的视频调用已达限流（rate_limit_exceeded）。这不是配置问题：等额度恢复再试，或升级 Token Plan。图片接口通常不受此限制。'
          : '检查配置档的 baseUrl / model / Key；视频模型名应为 agnes-video-2.5-flash，size 必须 720P。',
      request: result.request,
    }
  }

  // 下载 mp4 落盘
  const videos = result.videos ?? result.images ?? []
  const files = []
  for (const [index, item] of videos.entries()) {
    const res = await httpBinary(item.url, { timeoutMs: Number(args.download_timeout_ms ?? 180000) })
    if (!res.ok || !res.buffer) {
      record.error = `下载视频失败：${res.error ?? res.status}`
      continue
    }
    const file = path.join(projectDir, `${name}_${index + 1}.mp4`)
    await writeFile(file, res.buffer)
    files.push(file)
  }

  record.images = files.length
  record.files = files
  record.meta = result.meta ?? {}
  if (files.length === 0) {
    record.status = 'failed'
    record.error = record.error || '视频任务完成但下载失败（地址可能已过期或需要鉴权）'
  }
  const entry = gallery.add(record)

  if (files.length > 0) {
    await writeFile(
      path.join(projectDir, `${name}.json`),
      `${JSON.stringify({
        name, project, kind: 'video', prompt: args.prompt, mode,
        provider: providerDef.id, model: profile.model, params,
        meta: record.meta, files, assets: media.uploads, generatedAt: nowIso(), request: result.request,
      }, null, 2)}\n`,
      'utf8',
    )
  }

  return {
    ok: files.length > 0,
    media: 'video',
    kind: 'video',
    provider: providerDef.id,
    profile: profile.id,
    model: profile.model,
    project,
    output_dir: projectDir,
    videos: videos.map((item) => item.url),
    files,
    params,
    meta: record.meta,
    gallery_id: entry.id,
    ms: result.ms,
    task_id: result.taskId ?? '',
    error: record.error || undefined,
    ...provenance,
  }
}

export { pollTask }
