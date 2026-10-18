/**
 * Playground 协议引擎（仿照 gpt-image2ground 的 provider/profile 模板体系）
 *
 * 核心是一套「声明式接口模板」：
 *   provider = {
 *     id, name,
 *     submit:     { path, method, contentType, query, body, files, taskIdPath },
 *     editSubmit: { ...同上，图生图/局部重绘用 },
 *     poll:       { path, method, intervalSeconds, statusPath, successValues, failureValues, errorPath, result },
 *     result:     { imageUrlPaths: [...], b64JsonPaths: [...] }
 *   }
 * 模板里用占位符引用运行时数据：
 *   $prompt / $profile.model / $profile.baseUrl / $params.size / $params.quality ...
 *   {task_id} / {address} / {key} / {model}（路径与 URL 里的字符串插值）
 * 结果用路径表达式提取：data.*.url / data.*.b64_json / output.*.result ...
 *
 * 这样「换一家中转站」只要换模板，不用改代码 —— 和 Playground 一个思路。
 */
import { briefError, candidateBases, joinUrl } from './util.js'

/** Playground 的默认三件套路径。 */
export const DEFAULT_PATHS = {
  generationPath: 'images/generations',
  editPath: 'images/edits',
  taskPath: 'images/tasks/{task_id}',
}

/** Playground 的默认结果提取规则。 */
export const DEFAULT_RESULT = {
  imageUrlPaths: ['data.*.url'],
  b64JsonPaths: ['data.*.b64_json'],
}

/** 视频结果提取规则：视频接口通常把地址放在顶层 url，或 data.*.url / videos.*.url。 */
export const DEFAULT_VIDEO_RESULT = {
  videoUrlPaths: ['url', 'data.*.url', 'video.url', 'data.*.video_url', 'output.url'],
}

/** 把一个响应体按视频规则提取出 [{url}]。 */
export function extractVideos(payload, result = DEFAULT_VIDEO_RESULT) {
  const out = []
  const seen = new Set()
  for (const expression of result.videoUrlPaths ?? DEFAULT_VIDEO_RESULT.videoUrlPaths) {
    for (const value of resolvePath(payload, expression)) {
      if (typeof value === 'string' && value && !seen.has(value)) {
        seen.add(value)
        out.push({ url: value })
      }
    }
  }
  return out
}

/** 默认请求体模板（与 Playground 的 Ru/om 等价）。 */
export const DEFAULT_BODY = {
  model: '$profile.model',
  prompt: '$prompt',
  size: '$params.size',
  quality: '$params.quality',
  output_format: '$params.output_format',
  moderation: '$params.moderation',
  output_compression: '$params.output_compression',
  n: '$params.n',
  background: '$params.background',
}

/** multipart 文件字段模板（与 Playground 的 Tx 等价）。 */
export const DEFAULT_FILES = [
  { field: 'image[]', source: 'inputImages', array: true },
  { field: 'mask', source: 'mask' },
]

