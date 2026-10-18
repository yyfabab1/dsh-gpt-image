/**
 * 素材目录（磁盘索引）+ 人工审核状态。
 *
 * 解决两个真实问题：
 *   ① 磁盘上有图，画廊里却没有。
 *      原因：这些图不是本插件生成的，而是**别的工具/批量脚本直接写进输出目录**的
 *      （切片产物 `x_slices/…`、缩放件 `x_64x16.png`、`_labeled.png` 预览件、
 *      截图 `shot_*.png`、以及仓库批量跑出来的 `r67rest_*.png`）。
 *      history.json 只记"本插件生成的"，所以画廊永远看不到它们。
 *      → 这里改为**扫磁盘**，任何在输出目录里的图都进目录，并标注来源。
 *   ② 没有人能"拍板"哪些素材合格。
 *      → 增加持久化的审核状态：合格(approved) / 不合格(rejected) / 待定(pending)，
 *      可按素材名或按文件路径标记，支持一件勾选、批量操作。
 *
 * 数据落在 <数据目录>/assets.json，与 history.json 分开：那是"生成记录"，这是"人工判断"，
 * 两者的生命周期不同（重画一张图不会清掉人对它名字的结论，反之亦然）。
 */
import { readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from './util.js'

export const DEFAULT_ASSETS = {
  version: 1,
  /** 文件绝对路径(小写, 正斜杠) → 审核记录 */
  reviews: {},
  /** 素材名 → 审核记录（让"这个名字合格"跨重画继承） */
  byName: {},
  /**
   * 队列：**派生数据**，可从 reviews/byName + 磁盘扫描重算（存下来只为省一次全扫）。
   * 语义见各字段注释；不要把它当权威来源去反推审核结论。
   */
  queue: {
    /** 已合格、还没装（或装了之后内容又变）的源图路径 */
    needsInstall: [],
    /** 磁盘上有、但从来没审过的路径 */
    needsReview: [],
    /** 审过之后内容又变了 → 结论失效，要重审 */
    needsReReview: [],
  },
  /** 自动化策略开关。默认全开：审核一次，之后自动到底。 */
  auto: {
    slices: true,           // 审核通过 → 自动切片
    scaled: true,           // 生成 _64x16 这类缩放件
    installOnApprove: true, // 进 needsInstall，由 install 自动消费
  },
  updatedAt: '',
}

/** 审核状态。 */
export const REVIEW_STATES = ['approved', 'rejected', 'pending']
const STATE_LABEL = { approved: '合格', rejected: '不合格', pending: '待定' }
/** 中文标签；空/未知一律说「未审核」（比原样回显空串对用户更有意义）。 */
export const reviewStateLabel = (state) => STATE_LABEL[state] ?? '未审核'

/** 归一化路径：统一小写 + 正斜杠，避免 Windows 大小写/分隔符导致同一文件算两个。 */
export function normalizePath(file) {
  return String(file ?? '').replace(/\\/g, '/').toLowerCase()
}

/** 从文件名提炼「素材名」：去掉序号、_labeled、扩展名。 */
export function assetNameOf(file) {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? ''
  return base
    .replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '')
    .replace(/_labeled$/i, '')
    .replace(/_\d+x\d+$/i, '')   // 缩放产物 x_64x16
    .replace(/_\d+$/i, '')       // 序号 _1
}

/** 判断文件是哪来的（决定"这算不算正式素材"）。 */
export function classifyFile(file, { inSlicesDir = false } = {}) {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? ''
  if (inSlicesDir) return 'slice'
  if (/_labeled\.(png|jpe?g|webp)$/i.test(base)) return 'preview'
  if (/^shot_/i.test(base)) return 'screenshot'
  if (/_\d+x\d+\.(png|jpe?g|webp)$/i.test(base)) return 'resized'
  if (/_slices$/i.test(path.dirname(String(file ?? '')))) return 'slice'
  return 'source'
}

/** 会被当作"素材"的类别（截图/preview 默认不算正式素材，但要能被看见）。 */
export const ASSET_KINDS = ['source', 'slice', 'resized', 'preview', 'screenshot']

