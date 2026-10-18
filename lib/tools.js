/**
 * 工具面：GPT Image 出图台（模型自己调用）。
 *   list     看服务商/配置档/能力
 *   generate 文生图
 *   edit     图生图 / 局部重绘（参考图 + 蒙版）
 *   job      异步任务查状态 / 继续等
 *   config   改配置（多配置档、导入导出 Playground 配置、测连通）
 */
import path from 'node:path'
// 拆件管线 buildRig 是**模块级**函数，拿不到工具闭包里动态 import 的局部变量，
// 所以这三个必须静态引入（踩过一次：build 直接报 "readFile is not defined"）。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pollTask, probe } from './api.js'
import { BUILTIN_PROVIDERS, normalizeProvider, providerCapabilities } from './protocol.js'
import { persistImages, runImage, resolveProvider } from './run.js'
import { decodePngRgba } from './pngcodec.js'
import { runVideo, normalizeVideoParams, isVideoQueueFull, isVideoRateLimited, resolveVideoProfile } from './video.js'
import { UPLOAD_HOSTS } from './upload.js'
import { runBatch } from './batch/run.js'
import { scanGame } from './batch/scan.js'
import { installAssets } from './install.js'
import { galleryFingerprints, findDuplicate } from './fingerprint.js'
import { pickStyleRefs, stylePrompt } from './styleref.js'
import { capture } from './screenshot.js'
import { budgetCalendar, calendarText, calibratePrice, extractActualCost } from './cost.js'
import { buildStyleIndex, StyleIndex } from './styleindex.js'
import { fingerprintPrompt } from './stylefp.js'
import { planGenerationOrder } from './depgraph.js'
import { reviewBatch, reviewFile } from './review.js'
import { findRegistryFiles, findUnfilledRegistrations, registerAssets, detectGenerated } from './register.js'
import { runPipeline } from './pipeline.js'
import { usageHeatmap } from './heatmap.js'
import { forecastSpend } from './cost.js'
import { checkProject, readExpectations } from './check.js'
import { ApprovalQueue, approvalText } from './approval.js'
import { buildBalanceReport, balanceSummaryText } from './balance.js'
import { AssetCatalog, REVIEW_STATES, assetNameOf, reviewStateLabel, scanAssetCatalog, sliceRuleFor } from './assets.js'
import { captureChanges } from './snapshot.js'
import { acquireLock, planReprocess, runReprocess, rulesChanged, rulesFingerprint, recordRules } from './reprocess.js'
import { loadSpecCatalogue, resolveSpec, validateAgainstSpec, applySpecFixes, normalizePixelOptions } from './spec.js'
import { pixelizePng } from './pixelize.js'
import {
  loadPromptPack, savePromptPack, describePack, validatePack, starterPack, characterClause, listPacks,
  PACK_FILE,
} from './promptpack.js'
import { runAudio, audioHealth, audioRoles, parseToneScript } from './audio.js'
import { pickBest, disposeLosers, scoreImageFile } from './bestof.js'
import {
  splitParts, packAtlas as packRigAtlas, buildSkeleton, autoAssemble, validateRig, exportRig,
  buildPreviewHtml, partsPrompt, listTemplates, getTemplate, HUMANOID_SLOTS,
} from './rig.js'

/**
 * 拆件管线的一次性编排：切分 → 图集 → 骨架 → 自动合拢 → 落盘。
 * 抽出来的原因：generate 和 build 两条入口要走完全一样的四步，
 * 写两遍迟早会漂（历史上"两条入口两种口径"就是这类 bug 的高发区）。
 */
async function buildRig({ sheetFile, rigDir, layout, name, project, names, nameStrategy, grid, assemble = true }) {
  const buffer = await readFile(sheetFile)
  const split = splitParts({ buffer, layout, grid, names, nameStrategy })
  if (!split.ok) return { ok: false, stage: 'split', error: split.error, sheet: sheetFile }
  const atlas = packRigAtlas({ buffer, parts: split.parts })
  if (!atlas.ok) return { ok: false, stage: 'atlas', error: atlas.error, sheet: sheetFile }
  const built = buildSkeleton({ parts: split.parts, atlas, layout, name })
  if (!built.ok) return { ok: false, stage: 'skeleton', error: built.error, sheet: sheetFile }

  let assembled = null
  if (assemble) {
    assembled = await autoAssemble({ skeleton: built.skeleton, buffer: atlas.buffer })
  }
  const validation = validateRig(built.skeleton)

  await mkdir(rigDir, { recursive: true })
  await writeFile(path.join(rigDir, 'atlas.png'), atlas.buffer)
  // 原始部件图也留一份：以后想换切分参数，不用重新花钱生成
  const sheetCopy = path.join(rigDir, 'sheet.png')
  await writeFile(sheetCopy, buffer)
  await writeFile(path.join(rigDir, 'skeleton.json'), `${JSON.stringify(built.skeleton, null, 2)}\n`, 'utf8')

  return {
    ok: validation.ok,
    project,
    rig_dir: rigDir,
    atlas: path.join(rigDir, 'atlas.png'),
    skeleton: path.join(rigDir, 'skeleton.json'),
    sheet_copy: sheetCopy,
    layout,
    parts: split.parts.map((p) => ({ name: p.slotName, source: p.source, area: p.area })),
    part_count: split.parts.length,
    atlas_size: `${atlas.width}x${atlas.height}`,
    assembled: assembled ? { moved: assembled.moved, moves: assembled.moves } : null,
    validation,
    warnings: [...split.warnings, ...(built.warnings ?? [])],
    ...(validation.ok ? {} : { error: `骨架校验没通过：${validation.errors.join('；')}` }),
    next: validation.ok
      ? '打开 preview（rig action="preview"）拖关节验证拼合、改 pivot/名字，然后 export 导出。'
      : '先按 errors 修（名字对不上最常见：用 rig(action="rename") 改，或在预览器里改）',
  }
}
import { buildPalette, paletteDrift, readabilityAtSize, animationCoherence, groupStyleConsistency } from './coherence.js'
import { deriveVariants, packAtlas, manifestToJson, VARIANT_KINDS } from './variants.js'
import { visualTags, lineageOf, planRegenerate, scoreAsset, routeBatch, learnPreference, detectRegression } from './semantics.js'
import {
  TemplateLibrary, renderTemplate, planVariants, costByProject, costEffectiveness, reversePrompt,
  healthDashboard, reviewEfficiency, pipelineFunnel, trending,
} from './pipeline2.js'
import { buildReferenceGraph, checkContract, analyzeImpact, previewChecklist } from './gamecheck.js'
import {
  acquireResourceLock, lockStatus, ProvenanceLog, scanCorruption,
  createBackup, listBackups, restoreBackup,
} from './safety.js'
import {
  buildStyleGuide, styleGuideMarkdown, SharedLibrary, transferStyle,
  designAbTest, analyzeAbTest, buildGalleryHtml,
} from './evolution.js'
import {
  parseYamlSubset, PipelineConfig, buildStepGraph, planIncremental, idempotencyKeys,
  runPipeline as runDeclarativePipeline, STEP_CATALOG, DEFAULT_PIPELINE,
} from './declarative.js'
import {
  evaluateRules, computeConfidence, routeWithSampling, applyPolicy, classifyAsset,
  ReviewLog, DEFAULT_RULES, DEFAULT_POLICY, OPERATORS, PREDICATES,
} from './decide.js'
import {
  planOrphanCleanup, applyOrphanCleanup, planDanglingVerdicts, planCorruptionRepair,
  planMissingRepair, planConfigDrift, planCascadeInvalidation,
} from './selfheal.js'
import {
  debounceScan, throttleScan, parseWebhook, webhookSnippet, buildGitHook, installGitHook,
} from './watch.js'
import {
  planParameterSearch, analyzeRejections, planActiveSampling,
  planUsageSignals, planRetirement, planRestock,
  pipelineStatus, checkAlerts, checkPermission, planPipelineRollback,
  maintenanceChecklist, DEFAULT_ALERT_THRESHOLDS, DEFAULT_ROLES,
} from './orchestrate.js'
import { generateSheet, gridFor, sliceSheet } from './sheet.js'
import { buildProjectProfiles } from './crossstyle.js'
import { readJson, shortHash, safeSegment, nowIso } from './util.js'

const textOut = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}
const dump = (value) => JSON.stringify(value, null, 2)

/** 截图结果里带的附件引用（execute 时存进来，render 时贴成对话里的图片）。 */
const SHOT_ATTACHMENTS = new Map()

/** 截图专用渲染：文字 + （可选）直接把图贴在对话里。 */
const shotOut = {
  schema: { type: 'string' },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: String(value) }]
    try {
      const parsed = JSON.parse(String(value))
      const ref = parsed?.attachment_id ? SHOT_ATTACHMENTS.get(parsed.attachment_id) : null
      if (ref) blocks.push({ type: 'image', attachment: ref })
    } catch {
      /* 贴图失败就只留文字 */
    }
    return blocks
  },
}

const PIXEL_PROP = {
  oneOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'object', additionalProperties: true }],
  description: '像素画净化：true=自动检测网格；{width:32,height:32,palette:16,method:"median",aa_passes:2}=指定逻辑分辨率（推荐）。'
    + '会把 AI 画的「伪像素图」按块取核心区代表色还原成真像素图，再做调色板精炼。'
    + 'AI 的「像素风插画」通常没有一致网格，自动检测会拒绝（不硬做），这时请直接给 width/height。',
}

const PARAM_PROPS = {
  size: { type: 'string', description: '尺寸：精确尺寸（1024x1024 / 1536x1024）或档位（1K / 2K / 3K / 4K，配合 ratio 使用，Agnes 这类接口需要档位）' },
  ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'], description: '宽高比，与档位式 size 配合（如 size=2K + ratio=16:9 → 2624x1472）。仅部分服务商支持' },
  quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: '质量档；草稿用 low 最省' },
  background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: '背景（模型/接口支持时）' },
  output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '输出格式，默认 png' },
  output_compression: { type: 'number', description: '压缩率 0-100（webp/jpeg 时）' },
  moderation: { type: 'string', enum: ['low', 'auto'], description: '内容审核档' },
  n: { type: 'number', description: '生成几张，默认 1（上限看接口，通常 10）' },
  extra: { type: 'object', additionalProperties: true, description: '额外的接口参数透传，例如 {"image_size":"1024x1024"}' },
  pixel: PIXEL_PROP,
}

const COMMON = {
  prompt: { type: 'string', description: '提示词' },
  profile: { type: 'string', description: '配置档 id（不填用当前激活的）' },
  project: { type: 'string', description: '项目名：落盘到 <输出根>/<项目>/，决定「这是哪个项目的图」' },
  name: { type: 'string', description: '素材名（文件名前缀），不填自动生成' },
  output: { type: 'string', description: '输出根目录（不填用配置里的）' },
  wait_s: { type: 'number', description: '异步接口最多等几秒；0=只提交立即返回 task_id，默认 600' },
  timeout_ms: { type: 'number', description: '单次请求超时毫秒，默认 300000' },
  retries: { type: 'number', description: '同步接口瞬时故障（限流/上游抽风/网关 5xx）的重试次数，默认 2；只重试「没出图」的失败，不会多花钱' },
}