/** 内置服务商模板。 */
export const BUILTIN_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI 兼容 Images API（同步）',
    submit: { path: DEFAULT_PATHS.generationPath, method: 'POST', contentType: 'json', body: DEFAULT_BODY },
    editSubmit: { path: DEFAULT_PATHS.editPath, method: 'POST', contentType: 'multipart', body: DEFAULT_BODY, files: DEFAULT_FILES },
    result: DEFAULT_RESULT,
    supports: { text2image: true, image2image: true, mask: true, async: false, responses: false },
  },
  'sb2api-async': {
    id: 'sb2api-async',
    name: 'sub2api（异步提交 + 轮询）',
    submit: { path: 'images/generations/async', method: 'POST', contentType: 'json', body: DEFAULT_BODY, taskIdPath: 'task_id' },
    editSubmit: { path: 'images/edits/async', method: 'POST', contentType: 'multipart', body: DEFAULT_BODY, files: DEFAULT_FILES, taskIdPath: 'task_id' },
    poll: {
      path: DEFAULT_PATHS.taskPath,
      method: 'GET',
      intervalSeconds: 3,
      // 兼容各家状态字段：status / state
      statusPaths: ['status', 'state'],
      successValues: ['completed', 'succeeded', 'success', 'done'],
      failureValues: ['failed', 'error', 'cancelled', 'canceled'],
      errorPath: 'error.message',
    },
    // 异步任务的结果包在 result 里（Playground 的 sb2api 模板即如此）
    result: { imageUrlPaths: ['result.data.*.url'], b64JsonPaths: ['result.data.*.b64_json'] },
    supports: { text2image: true, image2image: true, mask: true, async: true, responses: false },
  },
  fal: {
    id: 'fal',
    name: 'fal.ai（fal.run）',
    baseUrl: 'https://fal.run',
    endpoint: 'openai/gpt-image-2',
    authScheme: 'Key',
    submit: {
      path: '$profile.endpoint',
      method: 'POST',
      contentType: 'json',
      body: { prompt: '$prompt', image_size: '$params.image_size', num_images: '$params.n', output_format: '$params.output_format' },
    },
    result: { imageUrlPaths: ['images.*.url'], b64JsonPaths: ['images.*.b64_json'] },
    supports: { text2image: true, image2image: false, mask: false, async: false, responses: false },
  },
  /**
   * Agnes 视频（agnes-video-2.5-flash）：异步建任务 + 轮询。
   * 与图片接口差异较大：
   *   - 建任务 POST /v1/videos，返回 id/task_id/video_id
   *   - 查询在站点根 https://host/agnesapi?video_id=..&model_name=..（不在 /v1 下）→ rootRelative
   *   - size 只能是 "720P"，seconds 是字符串 "4".."12"，三种 mode
   */
  'agnes-video': {
    id: 'agnes-video',
    name: 'Agnes 视频（agnes-video-2.5-flash，异步）',
    media: 'video',
    // host + defaultModel 是给「自动派生配置档」用的：用户只配了 Agnes 图片档（同一个
    // baseUrl / 同一个 Key）时，视频工具就据此就地派生一个能用的视频档，而不是甩一句
    // 「这不是视频服务商」把人卡住。见 video.js 的 resolveVideoProfile。
    host: 'apihub.agnes-ai.com',
    defaultModel: 'agnes-video-2.5-flash',
    defaultPriceNote: '视频按秒计价：刊例 $0.025/秒，当前免费。恢复计费时改成 0.025（或按当前汇率）。',
    submit: {
      path: 'videos',
      method: 'POST',
      contentType: 'json',
      taskIdPath: 'video_id',
      body: {
        model: '$profile.model',
        prompt: '$prompt',
        seconds: '$params.seconds',
        mode: '$params.mode',
        size: '$params.size',
        aspect_ratio: '$params.aspect_ratio',
        seed: '$params.seed',
        first_frame: '$params.first_frame',
        last_frame: '$params.last_frame',
        images: '$params.images',
        audios: '$params.audios',
      },
    },
    poll: {
      path: 'agnesapi?video_id={task_id}&model_name={model}',
      method: 'GET',
      intervalSeconds: 2,
      rootRelative: true,
      statusPaths: ['status', 'state'],
      successValues: ['completed', 'succeeded', 'success'],
      failureValues: ['failed', 'error', 'cancelled', 'canceled'],
      errorPath: 'error',
    },
    videoResult: { videoUrlPaths: ['url', 'data.*.url', 'video.url'] },
    // 视频专属约束：Flash 固定 720P、4-12 秒、最多 5 图 3 音、不支持参考视频
    videoConstraints: { size: '720P', minSeconds: 4, maxSeconds: 12, maxImages: 5, maxAudios: 3, allowVideos: false, defaultSeconds: 5 },
    result: { imageUrlPaths: ['url', 'data.*.url'], b64JsonPaths: ['data.*.b64_json'] },
    supports: { text2image: false, image2image: false, mask: false, async: true, responses: false, video: true },
  },
}

const PLACEHOLDER = /^\$([A-Za-z0-9_.]+)$/