/**
 * 切片规则：从「素材名 + 源图尺寸」推出网格。
 *
 * 实测本机的既有约定（`末日余烬-贴图重制/`）：目录 `<name>_slices/` 里的文件数
 * 就等于网格格数，而名字里带了这个数：
 *   pilot_cardart_4_slices     → 4  格
 *   r67_frames_8_slices        → 8  格
 *   icon_drug_12_slices        → 12 格
 *   card_atk_pilot16_slices    → 16 格
 *   icon_relic_18_slices       → 18 格
 * 所以「名字以数字结尾」就是格数（不是尺寸）。`_64x16` 那种是**缩放目标**，不是网格。
 *
 * 纯函数、不碰磁盘：UI 的实时切片预览和批量重处理都用它，保证两边算得一样。
 */

/**
 * 从素材名解析网格**候选**（可能不唯一）。
 *
 * 名字歧义在真实数据里非常严重，实测踩了三个坑：
 *   `t_path_64x16`    → 16 是尺寸高度，不是格数
 *   `i_skull_48`      → 48 是清单里的规格
 *   `r67tpath_dark2`  → 2 是版本号（但 `r67_spritetest4` 的 4 真是格数）
 * 光靠名字无法百分百分清，所以这里只给**候选**，最终由 sliceRuleFor 结合
 * 「磁盘上的 _slices 目录里实际有几个文件」来定 —— 那是唯一的事实来源。
 */
export function sliceCandidates(name) {
  const text = String(name ?? '').replace(/^(.*[\\/])/, '')
  const out = []
  const withoutSize = text.replace(/_\d{1,4}x\d{1,4}(?=$|_)/g, '')
  const sep = withoutSize.match(/[_\-](\d{1,3})$/)
  if (sep) out.push({ n: Number(sep[1]), from: 'separated', confident: true })
  const glued = withoutSize.match(/[a-z](\d{1,3})$/i)
  if (glued) out.push({ n: Number(glued[1]), from: 'glued', confident: false })
  return out.filter((item) => Number.isFinite(item.n) && item.n >= 2 && item.n <= 256)
}

/** 从素材名里解析出网格格数（取最可信的候选）；解析不出来返回 0。 */
export function parseSliceCount(name) {
  const candidates = sliceCandidates(name)
  if (candidates.length === 0) return 0
  // 有分隔符的优先（xxx_16），它比紧贴的（xxx16）更可能是刻意约定
  const best = candidates.find((item) => item.confident) ?? candidates[0]
  // 紧贴且是一位数、又像版本号的（dark2）交给外部用 _slices 事实推翻
  return best.n
}

/** 从 `_64x16` 这类后缀解析缩放目标（宽×高）；不是尺寸就返回 null。 */
export function parseScaleTarget(name) {
  const m = String(name ?? '').match(/_(\d{1,4})x(\d{1,4})(?:_|$)/)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!(width > 0 && height > 0)) return null
  return { width, height }
}

/** 把格数排成最接近正方形的网格（与 sheet.js 的 gridFor 同策略，避免两处不一致）。 */
export function gridFromCount(count) {
  const n = Math.max(1, Number(count) || 1)
  const columns = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / columns))
  return { columns, rows, capacity: columns * rows }
}

/**
 * 解析某张图该怎么切。
 *
 * 歧义消解（实测踩过两个坑）：
 *   1. `t_path_64x16` 的 16 是高度 → 已在 parseSliceCount 里排掉尺寸后缀
 *   2. `i_skull_48` 的 48 是**清单里声明的规格**（48×48）→ 必须先查清单
 * 所以传入 expectations（check.js 读出来的「待画素材清单」）时以它为准：
 * 名字的结尾数字若等于清单里的宽/高，就当**尺寸**而不是网格。
 *
 * @param {{name?:string, width?:number, height?:number, kind?:string,
 *          expected?:{size?:{width:number,height:number}}}} asset
 * @returns {{slices,columns,rows,capacity,scaled?,source}|null}
 */
