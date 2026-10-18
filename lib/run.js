/**
 * 出图编排：解析配置档 → 读入参考图/蒙版 → 调 API → 落盘 → 写清单 → 记历史。
 * 目录约定（「什么项目的什么图」）：
 *   <输出根>/<项目>/<素材名>_<序号>.<ext>
 *   <输出根>/<项目>/<素材名>.json        单张的完整参数（提示词/模型/参数）
 *   <输出根>/<项目>/图片清单.md          该项目下所有图与提示词的对照表
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pollTask, runGeneration, toBuffer } from './api.js'
import { assetFingerprint } from './fingerprint.js'
import { loadPromptPack, composePrompt } from './promptpack.js'
import { labelForAsset, nameFromPrompt } from './label.js'
import { BUILTIN_PROVIDERS, normalizeProvider } from './protocol.js'
import { ensureDir, nowIso, safeSegment } from './util.js'

export { BUILTIN_PROVIDERS }

export function resolveProvider(profiles, profile) {
  const custom = profiles.provider(profile.provider)
  if (custom) return normalizeProvider(custom)
  return normalizeProvider({ id: profile.provider ?? 'openai' })
}

export function sniffExt(buffer, fallback = 'png') {
  if (!buffer || buffer.length < 12) return fallback
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'gif'
  return fallback
}

/** 把参数对象清干净：去掉 undefined/空串，保留数字与布尔。 */
export function cleanParams(params = {}) {
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/** 收集一次运行的参数（profile 默认 + 本次覆盖 + extra 透传），并按接口惯例清理。 */
export function collectParams({ profile, args }) {
  const params = cleanParams({
    size: args.size,
    ratio: args.ratio,
    quality: args.quality,
    background: args.background,
    output_format: args.output_format ?? 'png',
    output_compression: args.output_compression,
    moderation: args.moderation ?? 'auto',
    n: args.n,
    ...(args.extra ?? {}),
  })
  if (params.n === undefined) params.n = 1
  params.n = Math.max(1, Math.min(10, Number(params.n) || 1))
  // png 没有压缩率这回事（Playground 同样只在非 png 时发 output_compression）
  if (String(params.output_format).toLowerCase() === 'png') delete params.output_compression
  // 档位式 size 与 ratio 配合才有意义；给了精确尺寸（1024x1024）时 ratio 是多余的，
  // 但 Agnes 这类接口两者都收，所以只在明确给档位时才保留（含 ':' 的才是宽高比）。
  if (params.ratio !== undefined && !/^\d+:\d+$/.test(String(params.ratio))) delete params.ratio
  return params
}

async function readInputImages(paths = []) {
  const buffers = []
  for (const item of paths) {
    if (!item) continue
    if (Buffer.isBuffer(item)) {
      buffers.push(item)
      continue
    }
    const text = String(item)
    if (text.startsWith('data:')) {
      const match = text.match(/^data:([^;]+);base64,(.*)$/)
      if (match) buffers.push(Buffer.from(match[2], 'base64'))
      continue
    }
    buffers.push(await readFile(text))
  }
  return buffers
}

/** 写「图片清单.md」：什么项目、哪张图、提示词是什么。 */
export async function writeImageIndex({ projectDir, project, records, meta = {} }) {
  const rows = records.slice(0, 500)
  const lines = [
    `# 图片清单 · ${project}`,
    '',
    `> 共 ${rows.length} 条 ｜ 更新 ${nowIso()}${meta.provider ? ` ｜ 服务商 \`${meta.provider}\`` : ''}${meta.model ? ` / 模型 \`${meta.model}\`` : ''}`,
    '',
    '| 素材名 | 文件 | 尺寸 | 质量 | 耗时 | 提示词 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const record of rows) {
    const files = (record.files ?? []).map((file) => path.relative(projectDir, file).replace(/\\/g, '/')).join('<br>') || '-'
    const prompt = String(record.prompt ?? '').replace(/\|/g, '\\|').slice(0, 200)
    lines.push(`| ${record.name ?? '-'} | ${files} | ${record.params?.size ?? '-'} | ${record.params?.quality ?? '-'} | ${record.ms ? `${(record.ms / 1000).toFixed(1)}s` : '-'} | ${prompt} |`)
  }
  lines.push('')
  await writeFile(path.join(projectDir, '图片清单.md'), `${lines.join('\n')}\n`, 'utf8')
  return path.join(projectDir, '图片清单.md')
}

/** 把一批「已经拿到的图片数据」落盘 + 记账（异步任务查回来时用）。 */
export async function persistImages({
  gallery,
  outputRoot,
  project = 'images',
  name = 'image',
  images = [],
  prompt = '',
  profileId = '',
  providerId = '',
  model = '',
  params = {},
  ms = 0,
  kind = 'generate',
}) {
  const safeProject = safeSegment(project, 'images')
  const fileName = safeSegment(name, 'image')
  const projectDir = path.join(outputRoot, safeProject)
  await ensureDir(projectDir)
  const buffers = []
  for (const image of images) {
    const buffer = await toBuffer(image)
    if (buffer && buffer.length > 0) buffers.push(buffer)
  }
  const files = []
  for (const [index, buffer] of buffers.entries()) {
    const file = path.join(projectDir, `${fileName}_${index + 1}.${sniffExt(buffer)}`)
    await writeFile(file, buffer)
    files.push(file)
  }
  const record = {
    kind,
    profile: profileId,
    provider: providerId,
    model,
    name: fileName,
    project: safeProject,
    prompt,
    params,
    ms,
    status: files.length > 0 ? 'ok' : 'failed',
    error: files.length > 0 ? '' : '没有可用的图片数据',
    images: files.length,
    files,
  }
  const entry = gallery.add(record)
  const projectRecords = gallery.list({ limit: 500 }).filter((item) => item.project === safeProject)
  const indexFile = await writeImageIndex({ projectDir, project: safeProject, records: projectRecords, meta: { provider: providerId, model } }).catch(() => '')
  return { gallery_id: entry.id, output_dir: projectDir, images: files.length, files, index_file: indexFile }
}

/**
 * 出图/改图主流程。
 * @param {{profiles:import('./store.js').ProfileStore, gallery:import('./store.js').Gallery,
 *          settings:object, args:object}} params
 */
export async function runImage({ profiles, gallery, settings, args = {} }) {
  const kind = args.images?.length || args.image ? 'edit' : 'generate'
  const profile = profiles.get(args.profile)
  if (!profile) {
    return { ok: false, error: `找不到配置档 ${args.profile ?? ''}；现有：${profiles.profiles.map((item) => item.id).join(', ')}` }
  }
  const definition = resolveProvider(profiles, profile)
  const capabilities = (await import('./protocol.js')).providerCapabilities(definition)
  if (kind === 'edit' && !capabilities.image2image) {
    return { ok: false, error: `服务商 ${definition.id} 不支持图生图/局部重绘（没有 editSubmit 配置）` }
  }
  // 蒙版要显式拒绝，不能"悄悄忽略"：Agnes 这类接口没有 mask 参数，
  // 传了蒙版还照常出图的话，用户会以为重绘生效了，实际整张重画。
  if (args.mask && !capabilities.mask) {
    return {
      ok: false,
      error: `服务商 ${definition.id} 不支持蒙版（局部重绘）：它没有 mask 参数。已拒绝执行，不浪费一次出图。`,
      hint: `改用支持蒙版的配置档（该服务商 supports.mask 非 false），或改走整图重绘（不传 mask，用提示词描述要改的部分）。`,
      provider: definition.id,
    }
  }

  // 要求像素化时，自动把「网格约束」补进提示词。
  // 为什么要在**生成阶段**做这件事：实测 AI 的「像素风」图块大小并不一致
  // （precision 只有 0.28~0.46），后处理只能尽力还原；而把「正好 N 列 N 行、
  // 每个像素等大、硬边、无抗锯齿」写进提示词，能直接提高一次就出真像素的概率。
  // 这是"让以后像素都是真像素"最有效的一步 —— 后处理只是兜底。
  let prompt = args.prompt
  let pixelPromptAdded = ''
  if (args.pixel && args.pixel !== false && args.pixel_prompt !== false) {
    const { pixelPromptSuffix } = await import('./prompts.js')
    pixelPromptAdded = pixelPromptSuffix(args.pixel, { existingPrompt: args.prompt ?? '' })
    if (pixelPromptAdded) prompt = `${args.prompt ?? ''}${args.prompt ? '. ' : ''}${pixelPromptAdded}`
  }

  // 项目提示词包：把「这个项目长什么样」自动拼进每一句提示词。
  // 这是统一画风最有效的一招 —— 用户只写「火焰塔图标」，包负责补风格/构图/约束。
  // 项目里没配包时**什么都不做**（纯加法，不改变现有行为）。
  let packInfo = null
  if (args.prompt_pack !== false) {
    const packProject = safeSegment(args.project || 'images', 'images')
    const pack = await loadPromptPack({
      outputDir: settings.outputDir,
      project: packProject,
      dataDir: settings.dataDir,
    }).catch(() => null)
    if (pack) {
      const composed = composePrompt({
        pack,
        prompt,
        kind: args.kind ?? '',
        character: args.character ?? '',
      })
      if (composed.used) {
        prompt = composed.prompt
        packInfo = {
          used: true,
          name: pack.name || packProject,
          file: pack.source?.file,
          character: args.character ?? '',
          prompt_chars: prompt.length,
          notes: composed.notes,
        }
      } else {
        packInfo = { used: false, name: pack.name || packProject, file: pack.source?.file, notes: composed.notes }
      }
    }
  }

  const params = collectParams({ profile, args })
  // 尺寸守卫：尺寸不合法时上游要么 400（白花一次），要么**默默给你裁过的图**（更糟）。
  // 在本地挡住/吸附，是纯赚。
  {
    const { checkImageSize } = await import('./sizeguard.js')
    const guard = checkImageSize(params.size)
    if (!guard.ok) {
      if (guard.fixed) {
        params.size_before_fix = params.size
        params.size = guard.fixed
      } else {
        return {
          ok: false,
          error: `尺寸不合法：${guard.errors.join('；')}`,
          hint: guard.kind === 'pixel'
            ? 'gpt-image-2 的约束：两边都是 16 的倍数、最长边 <3840、比例 ≤3:1、总像素 655,360~8,294,400。'
            : '检查 size 写法（精确尺寸用 宽x高，档位用 1K/2K）。',
          size_guard: guard,
        }
      }
    }
    if (guard.warnings?.length) params.size_warnings = guard.warnings
  }
  const inputPaths = args.images ?? (args.image ? [args.image] : [])
  if (inputPaths.length > 16) {
    return { ok: false, error: `参考图最多 16 张（收到 ${inputPaths.length} 张）` }
  }
  let inputImages = []
  let mask
  try {
    inputImages = await readInputImages(inputPaths)
    if (args.mask) mask = (await readInputImages([args.mask]))[0]
  } catch (error) {
    return { ok: false, error: `读参考图失败：${error.message}` }
  }

  const outputRoot = args.output || settings.outputDir
  const project = safeSegment(args.project || 'images', 'images')
  // 硬规定：每个素材必须有名字 —— 没给就从提示词里提炼一个，绝不留空（否则画面里的标签也没内容）
  const name = safeSegment(args.name || nameFromPrompt(args.prompt, `img_${Date.now().toString(36)}`), 'image')
  const projectDir = path.join(outputRoot, project)
  await ensureDir(projectDir)

  const events = []
  const result = await runGeneration({
    profile,
    provider: definition,
    prompt,
    params,
    inputImages,
    mask,
    waitS: args.wait_s === undefined ? 600 : Number(args.wait_s),
    timeoutMs: Number(args.timeout_ms ?? settings.timeoutMs ?? 300000),
    // 瞬时故障重试：只重试「上游没出图」的失败，不会重复出图多花钱
    retries: args.retries === undefined ? 2 : Math.max(0, Math.min(4, Number(args.retries) || 0)),
    onEvent: (type, data) => events.push({ ts: nowIso(), type, ...data }),
  })

  const record = {
    kind,
    profile: profile.id,
    provider: definition.id,
    model: profile.model,
    apiMode: profile.apiMode ?? 'images',
    name,
    project,
    prompt,
    params,
    // 指纹：批量去重用（同配置档+模型+提示词+尺寸+宽高比+质量+类型 = 同一张图）
    fingerprint: assetFingerprint({
      profileId: profile.id,
      model: profile.model,
      prompt: prompt ?? '',
      size: params.size ?? '',
      ratio: params.ratio ?? '',
      quality: params.quality ?? '',
      kind,
    }),
    // 记下"为了像素画追加了什么网格约束"—— 出图结果要能追溯，否则
    // 用户看到 prompt 变了会以为被改了提示词（其实是为了出真像素主动补的）
    pixel_prompt_added: pixelPromptAdded || '',
    // 用了哪个项目的提示词包（可追溯：看到 prompt 跟原文不一样时，能查出是谁补的）
    prompt_pack: packInfo,
    inputImages: inputPaths.filter((item) => typeof item === 'string'),
    mask: args.mask ?? '',
    ms: result.ms,
    status: result.ok ? (result.pending ? 'pending' : 'ok') : 'failed',
    error: result.error ?? '',
    taskId: result.taskId ?? '',
    images: 0,
    files: [],
    events,
    request: result.request,
  }

  if (result.pending) {
    const entry = gallery.add(record)
    return { ok: true, pending: true, task_id: result.taskId, gallery_id: entry.id, message: '已提交异步任务（未等待）；用 job 工具带 task_id 查结果', request: result.request }
  }

  if (!result.ok) {
    record.error = result.error ?? 'unknown error'
    gallery.add(record)
    return {
      ok: false,
      error: result.error,
      status: result.status,
      throttled: result.throttled,
      timed_out: result.timedOut,
      upstream: result.upstream,
      request: result.request,
      hint: '检查配置档的 baseUrl/model/Key，或换一个 provider（含 /v1 与否已自动兼容）。',
    }
  }

  const files = []
  const buffers = []
  for (const image of result.images) {
    const buffer = await toBuffer(image)
    if (buffer && buffer.length > 0) buffers.push(buffer)
  }
  for (const [index, buffer] of buffers.entries()) {
    const ext = args.output_format && /^(png|jpe?g|webp)$/i.test(args.output_format) ? args.output_format.replace('jpeg', 'jpg') : sniffExt(buffer)
    const file = path.join(projectDir, `${name}_${index + 1}.${ext}`)
    await writeFile(file, buffer)
    files.push(file)
  }

  // L5：生成完成即触发后处理（A1），不等审核 —— 技术毛病在入库前就修完。
  // 这里只做**确定性**的像素修复（去毛边/抠背景/裁留白/锐化/尺寸归一），
  // 不碰审美判断。产物写成 `<name>_N.post.png`，**不覆盖原图**（原图永远留着）。
  const postprocessed = []
  const postprocessErrors = []
  if (files.length > 0 && args.auto_postprocess !== false) {
    // pixel 参数只是 spec.pixel 的语法糖：让调用方能直接写 pixel:{width:32}，
    // 不用去套一层 spec（毕竟「我要像素画」是最常说的那句话）
    const postSpec = { ...(args.spec ?? {}) }
    if (args.pixel !== undefined) postSpec.pixel = args.pixel
    const specArg = Object.keys(postSpec).length > 0 ? postSpec : null
    for (const file of files) {
      try {
        const done = await postprocessGenerated({ file, name, spec: specArg, expectations: args.expectations ?? null })
        if (done?.ok && done.file) postprocessed.push(done.file)
        else if (done && done.ok === false) postprocessErrors.push({ file: path.basename(file), error: done.error ?? '后处理失败' })
      } catch (error) {
        postprocessErrors.push({ file: path.basename(file), error: String(error?.message ?? error) })
      }
    }
  }

  record.images = files.length
  record.files = files
  record.postprocessed = postprocessed
  record.postprocess_errors = postprocessErrors
  // 硬规定：每张产出都配一张「画面内带素材名」的预览图（干净图保持原样给游戏用）
  // 硬规定不允许"悄悄没做"：打标签失败也要记下来，让上层明确报出来。
  const labeled = []
  const labelErrors = []
  for (const file of files) {
    const preview = await labelForAsset({ file, name, project, size: String(params.size ?? '') })
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
    if (preview.ok) labeled.push(preview.file)
    else labelErrors.push({ file: path.basename(file), error: preview.error })
  }
  record.labeled = labeled
  record.label_errors = labelErrors
  if (files.length === 0) {
    record.status = 'failed'
    record.error = record.error || 'API 返回成功但没有任何可用图片数据'
  }
  const entry = gallery.add(record)

  // 单张参数 + 项目清单（人看一眼就知道哪张图是什么）
  if (files.length > 0) {
    await writeFile(path.join(projectDir, `${name}.json`), `${JSON.stringify({
      name,
      project,
      prompt,
      provider: definition.id,
      model: profile.model,
      apiMode: profile.apiMode ?? 'images',
      params,
      kind,
      inputImages: record.inputImages,
      mask: record.mask,
      files,
      generatedAt: nowIso(),
      request: result.request,
    }, null, 2)}\n`, 'utf8')
  }
  const projectRecords = gallery.list({ limit: 500 }).filter((item) => item.project === project)
  const indexFile = await writeImageIndex({ projectDir, project, records: projectRecords, meta: { provider: definition.id, model: profile.model } }).catch(() => '')

  return {
    ok: files.length > 0,
    kind,
    provider: definition.id,
    profile: profile.id,
    model: profile.model,
    project,
    output_dir: projectDir,
    images: files.length,
    files,
    // 硬规定产物：画面内印着素材名的预览图（面板/侧栏缩略图用它）
    labeled,
    ...(labelErrors.length > 0
      ? { label_warning: `有 ${labelErrors.length} 张没能生成带名字的预览图（硬规定未完全满足）：${labelErrors.map((item) => item.file).join('、')}`, label_errors: labelErrors }
      : {}),
    index_file: indexFile,
    gallery_id: entry.id,
    ms: result.ms,
    task_id: result.taskId ?? '',
    request: result.request,
    board_url: `${(process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '')}/gpt-image`,
  }
}

export { pollTask }

/**
 * L5：出图后的自动后处理。
 *
 * 为什么在**生成后立刻**做、不等审核：
 *   去毛边/抠背景/裁留白/锐化/尺寸归一都是**确定性**的像素修复（不是审美判断），
 *   越早做越好 —— 后面所有人（审核视图、对比视图、装机）看到的都是修过的图，
 *   而不是"带着毛边和留白、等审核时才发现不对"的半成品。
 *
 * 安全设计：
 *   - **不覆盖原图**：产物写 `.post.png`，原图永远留着（出了事能回退、能对比）
 *   - **失败不阻断**：后处理挂了不影响出图结果，只是记进 postprocess_errors
 *   - **可关**：args.auto_postprocess === false 时不跑
 *
 * @param {{file:string, name:string, project:string, spec?:object, expectations?:object}} params
 */
export async function postprocessGenerated({ file, name = '', spec = null, expectations = null } = {}) {
  const { applySpecFixes, resolveSpec } = await import('./spec.js')
  const buffer = await readFile(file).catch(() => null)
  if (!buffer) return { ok: false, error: '读不到刚生成的图' }
  const resolved = resolveSpec({
    kind: 'icon',
    name,
    fileSpec: spec,
    expectation: expectations?.[name] ?? null,
  })
  const fixed = applySpecFixes({ buffer, spec: resolved })
  if (!fixed.ok) return { ok: false, error: fixed.error }
  const target = `${file.replace(/\.[a-z0-9]+$/i, '')}.post.png`
  await writeFile(target, fixed.buffer)
  return {
    ok: true,
    file: target,
    applied: fixed.applied,
    skipped: fixed.skipped,
    pixel: fixed.pixel,
    size: `${fixed.width}×${fixed.height}`,
    note: `后处理产物写在 ${target}（**没有覆盖原图**）。`,
  }
}