function lookup(ctx, expr) {
  const parts = expr.split('.')
  let cursor = ctx
  for (const part of parts) {
    if (cursor == null) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** 路径/URL 里的字符串插值：{task_id} {address} {key} {model}。 */
export function interpolate(text, ctx = {}) {
  return String(text ?? '').replace(/\{([a-z_]+)\}/gi, (whole, key) => {
    const value = lookup(ctx, key)
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * 解析模板值：
 *  - 整串就是一个占位符（"$params.n"）→ 返回原始类型（数字/布尔保留），未定义 → undefined（该字段被丢弃）
 *  - 字符串里含占位符 → 字符串插值
 *  - 数组/对象 → 递归
 */
export function resolveValue(value, ctx = {}) {
  if (typeof value === 'string') {
    const match = value.match(PLACEHOLDER)
    if (match) return lookup(ctx, match[1])
    return interpolate(value, ctx)
  }
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const resolved = resolveValue(item, ctx)
      if (resolved !== undefined) out.push(resolved)
    }
    return out
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveValue(item, ctx)
      // 空数组同样视为「没有值」：像 $inputImages.dataUrls 在文生图时就是 []，
      // 若原样保留会发出 {"image":[]} 这种会被服务商拒掉的请求体。
      if (Array.isArray(resolved) && resolved.length === 0) continue
      if (resolved !== undefined && resolved !== null && resolved !== '') out[key] = resolved
    }
    return out
  }
  return value
}

/**
 * 路径表达式取值：支持 `data.*.url`（通配展开）、`output.0.result`（数字下标）、`task_id`。
 * 返回数组（可能为空）。
 */
export function resolvePath(root, expression) {
  if (!expression) return []
  const steps = String(expression).split('.').filter(Boolean)
  let cursor = [root]
  for (const step of steps) {
    const next = []
    for (const node of cursor) {
      if (node == null) continue
      if (step === '*') {
        if (Array.isArray(node)) next.push(...node)
        else if (typeof node === 'object') next.push(...Object.values(node))
      } else if (Array.isArray(node) && /^\d+$/.test(step)) {
        next.push(node[Number(step)])
      } else if (typeof node === 'object') {
        next.push(node[step])
      }
    }
    cursor = next
  }
  return cursor.filter((value) => value !== undefined && value !== null)
}

/** 按一组路径表达式收集第一个非空结果。 */
export function resolveFirstPath(root, expressions = []) {
  for (const expression of expressions) {
    const [found] = resolvePath(root, expression)
    if (found !== undefined && found !== null && found !== '') return found
  }
  return undefined
}

/** 把结果提取规则应用到一个响应体上，返回 [{b64}|{url}]。 */
export function extractImages(payload, result = DEFAULT_RESULT) {
  const out = []
  for (const expression of result.b64JsonPaths ?? []) {
    for (const value of resolvePath(payload, expression)) {
      if (typeof value === 'string' && value.length > 32) out.push({ b64: value })
    }
  }
  for (const expression of result.imageUrlPaths ?? []) {
    for (const value of resolvePath(payload, expression)) {
      if (typeof value === 'string' && value) out.push({ url: value })
    }
  }
  return out
}

/** 归一化服务商定义：补齐默认路径/结果规则。 */
export function normalizeProvider(definition = {}) {
  const base = BUILTIN_PROVIDERS[definition.id] ?? {}
  const provider = {
    ...base,
    ...definition,
    submit: { ...(base.submit ?? {}), ...(definition.submit ?? {}) },
    editSubmit: definition.editSubmit ?? base.editSubmit,
    poll: definition.poll ? { ...(base.poll ?? {}), ...definition.poll } : base.poll,
    result: { ...DEFAULT_RESULT, ...(base.result ?? {}), ...(definition.result ?? {}) },
  }
  if (provider.editSubmit) {
    provider.editSubmit = {
      files: DEFAULT_FILES,
      ...provider.editSubmit,
    }
  }
  return provider
}

/** 服务商能力（给工具/模型看的）。 */
export function providerCapabilities(provider) {
  const supports = provider.supports ?? {}
  return {
    text2image: supports.text2image !== false,
    image2image: Boolean(provider.editSubmit) || supports.image2image === true,
    // 显式声明 supports.mask === false 时以声明为准：normalizeProvider 会给每个 editSubmit
    // 注入默认 files（含 mask 字段），否则「没有蒙版能力」的服务商也会被报成支持蒙版。
    mask: supports.mask === false
      ? false
      : Boolean(provider.editSubmit?.files?.some((file) => file.field === 'mask')) || supports.mask === true,
    async: Boolean(provider.poll) || supports.async === true,
    responses: supports.responses === true,
  }
}

/**
 * 构造一次请求（不发送），便于单测与「先 dry-run 看请求」。
 * @returns {{url:string, method:string, headers:object, body:any, form?:FormData, baseUrlUsed:string}}
 */
/** 把输入图 buffer 包成 { dataUrl, base64, mime, buffer }，供 $inputImages.dataUrls 等占位符使用。 */
function describeImage(item) {
  if (!item) return null
  const buffer = Buffer.isBuffer(item) ? item : null
  if (!buffer) return null
  const mime = 'image/png'
  const base64 = buffer.toString('base64')
  return { dataUrl: `data:${mime};base64,${base64}`, base64, mime, buffer, byteLength: buffer.length }
}

export function buildRequest({ provider, profile, params = {}, prompt, inputImages = [], mask, taskId, baseUrlOverride }) {
  // $inputImages.dataUrls / $inputImages.base64 / $mask.dataUrl —— 部分服务商（如 Agnes）要求
  // 把参考图以 Data URI 传进 body，而不是 multipart 文件，所以这里同时暴露两种形态。
  const describedImages = inputImages.map(describeImage).filter(Boolean)
  const describedMask = describeImage(mask)
  const ctx = {
    prompt,
    profile,
    params,
    inputImages: Object.assign(describedImages, { dataUrls: describedImages.map((item) => item.dataUrl) }),
    mask: describedMask,
    task_id: taskId,
    taskId,
    video_id: taskId,
    key: profile?.apiKey,
    address: profile?.baseUrl,
    model: profile?.model,
  }
  const isEdit = Boolean(inputImages.length > 0 && provider.editSubmit)
  const spec = isEdit ? provider.editSubmit : provider.submit
  if (!spec) throw new Error(`服务商 ${provider.id} 没有${isEdit ? '图生图' : '文生图'}配置`)
  const bases = candidateBases(baseUrlOverride || profile?.baseUrl || provider.baseUrl)
  if (bases.length === 0) throw new Error('没有可用的 baseUrl')
  const path = interpolate(resolveValue(spec.path ?? DEFAULT_PATHS.generationPath, ctx), ctx)
  const headers = {}
  const authScheme = provider.authScheme ?? 'Bearer'
  if (profile?.apiKey) headers.authorization = `${authScheme} ${profile.apiKey}`
  const contentType = spec.contentType ?? 'json'
  // 与 Playground 对齐的字段裁剪规则：n 只有 >1 才发；output_compression 只在非 png 时有意义
  const trimBody = (target) => {
    if (!target || typeof target !== 'object') return target
    if (Number(target.n) <= 1) delete target.n
    if (String(target.output_format ?? '').toLowerCase() === 'png') delete target.output_compression
    if (profile?.responseFormatB64Json) target.response_format = 'b64_json'
    return target
  }
  let body
  let form
  if (contentType === 'multipart') {
    form = new FormData()
    const resolved = trimBody(resolveValue(spec.body ?? DEFAULT_BODY, ctx))
    for (const [key, value] of Object.entries(resolved)) {
      if (value === undefined || value === null) continue
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
    for (const fileSpec of spec.files ?? DEFAULT_FILES) {
      const value = fileSpec.source === 'mask' ? mask : inputImages
      if (!value) continue
      if (fileSpec.array) {
        // Playground 约定：image[] 每个 part 的文件名是 input-N.<ext>
        for (const [index, item] of (Array.isArray(value) ? value : [value]).entries()) {
          const blob = toBlob(item)
          if (blob) form.append(fileSpec.field, blob, `input-${index + 1}.png`)
        }
      } else {
        // 蒙版固定叫 mask.png
        const blob = toBlob(Array.isArray(value) ? value[0] : value)
        if (blob) form.append(fileSpec.field, blob, `${fileSpec.field}.png`)
      }
    }
    body = form
  } else {
    body = trimBody(resolveValue(spec.body ?? DEFAULT_BODY, ctx))
  }
  const query = spec.query ? resolveValue(spec.query, ctx) : undefined
  return { path, url: joinUrl(bases[0], path), bases, method: spec.method ?? 'POST', headers, body, form, contentType, query, isEdit }
}

function toBlob(item) {
  if (!item) return null
  if (typeof Blob !== 'undefined' && item instanceof Blob) return item
  if (Buffer.isBuffer(item)) return new Blob([item], { type: 'image/png' })
  if (typeof item === 'string') {
    const match = item.match(/^data:([^;]+);base64,(.*)$/)
    if (match) return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] })
  }
  return null
}

export { briefError }