export function sliceRuleFor(asset = {}) {
  const kind = asset.kind ?? 'source'
  // preview/screenshot 不参与切片（给人看的）
  if (kind === 'preview' || kind === 'screenshot') return null
  const scaled = parseScaleTarget(asset.name) ?? undefined

  // 事实优先：磁盘上 <name>_slices/ 里实际有几个文件，就是几格。
  // 名字解析只是**猜测**，在有观测值时必须让位（实测 dark2 被误判成 2 格）。
  const observed = Number(asset.observedSlices) || 0
  let count = observed || parseSliceCount(asset.name)

  // 清单里声明了尺寸，而结尾数字正好是宽或高 → 那是规格，不是网格
  const size = asset.expected?.size
  if (!observed && count && size) {
    const tail = Number((String(asset.name).match(/[_\-]?(\d{1,3})$/) ?? [])[1])
    if (tail === Number(size.width) || tail === Number(size.height)) count = 0
  }
  if (!count && !scaled) return null
  const grid = count ? gridFromCount(count) : { columns: 0, rows: 0, capacity: 0 }
  return {
    slices: count,
    columns: grid.columns,
    rows: grid.rows,
    capacity: grid.capacity,
    scaled,
    // 规则来源：便于审核界面告诉人"我是按什么切的"
    source: observed
      ? `已存在的切片数 ${observed}`
      : count
        ? `名字里的格数 ${count}`
        : `后缀尺寸 ${scaled.width}×${scaled.height}`,
    observed: Boolean(observed),
  }
}

export class AssetCatalog {
  constructor(dataDir, file, data) {
    this.dataDir = dataDir
    this.file = file
    this.data = {
      ...DEFAULT_ASSETS,
      ...data,
      reviews: { ...DEFAULT_ASSETS.reviews, ...(data?.reviews ?? {}) },
      byName: { ...DEFAULT_ASSETS.byName, ...(data?.byName ?? {}) },
      queue: { ...DEFAULT_ASSETS.queue, ...(data?.queue ?? {}) },
      auto: { ...DEFAULT_ASSETS.auto, ...(data?.auto ?? {}) },
    }
    // 队列字段必须是数组（快照/手改后可能变成别的东西）
    for (const key of ['needsInstall', 'needsReview', 'needsReReview']) {
      if (!Array.isArray(this.data.queue[key])) this.data.queue[key] = []
    }
  }