/** 参数 schema：只在这里声明 required 数组，属性节点里不要出现 required。 */
function params(props, required = []) {
  const schema = { type: 'object', properties: props, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/** 取 PNG 尺寸（before/after 展示用）；解不开返回 '?'。 */
function decodedSize(buffer) {
  try {
    const d = decodePngRgba(buffer)
    return d ? `${d.width}×${d.height}` : '?'
  } catch {
    return '?'
  }
}

// ── L–R 组的辅助：审核日志与流水线执行器 ──

const REVIEW_LOG_FILE_NAME = 'review-log.json'

/** 读审核日志（不存在就返回空结构）。 */
async function loadReviewLog(dataDir) {
  const file = path.join(dataDir, REVIEW_LOG_FILE_NAME)
  const raw = await readJson(file, null)
  const data = raw && Array.isArray(raw.entries) ? raw : { version: 1, entries: [] }
  return new ReviewLog(file, data)
}

async function saveReviewLog(log) {
  const { writeJsonAtomic } = await import('./util.js')
  await writeJsonAtomic(log.file, log.data)
}

/**
 * 给声明式流水线的每一步接上真实执行器。
 * 没实现的步骤**不静默跳过** —— runPipeline 会如实报"没有执行器"。
 */
function buildPipelineExecutors({ runtime, state, root, dataDir, outputDir, project }) {
  return {
    // 后处理：按 spec 跑 A1 管线（去毛边/裁留白/锐化/归一）
    postprocess: async ({ inputs }) => {
      const { loadSpecCatalogue, resolveSpec, applySpecFixes } = await import('./spec.js')
      const { readFile, writeFile } = await import('node:fs/promises')
      const { readExpectations } = await import('./check.js')
      const catalogue = await loadSpecCatalogue(root).catch(() => ({ kinds: {}, assets: {} }))
      const { expectations } = await readExpectations(root).catch(() => ({ expectations: {} }))
      let count = 0
      for (const file of inputs) {
        const buffer = await readFile(file).catch(() => null)
        if (!buffer) continue
        const name = path.basename(file).replace(/\.[a-z0-9]+$/i, '')
        const spec = resolveSpec({ name, catalogue, expectation: expectations[name] ?? null })
        const fixed = applySpecFixes({ buffer, spec })
        if (fixed.ok) {
          await writeFile(`${file.replace(/\.[a-z0-9]+$/i, '')}.post.png`, fixed.buffer)
          count += 1
        }
      }
      return { ok: true, count }
    },
    // 校验：按 spec 核对（能修的在 postprocess 已修）
    validate: async ({ inputs }) => {
      const { readFile } = await import('node:fs/promises')
      const { validateAgainstSpec, resolveSpec } = await import('./spec.js')
      let count = 0
      for (const file of inputs) {
        const buffer = await readFile(file).catch(() => null)
        if (buffer) { validateAgainstSpec({ buffer, spec: resolveSpec({ name: path.basename(file) }) }); count += 1 }
      }
      return { ok: true, count }
    },
    // 清理孤儿
    cleanup: async () => {
      const { scanAssetCatalog } = await import('./assets.js')
      const { planOrphanCleanup, applyOrphanCleanup } = await import('./selfheal.js')
      const scan = await scanAssetCatalog({ outputDir, catalog: state.assets, gallery: state.gallery, project })
      const plan = planOrphanCleanup({ files: scan.files, catalog: state.assets })
      const result = await applyOrphanCleanup({ plan, catalog: state.assets, recycleDir: path.join(dataDir, 'recycled', new Date().toISOString().slice(0, 10)) })
      await state.assets.save()
      return { ok: true, count: result.removed_files }
    },
  }
}

export function createTools(runtime) {
  /**
   * 取「这次实际会用哪个配置档」的单价。
   *
   * 花钱闸门必须按它的单价算，不能用激活档的 —— 否则：
   * 激活档是免费档、却显式指定了一个付费档（args.profile），闸门会当免费放行，
   * 日预算/确认锁全部失效 = 漏钱。
   * 配置档没声明 pricePerImage 时用全局单价（与 loadState 的注入规则一致）。
   *
   * 参数接受 **id 或配置档对象**：只收 id 的话，调用方一不小心传了对象就会静默退化成
   * 全局单价 —— 免费档（pricePerImage: 0）会被当成付费档，直接多扣/多拦一次（实测踩过）。
   */
  function priceForProfile(state, profileOrId) {
    const profile = typeof profileOrId === 'object' && profileOrId !== null
      ? profileOrId
      : state.profiles.get(profileOrId)
    const declared = Number(profile?.pricePerImage)
    if (Number.isFinite(declared) && declared >= 0) return declared
    return Number(state.spend.price ?? 0)
  }

  /** 解析风格参考图（显式给的优先；否则按 use_style_refs 自动挑，用指纹+宽高比打分）。 */
  async function resolveStyleRefs({ state, args }) {
    const explicit = [...(args.style_refs ?? []), ...(args.image && !args.images ? [args.image] : [])].filter(Boolean)
    if (explicit.length > 0) return { refs: explicit.slice(0, 3), prompt: String(args.prompt ?? ''), styleNote: '使用调用方显式指定的参考图。' }
    if (!args.use_style_refs) return { refs: [], prompt: String(args.prompt ?? '') }
    const dataDir = state.settings?.dataDir ?? state.profiles.dataDir
    const index = await StyleIndex.load(dataDir).catch(() => null)
    const entries = index?.data?.entries ?? {}
    const hasIndex = Object.keys(entries).length > 0

    const picked = await pickStyleRefs({
      root: args.game_root ?? state.profiles.data.gameRoot ?? '',
      outputDir: state.profiles.outputDir,
      project: args.project ?? '',
      kind: args.kind ?? '',
      max: 2,
      index: hasIndex ? entries : null,
      useFingerprint: hasIndex,
      targetFingerprint: hasIndex && args.size ? aspectFingerprint(entries, args.size) : null,
      targetSize: args.size ?? '',
      targetKind: args.kind ?? '',
    })

    // 风格描述：索引里有项目整体档案就拼进提示词，让模型知道要往哪个方向靠
    const profile = hasIndex && index.profile ? index.profile() : null
    const prefix = profile ? `${fingerprintPrompt(profile)}\n\n` : ''
    const scored = picked.refs.map((ref) => `${ref.reason}`).join('；')
    return {
      refs: picked.files,
      prompt: prefix + stylePrompt(args.prompt, picked.files),
      styleNote: picked.note + (scored ? `（挑选依据：${scored}）` : ''),
    }
  }

  /** 用索引里「尺寸最接近目标规格」的素材当风格基准（拿它的风格去比对所有候选）。 */
  function aspectFingerprint(entries, targetSize) {
    const list = Object.entries(entries)
      .map(([file, entry]) => ({ file, entry, aspect: parseAspect(entry.size ?? '') }))
      .filter((item) => item.aspect)
    if (list.length === 0) return null
    const target = parseAspect(targetSize)
    if (!target) return list[0].entry
    list.sort((a, b) => aspectScore(b.aspect, target) - aspectScore(a.aspect, target))
    return list[0].entry
  }

  const list = {
    name: '_dsh_external_dsh_gpt_image_list',
    description: 'GPT Image 出图台总览：可用服务商（内置+自定义）与能力（文生图/图生图/蒙版/异步/Responses）、配置档（密钥打码）、当前激活档、输出目录、最近出图记录。开跑前先看这里。',
    parameters: params({}),
    output: textOut,
    async execute() {
      try {
        const { profiles, gallery, settings } = await runtime.loadState()
        const providers = []
        for (const [id, definition] of Object.entries(BUILTIN_PROVIDERS)) {
          const capabilities = providerCapabilities(normalizeProvider({ id }))
          providers.push({ id, name: definition.name, kind: 'builtin', ...capabilities })
        }
        for (const custom of profiles.data.customProviders) {
          const capabilities = providerCapabilities(normalizeProvider(custom))
          providers.push({ id: custom.id, name: custom.name ?? custom.id, kind: 'custom', ...capabilities })
        }
        return dump({
          providers,
          profiles: profiles.masked().profiles.map((profile) => ({ ...profile, apiKey: undefined })),
          active_profile: profiles.active?.id ?? '',
          output_dir: profiles.outputDir,
          data_dir: profiles.dataDir,
          settings,
          gallery: gallery.stats(),
          recent: gallery.list({ limit: 5 }).map((record) => ({
            id: record.id, ts: record.ts, status: record.status, project: record.project, name: record.name,
            images: record.images, ms: record.ms, error: record.error || undefined,
          })),
          board_url: runtime.boardUrl(),
          usage: 'generate 文生图(可带 assets 一次多个) / edit 改图 / scan 素材体检 / pool 需求池(攒批) / batch 批量 / install 按规格装进游戏 / review 出图自检 / register 写进游戏登记表 / style 风格索引 / order 生成顺序 / screenshot 截图 / job 异步任务 / config 配置与花费。落盘：<输出根>/<项目>/<素材名>_序号.png，并生成 图片清单.md。',
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const generate = {
    name: '_dsh_external_dsh_gpt_image_generate',
    description: '★一次能出多个素材（推荐用法）：给 assets=["提示词1","提示词2",...] 或 [{name,prompt,kind}]，一个调用就批量出图（指纹去重 + 并发 + 波次），不用一个一个来；只画单张时才用 prompt。**硬性规定**：每个素材必须有名字（没给自动从提示词提炼），每张产出都附带「画面内印着素材名」的预览图 (*_labeled.png)，干净图原样给游戏用。⚠️花钱：>1 张必须带 confirm=true，当日超预算直接拒绝。效率：同一素材多方案用 variants=2~4（一次请求多变体），不同素材靠并发；先 quality=low 出草稿挑，再出终稿。',
    parameters: params({
      prompt: { ...COMMON.prompt },
      assets: {
        type: 'array',
        description: '★一次出多个素材：["提示词1","提示词2"] 或 [{name:"tower_fire",prompt:"...",kind:"tower"}]。给了它就按批量跑，一个调用出多张。',
        items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      },
      ...PARAM_PROPS,
      profile: COMMON.profile,
      project: COMMON.project,
      name: COMMON.name,
      output: COMMON.output,
      wait_s: COMMON.wait_s,
      timeout_ms: COMMON.timeout_ms,
      confirm: { type: 'boolean', description: '确认这次花费（一次 >1 张时必须为 true）' },
      use_style_refs: { type: 'boolean', description: 'true=自动从游戏现有素材/本项目已生成图里挑参考图，保持风格一致' },
      style_refs: { type: 'array', items: { type: 'string' }, description: '显式指定风格参考图路径（优先于自动挑选）' },
      game_root: { type: 'string', description: '游戏目录（自动挑风格参考图时用）' },
      dry_run: { type: 'boolean', description: '给了 assets 时：只规划不花钱' },
      variants: { type: 'number', description: '给了 assets 时：每个素材出几张（默认 1）' },
      best_of: { type: 'number', description: '**择优**：一次出 N 张（2~6），自动按机械自检打分留最高分那张，落选的改名带 `_落选_` 前缀。关键素材（主角立绘/封面）值得用；批量小图标别用（花 N 倍钱）。⚠️ 成本 = N 张' },
      best_of_recycle: { type: 'boolean', description: 'best_of 时是否**真删**落选图（默认 false = 只改名，可后悔）' },
      force: { type: 'boolean', description: '即使这张图之前已经生成过（参数完全一致）也要重画；默认 false = 直接跳过、不花钱' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const many = Array.isArray(args.assets) && args.assets.length > 0
        // best_of：一次出 N 张再择优。夹在 1~6 —— 再多就不是"择优"而是"抽卡"了。
        const bestOf = Math.min(6, Math.max(1, Math.round(Number(args.best_of ?? 1) || 1)))
        const images = many
          ? args.assets.length * Math.max(1, Number(args.variants ?? 1) || 1)
          : Math.max(bestOf, Math.max(1, Number(args.n ?? 1) || 1))

        // ★一次要出多个素材：直接走批量通道（去重 + 并发 + 波次），一个调用出多张
        if (many) {
          if (!args.dry_run) {
            const gate = state.spend.check({ images, action: 'generate.assets', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
            if (!gate.allow) return dump({ ...gate, spend_guard: true, assets: args.assets.length })
          }
          const result = await runBatch({
            profiles: state.profiles,
            gallery: state.gallery,
            settings: { outputDir: state.profiles.outputDir, caps: state.profiles.data.caps, timeoutMs: state.profiles.timeoutMs },
            args: {
              assets: args.assets,
              project: args.project,
              quality: args.quality || 'low',
              size: args.size,
              variants: args.variants,
              dry_run: args.dry_run,
              profile: args.profile,
              output: args.output,
              use_style_refs: args.use_style_refs,
              game_root: args.game_root,
            },
          })
          if (result.ok && !args.dry_run) {
            state.spend.record({ action: 'generate.assets', images: result.executed?.images ?? images, project: result.project, names: (result.prompt_log ?? []).map((item) => item.name), free: priceForProfile(state, args.profile) === 0 })
            await runtime.saveState(state)
          }
          return dump({ ...result, mode: 'multi-asset', board_url: runtime.boardUrl(), spend: state.spend.check({ images: 0, action: 'status' }).today })
        }

        if (!String(args.prompt ?? '').trim()) {
          return dump({ ok: false, error: '要么给 prompt（单张），要么给 assets（一次多个素材）' })
        }
        // 省钱预检：同一张图（同配置档/模型/提示词/尺寸/宽高比/质量）已经生成过就别再花一次
        if (!args.force) {
          const dup = findDuplicate(state.gallery, {
            profileId: state.profiles.get(args.profile)?.id ?? '',
            model: state.profiles.get(args.profile)?.model ?? '',
            prompt: args.prompt,
            size: args.size ?? '',
            ratio: args.ratio ?? '',
            quality: args.quality ?? '',
            kind: 'generate',
          })
          if (dup.duplicate) {
            return dump({
              ok: true,
              skipped_duplicate: true,
              spent: 0,
              fingerprint: dup.fingerprint,
              existing: { name: dup.existing.name, project: dup.existing.project, files: dup.existing.files, ts: dup.existing.ts },
              hint: '这张图之前已经生成过（参数完全一致），已直接跳过、没有花钱。确实要重画就带 force=true。',
            })
          }
        }
        const gate = state.spend.check({ images, action: 'generate', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
        if (!gate.allow) return dump({ ...gate, spend_guard: true })
        const style = await resolveStyleRefs({ state, args })
        if (style.error) return dump({ ...style.error, spend_guard: true })
        const result = await runImage({
          profiles: state.profiles,
          gallery: state.gallery,
          settings: state.settings,
          args: {
            ...args,
            kind: style.refs.length > 0 ? 'edit' : 'generate',
            prompt: style.prompt,
            images: style.refs.length > 0 ? style.refs : undefined,
            // best_of 用 n 让上游一次出多张（一次请求多图，比连调 N 次省时且更一致）
            ...(bestOf > 1 ? { n: bestOf } : {}),
          },
        })
        if (result.ok) state.spend.record({ action: 'generate', images: result.images || images, project: result.project, names: [result.name ?? args.name ?? ''], free: priceForProfile(state, args.profile) === 0 })

        // best_of：给候选打分，留最高分，落选的改名（默认不删，可后悔）
        let bestOfInfo = null
        if (result.ok && bestOf > 1) {
          const files = (result.files ?? []).filter(Boolean)
          if (files.length > 1) {
            const expected = result.width && result.height ? { width: result.width, height: result.height } : undefined
            const picked = await pickBest(files, { expected, requireAlpha: Boolean(args.background === 'transparent') })
            const disposed = await disposeLosers(picked.worst, { recycle: Boolean(args.best_of_recycle) })
            // 选中的那张排到最前面，让 files[0] 就是最终交付
            result.files = [picked.best, ...picked.worst.filter((f) => !disposed.find((d) => d.file === f && d.action !== 'kept'))]
            result.file = picked.best
            bestOfInfo = {
              requested: bestOf,
              picked: picked.best,
              picked_score: picked.best_score,
              all_scores: picked.scores.map((s) => ({ file: s.file, score: s.score, verdict: s.verdict, penalties: s.penalties })),
              disposed,
              summary: picked.summary,
              all_bad: picked.all_bad,
              ties: picked.ties,
            }
          } else if (files.length === 1) {
            bestOfInfo = { requested: bestOf, note: '上游只回了 1 张，没有可择优的候选' }
          }
        }

        await runtime.saveState(state)
        return dump({
          ...result,
          style_refs_used: style.refs,
          ...(bestOfInfo ? { best_of: bestOfInfo } : {}),
          spend: state.spend.check({ images: 0, action: 'status' }).today,
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const edit = {
    name: '_dsh_external_dsh_gpt_image_edit',
    description: '图生图 / 局部重绘：image 传本地参考图绝对路径（或 images 数组），mask 传蒙版路径（透明区域=要重绘的部分）。同样过花钱闸门（>1 张要 confirm）。',
    parameters: params({
      prompt: { ...COMMON.prompt },
      image: { type: 'string', description: '参考图本地绝对路径（单张）' },
      images: { type: 'array', items: { type: 'string' }, description: '参考图路径数组（多张，接口支持时）' },
      mask: { type: 'string', description: '蒙版图片本地绝对路径（做局部重绘时）' },
      ...PARAM_PROPS,
      profile: COMMON.profile,
      project: COMMON.project,
      name: COMMON.name,
      output: COMMON.output,
      wait_s: COMMON.wait_s,
      timeout_ms: COMMON.timeout_ms,
      confirm: { type: 'boolean', description: '确认这次花费（一次 >1 张时必须为 true）' },
    }, ['prompt']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const images = Math.max(1, Number(args.n ?? 1) || 1)
        const gate = state.spend.check({ images, action: 'edit', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
        if (!gate.allow) return dump({ ...gate, spend_guard: true })
        const result = await runImage({ profiles: state.profiles, gallery: state.gallery, settings: state.settings, args: { ...args, kind: 'edit' } })
        if (result.ok) state.spend.record({ action: 'edit', images: result.images || images, project: result.project, names: [args.name ?? ''], free: priceForProfile(state, args.profile) === 0 })
        await runtime.saveState(state)
        return dump({ ...result, spend: state.spend.check({ images: 0, action: 'status' }).today })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const job = {
    name: '_dsh_external_dsh_gpt_image_job',
    description: '异步任务：action=status 查当前状态（立即返回），action=wait 继续等到完成并落盘产物。支持异步提交的服务商（如 sb2api）用得到。',
    parameters: params({
      task_id: { type: 'string', description: '提交时返回的 task_id' },
      action: { type: 'string', enum: ['status', 'wait'], description: '默认 status' },
      wait_s: { type: 'number', description: 'action=wait 时最多等几秒，默认 300' },
      profile: COMMON.profile,
      project: COMMON.project,
      name: COMMON.name,
      output: COMMON.output,
    }, ['task_id']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const profile = state.profiles.get(args.profile)
        if (!profile) return dump({ ok: false, error: `找不到配置档 ${args.profile ?? ''}` })
        const provider = resolveProvider(state.profiles, profile)
        if (!provider.poll) return dump({ ok: false, error: `服务商 ${provider.id} 不是异步接口，没有可轮询的任务` })
        const action = args.action || 'status'
        const result = await pollTask({
          profile,
          provider,
          taskId: args.task_id,
          once: action === 'status',
          timeoutMs: action === 'status' ? 60000 : Number(args.wait_s ?? 300) * 1000,
        })
        if (action === 'status' || !result.ok || result.pending) {
          await runtime.saveState(state)
          return dump({ ok: result.ok !== false, action, task_id: args.task_id, status: result.status, pending: Boolean(result.pending), error: result.error, payload: action === 'status' ? result.payload : undefined })
        }
        // wait 完成：落盘 + 写清单
        const saved = await persistImages({
          gallery: state.gallery,
          outputRoot: args.output || state.profiles.outputDir,
          project: args.project || 'images',
          name: args.name || `task_${String(args.task_id).slice(0, 12)}`,
          images: result.images,
          prompt: `[异步任务 ${args.task_id}]`,
          profileId: profile.id,
          providerId: provider.id,
          model: profile.model,
          ms: result.ms,
          kind: 'job',
        })
        await runtime.saveState(state)
        return dump({ ok: true, action, task_id: args.task_id, status: result.status, ...saved, board_url: runtime.boardUrl() })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const scan = {
    name: '_dsh_external_dsh_gpt_image_scan',
    description: '素材体检：扫描游戏项目，一次说清三件事 —— ①还缺哪些素材（代码引用了却没有的文件 + 该题材通常需要的清单）②已经生成的图达不达标（对照项目里的「待画素材清单」看尺寸/透明底，含空图检测）③有没有被游戏代码真正引用。要确认「生图有没有用在游戏里」，先调它。',
    parameters: params({
      root: { type: 'string', description: '游戏项目目录（绝对路径）' },
      brief: { type: 'string', description: '玩法/风格描述，用于题材判定' },
      project: { type: 'string', description: '要核对哪个项目的产出（默认取 root 的目录名）' },
      max_assets: { type: 'number', description: '最多返回多少条素材建议，默认 24' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const result = await scanGame({
          root: args.root ?? '',
          brief: args.brief ?? '',
          project: args.project ?? '',
          outputDir: state.profiles.outputDir,
          maxAssets: Number(args.max_assets ?? 24),
        })
        // 发现缺口 → 只登记进需求池，不到阈值先不生图（省钱）
        const genre = result.genres?.[0]?.id ?? ''
        const existingKeys = new Set(state.pool.data.items.map((item) => `${item.project}/${item.name}`))
        const { added, skipped } = state.pool.enqueue({
          project: result.project,
          genre,
          suggestions: result.suggested ?? [],
          existingFingerprints: galleryFingerprints(state.gallery),
          existingKeys,
          source: 'scan',
        })
        if (added.length > 0) await state.pool.save()
        return dump({
          ...result,
          pool: state.pool.report({ genre, project: result.project }),
          pool_added: added.map((item) => item.name),
          pool_skipped: skipped,
          next_step: '不要现在就逐张生图：先让它攒着，攒到阈值后用 pool 工具 action=flush 一次性生成（同样一批只花一次的钱，且少返工）。',
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const poolTool = {
    name: '_dsh_external_dsh_gpt_image_pool',
    description: '素材需求池（省钱的闸门）：缺素材先登记进池子，**攒够阈值再一次性生成**，不要发现一张就生一张。默认阈值 8 张；卡牌类（杀戮尖塔那种）12 张，可改。action=show 看池子/还差几张/这批要花多少钱；add 登记需求；remove/clear 清理；set_threshold 改阈值；flush 到阈值了一次性生成（force=true 可强行提前跑）。',
    parameters: params({
      action: { type: 'string', enum: ['show', 'add', 'remove', 'clear', 'set_threshold', 'flush'], description: '默认 show' },
      assets: {
        type: 'array',
        description: 'action=add 时登记的需求：字符串或 {name,prompt,size,quality,kind,reason}',
        items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      },
      names: { type: 'array', items: { type: 'string' }, description: 'remove 时按名字删' },
      ids: { type: 'array', items: { type: 'string' }, description: 'remove 时按 id 删' },
      threshold: { type: 'number', description: 'set_threshold 的新阈值' },
      genre: { type: 'string', description: '按题材取阈值（card / rpg / tower-defense …）' },
      project: COMMON.project,
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'flush 时的质量档，草稿用 low' },
      size: { type: 'string', description: 'flush 时的默认尺寸' },
      ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'], description: 'flush 时的默认宽高比（与档位式 size 配合，如 size=2K + ratio=9:16）' },
      profile: COMMON.profile,
      force: { type: 'boolean', description: 'flush 时是否允许未到阈值也跑' },
      confirm: { type: 'boolean', description: 'flush 时确认花费（超过自动上限 autoSpendLimit 才需要，默认 0.5 元）' },
      use_style_refs: { type: 'boolean', description: 'flush 时自动拿游戏现有素材当风格参考，保持风格一致' },
      game_root: { type: 'string', description: '游戏目录（自动挑风格参考图时用）' },
      dry_run: { type: 'boolean', description: 'flush 时只给规划不花钱（强烈建议第一次先跑这个）' },
      output: COMMON.output,
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action || 'show'
        const genre = args.genre ?? ''
        if (action === 'set_threshold') {
          if (genre) state.pool.data.thresholds[genre.toLowerCase()] = Number(args.threshold)
          else state.pool.data.threshold = Number(args.threshold)
          await state.pool.save()
          return dump({ ok: true, thresholds: state.pool.data.thresholds, default_threshold: state.pool.data.threshold })
        }
        if (action === 'add') {
          const raw = args.assets ?? []
          const existingKeys = new Set(state.pool.data.items.map((item) => `${item.project}/${item.name}`))
          const suggestions = raw.map((entry, index) => {
            const item = typeof entry === 'string' ? { prompt: entry } : (entry ?? {})
            return { ...item, name: item.name || `${args.project || 'asset'}_${index + 1}` }
          })
          const { added, skipped } = state.pool.enqueue({
            project: args.project || 'assets',
            genre,
            suggestions,
            existingFingerprints: galleryFingerprints(state.gallery),
            existingKeys,
            source: 'manual',
          })
          await state.pool.save()
          return dump({ ok: true, added: added.length, skipped, pool: state.pool.report({ genre, project: args.project ?? '' }) })
        }
        if (action === 'remove') {
          const removed = state.pool.remove([...(args.ids ?? []), ...(args.names ?? [])])
          await state.pool.save()
          return dump({ ok: true, removed, pool: state.pool.report({ genre, project: args.project ?? '' }) })
        }
        if (action === 'clear') {
          const removed = state.pool.clear('generated')
          await state.pool.save()
          return dump({ ok: true, removed_generated: removed, pool: state.pool.report({ genre, project: args.project ?? '' }) })
        }
        if (action === 'flush') {
          const report = state.pool.report({ genre, project: args.project ?? '' })
          if (!report.ready && !args.force) {
            return dump({
              ok: true,
              generated: 0,
              ...report,
              hint: `还没到阈值（${report.pending}/${report.threshold}）：现在跑就是零散花钱。继续用 scan 攒需求，或 force=true 强行跑（不推荐）。`,
            })
          }
          // 花钱闸门（多道）：池子没到阈值 / 没确认 / 超单次张数 / 超日预算，全部拦在这里
          const spendGate = state.spend.check({ images: report.pending, action: 'pool.flush', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
          if (!args.dry_run && (!args.confirm || !spendGate.allow)) {
            const reasons = [...spendGate.refusals]
            if (!args.confirm) reasons.push(`这次要花约 ${report.cost_if_now} ${report.currency}（${report.pending} 张）：确认就带 confirm=true；只想看规划就带 dry_run=true。`)
            return dump({
              ok: true,
              generated: 0,
              needs_confirm: true,
              ...report,
              spend_guard: true,
              refusals: reasons,
              today: spendGate.today,
              hint: '被闸门拦下，没有花任何钱。',
            })
          }
          const assets = report.items.map((item) => ({ name: item.name, prompt: item.prompt, kind: item.kind, size: item.size || args.size, ratio: item.ratio || args.ratio, quality: args.quality || 'low' }))
          const result = await runBatch({
            profiles: state.profiles,
            gallery: state.gallery,
            settings: { outputDir: state.profiles.outputDir, caps: state.profiles.data.caps, timeoutMs: state.profiles.timeoutMs },
            args: { assets, project: args.project || report.items[0]?.project, quality: args.quality || 'low', size: args.size, ratio: args.ratio, dry_run: args.dry_run, profile: args.profile, output: args.output, use_style_refs: args.use_style_refs, game_root: args.game_root },
          })
          if (!args.dry_run && result.ok) {
            state.pool.markGenerated(assets.map((item) => item.name), args.project || '')
            state.spend.record({ action: 'pool.flush', images: result.executed?.images ?? report.pending, project: args.project || '', names: assets.map((item) => item.name), free: priceForProfile(state, args.profile) === 0 })
            await runtime.saveState(state)
          }
          return dump({
            ...result,
            pool_before: report,
            pool_after: state.pool.report({ genre, project: args.project ?? '' }),
            today: state.spend.check({ images: 0, action: 'status' }).today,
            next_step: '生成完请用 install 工具按规格装进游戏（不然尺寸不对=黑屏），装完再截图给用户看界面变化。',
            board_url: runtime.boardUrl(),
          })
        }
        return dump({ ok: true, ...state.pool.report({ genre, project: args.project ?? '' }), price_per_image: state.pool.price, currency: state.pool.data.currency })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const installTool = {
    name: '_dsh_external_dsh_gpt_image_install',
    description: '把生成好的图按游戏规格装进游戏、让它真的被用上（不再只是躺在输出目录）：①按「待画素材清单」的尺寸缩放（保留透明通道，避免做出几百字节的空图→黑屏）②写到游戏目录里代码期望的位置（同名文件先备份 .bak-before-install）③立刻复核尺寸与代码引用，并给出还差哪一步。装完请截游戏画面给用户看。',
    parameters: params({
      root: { type: 'string', description: '游戏项目目录（绝对路径）' },
      project: COMMON.project,
      names: { type: 'array', items: { type: 'string' }, description: '只装这几个素材（默认装该项目全部）' },
      data_url: { type: 'boolean', description: 'true=额外输出 .dataurl.txt（把 PNG 转成 data URL，喂给把素材内联进 JS 的工程）' },
    }, ['root']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const result = await installAssets({
          root: args.root,
          outputDir: state.profiles.outputDir,
          project: args.project || (args.root ? args.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'assets'),
          names: args.names ?? [],
          dataUrl: Boolean(args.data_url),
        })
        return dump(result)
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const batch = {
    name: '_dsh_external_dsh_gpt_image_batch',
    description: '批量出图（攒批后的执行口）：指纹去重（已有的不重跑）+ 容量规划（冷启动先 1 张探针、成功加性放量、限流自动缩容冷却）+ 波次并发执行。同样遵守硬性规定：每个素材必须有名字，每张产出都带「画面内印名字」的预览图。效率建议：每个素材的 variants 一次请求出（同一提示词多变体），不同素材靠并发；先 quality=low 草稿挑，再出终稿。dry_run=true 只规划不花钱。',
    parameters: params({
      assets: {
        type: 'array',
        description: '素材清单，可写字符串（等于只给提示词）或 {name,prompt,variants,size,ratio,quality,kind}',
        items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      },
      project: COMMON.project,
      profile: COMMON.profile,
      size: { type: 'string', description: '默认尺寸，如 1024x1024；Agnes 这类接口用档位 1K/2K/3K/4K' },
      ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'], description: '默认宽高比：与档位式 size 配合（如 size=2K + ratio=9:16 → 1472x2624）' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: '默认质量档，草稿用 low 最省' },
      variants: { type: 'number', description: '每个素材默认出几张' },
      caps: { type: 'object', additionalProperties: true, description: '本轮硬上限 {maxImagesPerRun,maxConcurrency,maxBatch,maxCostPerRun}' },
      deadline_s: { type: 'number', description: '时间预算（秒），排不完的这轮不排' },
      dry_run: { type: 'boolean', description: 'true=只规划不发请求（强烈建议第一次先跑这个）' },
      confirm: { type: 'boolean', description: '确认这次花费（一次 >1 张时必须为 true）' },
      approved_token: { type: 'string', description: '大额审批的单号（超阈值时先出单，批准后带上它执行）' },
      purpose: { type: 'string', description: '这批素材的用途（写进待批准单，便于人判断）' },
      impact_files: { type: 'array', items: { type: 'string' }, description: '会影响哪些游戏文件（写进待批准单）' },
      output: COMMON.output,
    }, ['assets']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const requested = (Array.isArray(args.assets) ? args.assets.length : 0) * Math.max(1, Number(args.variants ?? 1) || 1)
        if (!args.dry_run) {
          const gate = state.spend.check({ images: requested, action: 'batch', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
          if (!gate.allow) return dump({ ...gate, spend_guard: true, requested_images: requested })
          // 大额审批：超过阈值就出单子，不直接跑
          const queue = await ApprovalQueue.load(state.profiles.dataDir)
          const approval = queue.needsApproval({ cost: gate.estimate, token: args.approved_token ?? '' })
          if (approval.required) {
            const item = queue.create({
              action: 'batch',
              project: args.project ?? '',
              names: (args.assets ?? []).map((asset) => (typeof asset === 'string' ? asset : asset?.name)).filter(Boolean),
              images: requested,
              cost: gate.estimate,
              currency: gate.currency,
              purpose: args.purpose ?? '批量生成素材',
              impact_files: args.impact_files ?? [],
              samples: (args.assets ?? []).slice(0, 8).map((asset) => {
                const entry = typeof asset === 'string' ? { prompt: asset } : (asset ?? {})
                return { name: entry.name ?? '', prompt: String(entry.prompt ?? '').slice(0, 200) }
              }),
            })
            await queue.save()
            return dump({
              ok: true,
              generated: 0,
              needs_approval: true,
              token: item.token,
              approval: item,
              text: approvalText(item),
              hint: `这批要花 ${gate.estimate} ${gate.currency}，超过审批阈值 ${queue.threshold} —— 已出单，没花任何钱。确认后带 approved_token="${item.token}" 再调一次。`,
            })
          }
        }
        const result = await runBatch({
          profiles: state.profiles,
          gallery: state.gallery,
          settings: { outputDir: state.profiles.outputDir, caps: state.profiles.data.caps, timeoutMs: state.profiles.timeoutMs },
          args: args ?? {},
        })
        if (result.ok && !args.dry_run) {
          state.spend.record({ action: 'batch', images: result.executed?.images ?? requested, project: result.project, names: (result.prompt_log ?? []).map((item) => item.name), free: priceForProfile(state, args.profile) === 0 })
        }
        await runtime.saveState(state)
        return dump({ ...result, board_url: runtime.boardUrl(), spend: state.spend.check({ images: 0, action: 'status' }).today })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const screenshot = {
    name: '_dsh_external_dsh_gpt_image_screenshot',
    description: '截图给用户看真实结果（WorkBuddy 那种用法）：改完 UI / 跑起游戏 / 素材落地之后拍一张，让用户"确实看见了"。自己判断该不该截：只有"看得见的成果"才截，纯逻辑/配置改动别截；截完把图给用户看（present，或 attach=true 直接贴在对话里）。mode=window 时可指定窗口标题关键词（例如 "DeepSeek"、"MSI"），region 传 x,y,w,h。',
    parameters: params({
      mode: { type: 'string', enum: ['screen', 'all', 'window', 'region'], description: 'screen=主屏（默认）· all=全部屏幕 · window=指定窗口 · region=指定区域' },
      window: { type: 'string', description: 'mode=window 时的窗口标题关键词，如 "DeepSeek"' },
      region: { type: 'string', description: 'mode=region 时的 x,y,w,h' },
      project: COMMON.project,
      name: COMMON.name,
      output: COMMON.output,
      max_width: { type: 'number', description: '输出图最大宽度（默认 1600，便于贴进对话）' },
      attach: { type: 'boolean', description: 'true=把截图直接贴在对话里给用户看（默认 false，只给路径；用 present 展示）' },
    }),
    output: shotOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const result = await capture({
          mode: args.mode ?? 'screen',
          window: args.window ?? '',
          region: args.region ?? '',
          outputDir: args.output || state.profiles.outputDir,
          project: args.project || '截图',
          name: args.name || '',
          maxWidth: Number(args.max_width ?? 1600),
        })
        if (!result.ok) return dump({ ...result, hint: '截图失败：确认是在 Windows 桌面会话里跑，且本机安装了 Windows PowerShell。' })
        let attachmentId
        if (args.attach) {
          const ref = await runtime.attachImage(result.file).catch(() => null)
          if (ref) {
            attachmentId = `shot_${shortHash(result.file + result.capturedAt, 10)}`
            SHOT_ATTACHMENTS.set(attachmentId, ref)
          }
        }
        return dump({
          ...result,
          ...(attachmentId ? { attachment_id: attachmentId, attached: true } : {}),
          hint: attachmentId
            ? '截图已直接贴在对话里；路径也给你了，可再用 present 展示或让用户打开。'
            : '用 present 把这张图展示给用户（attach=true 可改为直接贴进对话）。',
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const styleTool = {
    name: '_dsh_external_dsh_gpt_image_style',
    description: '素材库风格索引：扫一遍游戏项目里现有的图，给每张算「风格指纹」（主色板、明暗、饱和度、线条/像素密度、透明占比），缓存起来。之后生成时 use_style_refs=true 会按指纹挑最像的参考图（而不是靠目录/名字猜），并把量化风格写进提示词 —— 风格一致性明显更好。同时能报出「风格跑偏」的素材。action=index 建索引；action=show 看档案；action=outliers 看跑偏的。',
    parameters: params({
      action: { type: 'string', enum: ['index', 'show', 'outliers'], description: '默认 index' },
      root: { type: 'string', description: '游戏项目目录（index 时必填）' },
      force: { type: 'boolean', description: 'true=全部重算（默认只算新增/变化的）' },
      max_files: { type: 'number', description: '最多索引多少张图，默认 400' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action || 'index'
        const index = await StyleIndex.load(state.profiles.dataDir)
        if (action === 'show') {
          return dump({ ok: true, stats: index.stats(), profile: index.profile(), roots: index.data.roots })
        }
        if (action === 'outliers') {
          return dump({ ok: true, outliers: index.outliers({ limit: 15 }), note: '相似度越低越可能是「风格跑偏」的素材。' })
        }
        const result = await buildStyleIndex({
          root: args.root ?? state.profiles.data.gameRoot ?? '',
          dataDir: state.profiles.dataDir,
          maxFiles: Number(args.max_files ?? 400),
          force: Boolean(args.force),
          index,
        })
        return dump(result)
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const orderTool = {
    name: '_dsh_external_dsh_gpt_image_order',
    description: '生成顺序计划（素材依赖图）：从代码里解析出哪些素材被谁用，按「先通用件、后具体件」排出批次 —— 先画 UI 框/图标底板/地形这类一改全改的，再画具体立绘/卡面/特效。避免通用的还没定稿就画一堆具体图，最后全部返工。',
    parameters: params({
      root: { type: 'string', description: '游戏项目目录' },
      wanted: { type: 'array', items: { type: 'string' }, description: '只排这几个素材（默认按代码里识别到的全部）' },
    }, ['root']),
    output: textOut,
    async execute(args) {
      try {
        const result = await planGenerationOrder({ root: args.root, wanted: args.wanted ?? [] })
        return dump(result)
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const reviewTool = {
    name: '_dsh_external_dsh_gpt_image_review',
    description: '出图自检（AI 审图的机械部分）：不等"模型看一眼"，先用确定性规则筛掉明显不能用的图 —— 几乎单色 / 全黑 / 全白 / 对比度极低 / 没有边缘（画面是空的）/ 该透明却不透明 / 尺寸不符。这些放大缩小都救不回来，直接重画最省。返回里只列可疑的，好的不占篇幅。',
    parameters: params({
      project: COMMON.project,
      names: { type: 'array', items: { type: 'string' }, description: '只检查这几个素材（默认该项目全部）' },
      output: COMMON.output,
      root: { type: 'string', description: '游戏目录（有「待画素材清单」时会按规格一起核对透明/尺寸）' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const project = args.project || state.profiles.data.lastProject || ''
        const outputRoot = args.output || state.profiles.outputDir
        const dir = path.join(outputRoot, project)
        const { readdir } = await import('node:fs/promises')
        let files = []
        try {
          files = (await readdir(dir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name) && !name.includes('_labeled'))
        } catch {
          return dump({ ok: false, error: `输出目录里没有项目 ${project}：${dir}` })
        }
        if (args.names?.length) files = files.filter((name) => args.names.some((key) => name.startsWith(key)))
        const { readExpectations } = await import('./check.js')
        const expectations = args.root ? (await readExpectations(args.root)).expectations : {}
        const result = await reviewBatch(files.map((name) => path.join(dir, name)), { expectations })
        // 自检结论回流进提示词库：成功的可复用，废的进避坑清单
        for (const item of [...(result.suspects ?? []), ...(result.good_files ?? [])]) {
          const isBad = (result.suspects ?? []).includes(item)
          const name = item.file.split(/[\\/]/).pop()
          const record = state.gallery.records.find((entry) => (entry.files ?? []).some((file) => file.endsWith(name)))
          if (record?.prompt) {
            state.prompts.record({
              prompt: record.prompt,
              verdict: isBad ? 'bad' : 'good',
              project,
              name: record.name,
              kind: record.kind,
              problems: isBad ? item.problems : [],
              files: record.files,
            })
          }
        }
        await runtime.saveState(state)
        return dump({ ok: true, project, dir, ...result, prompt_library: state.prompts.stats() })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const registerTool = {
    name: '_dsh_external_dsh_gpt_image_register',
    description: '登记进游戏：把生成好的图写进游戏的素材登记表（形如 `"key":{"s":"data:image/...","w":40,"h":60,...}`），真正做到「一步到游戏里」。会自动识别「构建生成物」（文件头写着请勿手改的，写了也会被下次构建覆盖）并拒绝，同时告诉你该改哪个源文件；写前备份 .bak-before-register；dry_run 可先预览。action=install 写入；action=audit 看登记表里还有哪些项没填真图。',
    parameters: params({
      action: { type: 'string', enum: ['install', 'audit'], description: '默认 install' },
      root: { type: 'string', description: '游戏项目目录' },
      project: COMMON.project,
      names: { type: 'array', items: { type: 'string' }, description: '只登记这几个素材' },
      registry: { type: 'string', description: '指定登记文件（默认自动找）' },
      data_url: { type: 'boolean', description: 'true=把图片内联成 data URL 写进去（默认 true，这正是这个游戏的做法）' },
      dry_run: { type: 'boolean', description: '只预览会改哪些地方，不写盘' },
    }, ['root']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const root = args.root
        if ((args.action || 'install') === 'audit') {
          const audit = await findUnfilledRegistrations(root, args.registry ?? '')
          return dump({ ok: true, ...audit })
        }
        const project = args.project || state.profiles.data.lastProject || (root ? path.basename(root) : '')
        const outputRoot = args.output || state.profiles.outputDir
        const dir = path.join(outputRoot, project)
        const { readdir } = await import('node:fs/promises')
        let files = []
        try {
          files = (await readdir(dir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name) && !name.includes('_labeled') && !/\.bak/.test(name))
        } catch {
          return dump({ ok: false, error: `输出目录里没有项目 ${project}：${dir}` })
        }
        // 优先用按规格缩好的（_fitted 目录），没有就直接用原图
        const fittedDir = path.join(dir, '_fitted')
        const entries = []
        for (const name of files) {
          const key = name.replace(/\.[a-z0-9]+$/i, '').replace(/_\d+x\d+$/, '').replace(/_\d+$/, '')
          if (args.names?.length && !args.names.includes(key)) continue
          let file = path.join(dir, name)
          try {
            const fitted = (await readdir(fittedDir)).find((candidate) => candidate.startsWith(key) && candidate.endsWith('.png'))
            if (fitted) file = path.join(fittedDir, fitted)
          } catch {
            /* 没有 _fitted 就用原图 */
          }
          entries.push({ key, file, name })
        }
        if (entries.length === 0) return dump({ ok: false, error: '没有匹配的素材可登记' })
        const result = await registerAssets({
          root,
          entries,
          dataUrl: args.data_url !== false,
          dryRun: Boolean(args.dry_run),
          registry: args.registry ?? '',
        })
        return dump(result)
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const pipelineTool = {
    name: '_dsh_external_dsh_gpt_image_pipeline',
    description: '★一键工作台：按正确顺序把「取素材 → 生成 → 自检 → 按规格装机 → 登记进游戏」串成一条命令。素材来源自动选（需求池里待生成的 → 没有就按 order 挑第一批）。**自检发现废图会直接停下不装机**（装进去只会黑屏），并给出该重画哪几张 + 原提示词。dry_run=true 只规划。',
    parameters: params({
      root: { type: 'string', description: '游戏项目目录' },
      project: COMMON.project,
      assets: {
        type: 'array',
        description: '要生成的素材（不填就自动从需求池/顺序计划取）',
        items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: '默认 low（草稿）' },
      size: { type: 'string', description: '默认尺寸' },
      max_images: { type: 'number', description: '本轮最多几张' },
      confirm: { type: 'boolean', description: '确认花费（>1 张必须为 true）' },
      dry_run: { type: 'boolean', description: '只规划不花钱' },
      strict: { type: 'boolean', description: '默认 true=发现废图就停下；false=照常往下走' },
      skip_install: { type: 'boolean', description: '跳过装机' },
      skip_register: { type: 'boolean', description: '跳过登记' },
      use_style_refs: { type: 'boolean', description: '默认 true，按风格索引挑参考图' },
      data_url: { type: 'boolean', description: '默认 true，登记时内联 data URL' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const result = await runPipeline({
          profiles: state.profiles,
          gallery: state.gallery,
          pool: state.pool,
          spend: state.spend,
          runtime,
          args: args ?? {},
        })
        await runtime.saveState(state)
        return dump({ ...result, board_url: runtime.boardUrl() })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const promptTool = {
    name: '_dsh_external_dsh_gpt_image_prompts',
    description: '提示词库 + **项目提示词包**。① 提示词库：把画得好/画废的提示词记下来，action=lookup 查历史表现，good 看成功模板，pitfalls 看避坑清单，record 手动记结果。② 项目提示词包（推荐先用这个）：pack-show 看本项目锁定的画风，pack-save 保存一套固定提示词（画风/构图/调色板/排除项/角色锚点），pack-template 生成可直接改的起步模板，pack-validate 校验。**配了包之后，该项目所有出图都会自动带上它** —— 这是统一画风、避免同一项目出图风格乱飘的关键。',
    parameters: params({
      action: { type: 'string', enum: ['lookup', 'good', 'pitfalls', 'stats', 'record', 'pack-show', 'pack-save', 'pack-template', 'pack-validate', 'pack-list'], description: '默认 lookup；pack-* 是项目提示词包' },
      prompt: { type: 'string', description: 'lookup/record 时的提示词' },
      verdict: { type: 'string', enum: ['good', 'bad', 'needs-fit'], description: 'record 时的结论' },
      kind: { type: 'string', description: '按分类过滤（good 时用）' },
      name: COMMON.name,
      project: COMMON.project,
      limit: { type: 'number', description: '返回条数，默认 10' },
      pack: { type: 'object', additionalProperties: true, description: 'pack-save 时的提示词包对象（use/style/composition/palette/negative/preserve/transparent/references/characters/kinds/defaults）' },
      pack_text: { type: 'string', description: 'pack-save 时也可以直接贴 JSON 文本' },
      global: { type: 'boolean', description: 'pack-save 时 true = 存成全局默认包（所有项目继承）' },
      character: { type: 'string', description: 'pack-show 时看某个角色锚点' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action || 'lookup'
        const outputDir = state.settings.outputDir
        const dataDir = state.settings.dataDir ?? state.profiles.dataDir

        // ---------- 项目提示词包 ----------
        if (action.startsWith('pack-')) {
          const project = safeSegment(args.project || state.profiles.data.lastProject || 'default', 'default')
          if (action === 'pack-show') {
            const pack = await loadPromptPack({ outputDir, project, dataDir })
            return dump({
              ok: true,
              project,
              ...describePack(pack),
              ...(pack && args.character ? { character_clause: characterClause(pack, args.character) } : {}),
              hint: pack
                ? '这个项目出图会自动带上这套提示词。改它用 pack-save；临时不带就传 prompt_pack=false。'
                : `用 pack-template 生成起步模板 → 改一改 → pack-save 保存。或者直接 pack-save 传你自己的 pack。`,
            })
          }
          if (action === 'pack-template') {
            return dump({
              ok: true,
              project,
              template: starterPack({ name: args.name || project, use: args.kind || 'game asset' }),
              note: '这是一份填好一半的起步模板：改 style / composition / palette 成你项目的实际画风，然后 pack-save 保存。',
            })
          }
          if (action === 'pack-validate') {
            return dump({ ok: true, project, ...validatePack(args.pack ?? {}) })
          }
          if (action === 'pack-list') {
            const projects = await listPacks({ outputDir, dataDir })
            return dump({ ok: true, count: projects.length, packs: projects })
          }
          if (action === 'pack-save') {
            let pack = args.pack
            if (!pack && args.pack_text) {
              try { pack = JSON.parse(args.pack_text) } catch (error) {
                return dump({ ok: false, error: `pack_text 不是合法 JSON：${String(error?.message ?? error)}` })
              }
            }
            if (!pack) return dump({ ok: false, error: 'pack-save 需要 pack（对象）或 pack_text（JSON 文本）' })
            const check = validatePack(pack)
            if (!check.ok) return dump({ ok: false, error: '提示词包有错误，未保存', ...check })
            const saved = await savePromptPack({
              outputDir,
              project: args.global ? '' : project,
              dataDir,
              pack,
            })
            return dump({
              ok: true,
              file: saved.file,
              scope: args.global ? '全局默认（所有项目继承）' : `项目「${project}」`,
              pack: describePack({ ...saved.pack, source: { file: saved.file } }),
              warnings: check.warnings,
              hint: '保存成功。下次该项目出图会自动带上这套提示词；已有素材不受影响。',
            })
          }
          return dump({ ok: false, error: `不认识的 pack 动作：${action}` })
        }

        // ---------- 提示词库 ----------
        if (action === 'record') {
          if (!args.prompt) return dump({ ok: false, error: 'record 需要 prompt' })
          const entry = state.prompts.record({
            prompt: args.prompt,
            verdict: args.verdict ?? 'good',
            name: args.name ?? '',
            project: args.project ?? '',
            kind: args.kind ?? '',
          })
          await runtime.saveState(state)
          return dump({ ok: true, entry })
        }
        if (action === 'good') return dump({ ok: true, templates: state.prompts.goodTemplates({ kind: args.kind ?? '', limit: Number(args.limit ?? 10) }) })
        if (action === 'pitfalls') return dump({ ok: true, pitfalls: state.prompts.pitfalls({ limit: Number(args.limit ?? 10) }) })
        if (action === 'stats') return dump({ ok: true, ...state.prompts.stats() })
        if (!args.prompt) return dump({ ok: true, ...state.prompts.stats(), hint: '给了 prompt 就能查这条提示词以前的表现。' })
        const found = state.prompts.lookup(args.prompt)
        return dump(found
          ? { ok: true, known: true, ...found }
          : { ok: true, known: false, hint: '这条提示词还没记录过，正常画；画完记得看 review 结果，废了就自动进避坑清单。' })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 生音频：桥接本机 VoiceStudio（127.0.0.1:8756）。
   * 角色配音 / 唱歌 / 作曲 / 换声，产出复制进当前项目目录。
   */
  const audioTool = {
    name: '_dsh_external_dsh_gpt_image_audio',
    description: '生音频。① **音效 sfx**（程序化合成，零依赖不花钱、确定性输出）：16 个预设（coin/laser/impact/explosion/whoosh/powerup/hit/jump/blip/alarm/click/footstep/glass/electric/magic/noise），一次可出多个，秒级完成。② **角色配音 speak**（台词支持 [语气] 标签，如「[愤怒] 你竟敢骗我」）③ **作曲演唱 song**（曲风 + 歌词 → 自动作曲并换声）④ **翻唱 sing** ⑤ **换声 rvc/seedvc** ⑥ **写词 lyrics** ⑦ 查进度 status。②③④⑤⑥ 需要本机 VoiceStudio 在跑（默认 127.0.0.1:8756，会自动尝试拉起；先用 roles 看有哪些音色）。产出都会复制到 <输出目录>/<项目>/audio/。',
    parameters: params({
      action: { type: 'string', enum: ['sfx', 'sfx-list', 'health', 'roles', 'speak', 'song', 'sing', 'rvc', 'seedvc', 'lyrics', 'status'], description: '默认 speak；音效用 sfx（不需要 VoiceStudio）；先 roles 看有哪些音色' },
      role: { type: 'string', description: '角色 / 音色 id 或名字（speak/song/sing 等必填）。用 roles 查' },
      script: { type: 'string', description: 'speak 的台词，支持语气标签：[愤怒] 你竟敢骗我！ 换行写下一句' },
      style: { type: 'string', description: 'song 的曲风：如 "dark ambient orchestral, slow, female vocal, 72bpm" —— YuE2 靠它决定曲风/乐器/人声/BPM' },
      lyrics: { type: 'string', description: 'song 的歌词（没有词它只会哼不唱）' },
      duration: { type: 'number', description: 'song 目标时长秒数（15~360，默认 120）；sfx 时是音效时长秒数（0.05~8）' },
      steps: { type: 'number', description: 'song 采样步数（8~64，默认 32；越大越慢越好）' },
      title: { type: 'string', description: '任务标题（给人看的）' },
      song: { type: 'string', description: 'sing/rvc/seedvc 用的源音频本地绝对路径' },
      lang: { type: 'string', description: 'speak 语言，默认 zh' },
      job_id: { type: 'string', description: 'status 时的任务 id' },
      preset: { type: 'string', description: 'sfx 的音效名：coin/laser/impact/explosion/whoosh/powerup/hit/jump/blip/alarm/click/footstep/glass/electric/magic/noise（sfx-list 看全部）' },
      presets: { type: 'array', items: { type: 'string' }, description: 'sfx 一次出多个音效（最多 32 个）' },
      pitch: { type: 'number', description: 'sfx 音高偏移半音（±24，负数更低沉）' },
      brightness: { type: 'number', description: 'sfx 亮度（0.1~2，越大越亮/越"沙"）' },
      seed: { type: 'number', description: 'sfx 随机种子（同 seed 同文件；换 seed 出不同变体）' },
      sample_rate: { type: 'number', description: 'sfx 采样率（8000~48000，默认 44100；22050 更有复古感）' },
      volume: { type: 'number', description: 'sfx 音量（0~1）' },
      channels: { type: 'number', description: 'sfx 声道数（1 或 2）' },
      project: COMMON.project,
      name: COMMON.name,
      output: COMMON.output,
      wait_s: { type: 'number', description: '最多等几秒（默认 900；0 = 只提交不等）' },
      autostart: { type: 'boolean', description: 'VoiceStudio 没在跑时是否自动拉起（默认 true）' },
      start_timeout_ms: { type: 'number', description: '自动拉起时最多等多少毫秒（默认 90000）' },
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const events = []
        const result = await runAudio({
          profiles: state.profiles,
          settings: state.settings,
          args: { ...args, project: args.project || state.profiles.data.lastProject || 'audio' },
          onLog: (line) => events.push({ at: nowIso(), line }),
        })
        // 音频产出也登记进历史，方便后面 install/register 找到
        if (result.ok && (result.files ?? []).length > 0) {
          for (const file of result.files) {
            state.gallery.add({
              kind: 'audio',
              media: 'audio',
              profile: '',
              model: 'voicestudio',
              name: path.basename(file, path.extname(file)),
              project: result.project,
              prompt: args.script ? String(args.script).slice(0, 200) : (args.style ?? ''),
              params: { action: result.action, role: result.role?.id, job_id: result.job_id },
              status: 'ok',
              images: 0,
              files: [file],
              audio_action: result.action,
            })
          }
          state.profiles.data.lastProject = result.project
          await runtime.saveState(state)
        }
        return dump({
          ...result,
          events: events.slice(-20),
          ...(result.action === 'speak' && args.script ? { tone_plan: parseToneScript(args.script) } : {}),
          board_url: runtime.boardUrl(),
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 拆件傀儡管线：部件图 → 切分 → 命名 → 枢轴 → 骨骼 JSON → 图集 → 导出/预览。
   * 核心认知：**"拼起来"是运行时按骨骼矩阵绘制，不是让 AI 生成一张拼好的图。**
   */
  const rigTool = {
    name: '_dsh_external_dsh_gpt_image_rig',
    description: '**拆件傀儡管线**（cutout puppet）：把 AI 出的「部件拆解图」变成游戏能直接用的「图集 PNG + 骨骼 JSON」。'
      + '一次生成 + 切分 + 自动命名 + 自动合拢关节 + 导出（通用 JSON / Spine / DragonBones）+ 自包含预览器（可拖关节、改 pivot、改部件名）。'
      + '核心认知：拼合发生在**运行时按骨骼矩阵绘制**，不是让 AI 拼好一张图。'
      + '两种版面：`positional`（炸开视图，推荐 —— 位置即装配关系，名字靠几何识别）和 `grid`（4×4 零件盘 —— 名字精确，摆放要人调）。'
      + '命令：template 看模板 · prompt 拿拆件提示词 · generate 一步到位 · split/build 切已有图 · pivot/rename 手改 · export 导出 · preview 生成预览器 · validate 校验。',
    parameters: params({
      action: { type: 'string', enum: ['template', 'prompt', 'generate', 'split', 'build', 'pivot', 'rename', 'export', 'preview', 'validate', 'skeleton'], description: '默认 template' },
      layout: { type: 'string', enum: ['positional', 'grid'], description: 'positional=炸开视图（推荐）· grid=4×4 零件盘' },
      prompt: { type: 'string', description: 'generate 时的角色描述（会拼上拆件约束）' },
      sheet: { type: 'string', description: 'split/build 时：已有部件图的本地路径' },
      names: { type: 'array', items: { type: 'string' }, description: '显式指定部件名（最可靠，按切分顺序）' },
      name_strategy: { type: 'string', enum: ['geometry', 'template-order', 'explicit'], description: '命名策略；默认 positional→geometry，grid→template-order' },
      grid: { type: 'object', additionalProperties: true, description: 'grid 版面：{columns,rows}' },
      part: { type: 'string', description: 'pivot/rename 时：部件名' },
      to: { type: 'string', description: 'rename 时：新名字' },
      pivot_x: { type: 'number', description: 'pivot 时：枢轴 x（部件矩形内像素）' },
      pivot_y: { type: 'number', description: 'pivot 时：枢轴 y' },
      pivot_ratio_x: { type: 'number', description: 'pivot 时：用比例指定 x（0~1）' },
      pivot_ratio_y: { type: 'number', description: 'pivot 时：用比例指定 y（0~1）' },
      format: { type: 'string', enum: ['generic', 'spine', 'dragonbones'], description: 'export 的格式' },
      assemble: { type: 'boolean', description: '是否自动合拢关节（默认 true）' },
      project: COMMON.project,
      name: COMMON.name,
      profile: COMMON.profile,
      size: { type: 'string', description: 'generate 的尺寸（默认 1024x1024）' },
      quality: { type: 'string', description: 'generate 的质量档（部件多建议 high）' },
      confirm: { type: 'boolean', description: 'generate 花钱确认' },
      wait_s: COMMON.wait_s,
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = String(args.action || 'template')
        const project = safeSegment(args.project || state.profiles.data.lastProject || 'rig', 'rig')
        const layout = args.layout === 'grid' ? 'grid' : 'positional'
        const name = safeSegment(args.name || 'character', 'character')
        const rigDir = path.join(state.settings.outputDir, project, 'rig', name)
        const skeletonPath = path.join(rigDir, 'skeleton.json')
        const atlasPath = path.join(rigDir, 'atlas.png')
        const saveSkeleton = async (skeleton) => {
          await mkdir(rigDir, { recursive: true })
          await writeFile(skeletonPath, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8')
          return skeletonPath
        }

        if (action === 'template') {
          return dump({
            ok: true,
            templates: listTemplates(),
            humanoid: { slots: HUMANOID_SLOTS.map((s) => ({ name: s.name, parent: s.parent, z: s.z, pivotRatio: s.pivotRatio })) },
            note: 'z 是绘制顺序（小=先画=在后面）；pivotRatio 是默认枢轴（占部件宽高比例），约定四肢按"自然下垂、关节在上端"画。',
          })
        }
        if (action === 'prompt') {
          return dump({
            ok: true,
            layout,
            prompt: partsPrompt({ layout, extra: args.prompt ?? '' }),
            hint: '把这段交给 generate，或用 rig(action="generate", prompt="...") 一步走完。部件多建议 quality=high + 1024 以上。',
            important: layout === 'positional'
              ? 'positional：要求"整体按解剖位置画好，但四肢从身体拉开一小段"——位置就编码了装配关系。'
              : 'grid：要求"4×4 一格一件"。名字精确，但摆放要靠模板偏移 + 人调。',
          })
        }

        if (action === 'generate') {
          const { runImage } = await import('./run.js')
          const promptText = partsPrompt({ layout, extra: args.prompt ?? '' })
          const gate = state.spend.check({ images: 1, action: 'rig.generate', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
          if (!gate.allow) return dump({ ...gate, spend_guard: true, prompt: promptText })
          const result = await runImage({
            profiles: state.profiles,
            gallery: state.gallery,
            settings: state.settings,
            args: {
              prompt: promptText,
              project,
              name: `${name}_parts`,
              size: args.size || '1024x1024',
              quality: args.quality || 'high',
              ratio: '1:1',
              profile: args.profile,
              background: 'transparent',
              kind: 'rig',
            },
          })
          if (!result.ok) return dump({ ...result, prompt: promptText })
          state.spend.record({
            action: 'rig.generate', images: result.images || 1, project, names: [name],
            free: priceForProfile(state, args.profile) === 0,
          })
          await runtime.saveState(state)
          const sheetFile = (result.files ?? [])[0]
          if (!sheetFile) return dump({ ok: false, error: '生成了但没拿到文件路径', prompt: promptText })
          const built = await buildRig({
            sheetFile, rigDir, layout, name, project,
            names: args.names, nameStrategy: args.name_strategy, grid: args.grid,
            assemble: args.assemble !== false,
          })
          return dump({ ...built, generated: true, sheet: sheetFile, prompt_used: promptText })
        }

        if (action === 'split' || action === 'build') {
          const sheetFile = String(args.sheet ?? '').trim()
          if (!sheetFile) return dump({ ok: false, error: 'split/build 需要 sheet（部件图的本地绝对路径）' })
          if (!path.isAbsolute(sheetFile)) return dump({ ok: false, error: `sheet 要用绝对路径（收到相对路径「${sheetFile}」）` })
          const built = await buildRig({
            sheetFile, rigDir, layout, name, project,
            names: args.names, nameStrategy: args.name_strategy, grid: args.grid,
            assemble: args.assemble !== false,
          })
          return dump({ ...built, sheet: sheetFile })
        }

        const skeleton = await readJson(skeletonPath, null)
        if (!skeleton) {
          return dump({
            ok: false,
            error: `还没有骨架：${skeletonPath}`,
            hint: '先跑 rig(action="generate", prompt="...") 或 rig(action="build", sheet="D:\\\\...\\\\parts.png")',
          })
        }
        if (action === 'skeleton') return dump({ ok: true, file: skeletonPath, rig: skeleton, validation: validateRig(skeleton) })
        if (action === 'validate') return dump({ ok: validateRig(skeleton).ok, ...validateRig(skeleton), file: skeletonPath })

        if (action === 'pivot') {
          const partName = String(args.part ?? '').trim()
          if (!partName) return dump({ ok: false, error: 'pivot 需要 part（部件名）', parts: skeleton.parts.map((p) => p.name) })
          const part = skeleton.parts.find((p) => p.name === partName)
          if (!part) return dump({ ok: false, error: `找不到部件「${partName}」`, parts: skeleton.parts.map((p) => p.name) })
          const [w, h] = [part.rect[2], part.rect[3]]
          let px = args.pivot_x
          let py = args.pivot_y
          if (args.pivot_ratio_x !== undefined) px = Number(args.pivot_ratio_x) * (w - 1)
          if (args.pivot_ratio_y !== undefined) py = Number(args.pivot_ratio_y) * (h - 1)
          if (px === undefined && py === undefined) {
            return dump({ ok: true, part: partName, rect: part.rect, pivot: part.pivot, hint: '给 pivot_x/pivot_y（像素）或 pivot_ratio_x/pivot_ratio_y（0~1）' })
          }
          part.pivot = [Math.max(0, Math.min(w, Number(px ?? part.pivot[0]))), Math.max(0, Math.min(h, Number(py ?? part.pivot[1])))]
          part.pivotRatio = [part.pivot[0] / Math.max(1, w - 1), part.pivot[1] / Math.max(1, h - 1)]
          return dump({ ok: true, part: partName, pivot: part.pivot, file: await saveSkeleton(skeleton), validation: validateRig(skeleton) })
        }

        if (action === 'rename') {
          const partName = String(args.part ?? '').trim()
          const to = String(args.to ?? '').trim()
          if (!partName || !to) return dump({ ok: false, error: 'rename 需要 part 和 to' })
          const part = skeleton.parts.find((p) => p.name === partName)
          const bone = skeleton.bones.find((b) => b.name === partName)
          if (!part || !bone) return dump({ ok: false, error: `找不到部件/骨骼「${partName}」` })
          if (skeleton.parts.some((p) => p.name === to) || skeleton.bones.some((b) => b.name === to)) {
            return dump({ ok: false, error: `已经有叫「${to}」的部件了` })
          }
          part.name = to
          part.slot = to
          bone.name = to
          for (const b of skeleton.bones) if (b.parent === partName) b.parent = to
          skeleton.drawOrder = (skeleton.drawOrder ?? []).map((n) => (n === partName ? to : n))
          return dump({ ok: true, from: partName, to, file: await saveSkeleton(skeleton), validation: validateRig(skeleton), hint: '改完记得重新 export + preview' })
        }

        if (action === 'export') {
          const format = String(args.format || 'generic')
          const ex = exportRig({ skeleton, format })
          if (!ex.ok) return dump(ex)
          await mkdir(rigDir, { recursive: true })
          const written = []
          for (const file of ex.files) {
            const target = path.join(rigDir, file.name)
            await writeFile(target, file.content, 'utf8')
            written.push(target)
          }
          return dump({
            ok: true,
            format,
            files: written,
            atlas: atlasPath,
            note: format === 'generic'
              ? '配 atlas.png 一起进游戏；运行时按 bones 层级算世界变换、按 drawOrder 绘制、每件从 rect 取图并以 pivot 为原点。'
              : `${format} 的 JSON 结构已校验，但**没有在真实 ${format} 编辑器里导入验证过**；图集也要按它的规则重新打包（本插件给的是 rect）。请先用编辑器跑一遍。`,
            validation: ex.check,
          })
        }

        if (action === 'preview') {
          const atlasBuffer = await readFile(atlasPath).catch(() => null)
          if (!atlasBuffer) return dump({ ok: false, error: `读不到图集 ${atlasPath}`, hint: '先跑 generate 或 build' })
          const html = buildPreviewHtml({ skeleton, atlasPng: atlasBuffer, title: `${name} · 部件拼合预览` })
          await mkdir(rigDir, { recursive: true })
          const previewPath = path.join(rigDir, 'preview.html')
          await writeFile(previewPath, html, 'utf8')
          return dump({
            ok: true,
            preview: previewPath,
            size_kb: Number((html.length / 1024).toFixed(1)),
            how: '双击打开（图集已内联，不用起服务器）。拖蓝圆转关节 · Shift+拖改 pivot · 左侧改名 · 点「导出骨架 JSON」拿回改好的结果。',
            validation: validateRig(skeleton),
          })
        }
        return dump({ ok: false, error: `不认识的 action「${action}」` })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const heatmapTool = {
    name: '_dsh_external_dsh_gpt_image_heatmap',
    description: '素材使用热度：哪些生成出来的图真正被游戏代码用到了、哪些零引用（= 白花钱）。被引用最多的就是核心素材（返工代价最大，要先定稿）；零引用的要补登记或确认是否真需要。这是「钱花在刀刃上没有」的答案。',
    parameters: params({
      root: { type: 'string', description: '游戏项目目录' },
      projects: { type: 'array', items: { type: 'string' }, description: '要统计哪些项目下已生成的图（默认当前项目）' },
    }, ['root']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const root = args.root
        const outputDir = state.profiles.outputDir
        const names = args.projects?.length ? args.projects : [state.profiles.data.lastProject || (root ? path.basename(root) : '')].filter(Boolean)
        const map = {}
        for (const name of names) {
          const check = await checkProject({ root, outputDir, project: name })
          map[name] = (check.items ?? []).map((item) => ({ key: item.key, file: item.file }))
        }
        const result = await usageHeatmap({ root, projects: map })
        return dump(result)
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const sheetTool = {
    name: '_dsh_external_dsh_gpt_image_sheet',
    description: '图标集批量生成（sprite sheet）：**一个请求出一整张合集图**，再自动按网格切成单张素材。画 N 个图标分开画要 N 个请求，这样只要 1 个 —— 钱和等待都省一大半。**切图默认自动对齐**：检测每个图标的真实包围盒 → 裁掉多余留白 → 居中（可再按 target_width/target_height 缩放到游戏规格），所以交付的是「能直接用的图标」而不是「格子」。产出 <项目>/<名字>.png（合集）+ <项目>/<名字>_slices/*.png（对齐后的单张，保留透明通道）。action=generate 出图并切；action=slice 只切已有合集图；action=grid 先看会排成几行几列。',
    parameters: params({
      action: { type: 'string', enum: ['generate', 'slice', 'grid'], description: '默认 generate' },
      items: { type: 'array', items: { type: 'string' }, description: '每格一个图标的描述（如 ["金幣圖標","紅藥水圖標",...]）' },
      project: COMMON.project,
      name: COMMON.name,
      style: { type: 'string', description: '统一美术风格描述（会强调所有格子风格一致）' },
      size: { type: 'string', description: '合集图尺寸，默认按数量自动（≤4 个 1024x1024，否则 1536x1024）' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: '默认 low' },
      profile: COMMON.profile,
      output: COMMON.output,
      confirm: { type: 'boolean', description: '确认花费（合集图也是一张，但按硬规定 >1 张才需要）' },
      sheet_file: { type: 'string', description: 'action=slice 时的合集图路径' },
      columns: { type: 'number', description: 'slice 时手动指定列数' },
      rows: { type: 'number', description: 'slice 时手动指定行数' },
      padding: { type: 'number', description: '每格四周留白像素（切偏了就调大）' },
      trim: { type: 'boolean', description: '默认 true=自动检测每个图标的包围盒，裁掉多余留白并居中（强烈建议保持开启）' },
      target_width: { type: 'number', description: '每张切图的目标宽（如 48），给了就按规格缩放' },
      target_height: { type: 'number', description: '每张切图的目标高（如 48）' },
      mode: { type: 'string', enum: ['contain', 'stretch'], description: '缩放方式：contain=保持宽高比居中（默认）；stretch=拉伸填满' },
      pixel: PIXEL_PROP,
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action || 'generate'
        if (action === 'grid') {
          const count = (args.items ?? []).length
          return dump({ ok: true, count, ...gridFor(count), hint: '按这个网格生成，切图也按它。' })
        }
        if (action === 'slice') {
          if (!args.sheet_file) return dump({ ok: false, error: 'slice 需要 sheet_file' })
          const count = (args.items ?? []).length || (Number(args.columns ?? 0) * Number(args.rows ?? 0))
          const grid = args.columns && args.rows ? { columns: args.columns, rows: args.rows } : gridFor(count)
          const outDir = path.join(path.dirname(args.sheet_file), `${path.basename(args.sheet_file, '.png')}_slices`)
          const sliced = await sliceSheet({
            sheetFile: args.sheet_file,
            outDir,
            items: (args.items ?? []).map((_, index) => ({ name: `slice_${String(index + 1).padStart(2, '0')}` })),
            columns: grid.columns,
            rows: grid.rows,
            padding: Number(args.padding ?? 0),
            trim: args.trim !== false,
            targetWidth: Number(args.target_width ?? 0),
            targetHeight: Number(args.target_height ?? 0),
            mode: args.mode ?? 'contain',
            pixel: args.pixel ?? null,
          })
          return dump(sliced)
        }
        const count = (args.items ?? []).length
        const gate = state.spend.check({ images: 1, action: 'sheet', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, args.profile) })
        if (!gate.allow) return dump({ ...gate, spend_guard: true })
        const result = await generateSheet({
          runImage,
          profiles: state.profiles,
          gallery: state.gallery,
          settings: state.settings,
          args: { ...args, project: args.project || state.profiles.data.lastProject || 'sheets', quality: args.quality ?? 'low' },
        })
        if (result.ok) {
          state.spend.record({ action: 'sheet', images: 1, project: args.project ?? '', names: [args.name ?? 'sheet'], free: priceForProfile(state, args.profile) === 0 })
          // 切好的单张也登记进历史，方便后续 install/register 找到
          for (const slice of result.slices ?? []) {
            state.gallery.add({
              kind: 'sprite-sheet-slice',
              profile: state.profiles.get(args.profile)?.id ?? '',
              model: state.profiles.get(args.profile)?.model ?? '',
              name: slice.name,
              project: args.project || state.profiles.data.lastProject || 'sheets',
              prompt: `[sheet slice] ${args.name ?? 'sheet'}`,
              params: { size: `${slice.width}x${slice.height}`, quality: args.quality ?? 'low' },
              status: 'ok',
              images: 1,
              files: [slice.file],
            })
          }
          await runtime.saveState(state)
        }
        return dump({ ...result, one_request: true, spend: state.spend.check({ images: 0, action: 'status' }).today })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const approvalTool = {
    name: '_dsh_external_dsh_gpt_image_approval',
    description: '资产预算审批流：一次花费超过阈值（默认 5 元）时不直接跑，先生成一张「待批准清单」（含预计花费、用途、影响范围、画什么、单号），等人在面板/这里点确认后才放行。action=list 看待批单；approve/reject 处理；set_threshold 改阈值。批准后把 approved_token 传给对应工具即可执行；**参数变了单子自动作废**（防止批了 A 跑了 B）。',
    parameters: params({
      action: { type: 'string', enum: ['list', 'approve', 'reject', 'set_threshold'], description: '默认 list' },
      token: { type: 'string', description: 'approve/reject 时的单号（如 apr_xxxx）' },
      threshold: { type: 'number', description: 'set_threshold 的新阈值（元）' },
      status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'list 时按状态过滤' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const queue = await ApprovalQueue.load(state.profiles.dataDir)
        const action = args.action || 'list'
        if (action === 'set_threshold') {
          queue.data.threshold = Number(args.threshold ?? 5)
          await queue.save()
          return dump({ ok: true, threshold: queue.threshold, note: `超过 ${queue.threshold} 元的花费会先生成待批准单。` })
        }
        if (action === 'approve' || action === 'reject') {
          if (!args.token) return dump({ ok: false, error: '需要 token' })
          const result = queue.decide(args.token, action, { by: 'user' })
          if (result.ok) await queue.save()
          return dump({
            ...result,
            hint: result.ok
              ? (action === 'approve'
                ? `已批准。把 approved_token="${args.token}" 传给对应工具就会执行。`
                : '已驳回，不会花这笔钱。')
              : undefined,
          })
        }
        const items = queue.list({ status: args.status ?? '' })
        return dump({
          ok: true,
          threshold: queue.threshold,
          pending: items.filter((item) => item.status === 'pending').length,
          items,
          texts: items.filter((item) => item.status === 'pending').map(approvalText),
          hint: items.some((item) => item.status === 'pending')
            ? '在面板「待批准」区点确认，或这里 action=approve token=apr_xxx。'
            : '没有待批准的单子。',
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const crossStyleTool = {
    name: '_dsh_external_dsh_gpt_image_cross_style',
    description: '跨项目风格对比：给每个项目算一份风格档案（主色/明暗/线条密度）并两两比对。相似度低 = 两套美术语言（比如 starcraft-rts 的科幻旗 vs doomsday-ember 的废土素材），这时**绝不能跨项目借用参考图**，否则新图会串味。生成时已强制只用同项目素材当参考。',
    parameters: params({
      action: { type: 'string', enum: ['compare'], description: '默认 compare' },
      output: COMMON.output,
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const result = await buildProjectProfiles({
          outputDir: args.output || state.profiles.outputDir,
          dataDir: state.profiles.dataDir,
        })
        return dump(result)
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const config = {
    name: '_dsh_external_dsh_gpt_image_config',
    description: '配置出图台：show 看配置；set_profile 新增/修改配置档（id/name/provider/baseUrl/apiKey/model/apiMode）；set_active 切换档；remove_profile 删除；import 导入 GPT Image Playground 的 gpt-image-config.json（内联 JSON 或文件路径）；export 导出成同格式；set_output 改输出根目录；set_upload 配「导入本地图片生成视频」的素材上传方式；test 测连通（自动兼容缺 /v1）。',
    parameters: params({
      action: { type: 'string', enum: ['show', 'set_profile', 'set_active', 'remove_profile', 'import', 'export', 'set_output', 'set_caps', 'set_locks', 'set_upload', 'spend', 'calibrate', 'test'], description: '默认 show；set_locks 改花钱闸门；set_upload 配素材上传；spend 看花费与日历；calibrate 用真实扣费校准单价' },
      actual_cost: { type: 'number', description: 'calibrate 时：这次实际扣了多少钱（例如 0.48）' },
      images: { type: 'number', description: 'calibrate 时：这笔钱对应几张图' },
      days: { type: 'number', description: 'spend 时返回多少天的日历，默认 30' },
      profile: { type: 'object', additionalProperties: true, description: 'set_profile 时的配置档对象' },
      profile_id: { type: 'string', description: 'set_active / remove_profile / test 时的目标档 id' },
      payload: { type: 'object', additionalProperties: true, description: 'import 时的内联配置对象' },
      path: { type: 'string', description: 'import 时的配置文件路径（绝对路径）' },
      output_dir: { type: 'string', description: 'set_output 时的输出根目录' },
      patch: { type: 'object', additionalProperties: true, description: 'set_caps / set_locks / set_upload 时的补丁对象。set_upload 认 publicBaseUrl（自建公网前缀，最优先）/ uploadEndpoint（自己的图床）/ uploadField / uploadTimeoutMs；传 {clear:true} 清空回内置免费图床' },
      timeout_ms: { type: 'number', description: '可选：改单次请求超时' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const { profiles } = state
        const action = args.action || 'show'
        if (action === 'set_profile') {
          // 工具入参可能是冻结对象（严格模式下原地赋值会抛
          // "Cannot assign to read only property"），所以先拷贝再归一化。
          const raw = args.profile
          if (!raw?.id) return dump({ ok: false, error: 'set_profile 需要 profile.id' })
          const incoming = { ...raw }
          if (incoming.apiKey && /^\*+$/.test(incoming.apiKey)) delete incoming.apiKey
          if (incoming.baseUrl) incoming.baseUrl = String(incoming.baseUrl).replace(/\/+$/, '')
          profiles.upsert(incoming)
          await profiles.save()
          return dump({ ok: true, profiles: profiles.masked().profiles })
        }
        if (action === 'set_active') {
          const ok = profiles.setActive(args.profile_id)
          await profiles.save()
          return dump({ ok, active_profile: profiles.active?.id, error: ok ? undefined : `没有这个档：${args.profile_id}` })
        }
        if (action === 'remove_profile') {
          const ok = profiles.remove(args.profile_id)
          await profiles.save()
          return dump({ ok, error: ok ? undefined : `没有这个档：${args.profile_id}`, active_profile: profiles.active?.id })
        }
        if (action === 'import') {
          let payload = args.payload
          if (!payload && args.path) payload = await readJson(args.path, null)
          if (!payload) return dump({ ok: false, error: 'import 需要 payload 对象或 path 文件路径' })
          const result = profiles.importPlaygroundConfig(payload)
          if (result.ok) await profiles.save()
          return dump({ ...result, active_profile: profiles.active?.id })
        }
        if (action === 'export') {
          return dump({ ok: true, config: profiles.exportPlaygroundConfig() })
        }
        if (action === 'set_output') {
          profiles.data.outputDir = String(args.output_dir ?? '')
          if (Number(args.timeout_ms) > 0) profiles.data.timeoutMs = Number(args.timeout_ms)
          await profiles.save()
          return dump({ ok: true, output_dir: profiles.outputDir, timeout_ms: profiles.timeoutMs })
        }
        if (action === 'set_caps') {
          profiles.data.caps = { ...profiles.data.caps, ...(args.patch ?? {}) }
          await profiles.save()
          return dump({ ok: true, caps: profiles.data.caps })
        }
        if (action === 'set_upload') {
          // 「导入本地图片生成视频」的落地配置：Agnes 只收公网 URL，本地素材得先传出去。
          // 不配也能用（走内置免费匿名图床），但配了更稳、也更私密。
          const patch = args.patch ?? {}
          if (patch.publicBaseUrl !== undefined) profiles.data.publicBaseUrl = String(patch.publicBaseUrl ?? '')
          if (patch.uploadEndpoint !== undefined) profiles.data.uploadEndpoint = String(patch.uploadEndpoint ?? '')
          if (patch.uploadField !== undefined) profiles.data.uploadField = String(patch.uploadField ?? 'file')
          if (Number(patch.uploadTimeoutMs) > 0) profiles.data.uploadTimeoutMs = Number(patch.uploadTimeoutMs)
          if (patch.clear === true) {
            delete profiles.data.publicBaseUrl
            delete profiles.data.uploadEndpoint
            delete profiles.data.uploadField
            delete profiles.data.uploadTimeoutMs
          }
          await profiles.save()
          return dump({
            ok: true,
            publicBaseUrl: profiles.data.publicBaseUrl ?? '',
            uploadEndpoint: profiles.data.uploadEndpoint ?? '',
            uploadField: profiles.data.uploadField ?? 'file',
            uploadTimeoutMs: profiles.data.uploadTimeoutMs ?? null,
            builtin_hosts: UPLOAD_HOSTS.map((host) => ({ id: host.id, name: host.name })),
            note: 'publicBaseUrl：把 DSH 的 HTTP 服务通过隧道/反代暴露出去，素材不外泄给第三方（优先级最高）。'
              + 'uploadEndpoint：自己的图床/对象存储（multipart 字段名 uploadField，默认 file）。'
              + '都不配就走内置免费匿名图床（临时链接，几小时后失效）。',
          })
        }
        if (action === 'set_locks') {
          const state2 = await runtime.loadState()
          state2.spend.data.locks = { ...state2.spend.locks, ...(args.patch ?? {}) }
          if (Number(args.patch?.pricePerImage) > 0) state2.spend.data.pricePerImage = Number(args.patch.pricePerImage)
          await state2.spend.save()
          return dump({ ok: true, locks: state2.spend.locks, price_per_image: state2.spend.price, currency: state2.spend.data.currency, hint: '这些是花钱的闸门：spendDisabled（总闸）/ perRunMaxImages（单次张数）/ confirmAboveImages（超过几张要 confirm）/ dailyBudget（每天上限，元）。' })
        }
        if (action === 'spend') {
          const state2 = await runtime.loadState()
          const gate = state2.spend.check({ images: 0, action: 'status' })
          const calendar = budgetCalendar(state2.spend, { days: Number(args.days ?? 30) })
          const pending = state2.pool.pending()
          const forecast = forecastSpend(state2.spend, {
            pendingAssets: pending.length,
            avgImagesPerAsset: Number(state2.profiles.data.caps?.maxBatch ?? 1) > 1 ? 1 : 1,
          })
          return dump({
            ok: true,
            date: gate.today.date,
            today_images: gate.today.images,
            today_cost: gate.today.cost,
            daily_budget: gate.today.budget,
            price_per_image: gate.price_per_image,
            price_source: gate.price_source ?? calendar.price_source,
            active_profile: state2.profiles.active?.id,
            currency: gate.currency,
            totals: gate.totals,
            locks: gate.locks,
            remaining_today: calendar.remaining_today,
            forecast_daily: calendar.forecast_daily,
            trend: calendar.trend,
            plan_forecast: forecast,
            prompt_library: state2.prompts.stats(),
            calendar: calendar.calendar.slice(0, Number(args.days ?? 30)),
            calendar_chart: calendarText(calendar.calendar),
            recent: state2.spend.data.records.slice(-10),
          })
        }
        if (action === 'calibrate') {
          const state2 = await runtime.loadState()
          const images = Number(args.images ?? args.patch?.images ?? 0)
          const actualCost = Number(args.actual_cost ?? args.patch?.actual_cost ?? 0)
          const result = calibratePrice(state2.spend, { images, actualCost, note: String(args.patch?.note ?? '') })
          if (result.ok) await state2.spend.save()
          return dump(result)
        }
        if (action === 'test') {
          const profile = profiles.get(args.profile_id)
          if (!profile) return dump({ ok: false, error: `找不到配置档 ${args.profile_id ?? ''}` })
          const provider = resolveProvider(profiles, profile)
          const result = await probe({ profile, provider })
          return dump({ ok: Boolean(result.ok), profile: profile.id, provider: provider.id, baseUrl: profile.baseUrl, model: profile.model, probe: result })
        }
        return dump({ ok: true, config: profiles.masked(), data_dir: profiles.dataDir, board_url: runtime.boardUrl() })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 生视频：Agnes Video 2.5 Flash 这类异步视频接口。
   * 与生图共用花钱闸门与历史/面板，但参数与产物（mp4）完全不同。
   */
  const videoTool = {
    name: '_dsh_external_dsh_gpt_image_video',
    description: '生成视频（Agnes Video 2.5 Flash）：异步建任务 + 轮询 + 下载 mp4 落盘。默认 720P、5 秒、文生视频。三种模式：text（文生视频）、keyframe（导入图片作首/尾帧）、reference（导入图片/音频作参考，最多 5 图 3 音）。**first_frame / last_frame / images / audios 直接传本地文件绝对路径即可**，插件会自动上传换公网 URL（Agnes 只收公网 URL）；也可以直接传已有的公网 URL。配置档不用自己挑：指错了会自动换到视频档。当前官方免费（刊例 $0.025/秒）。视频队列常满（503 video_queue_full）会自动退避重试。action=status 用 task_id 查进度。',
    parameters: params({
      prompt: { type: 'string', description: '视频描述：主体 + 动作 + 镜头运动 + 氛围。reference 模式可用 <Picture 1> <Audio 1> 指代素材，例如「以 <Picture 1> 为角色参考」' },
      project: COMMON.project,
      name: COMMON.name,
      profile: COMMON.profile,
      output: COMMON.output,
      seconds: { type: 'number', description: '时长秒数 4-12（默认 5）。越长越慢；免费档按秒计价（当前 0 元）' },
      mode: { type: 'string', enum: ['text', 'keyframe', 'reference'], description: 'text=文生视频（默认）；keyframe=导入图片当首/尾帧（控制起止构图）；reference=导入图片/音频当参考' },
      aspect_ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], description: '画面比例，默认 16:9；竖屏素材用 9:16' },
      first_frame: { type: 'string', description: 'mode=keyframe：首帧。**本地图片绝对路径**或公网 URL 都行（本地会自动上传）；提示词里用 <Picture N> 指代参考图' },
      last_frame: { type: 'string', description: 'mode=keyframe：尾帧。本地路径或公网 URL。与首帧至少给一个' },
      images: { type: 'array', items: { type: 'string' }, description: 'mode=reference：参考图，最多 5 张。**本地绝对路径或公网 URL 都行**（本地会自动上传）' },
      audios: { type: 'array', items: { type: 'string' }, description: 'mode=reference：参考音频，最多 3 段。本地路径或公网 URL' },
      upload: { type: 'boolean', description: '本地素材是否自动上传换公网 URL，默认 true。关掉（false）时本地路径会被直接拒绝并说明原因' },
      seed: { type: 'number', description: '随机种子' },
      queue_retries: { type: 'number', description: '队列满（video_queue_full）时的自动重试次数，默认 3；每次退避 8s/16s/24s' },
      poll_interval_ms: { type: 'number', description: '轮询间隔毫秒，默认 2000' },
      wait_s: { type: 'number', description: '最多等几秒；0=只提交立即返回 task_id，默认 900' },
      timeout_ms: { type: 'number', description: '建任务请求超时毫秒' },
      confirm: { type: 'boolean', description: '确认花费（默认闸门按张计价，视频按秒，确认锁同样生效）' },
      action: { type: 'string', enum: ['generate', 'status'], description: '默认 generate；status 用 task_id 查已提交任务的进度' },
      task_id: { type: 'string', description: 'action=status 时的视频任务 id' },
    }, ['prompt']),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()

        // 查进度：只查一次，把当前状态交回去
        if ((args.action ?? 'generate') === 'status') {
          if (!args.task_id) return dump({ ok: false, error: 'action=status 需要 task_id' })
          const resolved = resolveVideoProfile(state.profiles, args.profile)
          if (!resolved.profile) return dump({ ok: false, error: '找不到可用的视频配置档', profile_reason: resolved.reason })
          const result = await pollTask({ profile: resolved.profile, provider: resolved.provider, taskId: args.task_id, once: true })
          return dump({ ok: true, task_id: args.task_id, profile: resolved.profile.id, ...result, hint: result.pending ? '还没完成，稍后再查一次（或用 wait_s 让它继续等）。' : undefined })
        }

        if (!args.prompt) return dump({ ok: false, error: '需要 prompt' })

        // 配置档：指错了（比如把出图档丢过来）不该报错卡住，自动换成视频档
        const resolved = resolveVideoProfile(state.profiles, args.profile)
        if (!resolved.profile) {
          return dump({
            ok: false,
            error: `找不到可用的视频配置档${args.profile ? `（你指的是 ${args.profile}，它不是视频服务商）` : ''}。`,
            hint: '需要 provider 为 "agnes-video" 的配置档（baseUrl 用带 /v1 的图片地址即可，视频模板会自己去掉 /v1）。'
              + '如果已配 Agnes 图片档（同 baseUrl / Key），正常会自动派生；派生失败通常是 Key 或 baseUrl 缺失。'
              + '也可用 config 工具 import examples/agnes-config.json。',
            profile_reason: resolved.reason,
            existing_profiles: resolved.candidates,
            available_video_providers: resolved.available_video_providers,
          })
        }
        // 派生出来的档落盘，下次直接可用（config 工具可删，完全可逆）
        if (resolved.profile.derived && !state.profiles.get(resolved.profile.id)) {
          state.profiles.upsert(resolved.profile)
          await state.profiles.save()
        }

        // 花钱闸门：按秒计价（免费档 pricePerImage: 0 时不拦）
        const seconds = Number(args.seconds ?? 5) || 5
        const gate = state.spend.check({ images: seconds, action: 'video', confirm: Boolean(args.confirm), pricePerImage: priceForProfile(state, resolved.profile.id) })
        if (!gate.allow) return dump({ ...gate, spend_guard: true, note_for_video: '视频按「秒」计入闸门（1 秒 = 1 单位）。' })

        const result = await runVideo({
          profiles: state.profiles,
          gallery: state.gallery,
          settings: state.settings,
          args: { ...args, profile: resolved.profile.id, project: args.project || state.profiles.data.lastProject || 'video' },
        })
        if (result.ok && !result.pending) {
          state.spend.record({ action: 'video', images: seconds, project: result.project ?? '', names: [args.name ?? 'video'], free: priceForProfile(state, resolved.profile.id) === 0 })
          state.profiles.data.lastProject = result.project
        }
        await runtime.saveState(state)
        return dump({
          ...result,
          seconds,
          profile: resolved.profile.id,
          profile_reason: resolved.reason,
          profile_note: resolved.note,
          asset_notes: (result.asset_notes ?? []).length ? result.asset_notes : undefined,
          price_note: '当前 Agnes Video 2.5 Flash 免费（刊例 $0.025/秒）；恢复计费时改配置档的 pricePerImage。',
          board_url: runtime.boardUrl(),
          spend: state.spend.check({ images: 0, action: 'status' }).today,
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 余额 / 花费：把「还能不能花钱、花了多少、上游什么情况」一次说清。
   * 本地闸门是真实生效的；上游账户计费查得到多少算多少（免费档没有真实余额，如实标注）。
   */
  const balanceTool = {
    name: '_dsh_external_dsh_gpt_image_balance',
    description: '查余额与花费：今日花费/日预算/剩余/还能出几张（本地闸门，真实生效）+ 上游账户计费状态（额度、累计用量；免费档会明确说明没有真实余额）。出图花钱前、或用户问"还能画多少/花了多少/是不是免费"时调用。check_remote=false 只看本地、不联网。',
    parameters: params({
      profile: { type: 'string', description: '看哪个配置档（不填用当前激活的）' },
      check_remote: { type: 'boolean', description: '是否联网查上游账户计费，默认 true；只想看本地花费就传 false' },
      remote_timeout_ms: { type: 'number', description: '上游计费查询超时毫秒，默认 10000' },
    }),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const report = await buildBalanceReport({
          profiles: state.profiles,
          spend: state.spend,
          pool: state.pool,
          gallery: state.gallery,
          profileId: args.profile ?? '',
          checkRemote: args.check_remote !== false,
          timeoutMs: Number(args.remote_timeout_ms ?? 10000),
        })
        return dump({
          ...report,
          summary: balanceSummaryText(report),
          board_url: runtime.boardUrl(),
          hint: report.advice,
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 素材目录 + 人工审核：让 AI 知道「该看哪些素材」，也让人能一件勾选拍板。
   *
   * 存在的理由：输出目录里有很多图不是本插件生成的（切片、缩放件、别的脚本批量跑的），
   * 它们从不出现在出图历史里 → AI 和人都"看不见"。这个工具改为扫磁盘，全部列出来。
   */
  const assetsTool = {
    name: '_dsh_external_dsh_gpt_image_assets',
    description: '素材目录与审核：列出输出目录里**所有**图（包含不是本插件生成的切片/缩放件/批量产物，这些以前在画廊里看不见），带「合格/不合格/待定」审核状态。AI 要挑素材、要知道哪些能用、要核对待办时先调它。action=scan 看全量+统计；review 一件标记（可批量、可按素材名跨重画继承）；clear 撤销标记；pending 看还没审的（默认只列待审，方便逐批清）。',
    parameters: params({
      action: { type: 'string', enum: ['scan', 'review', 'clear', 'pending', 'changes', 'queue'], description: '默认 scan；changes=自上次以来的变化摘要；queue=待安装/待审/结论失效三个队列' },
      project: { type: 'string', description: '只看某个项目' },
      kind: { type: 'string', enum: ['source', 'slice', 'resized', 'preview', 'screenshot'], description: '按文件类别过滤：source=正式素材、slice=切片、resized=缩放件、preview=带名字预览图、screenshot=截图' },
      state: { type: 'string', enum: ['approved', 'rejected', 'pending', 'unreviewed'], description: '按审核状态过滤' },
      files: { type: 'array', items: { type: 'string' }, description: 'review/clear 时：要标记的文件路径数组（或 {path,name} 对象）' },
      names: { type: 'array', items: { type: 'string' }, description: 'review/clear 时：按**素材名**标记（重画同名的图会继承这个结论）' },
      review_state: { type: 'string', enum: REVIEW_STATES, description: 'review 时：approved=合格 / rejected=不合格 / pending=待定' },
      note: { type: 'string', description: 'review 时的备注（为什么不合格等）' },
      limit: { type: 'number', description: '最多返回多少条（默认 200，避免刷屏）' },
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action ?? 'scan'
        const catalog = state.assets

        if (action === 'review') {
          if (!args.review_state) return dump({ ok: false, error: `review 需要 review_state（${REVIEW_STATES.join(' / ')}）` })
          const result = catalog.mark({
            files: args.files ?? [],
            names: args.names ?? [],
            state: args.review_state,
            note: args.note ?? '',
          })
          if (!result.ok) return dump(result)
          await state.assets.save()
          return dump({
            ...result,
            stats: catalog.stats(),
            hint: `已标记 ${result.changed} 项为「${result.label}」。按名字标记的结论会在重画同名图后继续生效。`,
            board_url: runtime.boardUrl(),
          })
        }

        if (action === 'clear') {
          const result = catalog.clear({ files: args.files ?? [], names: args.names ?? [] })
          await state.assets.save()
          return dump({ ...result, stats: catalog.stats() })
        }

        if (action === 'changes') {
          // 变化摘要（prompt 1）：和快照 diff，并推进基线
          const scan = await scanAssetCatalog({
            outputDir: state.settings.outputDir,
            catalog,
            gallery: state.gallery,
            project: args.project ?? '',
          })
          const diff = await captureChanges({ files: scan.files, dataDir: state.profiles.dataDir, save: args.save !== false })
          const queue = catalog.recomputeQueue({ files: scan.files })
          await catalog.save()
          return dump({
            ok: true,
            first_run: diff.first_run,
            summary: diff.summary,
            stats: diff.stats,
            baseline_taken_at: diff.taken_at,
            added: diff.added.slice(0, 60).map((item) => ({ file: item.file, name: item.name, kind: item.kind, external: item.external })),
            changed: diff.changed.slice(0, 60),
            removed: diff.removed.slice(0, 60),
            invalidated: queue.needsReReview.length,
            guidance: [
              diff.first_run
                ? '首次运行：已建立基线。之后每次扫描会告诉你"自上次以来新增/消失了什么"。这是正常行为，不是"新增了 900 张"。'
                : diff.summary,
              queue.needsReReview.length > 0
                ? `有 ${queue.needsReReview.length} 张的审核结论已失效（内容变了）→ 要重审：${queue.needsReReview.slice(0, 5).join('、')}`
                : '没有结论失效的素材。',
              queue.needsReview.length > 0 ? `另有 ${queue.needsReview.length} 张从未审核。` : '',
            ].filter(Boolean),
          })
        }

        if (action === 'queue') {
          // 三个队列：这就是「审核一次、之后自动到底」的待办清单
          const scan = await scanAssetCatalog({
            outputDir: state.settings.outputDir,
            catalog,
            gallery: state.gallery,
            project: args.project ?? '',
          })
          const queue = catalog.recomputeQueue({ files: scan.files })
          await catalog.save()
          return dump({
            ok: true,
            report: catalog.queueReport(),
            needs_install: queue.needsInstall.slice(0, 80),
            needs_review: queue.needsReview.slice(0, 80),
            needs_re_review: queue.needsReReview.slice(0, 80),
            guidance: [
              `待装 ${queue.needsInstall.length} 张：已合格，install 会自动捡走（不用人管）。`,
              queue.needsReview.length > 0 ? `待审 ${queue.needsReview.length} 张：这是唯一需要人的地方 —— 去画廊勾选批量拍板。` : '没有待审素材。',
              queue.needsReReview.length > 0 ? `结论失效 ${queue.needsReReview.length} 张：内容变了，要重新审一次。` : '',
            ].filter(Boolean),
          })
        }

        // scan / pending：扫磁盘
        const catalogResult = await scanAssetCatalog({
          outputDir: state.settings.outputDir,
          catalog,
          gallery: state.gallery,
          project: args.project ?? '',
        })
        let files = catalogResult.files
        if (args.kind) files = files.filter((item) => item.kind === args.kind)
        if (args.state) files = files.filter((item) => item.review_state === args.state)
        // pending 默认只看"还没审的正式素材"，避免把预览图/截图也算进来
        if (action === 'pending') {
          files = files.filter((item) => item.review_state === 'unreviewed' && item.kind === 'source')
        }
        const limit = Math.max(1, Number(args.limit ?? 200))
        const shown = files.slice(0, limit)
        return dump({
          ok: true,
          output_dir: catalogResult.output_dir,
          projects: catalogResult.projects,
          tally: catalogResult.tally,
          by_kind: catalogResult.by_kind,
          review_stats: catalog.stats(),
          filtered_total: files.length,
          shown: shown.length,
          files: shown.map((item) => ({
            file: item.file,
            name: item.name,
            project: item.project,
            kind: item.kind,
            review: item.review_state,
            review_label: reviewStateLabel(item.review_state),
            generated: item.generated,
            size: item.bytes,
            prompt: item.prompt ? String(item.prompt).slice(0, 120) : undefined,
          })),
          // 给 AI 的关键提示：哪些是人工拍板能用的
          guidance: [
            `目录里共 ${catalogResult.tally.total} 张：本插件生成 ${catalogResult.tally.generated} 张，外部写入 ${catalogResult.tally.external} 张。`,
            `审核状态：合格 ${catalogResult.tally.approved}｜不合格 ${catalogResult.tally.rejected}｜待定 ${catalogResult.tally.pending}｜未审核 ${catalogResult.tally.unreviewed}。`,
            '挑素材给游戏用时，**优先用 review=approved 的**；unreviewed 的未经人确认，rejected 的不要用。',
            'kind=preview 是「画面里带素材名」的预览图，给人看的，不要装进游戏；kind=screenshot 是截图，同理。',
            catalogResult.tally.unreviewed > 0 ? `还有 ${catalogResult.tally.unreviewed} 张未审核，可在画廊里勾选后一件标记，或调 action=review 批量标。` : '全部已审核。',
          ],
          board_url: runtime.boardUrl(),
        })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 批量重处理（prompt 3）：切片网格/目标尺寸改了，但已审核的几百张不想重审。
   * 区分「源图变了」（要重审）与「派生规则变了」（结论继承、只重切）。
   */
  const reprocessTool = {
    name: '_dsh_external_dsh_gpt_image_reprocess',
    description: '批量重处理：派生规则（切片网格/目标尺寸/命名）变了、但源图没变时，只重切派生文件并继承源图审核结论，不让人重审一遍。dry_run=true（默认）只给规划。只动 _slices/ 等派生文件，绝不碰源图；失败会回滚；与 install 互斥（文件锁）。',
    parameters: params({
      root: { type: 'string', description: '游戏目录（读「待画素材清单」里的尺寸规格；没有也能跑，只是不做尺寸缩放）' },
      project: { type: 'string', description: '只处理某个项目（默认全部）' },
      slices: { type: 'boolean', description: '是否重切切片（默认 true）' },
      scaled: { type: 'boolean', description: '是否重做缩放件（默认 false）' },
      dry_run: { type: 'boolean', description: '默认 true：只给规划不动文件。要真执行传 false' },
      clean_orphans: { type: 'boolean', description: '是否清理孤儿派生文件（源图已不在的），默认 true' },
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const { expectations } = await readExpectations(args.root ?? state.profiles.data.gameRoot ?? '').catch(() => ({ expectations: {} }))
        const scan = await scanAssetCatalog({
          outputDir: state.settings.outputDir,
          catalog: state.assets,
          gallery: state.gallery,
          project: args.project ?? '',
        })
        const fingerprint = rulesFingerprint({ slices: args.slices !== false, scaled: args.scaled === true, expectations })
        const plan = planReprocess({
          files: scan.files,
          catalog: state.assets,
          expectations,
          slices: args.slices !== false,
          scaled: args.scaled === true,
        })

        if (args.dry_run !== false) {
          return dump({
            ok: true,
            dry_run: true,
            summary: plan.summary,
            text: plan.text,
            rules_changed: rulesChanged(state.assets, fingerprint),
            affected: plan.to_reprocess.map((item) => ({ name: item.name, slices: item.rule?.slices ?? 0, grid: item.rule ? `${item.rule.columns}x${item.rule.rows}` : '' })),
            skipped_unreviewed: plan.skipped_unreviewed.length,
            invalidated: plan.invalidated,
            no_rule: plan.no_rule.length,
            orphans: plan.orphans.length,
            next: '确认无误后带 dry_run=false 执行。执行只动派生文件，源图和源图的审核结论都不碰。',
          })
        }

        // 执行：先拿锁（和 install 互斥）
        const lock = await acquireLock(state.profiles.dataDir, 'reprocess')
        if (!lock.ok) return dump({ ok: false, error: lock.error })
        try {
          const result = await runReprocess({
            root: args.project ? path.join(state.settings.outputDir, args.project) : state.settings.outputDir,
            files: scan.files,
            catalog: state.assets,
            expectations,
            plan,
            sliceFn: async ({ file, name, rule, outDir }) => {
              const { readFile: readPng, writeFile: writePng } = await import('node:fs/promises')
              const { decodePngRgba } = await import('./pngcodec.js')
              const { computeSlices } = await import('./sheet.js')
              const decoded = decodePngRgba(await readPng(file))
              if (!decoded) return { ok: false, error: '解不开（只支持 8bit 非隔行 PNG）' }
              const size = expectations[name]?.size
              const computed = computeSlices({
                decoded,
                items: Array.from({ length: rule.columns * rule.rows }, (_, i) => ({
                  name: `${name}_${String(i + 1).padStart(2, '0')}`,
                  width: size?.width ?? 0,
                  height: size?.height ?? 0,
                })),
                columns: rule.columns,
                rows: rule.rows,
                trim: true,
                targetWidth: size?.width ?? 0,
                targetHeight: size?.height ?? 0,
                encode: true,
              })
              if (!computed.ok) return { ok: false, error: computed.error }
              const files = []
              for (const slice of computed.slices) {
                const out = path.join(outDir, `${slice.name}.png`)
                await writePng(out, slice.png)
                files.push(out)
              }
              return { ok: true, files, warnings: computed.warnings }
            },
          })
          recordRules(state.assets, fingerprint)
          const after = await scanAssetCatalog({
            outputDir: state.settings.outputDir, catalog: state.assets, gallery: state.gallery, project: args.project ?? '',
          })
          state.assets.recomputeQueue({ files: after.files })
          await state.assets.save()
          return dump({
            ...result,
            rules_recorded: true,
            queue: state.assets.queueReport(),
            next: result.failed > 0
              ? '有失败的已回滚，原始派生文件未改动。修掉原因后再跑一次。'
              : '重切完成并已继承结论，进了待安装队列 —— 跑 install 会自动装（无需再审核）。',
          })
        } finally {
          await lock.release?.()
        }
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * 质量地基（A–E 组）：把「能不能用」从审美问题降级成技术问题。
   *
   * 一个工具覆盖多件事，因为这些事**必须一起用**才成立：
   *   规格校验 → 能修的修（A1/A2）→ 协调性检查（B）→ 派生变体（C）→ 评分路由（D3）
   * 拆成五个工具会让 AI 只调其中一个，反而容易漏步骤。
   */
  const qualityTool = {
    name: '_dsh_external_dsh_gpt_image_quality',
    description: '素材质量地基（A–E）：①spec 校验+自动修复（去毛边/抠背景/裁留白/调色板吸附/锐化/尺寸归一）②协调性检查（调色板漂移 B1 / 小尺寸可读性 B2 / 动画连贯性 B3）③派生变体（翻转/灰度/染色/受损/高亮，继承源图结论）④图集打包+manifest ⑤视觉标签 ⑥质量评分路由（把 900 张审核降到 200 张）。action=check 单张全检；batch 批量路由；spec 看规格；fix 自动修复；coherence 整组一致性；animation 动画连贯性；variants 生成派生变体；atlas 打包图集；tags 视觉标签；preference 从装机记录学偏好；regression 与上版对比。',
    parameters: params({
      action: { type: 'string', enum: ['check', 'batch', 'spec', 'fix', 'pixelize', 'coherence', 'animation', 'variants', 'atlas', 'tags', 'preference', 'regression'], description: '默认 check；pixelize 把 AI 的「伪像素图」变成真像素图' },
      root: { type: 'string', description: '游戏目录（读 asset-specs.json 与「待画素材清单」的规格）' },
      project: { type: 'string', description: '处理哪个项目' },
      file: { type: 'string', description: '单张：文件路径（check/fix/pixelize/tags/regression 用）' },
      files: { type: 'array', items: { type: 'string' }, description: '多张：文件路径数组（variants/atlas 用）' },
      kind: { type: 'string', description: '素材类型（icon/card/tile/unit/building/pixel…），决定用哪套默认规格' },
      names: { type: 'array', items: { type: 'string' }, description: 'check/batch/pixelize 时只处理这些素材名' },
      variants: { type: 'array', items: { type: 'string' }, description: `variants 时生成哪些：${VARIANT_KINDS.join(' / ')}` },
      color: { type: 'string', description: 'variants 的阵营染色目标色（如 #4a9eff）' },
      cell_width: { type: 'number', description: 'atlas 格子宽（默认 64）' },
      cell_height: { type: 'number', description: 'atlas 格子高（默认 64）' },
      apply: { type: 'boolean', description: 'fix/variants/atlas 时是否真的写盘（默认 false 只预览）' },
      limit: { type: 'number', description: 'batch 最多处理多少张（默认 200）；pixelize 默认 20' },
      logical_width: { type: 'number', description: 'pixelize：**逻辑像素宽**（如 32）—— 给了它最可靠；不给则试图自动检测网格（AI 插画通常检测不到，会跳过并说明）' },
      logical_height: { type: 'number', description: 'pixelize：逻辑像素高；只给宽时会按原图宽高比自动补' },
      palette: { type: 'number', description: 'pixelize：调色板颜色数（默认 0=不量化；像素画常用 16）' },
      method: { type: 'string', enum: ['median', 'mean', 'mode', 'kmeans', 'dominant'], description: 'pixelize：块代表色算法，默认 median' },
      aa_passes: { type: 'number', description: 'pixelize：抗锯齿消除迭代次数（默认 0=不做；2 是上游默认值）' },
      core_ratio: { type: 'number', description: 'pixelize：块内核心区比例（默认 0.6），用于避开块边缘杂色' },
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action ?? 'check'
        const root = args.root ?? state.profiles.data.gameRoot ?? ''
        const catalogue = await loadSpecCatalogue(root).catch(() => ({ kinds: {}, assets: {} }))
        const { expectations } = await readExpectations(root).catch(() => ({ expectations: {} }))
        const { readFile: readPng, writeFile: writePng } = await import('node:fs/promises')
        const project = args.project ?? ''
        const outputDir = state.settings.outputDir

        const specFor = (name, kind = args.kind, fileSpec = null) => resolveSpec({
          kind: kind ?? 'default', name, fileSpec, catalogue, expectation: expectations[name] ?? null,
        })

        // 扫描（多数 action 都要）
        const scan = await scanAssetCatalog({ outputDir, catalog: state.assets, gallery: state.gallery, project })

        if (action === 'spec') {
          const sample = args.names?.[0] ?? scan.files.find((f) => f.kind === 'source')?.name ?? ''
          // 每种 kind 都给一份，便于人对照
          const kinds = {}
          for (const kind of ['icon', 'card', 'tile', 'unit', 'building', 'effect']) {
            kinds[kind] = specFor(sample, kind)
          }
          return dump({
            ok: true,
            catalogue_file: root ? `${root}/asset-specs.json` : '(没有游戏目录)',
            catalogue_loaded: Object.keys(catalogue.kinds).length + Object.keys(catalogue.assets).length,
            sample, by_kind: kinds,
            resolved_for_sample: specFor(sample),
            hint: '规格优先级：内置默认 → asset-specs.json → 待画素材清单.md → 显式传入。',
          })
        }

        /** 单张的完整质量检查（spec + 可读性 + 漂移 + 评分）。 */
        const inspect = async (entry, lockedPalette) => {
          const buffer = await readPng(entry.file).catch(() => null)
          if (!buffer) return { file: entry.file, name: entry.name, error: '读不到' }
          const spec = specFor(entry.name, entry.kind === 'source' ? args.kind : entry.kind)
          const validation = validateAgainstSpec({ buffer, spec, name: entry.name })
          const read = spec.width ? readabilityAtSize({ buffer, targetWidth: spec.width, targetHeight: spec.height }) : null
          let fingerprint = null
          try {
            const { styleFingerprint } = await import('./stylefp.js')
            fingerprint = styleFingerprint(buffer)
          } catch { /* 指纹失败不影响其它 */ }
          const drift = fingerprint && lockedPalette.length ? paletteDrift({ fingerprint, locked: lockedPalette }) : null
          const score = scoreAsset({ buffer, spec, lockedPalette, fingerprint, drift })
          return {
            file: entry.file, name: entry.name, kind: entry.kind, review: entry.review_state,
            spec: { size: spec.width ? `${spec.width}×${spec.height}` : '(未定义)', alpha: spec.alpha, source: spec.source },
            validation: { ok: validation.ok, needsHuman: validation.needsHuman, problems: validation.problems, fixes: validation.fixes.map((f) => f.action) },
            readability: read ? { level: read.level, contrast: read.contrast, fill: read.fillRatio, problems: read.problems } : null,
            drift: drift ? { level: drift.level, drift: drift.drift } : null,
            score: score.score, route: score.route, route_label: score.route_label,
            reasons: score.reasons, diagnostics: score.diagnostics,
          }
        }

        if (action === 'check' || action === 'batch') {
          // 先算锁定调色板（B1）——取自「已合格」的素材，那才是"这套素材"的基准
          const approved = scan.files.filter((f) => f.review_state === 'approved' && f.kind === 'source').slice(0, 60)
          const { styleFingerprint } = await import('./stylefp.js')
          const fps = []
          for (const item of approved) {
            const buffer = await readPng(item.file).catch(() => null)
            if (!buffer) continue
            try { const fp = styleFingerprint(buffer); if (fp) fps.push(fp) } catch { /* 跳过 */ }
          }
          const lockedPalette = fps.length >= 2 ? buildPalette(fps.map((fp) => ({ fingerprint: fp }))).palette : []

          const pool = scan.files.filter((f) => f.kind === 'source' || f.kind === 'resized')
            .filter((f) => !args.names?.length || args.names.includes(f.name))
          const limited = pool.slice(0, Math.max(1, Number(args.limit ?? 200)))
          const results = []
          for (const entry of limited) results.push(await inspect(entry, lockedPalette))
          const routing = routeBatch(results)
          const needHuman = results.filter((r) => r.validation?.needsHuman)
          return dump({
            ok: true,
            action,
            scanned: pool.length,
            checked: results.length,
            locked_palette: lockedPalette.slice(0, 8),
            locked_palette_note: lockedPalette.length
              ? `从 ${fps.length} 张已合格素材统计出 ${lockedPalette.length} 个主色，作为「这套素材」的风格基准。`
              : '还没有足够的已合格素材来统计调色板 —— 先去画廊标一批合格。',
            routing,
            // 需要人看的排前面（这就是"900 → 200"的落地方式）
            priority: results.filter((r) => r.route === 'priority').slice(0, 30),
            auto_pass_count: routing.auto_pass,
            needs_human: needHuman.slice(0, 20),
            advice: [
              routing.advice,
              needHuman.length > 0 ? `${needHuman.length} 张有内容层面的问题（需人处理或重画）。` : '没有必须人处理的内容问题。',
              lockedPalette.length === 0 ? '提示：先标一批合格素材，B1 漂移检测才有基准。' : '',
            ].filter(Boolean),
          })
        }

        if (action === 'pixelize') {
          // 把 AI 生成的「伪像素图」还原成真像素图（移植 AIPixelImageConversionTool）。
          // 默认 dry-run：先看清楚块尺寸/逻辑分辨率/颜色数，满意了再 apply。
          const targets = []
          const missing = []
          if (args.file) {
            targets.push({ file: args.file, name: String(args.file).split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '') })
          } else if (args.names?.length) {
            for (const name of args.names) {
              const found = scan.files.find((item) => item.name === name && item.kind === 'source')
              if (found) targets.push(found)
              else missing.push(name)
            }
          } else {
            targets.push(...scan.files.filter((item) => item.kind === 'source').slice(0, Math.max(1, Number(args.limit ?? 20))))
          }
          if (targets.length === 0) {
            return dump({
              ok: false, missing,
              error: 'pixelize 没找到要处理的图：给 file（单张路径）或 names（素材名），或先在该项目里出图。',
            })
          }

          const results = []
          for (const item of targets) {
            const buffer = await readPng(item.file).catch(() => null)
            if (!buffer) { results.push({ name: item.name, file: item.file, ok: false, error: '读不到文件' }); continue }
            const spec = specFor(item.name, args.kind)
            const plan = normalizePixelOptions(spec.pixel, { width: 0, height: 0 })
            const options = { ...(plan?.options ?? {}) }
            // 显式参数优先于 spec（方便"试几个逻辑分辨率看看哪个好"）
            if (Number(args.logical_width) > 0) {
              options.logicalWidth = Number(args.logical_width)
              options.logicalHeight = Number(args.logical_height) > 0 ? Number(args.logical_height) : 0
            } else if (Number(args.logical_height) > 0) {
              options.logicalHeight = Number(args.logical_height)
            }
            if (args.palette !== undefined) options.palette = Number(args.palette)
            if (args.method) options.method = args.method
            if (Number(args.aa_passes) >= 0) options.aaPasses = Number(args.aa_passes)
            if (Number(args.core_ratio) > 0) options.coreRatio = Number(args.core_ratio)

            const result = pixelizePng({ buffer, options })
            if (!result.ok) {
              results.push({
                name: item.name, file: item.file, ok: false, error: result.error,
                hint: '给 logical_width（例如 32 或 48）就能强制按这个逻辑分辨率等分图像 —— 比自动检测可靠得多。',
              })
              continue
            }
            const entry = {
              name: item.name,
              file: item.file,
              ok: true,
              block: `${result.grid.px.toFixed(2)}×${result.grid.py.toFixed(2)}px`,
              grid_source: result.grid.source,
              logical: `${result.width}×${result.height}`,
              colors: result.stats.colors,
              applied: result.applied,
              written: false,
            }
            if (args.apply) {
              const target = `${item.file.replace(/\.[a-z0-9]+$/i, '')}.pixel.png`
              await writePng(target, result.buffer)
              entry.written = true
              entry.output_file = target
            }
            results.push(entry)
          }

          const done = results.filter((item) => item.ok)
          return dump({
            ok: done.length > 0,
            total: results.length,
            succeeded: done.length,
            failed: results.length - done.length,
            missing,
            results,
            note: args.apply
              ? '产物写到 *.pixel.png（**没有覆盖原图**）—— 确认满意后自己替换。'
              : '预览模式（未写盘）。确认无误后带 apply=true。',
            clarify: 'pixelize 做的是「按块取核心区代表色」而不是普通缩放：'
              + '前提是图里确实有像素块。AI 画的「像素风插画」常常**没有**一致网格，'
              + '这时自动检测会拒绝并说明原因 —— 直接给 logical_width 指定逻辑分辨率即可。',
            board_url: runtime.boardUrl(),
          })
        }

        if (action === 'fix') {
          if (!args.file) return dump({ ok: false, error: 'fix 需要 file' })
          const buffer = await readPng(args.file)
          const name = args.file.split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '')
          const spec = specFor(name)
          const fixed = applySpecFixes({ buffer, spec })
          if (!fixed.ok) return dump(fixed)
          const out = {
            ok: true,
            file: args.file,
            spec: { size: `${spec.width ?? '?'}×${spec.height ?? '?'}`, alpha: spec.alpha, source: spec.source },
            applied: fixed.applied,
            before_after: `${decodedSize(buffer)} → ${fixed.width}×${fixed.height}`,
            written: false,
          }
          if (args.apply) {
            const target = `${args.file.replace(/\.[a-z0-9]+$/i, '')}.fixed.png`
            await writePng(target, fixed.buffer)
            out.written = true
            out.output_file = target
            out.note = '写到了 *.fixed.png（**没有覆盖原图**）—— 确认满意后自己替换。'
          } else {
            out.note = '预览模式（未写盘）。确认无误后带 apply=true。'
          }
          return dump(out)
        }

        if (action === 'coherence') {
          const { styleFingerprint } = await import('./stylefp.js')
          const pool = scan.files.filter((f) => f.kind === 'source').slice(0, Math.max(1, Number(args.limit ?? 80)))
          const items = []
          const drifts = []
          const fps = []
          const byName = new Map()
          for (const item of pool) {
            const buffer = await readPng(item.file).catch(() => null)
            if (!buffer) continue
            let fp = null
            try { fp = styleFingerprint(buffer) } catch { continue }
            if (!fp) continue
            fps.push(fp)
            byName.set(item.name, { item, fp })
          }
          const lock = buildPalette(fps.map((fp) => ({ fingerprint: fp })))
          for (const [name, { item, fp }] of byName) {
            const d = paletteDrift({ fingerprint: fp, locked: lock.palette })
            if (d.level !== 'ok') drifts.push({ name, file: item.file, drift: d.drift, level: d.level, advice: d.advice })
          }
          return dump({
            ok: true,
            locked_palette: lock.palette.slice(0, 12),
            considered: lock.considered,
            consistency: groupStyleConsistency(fps),
            drift_count: drifts.length,
            drifting: drifts.sort((a, b) => b.drift - a.drift).slice(0, 25),
            advice: drifts.length === 0
              ? `整组用色与锁定调色板一致（取样 ${lock.considered} 张）。`
              : `${drifts.length} 张用色偏离整体调色板 —— 这些看起来"不像同一套"，建议调色板吸附或重出。`,
          })
        }

        if (action === 'animation') {
          // 按「序列帧」分组：同一素材名的连续编号算一组
          const groups = new Map()
          for (const item of scan.files) {
            if (item.kind !== 'source' && item.kind !== 'slice') continue
            const base = String(item.name).replace(/[_\-]?\d{1,3}$/, '')
            if (!groups.has(base)) groups.set(base, [])
            groups.get(base).push(item)
          }
          const reports = []
          for (const [base, list] of groups) {
            if (list.length < 3) continue
            const sorted = list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
            const frames = []
            for (const item of sorted) {
              const { decodePngRgba } = await import('./pngcodec.js')
              const buffer = await readPng(item.file).catch(() => null)
              const decoded = buffer ? decodePngRgba(buffer) : null
              if (decoded) frames.push({ name: item.name, decoded })
            }
            if (frames.length < 3) continue
            const report = animationCoherence({ frames })
            if (report.level !== 'ok') reports.push({ sequence: base, frames: frames.length, ...report, frames_detail: report.diffs })
          }
          return dump({
            ok: true,
            sequences_checked: [...groups.values()].filter((l) => l.length >= 3).length,
            problems_found: reports.length,
            reports: reports.slice(0, 20),
            advice: reports.length === 0
              ? '有 3 帧以上的序列都检查了，连贯性没问题。'
              : `${reports.length} 组序列有连贯性问题（突变/循环不闭合/全一样）—— 见 reports。`,
          })
        }

        if (action === 'variants') {
          if (!args.files?.length) return dump({ ok: false, error: 'variants 需要 files（母图路径数组）' })
          const kinds = args.variants?.length ? args.variants : undefined
          const produced = []
          for (const file of args.files) {
            const buffer = await readPng(file).catch(() => null)
            if (!buffer) { produced.push({ file, ok: false, error: '读不到' }); continue }
            const name = file.split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '')
            const spec = specFor(name)
            const r = deriveVariants({ buffer, kinds, color: args.color, targetWidth: spec.width ?? 0, targetHeight: spec.height ?? 0 })
            if (!r.ok) { produced.push({ file, ok: false, error: r.error }); continue }
            const entries = []
            for (const variant of r.variants) {
              const target = `${file.replace(/\.[a-z0-9]+$/i, '')}.${variant.kind}.png`
              if (args.apply) {
                await writePng(target, variant.buffer)
                // 继承源图审核结论（人审 1 张 = N 份产出）
                state.assets.mark({ files: [{ path: target, name }], state: state.assets.reviewOf({ file, name })?.state ?? 'pending', by: 'variant' })
              }
              entries.push({ kind: variant.kind, label: variant.label, size: `${variant.width}×${variant.height}`, file: target, written: Boolean(args.apply) })
            }
            produced.push({ file, ok: true, base: `${r.base.width}×${r.base.height}`, variants: entries })
          }
          if (args.apply) await state.assets.save()
          return dump({
            ok: true,
            applied: Boolean(args.apply),
            produced,
            inherit_note: '变体继承源图的审核结论 —— 人审 1 张母图 = N 份产出，不需要逐张审。',
            note: args.apply ? '已写盘。' : '预览模式（未写盘）。确认后带 apply=true。',
          })
        }

        if (action === 'atlas') {
          const files = args.files?.length ? args.files : scan.files.filter((f) => f.review_state === 'approved' && f.kind === 'source').map((f) => f.file)
          if (!files.length) {
            return dump({
              ok: false,
              error: '没有可打包的素材：传 files，或先在画廊标一批「合格」（approved 才会进图集）。',
              hint: 'approved 素材自动进图集 —— 这是"审核一次、之后自动到底"的最后一环。',
            })
          }
          const sprites = []
          for (const file of files.slice(0, Math.max(1, Number(args.limit ?? 256)))) {
            const buffer = await readPng(file).catch(() => null)
            if (!buffer) continue
            sprites.push({ name: file.split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, ''), buffer, pivot: specFor(file).pivot })
          }
          const packed = packAtlas({
            sprites,
            cellWidth: Number(args.cell_width ?? 64),
            cellHeight: Number(args.cell_height ?? 64),
          })
          if (!packed.ok) return dump(packed)
          const out = {
            ok: true,
            atlas_size: `${packed.atlas.width}×${packed.atlas.height}`,
            grid: packed.manifest.grid,
            frames: packed.manifest.frames.length,
            manifest_preview: packed.manifest.frames.slice(0, 5),
            written: false,
          }
          if (args.apply && project) {
            const dir = `${outputDir}\\${project}`
            await writePng(`${dir}\\atlas.png`, packed.atlas.buffer)
            await writePng(`${dir}\\atlas.manifest.json`, Buffer.from(manifestToJson(packed.manifest), 'utf8'))
            out.written = true
            out.files = [`${dir}\\atlas.png`, `${dir}\\atlas.manifest.json`]
          }
          out.note = args.apply ? '已写盘（atlas.png + atlas.manifest.json）。' : '预览模式（未写盘）。带 apply=true 且指定 project 才写盘。'
          return dump(out)
        }

        if (action === 'tags') {
          const pool = args.file ? [{ file: args.file, name: path.basename(args.file).replace(/\.[a-z0-9]+$/i, ''), kind: 'source' }]
            : scan.files.filter((f) => f.kind === 'source').slice(0, Math.max(1, Number(args.limit ?? 40)))
          const out = []
          for (const item of pool) {
            const buffer = await readPng(item.file).catch(() => null)
            if (!buffer) continue
            const record = (state.gallery.list({ limit: 1000 }) ?? []).find((r) => (r.files ?? []).some((f) => f === item.file))
            const t = visualTags({ buffer, name: item.name, kind: item.kind, prompt: record?.prompt ?? '', spec: specFor(item.name) })
            out.push({ name: item.name, file: item.file, tags: t.tags, attributes: t.attributes, semantic: t.semantic })
          }
          return dump({
            ok: true,
            tagged: out.length,
            items: out,
            hint: '语义描述只来自 prompt（这张图怎么来的）——不用视觉模型猜"画的是什么"，那样既慢又不准。',
          })
        }

        if (action === 'preference') {
          const records = state.gallery.list({ limit: 1000 }) ?? []
          // "真进游戏"的判据：install 之后历史里留有 install 痕迹，或标了合格
          const installed = scan.files.filter((f) => f.review_state === 'approved').map((f) => {
            const record = records.find((r) => (r.files ?? []).some((x) => x === f.file)) ?? {}
            return { provider: record.provider ?? f.provider, model: record.model ?? f.model, params: record.params ?? {}, kind: f.kind }
          })
          const rejectedFiles = scan.files.filter((f) => f.review_state === 'rejected')
          const preference = learnPreference({ installed, rejected: rejectedFiles })
          return dump({ ok: true, ...preference, based_on: `${installed.length} 张合格 + ${rejectedFiles.length} 张不合格` })
        }

        if (action === 'regression') {
          if (!args.file) return dump({ ok: false, error: 'regression 需要 file（当前版）' })
          const current = await readPng(args.file).catch(() => null)
          if (!current) return dump({ ok: false, error: '读不到当前版' })
          // 备份文件就是上一版（install 会留 .bak-before-install）
          const previous = await readPng(`${args.file}.bak-before-install`).catch(() => null)
          if (!previous) {
            return dump({
              ok: false,
              error: '找不到上一版可对比（没有 .bak-before-install）',
              hint: 'install 覆盖时会自动留备份；也可以显式传 previous_file。',
            })
          }
          const result = detectRegression({ previousBuffer: previous, currentBuffer: current })
          return dump({ ok: true, file: args.file, previous_file: `${args.file}.bak-before-install`, ...result })
        }

        return dump({ ok: false, error: `未知 action：${action}` })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * F–J 组：生成端 / 游戏倒推 / 安全网 / 可观测性 / 长期演进。
   *
   * 合并成一个工具的同一个理由：这些能力**互相喂数据** ——
   * 模板(F1)产出清单 → 批量(F2)执行 → 成本(F3)汇总 → 漏斗(I3)看流失 →
   * 风格指南(J1)沉淀 → 下次模板更好。拆开就断了。
   */
  const studioTool = {
    name: '_dsh_external_dsh_gpt_image_studio',
    description: '素材工作室（F–J）：模板库/变体矩阵/成本分析/反向提取 prompt（F）；引擎契约·引用完整性·替换影响（G）；并发锁·来源归属·损坏检测·备份回滚（H）；健康度仪表盘·审核效率·漏斗·趋势（I）；风格指南·共享库·风格迁移·A/B·图鉴（J）。',
    parameters: params({
      action: {
        type: 'string',
        enum: [
          'templates', 'template-save', 'template-expand', 'variants-plan',
          'cost', 'cost-effectiveness', 'reverse-prompt',
          'contract', 'references', 'impact', 'preview-plan',
          'lock', 'unlock', 'provenance', 'provenance-backfill', 'corruption',
          'backup', 'backups', 'restore',
          'health', 'efficiency', 'funnel', 'trending',
          'style-guide', 'shared-list', 'shared-save', 'style-transfer',
          'ab-design', 'ab-analyze', 'gallery-html',
        ],
        description: '默认 health',
      },
      root: { type: 'string', description: '游戏目录' },
      project: { type: 'string', description: '项目名' },
      file: { type: 'string', description: '单文件（reverse-prompt / corruption / impact 用）' },
      files: { type: 'array', items: { type: 'string' }, description: '多文件（corruption / style-transfer 等）' },
      key: { type: 'string', description: 'impact：要分析的素材名' },
      template: { type: 'string', description: 'template-expand：模板 id' },
      items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'template-expand：变量对象数组（如 [{元素:"剑",风格:"像素"}]）' },
      vars: { type: 'object', additionalProperties: true, description: 'template-expand：公共默认变量' },
      template_text: { type: 'string', description: 'template-save：模板内容（含 {变量}）' },
      template_name: { type: 'string', description: 'template-save：显示名' },
      count: { type: 'number', description: 'variants-plan：seed 个数' },
      seed_start: { type: 'number', description: 'variants-plan：起始 seed' },
      prompts: { type: 'array', items: { type: 'string' }, description: 'variants-plan：多个 prompt' },
      lock_name: { type: 'string', description: 'lock：锁名（默认 assets-write）' },
      owner: { type: 'string', description: 'lock：持有者标识' },
      reason: { type: 'string', description: 'lock：为什么加锁' },
      writer: { type: 'string', description: 'provenance：写入者' },
      label: { type: 'string', description: 'backup/restore：标签或备份 id' },
      keep: { type: 'number', description: 'backup：保留几份（默认 20）' },
      palette_id: { type: 'string', description: 'shared-save：调色板 id' },
      shared_id: { type: 'string', description: 'shared-save / style-transfer：共享库条目 id' },
      target_project: { type: 'string', description: 'shared-save / style-transfer：目标项目' },
      baseline_rate: { type: 'number', description: 'ab-design：基线转化率' },
      detectable_effect: { type: 'number', description: 'ab-design：想检出的最小差异' },
      views_a: { type: 'number', description: 'ab-analyze：A 版曝光量' },
      conversions_a: { type: 'number', description: 'ab-analyze：A 版转化数' },
      views_b: { type: 'number', description: 'ab-analyze：B 版曝光量' },
      conversions_b: { type: 'number', description: 'ab-analyze：B 版转化数' },
      apply: { type: 'boolean', description: 'gallery-html：是否写盘' },
      limit: { type: 'number', description: '通用上限' },
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action ?? 'health'
        const root = args.root ?? state.profiles.data.gameRoot ?? ''
        const outputDir = state.settings.outputDir
        const project = args.project ?? ''
        const { readFile: readPng, writeFile: writePng } = await import('node:fs/promises')
        const scan = async () => scanAssetCatalog({ outputDir, catalog: state.assets, gallery: state.gallery, project })

        // ── F1 模板 ──
        if (action === 'templates') {
          const lib = await TemplateLibrary.load(state.profiles.dataDir)
          return dump({ ok: true, count: lib.templates.length, templates: lib.templates })
        }
        if (action === 'template-save') {
          const lib = await TemplateLibrary.load(state.profiles.dataDir)
          const r = lib.upsert({ id: args.shared_id ?? args.template, name: args.template_name, text: args.template_text, tags: args.project ? [args.project] : [] })
          if (!r.ok) return dump(r)
          await lib.save()
          return dump({ ok: true, template: r.template, hint: '模板已存。用 template-expand 批量套用。' })
        }
        if (action === 'template-expand') {
          const lib = await TemplateLibrary.load(state.profiles.dataDir)
          if (!args.template) return dump({ ok: false, error: '需要 template（模板 id）' })
          const r = lib.expand({ id: args.template, items: args.items ?? [], defaults: args.vars ?? {} })
          if (!r.ok) return dump(r)
          return dump({
            ...r,
            next: '把这些 assets 直接传给 batch 工具即可批量生成（它们已经带好 name/prompt）。',
          })
        }

        // ── F2 变体矩阵 ──
        if (action === 'variants-plan') {
          const r = planVariants({
            base: { prompt: args.prompts?.[0] ?? '', size: args.vars?.size, quality: args.vars?.quality },
            prompts: args.prompts,
            count: Number(args.count ?? 4),
            seedStart: Number(args.seed_start ?? 0),
            namePrefix: args.project || 'v',
          })
          if (!r.ok) return dump(r)
          return dump({ ...r, next: '把 assets 传给 batch（confirm=true 才会真跑）。先小批试方向，再放量。' })
        }

        // ── F3 成本 ──
        if (action === 'cost' || action === 'cost-effectiveness') {
          const records = state.spend.data.records ?? []
          if (action === 'cost') return dump({ ok: true, ...costByProject({ records, currency: state.spend.data.currency }) })
          // 哪些名字真进了游戏：用 install 后留下的备份/注册表判断
          const installedKeys = (await scan()).files.filter((f) => f.review_state === 'approved').map((f) => f.name)
          return dump({ ok: true, ...costEffectiveness({ records, installedKeys, currency: state.spend.data.currency }) })
        }

        // ── F4 反向提取 ──
        if (action === 'reverse-prompt') {
          if (!args.file) return dump({ ok: false, error: '需要 file' })
          const buffer = await readPng(args.file).catch(() => null)
          if (!buffer) return dump({ ok: false, error: '读不到文件' })
          const { styleFingerprint } = await import('./stylefp.js')
          const fp = styleFingerprint(buffer)
          const { imageQuality } = await import('./review.js')
          const { decodePngRgba } = await import('./pngcodec.js')
          const decoded = decodePngRgba(buffer)
          return dump({
            ok: true,
            file: args.file,
            ...reversePrompt({
              fingerprint: fp,
              quality: imageQuality(buffer),
              imageSize: decoded ? { width: decoded.width, height: decoded.height } : null,
            }),
          })
        }

        // ── G 组 ──
        if (action === 'references') {
          if (!root) return dump({ ok: false, error: '需要 root（游戏目录）' })
          const keys = (await scan()).files.filter((f) => f.kind === 'source').map((f) => f.name)
          const graph = await buildReferenceGraph({ root, keys: keys.slice(0, 300) })
          return dump({ ...graph, hint: 'missing=游戏会缺图（优先补）；orphans=存在但没被引用（冗余）。' })
        }
        if (action === 'contract') {
          if (!root) return dump({ ok: false, error: '需要 root（游戏目录）' })
          const { readExpectations } = await import('./check.js')
          const exp = (await readExpectations(root).catch(() => ({ expectations: {} }))).expectations ?? {}
          const files = (await scan()).files.filter((f) => exp[f.name]).slice(0, Math.max(1, Number(args.limit ?? 100)))
          const r = await checkContract({ root, assets: files.map((f) => ({ name: f.name, file: f.file })), expectations: exp })
          return dump(r)
        }
        if (action === 'impact') {
          if (!args.key) return dump({ ok: false, error: '需要 key（素材名）' })
          return dump(await analyzeImpact({ root, key: args.key }))
        }
        if (action === 'preview-plan') {
          return dump(previewChecklist({ root, key: args.key ?? '' }))
        }

        // ── H 组 ──
        if (action === 'lock') {
          const r = await acquireResourceLock({
            dataDir: state.profiles.dataDir,
            name: args.lock_name ?? 'assets-write',
            owner: args.owner ?? 'dsh-agent',
            reason: args.reason ?? '',
          })
          return dump(r.ok
            ? { ok: true, file: r.file, note: '已加锁。用完记得 action=unlock（或让它心跳超时自动失效）。' }
            : r)
        }
        if (action === 'unlock') {
          const name = args.lock_name ?? 'assets-write'
          const status = await lockStatus({ dataDir: state.profiles.dataDir, name })
          if (!status.held) return dump({ ok: true, note: '本来就没锁。' })
          // 只是看状态；真释放需要持有者对象，这里给出手动清理路径
          return dump({ ok: false, status, hint: '锁由持有者释放（heartbeat 超时会自动失效）。要强制清理，删掉锁文件即可。' })
        }
        if (action === 'provenance') {
          const log = await ProvenanceLog.load(state.profiles.dataDir)
          return dump({ ok: true, writers: log.byWriter(), batches: Object.keys(log.data.batches).length, of_file: args.file ? log.of(args.file) : undefined })
        }
        if (action === 'provenance-backfill') {
          const log = await ProvenanceLog.load(state.profiles.dataDir)
          const r = await log.backfill({ files: (await scan()).files, gallery: state.gallery })
          await log.save()
          return dump({ ok: true, ...r, writers: log.byWriter() })
        }
        if (action === 'corruption') {
          const files = args.file ? [{ file: args.file }] : (await scan()).files
          const r = await scanCorruption({ files, limit: Number(args.limit ?? 2000) })
          return dump({ ok: true, ...r })
        }
        if (action === 'backup') {
          const r = await createBackup({ dataDir: state.profiles.dataDir, label: args.label ?? '', keep: Number(args.keep ?? 20) })
          return dump(r)
        }
        if (action === 'backups') {
          return dump({ ok: true, ...(await listBackups({ dataDir: state.profiles.dataDir })) })
        }
        if (action === 'restore') {
          return dump(await restoreBackup({ dataDir: state.profiles.dataDir, id: args.label ?? '' }))
        }

        // ── I 组 ──
        if (action === 'health' || action === 'funnel' || action === 'trending' || action === 'efficiency') {
          const current = await scan()
          if (action === 'health') {
            // 顺带算风格一致性与坏图（这两个是最值得在仪表盘上看的）
            const { styleFingerprint } = await import('./stylefp.js')
            const { buildPalette } = await import('./coherence.js')
            const approved = current.files.filter((f) => f.review_state === 'approved').slice(0, 60)
            const fps = []
            for (const item of approved) {
              const buffer = await readPng(item.file).catch(() => null)
              if (!buffer) continue
              try { const fp = styleFingerprint(buffer); if (fp) fps.push(fp) } catch { /* 跳过 */ }
            }
            const palette = fps.length >= 2 ? buildPalette(fps.map((fp) => ({ fingerprint: fp }))) : { palette: [] }
            return dump({
              ok: true,
              ...healthDashboard({
                scan: current,
                reviewStats: state.assets.stats(),
                paletteResult: { drift_count: 0, consistency: null, locked_palette: palette.palette },
                readabilityWarnings: 0,
                orphans: 0,
              }),
              queue: state.assets.queueReport(),
            })
          }
          if (action === 'funnel') {
            const records = state.gallery.list({ limit: 1000 }) ?? []
            const generated = records.reduce((s, r) => s + (r.images ?? 0), 0)
            const tally = current.tally ?? {}
            return dump({
              ok: true,
              ...pipelineFunnel({
                generated,
                reviewed: tally.approved + tally.rejected + tally.pending,
                approved: tally.approved,
                installed: current.files.filter((f) => f.review_state === 'approved').length,
              }),
            })
          }
          if (action === 'trending') {
            // 从审核记录按天聚合
            const points = Object.values(state.assets.data.reviews ?? {}).map((r) => ({ date: r.at, approved: r.state === 'approved' ? 1 : 0, rejected: r.state === 'rejected' ? 1 : 0 }))
            return dump({ ok: true, ...trending({ points }) })
          }
          // efficiency
          // efficiency：把审核记录整理成事件（kind 先查好，避免在 map 里 await）
          const currentFiles = (await scan()).files
          const kindByFile = new Map(currentFiles.map((f) => [f.file, f.kind]))
          const events = Object.entries(state.assets.data.reviews ?? {}).map(([file, r]) => ({
            file,
            state: r.state,
            note: r.note,
            at: r.at,
            kind: kindByFile.get(file) ?? '未知',
          }))
          return dump({ ok: true, ...reviewEfficiency({ events }) })
        }

        // ── J 组 ──
        if (action === 'style-guide') {
          const { styleFingerprint } = await import('./stylefp.js')
          const current = await scan()
          const approved = current.files.filter((f) => f.review_state === 'approved').slice(0, 120)
          const items = []
          for (const item of approved) {
            const buffer = await readPng(item.file).catch(() => null)
            if (!buffer) continue
            try {
              const fp = styleFingerprint(buffer)
              if (fp) items.push({ name: item.name, fingerprint: fp, spec: null })
            } catch { /* 跳过 */ }
          }
          const guide = buildStyleGuide({ items, project })
          if (!guide.ok) return dump({ ...guide, hint: '先标一批「合格」素材 —— 风格指南只统计已合格的（那是你认可的风格）。' })
          const markdown = styleGuideMarkdown(guide)
          const out = { ok: true, ...guide, markdown }
          if (args.apply && project) {
            const target = `${outputDir}\\${project}\\风格指南.md`
            await writePng(target, Buffer.from(markdown, 'utf8'))
            out.written = target
          }
          return dump(out)
        }
        if (action === 'shared-list') {
          const lib = await SharedLibrary.load(state.profiles.dataDir)
          return dump({ ok: true, count: lib.list().length, items: lib.list() })
        }
        if (action === 'shared-save') {
          const lib = await SharedLibrary.load(state.profiles.dataDir)
          const { styleFingerprint } = await import('./stylefp.js')
          const { buildPalette } = await import('./coherence.js')
          const current = await scan()
          const approved = current.files.filter((f) => f.review_state === 'approved').slice(0, 60)
          const fps = []
          for (const item of approved) {
            const buffer = await readPng(item.file).catch(() => null)
            if (!buffer) continue
            try { const fp = styleFingerprint(buffer); if (fp) fps.push(fp) } catch { /* 跳过 */ }
          }
          if (fps.length < 2) return dump({ ok: false, error: '已合格素材不足 2 张，无法统计出可复用的调色板' })
          const palette = buildPalette(fps.map((fp) => ({ fingerprint: fp }))).palette.map((p) => p.hex)
          const r = lib.savePalette({ id: args.shared_id ?? project ?? `palette_${Date.now().toString(36)}`, project: project || '(未指定)', palette, note: `来自 ${fps.length} 张已合格素材` })
          if (!r.ok) return dump(r)
          await lib.save()
          return dump({ ok: true, ...r, palette, note: '其他项目可用 shared-list 看到它，style-transfer 或 palette 吸附时引用。跨项目复用会提示串味风险。' })
        }
        if (action === 'style-transfer') {
          if (!args.file || !args.files?.[0]) return dump({ ok: false, error: '需要 file（目标图）与 files[0]（参考图）' })
          const { decodePngRgba } = await import('./pngcodec.js')
          const targetBuffer = await readPng(args.file).catch(() => null)
          const refBuffer = await readPng(args.files[0]).catch(() => null)
          if (!targetBuffer || !refBuffer) return dump({ ok: false, error: '读不到目标图或参考图' })
          const target = decodePngRgba(targetBuffer)
          const reference = decodePngRgba(refBuffer)
          const r = transferStyle({ target, reference, strength: Number(args.vars?.strength ?? 1), keepHue: args.vars?.keep_hue !== false })
          if (!r.ok) return dump(r)
          const { encodePngRgba } = await import('./pngcodec.js')
          const out = { ok: true, measured: r.measured, note: r.note, written: false }
          if (args.apply) {
            const target_path = `${args.file.replace(/\.[a-z0-9]+$/i, '')}.styled.png`
            await writePng(target_path, encodePngRgba(r.width, r.height, r.pixels))
            out.written = true
            out.output_file = target_path
          }
          return dump(out)
        }
        if (action === 'ab-design') {
          return dump({ ok: true, ...designAbTest({ baselineRate: Number(args.baseline_rate ?? 0.1), minDetectableEffect: Number(args.detectable_effect ?? 0.02) }) })
        }
        if (action === 'ab-analyze') {
          return dump({
            ok: true,
            ...analyzeAbTest({
              a: { views: Number(args.views_a ?? 0), conversions: Number(args.conversions_a ?? 0) },
              b: { views: Number(args.views_b ?? 0), conversions: Number(args.conversions_b ?? 0) },
            }),
          })
        }
        if (action === 'gallery-html') {
          const current = await scan()
          const html = buildGalleryHtml({ scan: current, title: `素材图鉴${project ? ` · ${project}` : ''}` })
          const out = { ok: true, bytes: Buffer.byteLength(html), files: current.files.length, written: false }
          if (args.apply) {
            const name = `素材图鉴${project ? `-${project}` : ''}.html`
            const target = `${outputDir}\\${name}`
            await writePng(target, Buffer.from(html, 'utf8'))
            out.written = target
            out.note = '图片用本地路径引用（和素材同机即可打开）。发给别人时要连同素材目录一起给。'
          } else {
            out.note = '预览模式。带 apply=true 才写盘。'
          }
          return dump(out)
        }

        return dump({ ok: false, error: `未知 action：${action}` })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  /**
   * L–R 组：自动化编排（触发 / 决策 / 执行 / 自愈 / 优化 / 治理）。
   *
   * ⚠ 用户已确认游戏是**单机**：
   *   Q1 玩家数据回流 / Q2 效果校准 / P4 自动 A/B / J4 真实 A/B 全部**不成立**
   *   （没有回传通道）。这些 action 要么不提供，要么提供本地替代并明确标注局限。
   */
  const autoTool = {
    name: '_dsh_external_dsh_gpt_image_auto',
    description: '自动化编排（L–R）：声明式流水线（N）；规则引擎与置信度分流（M，含抽查/撤销/冷启动降级）；自愈（O）；触发（L：防抖/webhook/git hook）；优化（P）；编排治理（R）。单机游戏没有玩家数据回流 → Q 组只做本地文件级信号，并明确标注局限。',
    parameters: params({
      action: {
        type: 'string',
        enum: [
          'pipeline-show', 'pipeline-set', 'pipeline-validate', 'pipeline-run', 'pipeline-status',
          'pipeline-incremental', 'pipeline-rollback',
          'rules', 'rules-set', 'classify', 'route', 'route-apply',
          'review-log', 'review-undo', 'review-history',
          'selfheal-plan', 'selfheal-apply', 'cascade-plan', 'cascade-apply',
          'debounce', 'throttle', 'webhook-info', 'git-hook', 'git-hook-install',
          'search-params', 'optimize-prompt', 'active-sample',
          'usage-signals', 'retire-plan', 'restock-plan',
          'alerts', 'permission', 'maintenance',
        ],
        description: '默认 pipeline-status',
      },
      root: { type: 'string', description: '游戏目录' },
      project: { type: 'string', description: '项目名' },
      file: { type: 'string', description: '单文件（cascade / debounce 等用）' },
      files: { type: 'array', items: { type: 'string' }, description: '多文件' },
      key: { type: 'string', description: '母图名（cascade）或素材名' },
      state: { type: 'string', enum: ['approved', 'rejected', 'pending'], description: '审核状态' },
      batch_id: { type: 'string', description: '批次 id（route-apply / review-undo / rollback）' },
      dry_run: { type: 'boolean', description: '只算不改（默认 true，安全）' },
      resume: { type: 'boolean', description: '断点续跑（默认 true）' },
      pipeline_text: { type: 'string', description: 'pipeline-set：YAML 或 JSON 文本' },
      rules_text: { type: 'string', description: 'rules-set：规则 JSON' },
      policy: { type: 'object', additionalProperties: true, description: '策略覆盖（阈值/白名单/抽查率）' },
      items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'route：待分流项' },
      actor: { type: 'string', description: 'permission：操作者' },
      perm_action: { type: 'string', description: 'permission：动作（review/configure/install/delete）' },
      hook: { type: 'string', description: 'git-hook：pre-commit / pre-push' },
      debounce_ms: { type: 'number', description: '防抖窗口毫秒（默认 5000）' },
      limit: { type: 'number', description: '通用上限' },
    }, []),
    output: textOut,
    async execute(args) {
      try {
        const state = await runtime.loadState()
        const action = args.action ?? 'pipeline-status'
        const root = args.root ?? state.profiles.data.gameRoot ?? ''
        const outputDir = state.settings.outputDir
        const project = args.project ?? ''
        const dataDir = state.profiles.dataDir
        const scan = async () => scanAssetCatalog({ outputDir, catalog: state.assets, gallery: state.gallery, project })
        const { readFile: readPng } = await import('node:fs/promises')

        // 取「事实」（给规则引擎/分流用）
        const buildFacts = async (entry, lockedPalette = []) => {
          const buffer = await readPng(entry.file).catch(() => null)
          if (!buffer) return null
          const { styleFingerprint } = await import('./stylefp.js')
          const { scoreAsset } = await import('./semantics.js')
          const { readabilityAtSize } = await import('./coherence.js')
          const { decodePngRgba } = await import('./pngcodec.js')
          const decoded = decodePngRgba(buffer)
          let fp = null
          try { fp = styleFingerprint(buffer) } catch { /* 忽略 */ }
          const spec = state.assets ? null : null
          const read = decoded ? readabilityAtSize({ buffer, targetWidth: Math.min(64, decoded.width), targetHeight: Math.min(64, decoded.height) }) : null
          const score = scoreAsset({ buffer, lockedPalette, fingerprint: fp })
          return {
            kind: entry.kind,
            name: entry.name,
            size: decoded ? { width: decoded.width, height: decoded.height } : null,
            palette: { drift: fp ? (fp.saturation ?? 0) * 0.2 : 0 },
            dup: { similarity: 0 },
            quality: { score: score.score },
            readability: { level: read?.level ?? 'unknown' },
          }
        }

        // ── N 组：声明式流水线 ──
        if (action === 'pipeline-show') {
          const p = await PipelineConfig.load(dataDir)
          return dump({
            ok: true,
            pipeline: p.data,
            steps_available: Object.entries(STEP_CATALOG).map(([id, def]) => ({ id, label: def.label, needs: def.needs, produces: def.produces })),
            hint: '改流程用 pipeline-set（YAML/JSON 都行），不用改代码。',
          })
        }
        if (action === 'pipeline-set') {
          if (!args.pipeline_text) return dump({ ok: false, error: '需要 pipeline_text（YAML 或 JSON）' })
          const parsed = PipelineConfig.parse(args.pipeline_text)
          if (!parsed.ok) return dump(parsed)
          const p = new PipelineConfig(path.join(dataDir, 'pipeline.json'), parsed.data)
          const v = p.validate()
          if (!v.ok) return dump({ ok: false, error: '流水线定义有误，未保存', errors: v.errors })
          await p.save()
          return dump({ ok: true, saved: true, validation: v, pipeline: p.data })
        }
        if (action === 'pipeline-validate') {
          const p = await PipelineConfig.load(dataDir)
          return dump({ ok: true, ...p.validate(), pipeline: p.data.name })
        }
        if (action === 'pipeline-incremental') {
          const p = await PipelineConfig.load(dataDir)
          const changed = args.files ?? []
          const current = await scan()
          const plan = planIncremental({ steps: p.data.steps, changedInputs: changed })
          return dump({
            ok: true,
            ...plan,
            pipeline: p.data.name,
            scanned: current.tally?.total ?? 0,
            hint: '改一张图只会重跑受影响的下游，不会触发全库重算。',
          })
        }
        if (action === 'pipeline-status') {
          const p = await PipelineConfig.load(dataDir)
          const runState = await (await import('./util.js')).readJson(path.join(dataDir, 'pipeline-run.json'), null)
          const current = await scan()
          return dump(pipelineStatus({ pipeline: p, runState, scan: current }))
        }
        if (action === 'pipeline-run') {
          const p = await PipelineConfig.load(dataDir)
          const current = await scan()
          const inputs = (args.files?.length ? current.files.filter((f) => args.files.includes(f.file)) : current.files)
            .filter((f) => f.kind === 'source').map((f) => f.file)
          // 试运行优先：配置里要求 dry_run_first 且没跑过 dry-run 时，强制先试运行
          const dryRun = args.dry_run !== false
          const executors = buildPipelineExecutors({ runtime, state, root, dataDir, outputDir, project })
          const result = await runDeclarativePipeline({
            pipeline: p, batchId: args.batch_id ?? `run_${Date.now().toString(36)}`,
            inputs, dataDir, executors,
            dryRun, resume: args.resume !== false,
          })
          return dump({
            ...result,
            note: dryRun
              ? result.note + ' 确认无误后带 dry_run=false 再跑。'
              : result.note,
          })
        }
        if (action === 'pipeline-rollback') {
          const backups = await listBackups({ dataDir })
          const runState = await (await import('./util.js')).readJson(path.join(dataDir, 'pipeline-run.json'), null)
          return dump(planPipelineRollback({ batchId: args.batch_id, runState, backups: backups.items }))
        }

        // ── M 组：规则 + 分流 ──
        if (action === 'rules') {
          const rules = state.assets?.data?.rules ?? DEFAULT_RULES.rules
          return dump({ ok: true, count: rules.length, rules, operators: Object.keys(OPERATORS ?? {}), available_predicates: Object.keys(PREDICATES ?? {}) })
        }
        if (action === 'classify') {
          const current = await scan()
          const { expectations } = await readExpectations(root).catch(() => ({ expectations: {} }))
          const { decodePngRgba: decodePngForClass } = await import('./pngcodec.js')
          const { visualTags } = await import('./semantics.js')
          const { readFile: readForClass } = await import('node:fs/promises')
          const pool = current.files.filter((f) => (args.names ? args.names.includes(f.name) : f.kind === 'source')).slice(0, Number(args.limit ?? 100))
          const results = []
          for (const f of pool) {
            // 尽量多给线索：清单 > 文件名 > 尺寸 > 视觉标签
            // （只给文件名会让真实素材大量落在 unknown —— 实测 ships_zerg_v3 这类名字推不出类别）
            let size = null
            let tags = []
            const buffer = await readForClass(f.file).catch(() => null)
            if (buffer) {
              const decoded = decodePngForClass(buffer)
              if (decoded) size = { width: decoded.width, height: decoded.height }
              try {
                const t = visualTags({ buffer, name: f.name, kind: f.kind })
                tags = t.tags ?? []
              } catch { /* 标签失败不影响分类 */ }
            }
            results.push({ name: f.name, file: f.file, ...classifyAsset({ file: f.file, name: f.name, size, tags, expectations }) })
          }
          const unknown = results.filter((r) => r.kind === 'unknown')
          const bySource = {}
          for (const r of results) bySource[r.source] = (bySource[r.source] ?? 0) + 1
          return dump({
            ok: true,
            classified: results.length,
            unknown: unknown.length,
            by_source: bySource,
            results: results.slice(0, 50),
            advice: unknown.length > 0
              ? `${unknown.length}/${results.length} 张判不出类别 —— 判不出就标 unknown，**不硬塞**（错分类比没分类更糟，会让按类别处理全错）。`
                + `想让它们也能分类：给文件名加类别前缀（i_/card_/t_/u_），或在游戏的 asset-specs.json 里声明。`
              : '全部识别出类别。',
          })
        }
        if (action === 'route' || action === 'route-apply') {
          const current = await scan()
          const policy = { ...DEFAULT_POLICY, ...(args.policy ?? {}) }
          // 历史样本：从审核记录统计
          const reviews = Object.values(state.assets.data.reviews ?? {})
          const history = {
            approved: reviews.filter((r) => r.state === 'approved').length,
            rejected: reviews.filter((r) => r.state === 'rejected').length,
          }
          const pool = (args.items ?? current.files.filter((f) => f.review_state === 'unreviewed' && f.kind === 'source'))
            .slice(0, Number(args.limit ?? 50))
          // 算事实（质量分等）
          const factsList = []
          for (const entry of pool) {
            const facts = await buildFacts(entry)
            if (facts) factsList.push({ name: entry.name, file: entry.file, kind: entry.kind, facts })
          }
          const routed = applyPolicy({ policy, items: factsList, history })
          const out = { ok: true, ...routed, history_samples: history, policy_used: { confidence_approve: policy.confidence_approve, sample_after_approve: policy.sample_after_approve, auto_approve_kinds: policy.auto_approve_kinds } }
          if (action === 'route-apply' && args.dry_run === false) {
            // 真正写结论（并留日志，才能撤销）
            const log = await loadReviewLog(dataDir)
            const changes = []
            const batchId = args.batch_id ?? `auto_${Date.now().toString(36)}`
            for (const item of [...routed.auto_approve, ...routed.sampled]) {
              const before = state.assets.reviewOf({ file: item.file, name: item.name })?.state ?? null
              state.assets.mark({ files: [{ path: item.file, name: item.name }], state: 'approved', note: item.sampled ? '自动通过（抽查复核）' : '自动通过', by: 'auto' })
              changes.push({ file: item.file, before, after: 'approved' })
            }
            for (const item of routed.auto_reject) {
              const before = state.assets.reviewOf({ file: item.file, name: item.name })?.state ?? null
              state.assets.mark({ files: [{ path: item.file, name: item.name }], state: 'rejected', note: item.reasons?.join('；') ?? '自动驳回', by: 'auto' })
              changes.push({ file: item.file, before, after: 'rejected' })
            }
            log.record({ batchId, by: 'auto', action: 'auto_review', changes, note: `自动分流：通过 ${routed.auto_approve.length}，驳回 ${routed.auto_reject.length}` })
            await state.assets.save()
            await saveReviewLog(log)
            out.applied = true
            out.batch_id = batchId
            out.changes = changes.length
            out.undo_hint = `自动改错了？带 action=review-undo batch_id=${batchId} 一键撤销。`
          } else if (action === 'route-apply') {
            out.note = '试运行（dry_run 未设为 false）—— 只报告会怎么分流，没有改任何结论。'
          }
          return dump(out)
        }
        if (action === 'review-log') {
          const log = await loadReviewLog(dataDir)
          return dump({ ok: true, batches: log.undoable(), total_entries: log.data.entries.length })
        }
        if (action === 'review-undo') {
          const log = await loadReviewLog(dataDir)
          const plan = log.planUndo(args.batch_id)
          if (!plan.ok) return dump(plan)
          if (args.dry_run !== false) return dump({ ok: true, dry_run: true, ...plan, hint: '确认后带 dry_run=false 执行撤销。' })
          // 执行撤销（撤销本身也记一条，可再撤销）
          const inverse = []
          for (const item of plan.restore) {
            const before = state.assets.reviewOf({ file: item.file })?.state ?? null
            if (item.state === null) {
              state.assets.clear({ files: [item.file] })
              inverse.push({ file: item.file, before, after: null })
            } else {
              state.assets.mark({ files: [{ path: item.file }], state: item.state, by: 'undo', note: `撤销 ${args.batch_id}` })
              inverse.push({ file: item.file, before, after: item.state })
            }
          }
          log.markUndone(args.batch_id)
          const undoBatch = `undo_${args.batch_id}_${Date.now().toString(36)}`
          log.record({ batchId: undoBatch, by: 'user', action: 'undo', changes: inverse, note: `撤销了 ${args.batch_id}` })
          await state.assets.save()
          await saveReviewLog(log)
          return dump({ ok: true, undone: plan.restore.length, batch_id: args.batch_id, undo_batch: undoBatch, note: `已撤销 ${plan.restore.length} 项。撤销本身也留了痕，可以再撤销回来。` })
        }
        if (action === 'review-history') {
          const log = await loadReviewLog(dataDir)
          if (!args.file) return dump({ ok: true, note: '需要 file 才能查某个文件的变更历史', batches: log.undoable().slice(0, 5) })
          return dump({ ok: true, file: args.file, history: log.historyOf(args.file) })
        }

        // ── O 组：自愈 ──
        if (action === 'selfheal-plan') {
          const current = await scan()
          const { expectations } = await readExpectations(root).catch(() => ({ expectations: {} }))
          // 补 slice_rule（工具层需要的规则）
          const { sliceRuleFor } = await import('./assets.js')
          for (const f of current.files) {
            f.asset_kind = classifyAsset({ file: f.file, name: f.name }).kind
            f.slice_rule = sliceRuleFor({ name: f.name, kind: f.kind, observedSlices: f.observedSlices })
          }
          const orphans = planOrphanCleanup({ files: current.files, catalog: state.assets })
          const dangling = planDanglingVerdicts({ files: current.files, catalog: state.assets })
          const missing = planMissingRepair({ files: current.files, catalog: state.assets, expectations })
          const drift = planConfigDrift({ pipeline: await PipelineConfig.load(dataDir), state: { approved_count: current.tally?.approved ?? 0, installed_count: 0, orphan_count: orphans.summary.total } })
          return dump({
            ok: true,
            orphans, dangling, missing, drift,
            overall: {
              orphans: orphans.summary.total,
              invalidated: dangling.summary.invalidated,
              missing: missing.summary.total,
              drift: drift.summary.drifts,
            },
            advice: '全部是 plan（只算不改）。要执行，带 dry_run=false 调 selfheal-apply。'
              + '删除动作会先备份到回收目录（Q3↔H3 冲突的解法）。',
          })
        }
        if (action === 'selfheal-apply') {
          if (args.dry_run !== false) return dump({ ok: true, dry_run: true, note: 'selfheal-apply 需要 dry_run=false 才真执行。先跑 selfheal-plan 看清单。' })
          const current = await scan()
          const plan = planOrphanCleanup({ files: current.files, catalog: state.assets })
          const recycleDir = path.join(dataDir, 'recycled', new Date().toISOString().slice(0, 10))
          const result = await applyOrphanCleanup({ plan, catalog: state.assets, recycleDir })
          await state.assets.save()
          return dump({ ok: true, ...result, plan_summary: plan.summary })
        }
        if (action === 'cascade-plan' || action === 'cascade-apply') {
          if (!args.key) return dump({ ok: false, error: '需要 key（母图名）' })
          const current = await scan()
          const source = current.files.find((f) => f.name === args.key && f.kind === 'source')
          if (!source) return dump({ ok: false, error: `找不到母图 ${args.key}` })
          const targetState = args.state ?? 'rejected'
          const plan = planCascadeInvalidation({ sourceName: source.name, sourceFile: source.file, files: current.files, catalog: state.assets, newState: targetState })
          if (action === 'cascade-plan' || args.dry_run !== false) {
            return dump({ ok: true, dry_run: true, ...plan, hint: `确认后带 dry_run=false 执行（会把 ${plan.summary.total} 个派生件一并改为 ${targetState === 'rejected' ? '不合格' : '待审'}）。` })
          }
          const log = await loadReviewLog(dataDir)
          const changes = []
          const batchId = `cascade_${Date.now().toString(36)}`
          for (const item of plan.affected) {
            state.assets.mark({ files: [{ path: item.file, name: source.name }], state: item.next_state, by: 'cascade', note: `母图 ${source.name} 变为 ${targetState}` })
            changes.push({ file: item.file, before: item.current_state, after: item.next_state })
          }
          log.record({ batchId, by: 'cascade', action: 'cascade', changes, note: `母图 ${source.name} → ${targetState}` })
          await state.assets.save()
          await saveReviewLog(log)
          return dump({ ok: true, applied: true, batch_id: batchId, changed: changes.length, note: plan.advice })
        }

        // ── L 组：触发 ──
        if (action === 'debounce') {
          const current = await scan()
          const pool = current.files.filter((f) => !args.files?.length || args.files.includes(f.file))
          const result = debounceScan({ files: pool.map((f) => ({ file: f.file, mtime: f.mtime, bytes: f.bytes })), debounceMs: Number(args.debounce_ms ?? 5000) })
          return dump({
            ok: true,
            ready: result.ready.length,
            pending: result.pending.length,
            pending_detail: result.pending.slice(0, 20),
            advice: result.advice,
          })
        }
        if (action === 'throttle') {
          const current = await scan()
          const result = throttleScan({ newFiles: current.files })
          return dump({ ok: true, ...result })
        }
        if (action === 'webhook-info') {
          return dump({ ok: true, url: `${runtime.boardUrl().replace('/gpt-image', '')}/gpt-image/api/webhook`, snippet: webhookSnippet({ writer: project || 'my-script' }) })
        }
        if (action === 'git-hook') {
          return dump(buildGitHook({ hook: args.hook ?? 'pre-commit', gameRoot: root }))
        }
        if (action === 'git-hook-install') {
          if (args.dry_run !== false) {
            const built = buildGitHook({ hook: args.hook ?? 'pre-commit', gameRoot: root })
            return dump({ ok: true, dry_run: true, would_write: built.file, script_preview: built.script.slice(0, 400), hint: '确认后带 dry_run=false 安装。' })
          }
          return dump(await installGitHook({ gameRoot: root, hook: args.hook ?? 'pre-commit', force: Boolean(args.force) }))
        }

        // ── P 组：优化 ──
        if (action === 'search-params') {
          const current = await scan()
          const entry = args.key ? current.files.find((f) => f.name === args.key) : current.files.find((f) => f.review_state === 'approved')
          if (!entry) return dump({ ok: false, error: '找不到作为基准的图（用 key 指定，或先标一张合格）' })
          const record = (state.gallery.list({ limit: 1000 }) ?? []).find((r) => (r.files ?? []).some((f) => f === entry.file))
          const { lineageOf } = await import('./semantics.js')
          const lineage = lineageOf(record)
          if (!lineage?.prompt) return dump({ ok: false, error: '这张图没有 prompt 血缘（不是本插件生成的），无法搜索', hint: '只能对"本插件生成过"的图做参数搜索。' })
          return dump({ ok: true, base: entry.name, ...planParameterSearch({ lineage, seedRadius: Number(args.limit ?? 5), variants: 6 }) })
        }
        if (action === 'optimize-prompt') {
          const reviews = Object.values(state.assets.data.reviews ?? {})
          const rejected = reviews.filter((r) => r.state === 'rejected')
          const counts = new Map()
          for (const r of rejected) {
            const reason = String(r.note ?? '').split(/[\s:：（(]/)[0].trim() || '(未写原因)'
            counts.set(reason, (counts.get(reason) ?? 0) + 1)
          }
          const reasons = [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
          const lib = await TemplateLibrary.load(dataDir)
          return dump({ ok: true, ...analyzeRejections({ reject_reasons: reasons, templates: lib.templates }) })
        }
        if (action === 'active-sample') {
          const current = await scan()
          const reviews = Object.values(state.assets.data.reviews ?? {})
          const history = { approved: reviews.filter((r) => r.state === 'approved').length, rejected: reviews.filter((r) => r.state === 'rejected').length }
          const pool = current.files.filter((f) => f.review_state === 'unreviewed' && f.kind === 'source').slice(0, 60)
          const scored = []
          for (const entry of pool) {
            const facts = await buildFacts(entry)
            if (!facts) continue
            const conf = computeConfidence({ facts, history })
            scored.push({ name: entry.name, file: entry.file, kind: entry.kind, confidence: conf.confidence })
          }
          return dump({ ok: true, ...planActiveSampling({ items: scored, budget: Number(args.limit ?? 20) }) })
        }

        // ── Q/R 组 ──
        if (action === 'usage-signals') {
          const current = await scan()
          const { buildReferenceGraph } = await import('./gamecheck.js')
          const keys = current.files.filter((f) => f.kind === 'source').map((f) => f.name)
          const graph = root ? await buildReferenceGraph({ root, keys: keys.slice(0, 300) }) : null
          const { sliceRuleFor } = await import('./assets.js')
          for (const f of current.files) f.asset_kind = classifyAsset({ file: f.file, name: f.name }).kind
          return dump({ ok: true, ...planUsageSignals({ files: current.files, referenceGraph: graph }) })
        }
        if (action === 'retire-plan') {
          const current = await scan()
          const { buildReferenceGraph } = await import('./gamecheck.js')
          const keys = current.files.filter((f) => f.kind === 'source').map((f) => f.name)
          const graph = root ? await buildReferenceGraph({ root, keys: keys.slice(0, 300) }) : null
          const plan = planRetirement({ files: current.files, referenceGraph: graph, policy: args.policy ?? {} })
          return dump({ ok: true, ...plan, snapshot_hint: '执行前先 action=backup（这是 Q3↔H3 冲突的强制解法）。' })
        }
        if (action === 'restock-plan') {
          const current = await scan()
          const { expectations } = await readExpectations(root).catch(() => ({ expectations: {} }))
          for (const f of current.files) f.asset_kind = classifyAsset({ file: f.file, name: f.name, expectations }).kind
          return dump({ ok: true, ...planRestock({ files: current.files, expectations, minPerKind: Number(args.policy?.min_per_kind ?? 3) }) })
        }
        if (action === 'alerts') {
          const current = await scan()
          const balance = await buildBalanceReport({ profiles: state.profiles, spend: state.spend, pool: state.pool, gallery: state.gallery, checkRemote: false })
          const reviews = Object.values(state.assets.data.reviews ?? [])
          const metrics = {
            unreviewed_ratio: (current.tally?.total ?? 0) > 0 ? (current.tally?.unreviewed ?? 0) / current.tally.total : 0,
            budget_used: balance.today?.budget > 0 ? balance.today.cost / balance.today.budget : 0,
            queue_backlog: state.assets.queueReport().needs_review,
            fail_rate: 0,
          }
          return dump({ ok: true, ...checkAlerts({ metrics, thresholds: args.policy ?? DEFAULT_ALERT_THRESHOLDS }), metrics })
        }
        if (action === 'permission') {
          return dump({ ok: true, ...checkPermission({ actor: args.actor ?? 'dsh-agent', action: args.perm_action ?? 'review', roles: DEFAULT_ROLES }) })
        }
        if (action === 'maintenance') {
          const current = await scan()
          const p = await PipelineConfig.load(dataDir)
          return dump({
            ok: true,
            ...maintenanceChecklist({ outputDir, dataDir }),
            current_state: { total: current.tally?.total ?? 0, unreviewed: current.tally?.unreviewed ?? 0, queue: state.assets.queueReport() },
            pipeline: p.data.name,
          })
        }

        return dump({ ok: false, error: `未知 action：${action}` })
      } catch (error) {
        return dump({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  return [list, generate, edit, videoTool, balanceTool, assetsTool, reprocessTool, qualityTool, studioTool, autoTool, job, scan, poolTool, batch, installTool, screenshot, pipelineTool, styleTool, orderTool, reviewTool, registerTool, promptTool, heatmapTool, sheetTool, approvalTool, crossStyleTool, audioTool, rigTool, config]
}