  static async load(dataDir) {
    const file = path.join(dataDir, 'assets.json')
    const raw = await readJson(file, null)
    return new AssetCatalog(dataDir, file, raw && typeof raw === 'object' ? raw : {})
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  /** 查某个文件/素材名的审核状态：优先按文件，其次按名字。 */
  reviewOf({ file, name } = {}) {
    const byFile = file ? this.data.reviews[normalizePath(file)] : null
    if (byFile) return byFile
    const key = name ? String(name) : (file ? assetNameOf(file) : '')
    return key ? (this.data.byName[key] ?? null) : null
  }

  /**
   * 标记审核状态。
   * @param {{files?:Array<{path:string,name?:string,contentHash?:string}>, names?:string[], state:string,
   *          note?:string, by?:string, scope?:'file'|'name'}} params
   */
  mark({ files = [], names = [], state, note = '', by = 'user', scope = 'file' }) {
    if (!REVIEW_STATES.includes(state)) return { ok: false, error: `state 必须是 ${REVIEW_STATES.join(' / ')}` }
    const at = nowIso()
    let changed = 0
    for (const item of files) {
      // contentHash 是"结论失效"的判据：审的时候记下内容，之后内容变了就知道要重审
      const entry = { state, note, by, at, ...(item.contentHash ? { contentHash: item.contentHash } : {}) }
      this.data.reviews[normalizePath(item.path ?? item)] = entry
      // 同时按名字记一份（除非显式只要 file scope），这样重画后结论能继承
      if (scope !== 'file') {
        const name = item.name ?? assetNameOf(item.path ?? item)
        if (name) this.data.byName[name] = entry
      }
      changed += 1
    }
    for (const name of names) {
      if (!name) continue
      this.data.byName[String(name)] = { state, note, by, at }
      changed += 1
    }
    return { ok: true, changed, state, label: reviewStateLabel(state) }
  }

  clear({ files = [], names = [] }) {
    let changed = 0
    for (const item of files) {
      const key = normalizePath(item.path ?? item)
      if (this.data.reviews[key]) { delete this.data.reviews[key]; changed += 1 }
    }
    for (const name of names) {
      if (this.data.byName[name]) { delete this.data.byName[name]; changed += 1 }
    }
    return { ok: true, cleared: changed }
  }

  /** 统计（含"未审核"）。 */
  stats() {
    const tally = { approved: 0, rejected: 0, pending: 0 }
    for (const item of Object.values(this.data.reviews)) {
      if (tally[item.state] !== undefined) tally[item.state] += 1
    }
    return { files_reviewed: Object.keys(this.data.reviews).length, names_reviewed: Object.keys(this.data.byName).length, ...tally }
  }

  /**
   * 派生文件继承源图结论。
   *
   * 「人审 1 张源图 = N 张切片自动合格」就靠这里，也是自动切片与批量重处理**共用**的同一套
   * （prompt 3 明确要求不要写两份）。派生文件的结论同时写 byPath 与 byName，
   * 这样它自己也满足"没被审过"的判定，不会又被丢进 needsReview。
   *
   * @param {{sourcePath:string, sourceName:string, derived:Array<{path:string,name?:string}>, state?:string, note?:string}} params
   */
  inherit({ sourcePath, sourceName, derived = [], state, note = '' }) {
    const source = this.reviewOf({ file: sourcePath, name: sourceName })
    const inherited = state ?? source?.state
    if (!inherited) return { ok: false, error: '源图没有审核结论，无处继承' }
    const at = nowIso()
    for (const item of derived) {
      const entry = { state: inherited, note: note || `继承自 ${sourceName || sourcePath}`, by: 'inherit', at }
      this.data.reviews[normalizePath(item.path)] = entry
      if (item.name) this.data.byName[item.name] = entry
    }
    return { ok: true, inherited_from: sourceName || sourcePath, state: inherited, count: derived.length }
  }

  /**
   * 重算队列（**纯计算**，不写盘）：扫出来的文件 + 审核记录 → 三个队列。
   * 之所以能重算，是因为队列只依赖"有没有结论 + 内容有没有变"。
   *
   * @param {{files:Array<{file:string,name:string,kind:string,contentHash?:string}>}} params
   */
  recomputeQueue({ files = [] } = {}) {
    const needsInstall = []
    const needsReview = []
    const needsReReview = []
    for (const item of files) {
      // 预览图/截图不是交付物，不进任何队列
      if (item.kind === 'preview' || item.kind === 'screenshot') continue
      const review = this.reviewOf({ file: item.file, name: item.name })
      if (!review) {
        needsReview.push(item.file)
        continue
      }
      // 审过之后内容变了 → 结论失效（这就是"结论失效"的唯一来源）
      const reviewedHash = review.contentHash
      if (reviewedHash && item.contentHash && reviewedHash !== item.contentHash) {
        needsReReview.push(item.file)
        continue
      }
      if (review.state === 'approved') needsInstall.push(item.file)
    }
    this.data.queue = {
      needsInstall: dedupe(needsInstall),
      needsReview: dedupe(needsReview),
      needsReReview: dedupe(needsReReview),
    }
    return this.data.queue
  }

  /** 队列概况（给 UI/工具看）。 */
  queueReport() {
    const n = (key) => (this.data.queue[key] ?? []).length
    return {
      needs_install: n('needsInstall'),
      needs_review: n('needsReview'),
      needs_re_review: n('needsReReview'),
      auto: { ...this.data.auto },
      // 只有这两种情况需要打断人；其余全自动
      needs_human: n('needsReview') > 0 || n('needsReReview') > 0,
    }
  }

  /** 从队列里移除（装完之后调用）。 */
  dequeue(files = []) {
    const drop = new Set(files.map(normalizePath))
    let removed = 0
    for (const key of ['needsInstall', 'needsReview', 'needsReReview']) {
      const before = this.data.queue[key].length
      this.data.queue[key] = this.data.queue[key].filter((file) => !drop.has(normalizePath(file)))
      removed += before - this.data.queue[key].length
    }
    return removed
  }
}

/** 去重但保序（队列顺序有意义：先来的先处理）。 */
function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = normalizePath(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 扫输出目录，把磁盘上**所有**图列出来（不只历史里记过的）。
 * @param {{outputDir:string, catalog?:AssetCatalog, gallery?:object, project?:string, maxFiles?:number}} params
 */
export async function scanAssetCatalog({ outputDir, catalog, gallery, project = '', maxFiles = 4000 } = {}) {
  if (!outputDir) return { ok: false, error: '没有输出目录' }
  // 历史里的记录按路径索引，用来标"谁生成的 + 提示词"
  const byPath = new Map()
  for (const record of gallery?.list?.({ limit: 1000 }) ?? []) {
    for (const file of record.files ?? []) byPath.set(normalizePath(file), record)
    for (const file of record.labeled ?? []) byPath.set(normalizePath(file), record)
  }

  const projects = []
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => [])
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue
    if (project && dirent.name !== project) continue
    projects.push(dirent.name)
  }

  const files = []
  for (const proj of projects) {
    const projectDir = path.join(outputDir, proj)
    // 项目根 + 一层子目录（切片产物在 x_slices/ 里）
    const stack = [{ dir: projectDir, depth: 0 }]
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()
      const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const child of children) {
        if (files.length >= maxFiles) break
        const full = path.join(dir, child.name)
        if (child.isDirectory()) {
          if (depth < 1) stack.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(child.name)) continue
        let size = 0
        let mtime = ''
        try {
          const info = await stat(full)
          size = info.size
          mtime = info.mtime.toISOString()
        } catch { /* 读不到就留空，不影响列出 */ }
        const kind = classifyFile(full, { inSlicesDir: path.basename(dir).endsWith('_slices') })
        const record = byPath.get(normalizePath(full)) ?? null
        const name = record?.name ?? assetNameOf(full)
        const review = catalog?.reviewOf({ file: full, name }) ?? null
        files.push({
          file: full,
          project: proj,
          name,
          kind,
          bytes: size,
          mtime,
          // 有历史记录 = 本插件生成的；没有 = 外部工具写的（这正是以前"看不见"的那批）
          generated: Boolean(record),
          prompt: record?.prompt ?? '',
          provider: record?.provider ?? '',
          model: record?.model ?? '',
          review_state: review?.state ?? 'unreviewed',
          review_note: review?.note ?? '',
          review_at: review?.at ?? '',
        })
      }
    }
  }

  const tally = { total: files.length, generated: 0, external: 0, approved: 0, rejected: 0, pending: 0, unreviewed: 0 }
  const byKind = {}
  for (const item of files) {
    tally[item.generated ? 'generated' : 'external'] += 1
    if (item.review_state === 'unreviewed') tally.unreviewed += 1
    else tally[item.review_state] += 1
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
  }

  // 观测到的切片数：<name>_slices/ 里实际有几个文件 —— 这是网格的**事实来源**，
  // 比从名字猜可靠（实测 r67tpath_dark2 会被名字误判成 2 格）。
  // 注意：切片文件自己在 _slices 目录里，名字形如 `r67_frames_8_01`，
  // 要归到**源素材名** `r67_frames_8` 上，而不是按切片自己的名字统计。
  const observedSlices = {}
  for (const item of files) {
    if (item.kind !== 'slice') continue
    const dir = path.basename(path.dirname(item.file))
    const source = dir.endsWith('_slices') ? dir.slice(0, -'_slices'.length) : item.name
    if (!source) continue
    observedSlices[source] = (observedSlices[source] ?? 0) + 1
  }
  for (const item of files) item.observedSlices = observedSlices[item.name] ?? 0

  return {
    ok: true,
    output_dir: outputDir,
    projects,
    files: files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))),
    tally,
    by_kind: byKind,
    observedSlices,
    // 这批就是以前"只在文件夹里、看不见"的图
    external_files: files.filter((item) => !item.generated).map((item) => item.file),
  }
}
