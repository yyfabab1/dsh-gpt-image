/**
 * M 组 · 决策自动化（人不用逐张拍板）。
 *
 * 你的批评（我全部接受并实现）：
 *   1. M2 自动 approve ↔ 责任  → 必须配**事后抽查 + 批量撤销**
 *   2. 自动化本身的冷启动      → 没有历史数据时**全走人工**（降级，不是硬猜）
 *   3. 批量撤销               → 前面完全没提，这里补上
 *   4. 审核的 undo            → 人拍错板也要能撤回
 *   5. 试运行模式             → 上线前先 dry-run 看会做什么
 *   6. 权限                   → 谁能改结论、谁能跑自动 approve
 *   7. 并发审核协调           → 多人/多 agent 同时审的冲突合并
 *
 * 设计原则：**明确的判断机器做，模糊的留给人**。
 * 机器的每一次自动决定都必须：可解释（给理由）+ 可撤销（留记录）+ 可抽查。
 */
import { nowIso, sha256 } from './util.js'

// ───────── M1 规则引擎 ─────────

/**
 * 规则 = { id, when: [条件], then: {action, ...}, priority, enabled }
 *
 * 条件形状（全部确定性，好测）：
 *   { field: 'size.width', op: '!=', value: 2 的幂 }  → 用 predicate
 *   { field: 'palette.drift', op: '>', value: 0.3 }
 *   { field: 'dup.similarity', op: '>', value: 0.95 }
 *   { field: 'quality.score', op: '<', value: 60 }
 *
 * 支持的操作符：>, >=, <, <=, ==, !=, in, not_in, matches
 * 也支持 predicate（函数名）做复杂判断（如"非 2 的幂"）。
 */
export const OPERATORS = {
  '>': (a, b) => Number(a) > Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  '==': (a, b) => a === b || String(a) === String(b),
  '!=': (a, b) => !(a === b || String(a) === String(b)),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  not_in: (a, b) => Array.isArray(b) && !b.includes(a),
  matches: (a, b) => new RegExp(String(b)).test(String(a)),
}

/** 常用谓词（复杂到不能用简单比较的判断）。 */
export const PREDICATES = {
  /** 不是 2 的幂（贴图常见要求）。 */
  not_power_of_two: (value) => {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 && (n & (n - 1)) !== 0
  },
  is_power_of_two: (value) => {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
  },
  /** 全透明（透明像素占比极高）。 */
  mostly_transparent: (value) => Number(value) > 0.98,
  /** 有透明通道（至少 2% 透明像素）。 */
  has_transparency: (value) => Number(value) > 0.02,
}

/** 按路径取值：'size.width' → obj.size.width。 */
export function getField(facts, path) {
  return String(path ?? '').split('.').reduce((cursor, key) => {
    if (cursor == null) return undefined
    return cursor[key]
  }, facts)
}

/** M1：全部规则跑一遍，返回命中的（按 priority 降序）。 */
export function evaluateRules({ rules = [], facts = {} } = {}) {
  const hits = []
  const errors = []
  for (const rule of rules) {
    if (rule.enabled === false) continue
    try {
      const matched = (rule.when ?? []).every((cond) => matchCondition(cond, facts))
      const skipped = (rule.when ?? []).length === 0
      if (matched && !skipped) hits.push({ rule, action: rule.then })
    } catch (error) {
      errors.push({ rule: rule.id, error: String(error?.message ?? error) })
    }
  }
  hits.sort((a, b) => Number(b.rule.priority ?? 0) - Number(a.rule.priority ?? 0))
  return { hits, errors, evaluated: rules.filter((r) => r.enabled !== false).length }
}

function matchCondition(cond, facts) {
  if (!cond) return true
  if (cond.predicate) {
    const fn = PREDICATES[cond.predicate]
    if (!fn) throw new Error(`未知谓词 ${cond.predicate}`)
    return Boolean(fn(getField(facts, cond.field), facts))
  }
  if (cond.any) return (cond.any ?? []).some((c) => matchCondition(c, facts))
  if (cond.all) return (cond.all ?? []).every((c) => matchCondition(c, facts))
  if (cond.not) return !matchCondition(cond.not, facts)
  const op = OPERATORS[cond.op ?? '==']
  if (!op) throw new Error(`未知操作符 ${cond.op}`)
  const actual = getField(facts, cond.field)
  if (actual === undefined) return false
  return Boolean(op(actual, cond.value))
}

/** 默认规则集（用户给的示例规则，落成可配置数据）。 */
export const DEFAULT_RULES = {
  version: 1,
  rules: [
    {
      id: 'icon-resize-power-of-two',
      description: '图标尺寸不是 2 的幂 → 自动缩到最近 2 的幂',
      priority: 10,
      when: [{ field: 'kind', op: '==', value: 'icon' }, { field: 'size.width', predicate: 'not_power_of_two' }],
      then: { action: 'resize_to_power_of_two', reason: '图标尺寸非 2 的幂（贴图常见要求）' },
    },
    {
      id: 'palette-drift-review',
      description: '调色板距离 > 0.3 → 标记待审（不自动驳回）',
      priority: 20,
      when: [{ field: 'palette.drift', op: '>', value: 0.3 }],
      then: { action: 'mark_pending', reason: '风格偏离整体调色板，需人确认是否是刻意的' },
    },
    {
      id: 'auto-reject-duplicate',
      description: '与已合格素材重复度 > 95% → 自动驳回（dup）',
      priority: 30,
      when: [{ field: 'dup.similarity', op: '>', value: 0.95 }],
      then: { action: 'auto_reject', code: 'dup', reason: '与已有合格素材几乎相同' },
    },
    {
      id: 'auto-reject-blurry',
      description: '清晰度分低于阈值 → 自动驳回（blurry）',
      priority: 30,
      when: [{ field: 'quality.score', op: '<', value: 50 }],
      then: { action: 'auto_reject', code: 'blurry', reason: '质量分过低（画面不清/信息太少）' },
    },
    {
      id: 'auto-approve-high-score',
      description: '分数高且无风险标记 → 自动通过',
      priority: 100,
      when: [
        { field: 'quality.score', op: '>=', value: 80 },
        { field: 'palette.drift', op: '<=', value: 0.25 },
        { field: 'dup.similarity', op: '<=', value: 0.95 },
      ],
      then: { action: 'auto_approve', reason: '技术层面无硬伤、无风格偏离、非重复' },
    },
  ],
}

// ───────── M2 置信度分流 ─────────

/**
 * M2：算置信度并分流。
 *
 * 置信度来源（全部已有）：D1 视觉标签 + D3 质量评分 + E1 历史偏好。
 *
 * **冷启动降级**（你的自检第 7 条）：没有历史数据时，
 * 偏好项权重自动归零、阈值自动提高；样本为零则**一律走人工**。
 * 绝不因为"没数据"就默认"应该没问题"。
 *
 * @param {{facts:object, history?:{approved:number,rejected:number}, policy?:object}} params
 * @returns {{confidence:number, decision:string, reasons:Array, cold_start:boolean}}
 */
export function computeConfidence({ facts = {}, history = { approved: 0, rejected: 0 }, policy = {} } = {}) {
  const thresholds = {
    approve: Number(policy.confidence_approve ?? 0.85),
    reject: Number(policy.confidence_reject ?? 0.8),
    minHistory: Number(policy.min_history ?? 20),
  }
  const reasons = []
  let score = 0
  let weight = 0

  // ① 质量分（D3）—— 主要信号
  const quality = Number(getField(facts, 'quality.score') ?? -1)
  if (quality >= 0) {
    const q = quality / 100
    score += q * 0.5
    weight += 0.5
    reasons.push(`质量分 ${quality}/100`)
  } else {
    reasons.push('⚠ 没有质量分 —— 无法判断')
  }

  // ② 风格一致（B1 漂移）
  const drift = getField(facts, 'palette.drift')
  if (drift !== undefined) {
    const d = Math.max(0, 1 - Number(drift) * 2)   // drift 0 → 1.0；drift 0.5+ → 0
    score += d * 0.3
    weight += 0.3
    reasons.push(`风格漂移 ${Number(drift).toFixed(2)}`)
  }

  // ③ 可读性（B2）
  const readLevel = getField(facts, 'readability.level')
  if (readLevel) {
    const map = { ok: 1, watch: 0.4, bad: 0, unknown: 0.5 }
    score += (map[readLevel] ?? 0.5) * 0.2
    weight += 0.2
    reasons.push(`小尺寸可读性 ${readLevel}`)
  }

  // ④ 历史偏好（E1）—— **只在样本足够时计入**
  const total = Number(history.approved ?? 0) + Number(history.rejected ?? 0)
  const coldStart = total < thresholds.minHistory
  if (!coldStart) {
    const approveRate = total > 0 ? Number(history.approved) / total : 0.5
    score += approveRate * 0.1
    weight += 0.1
    reasons.push(`历史合格率 ${Math.round(approveRate * 100)}%（样本 ${total}）`)
  } else {
    reasons.push(`⚠ 历史样本不足（${total} < ${thresholds.minHistory}）—— 偏好项不参与，避免用小样本瞎猜`)
  }

  const confidence = weight > 0 ? Number((score / weight).toFixed(3)) : 0

  // 分流：冷启动时**只降不升**（阈值提高），确保"没数据 → 全走人工"
  const approveAt = coldStart ? Math.min(0.98, thresholds.approve + 0.1) : thresholds.approve

  // 驳回判定要看**原始质量分**，不能只看加权置信度：
  // 早先要求 confidence <= 1 - reject 才算驳回，但质量分 20 的图置信度是 0.315，
  // 而 1-0.8=0.2，于是永远不满足 → 明显该驳回的图落进了人工队列（低分分支是死代码）。
  // 这里明确：质量分低于 reject_below_score 就自动驳回 —— 这是**有把握的**判断。
  const rejectBelow = Number(policy.reject_below_score ?? 50)
  const qualityScore = Number(facts.quality?.score ?? -1)

  let decision = 'human'
  if (confidence >= approveAt) decision = 'auto_approve'
  else if (qualityScore >= 0 && qualityScore < rejectBelow) decision = 'auto_reject'
  else decision = 'human'

  return {
    confidence,
    decision,
    decision_label: { auto_approve: '自动通过', auto_reject: '自动驳回', human: '转人工' }[decision],
    cold_start: coldStart,
    thresholds: { approve_at: approveAt, reject_below_score: rejectBelow, ...thresholds },
    reasons,
    note: coldStart
      ? '**冷启动降级**：历史样本不足，阈值已提高，大部分会转人工 —— 这是刻意的，不在没数据时硬猜。'
      : decision === 'auto_reject'
        ? `质量分 ${qualityScore} 低于驳回阈值 ${rejectBelow} —— 这是有把握的判断（画面本身有硬伤）。`
        : '按当前阈值分流。',
  }
}

/**
 * M2：批量分流 + **抽查**（你的批评第 1 条）。
 *
 * 自动通过不等于免检：按 `sampleRate` 抽一部分**回推到人工队列**。
 *
 * 两个设计要点：
 *   1. **确定性**：用 hash(名字+批次) 分桶，不用 Math.random ——
 *      同一批每次跑抽查集合一致（可复现、可讨论、可对比两次跑的结果）。
 *   2. **保底至少 1 张**：纯随机在 10 张 × 10% 时约 35% 概率一张都不中，
 *      用户会以为"抽查坏了"。这里保证只要自动通过数 ≥ 3 就一定抽到至少 1 张，
 *      且**明确标出**这次是保底抽的（不假装是概率命中）。
 */
export function routeWithSampling({ items = [], history = {}, policy = {}, batchSeed = '' } = {}) {
  const sampleRate = Math.max(0, Math.min(1, Number(policy.sample_after_approve ?? 0.1)))
  const minSample = Math.max(0, Number(policy.min_sample ?? 1))
  const results = { auto_approve: [], auto_reject: [], human: [], sampled: [] }
  const approved = []
  for (const item of items) {
    const conf = computeConfidence({ facts: item.facts ?? item, history, policy })
    const record = { ...item, ...conf }
    if (conf.decision === 'auto_approve') approved.push(record)
    else if (conf.decision === 'auto_reject') results.auto_reject.push(record)
    else results.human.push(record)
  }

  // 确定性分桶
  for (const record of approved) {
    const bucket = parseInt(sha256(`${batchSeed}|${record.name ?? ''}`).slice(0, 8), 16) / 0xffffffff
    record.__bucket = bucket
  }
  let picked = approved.filter((r) => r.__bucket < sampleRate)
  // 保底：自动通过够多却一张没抽中时，取桶值最小的那几张
  let backfilled = 0
  if (picked.length === 0 && sampleRate > 0 && approved.length >= 3 && minSample > 0) {
    picked = [...approved].sort((a, b) => a.__bucket - b.__bucket).slice(0, Math.max(minSample, Math.ceil(approved.length * sampleRate)))
    backfilled = picked.length
  }
  const pickedNames = new Set(picked.map((r) => r.name))
  for (const record of approved) {
    const clean = { ...record }
    delete clean.__bucket
    if (pickedNames.has(record.name)) {
      results.sampled.push({ ...clean, sampled: true, reason: backfilled > 0 ? '事后抽查（保底抽中，本次概率命中为空）' : '事后抽查（自动通过但被抽中复核）' })
    } else {
      results.auto_approve.push(clean)
    }
  }

  const total = items.length
  return {
    ...results,
    sample_rate: sampleRate,
    backfilled,
    summary: {
      total,
      auto_approved: results.auto_approve.length,
      sampled: results.sampled.length,
      auto_rejected: results.auto_reject.length,
      human: results.human.length + results.sampled.length,
      human_ratio: total > 0 ? Number(((results.human.length + results.sampled.length) / total).toFixed(3)) : 0,
    },
    advice: total === 0
      ? '没有素材可分流。'
      : `共 ${total} 张：自动通过 ${results.auto_approve.length}（其中 ${results.sampled.length} 张转抽查复核`
        + `${results.sampled.length > 0 ? `，抽中率 ${Math.round((results.sampled.length / Math.max(1, results.auto_approve.length + results.sampled.length)) * 100)}%` : ''}` +
        `${backfilled > 0 ? '，含保底抽中' : ''}），`
        + `自动驳回 ${results.auto_reject.length}，需人工 ${results.human.length + results.sampled.length}`
        + `（占 ${Math.round(((results.human.length + results.sampled.length) / total) * 100)}%）。`
        + `自动通过的都会留记录，可随时批量撤销。`,
  }
}

// ───────── 批量撤销（新增，你批评里漏掉的） ─────────

export const REVIEW_LOG_FILE = 'review-log.json'

/**
 * 审核操作日志：**每一次结论变更都留痕**，才能撤销。
 *
 * 这是"自动 approve 出错谁负责"的答案：不是靠不犯错，
 * 而是**每次自动决定都可追溯、可批量撤回**。
 */
export const DEFAULT_REVIEW_LOG = { version: 1, entries: [], undoStack: [] }

export class ReviewLog {
  constructor(file, data) {
    this.file = file
    this.data = data
  }

  static async loadFrom(dataDir, readJsonFn, writeJsonFn) {
    const path = `${dataDir}\\${REVIEW_LOG_FILE}`
    const raw = await readJsonFn(path, null)
    return new ReviewLog(path, raw && Array.isArray(raw.entries) ? raw : structuredClone(DEFAULT_REVIEW_LOG))
  }

  /**
   * 记录一次批量操作（这是撤销的依据）。
   * @param {{batchId:string, by:string, action:string, changes:Array<{file,before,after}>, note?:string}} params
   */
  record({ batchId, by = 'unknown', action = 'review', changes = [], note = '' }) {
    const entry = {
      batch_id: batchId || `rb_${Date.now().toString(36)}`,
      at: nowIso(),
      by,
      action,
      note,
      count: changes.length,
      // 撤销需要"改前"的值
      changes: changes.slice(0, 5000),
      // 撤销后这个 batch 不能再撤一次
      undone: false,
    }
    this.data.entries.unshift(entry)
    this.data.entries = this.data.entries.slice(0, 500)
    return entry
  }

  /** 按批次查。 */
  get(batchId) {
    return this.data.entries.find((e) => e.batch_id === batchId) ?? null
  }

  /**
   * 撤销一批：返回**应该恢复成什么**（不直接改，由调用方写入并再记一条日志）。
   * 关键：撤销本身也要留痕（否则撤错了无法再撤销回来）。
   */
  planUndo(batchId) {
    const entry = this.get(batchId)
    if (!entry) return { ok: false, error: `找不到批次 ${batchId}` }
    if (entry.undone) return { ok: false, error: `批次 ${batchId} 已经撤销过了` }
    const restore = entry.changes
      .filter((c) => c.before !== c.after)
      .map((c) => ({ file: c.file, state: c.before ?? null }))
    return {
      ok: true,
      batch_id: batchId,
      original: { by: entry.by, action: entry.action, at: entry.at, note: entry.note },
      restore,
      count: restore.length,
      note: `将把 ${restore.length} 项恢复到这次操作之前的状态（${entry.by} 于 ${entry.at} 做的「${entry.action}」）。`,
    }
  }

  /** 标记已撤销。 */
  markUndone(batchId) {
    const entry = this.get(batchId)
    if (entry) entry.undone = true
    return Boolean(entry)
  }

  /** 列出可撤销的批次。 */
  undoable() {
    return this.data.entries.filter((e) => !e.undone && e.count > 0).slice(0, 30)
  }

  /** 审计：某个文件被改过几次、谁改的。 */
  historyOf(file) {
    const key = String(file).replace(/\\/g, '/').toLowerCase()
    const out = []
    for (const entry of this.data.entries) {
      for (const change of entry.changes) {
        if (String(change.file).replace(/\\/g, '/').toLowerCase() === key) {
          out.push({ at: entry.at, by: entry.by, batch: entry.batch_id, before: change.before, after: change.after, undone: entry.undone })
        }
      }
    }
    return out
  }
}

// ───────── M3 自动分类打标 ─────────

/**
 * M3：新素材自动判断项目/类别/用途。
 * 依据（确定性，优先级从高到低）：
 *   1. 规格清单里的定义（最权威）
 *   2. 文件名前缀（i_=icon, u_=ui, t_=tile, card_/card=卡面…）
 *   3. 尺寸（48×48 → 图标；512×768 → 卡面/立绘）
 *   4. 视觉标签（D1）
 * 判不出来就标 unknown —— **不硬塞一个分类**。
 */
export const FILENAME_PREFIX_KINDS = {
  i_: 'icon', icon_: 'icon', ico_: 'icon',
  u_: 'ui', ui_: 'ui',
  t_: 'tile', tile_: 'tile',
  card_: 'card', card: 'card',
  portrait_: 'portrait', char_: 'portrait',
  unit_: 'unit', u2_: 'unit',
  b_: 'building', building_: 'building',
  fx_: 'effect', effect_: 'effect',
  bg_: 'background', background_: 'background',
  wx_: 'effect',       // weather overlay（实测自 doomsday-ember）
  nxb_: 'portrait',
}

export const SIZE_HINTS = [
  { width: 48, height: 48, kind: 'icon' },
  { width: 64, height: 64, kind: 'tile' },
  { width: 512, height: 768, kind: 'card' },
  { width: 1024, height: 1536, kind: 'portrait' },
]

/**
 * 按**宽高比**推断类别（比精确尺寸匹配有用得多）。
 *
 * 为什么需要：实测真实素材是 2048×2048 / 1024×1024 / 1248×832 ——
 * 这些是**生成尺寸**（模型出的），不是**游戏规格尺寸**（48×48 那种）。
 * 用精确匹配必然全部落 unknown，于是"自动分流"永不生效。
 * 宽高比不受分辨率影响，是更稳的线索。
 */
export const ASPECT_HINTS = [
  { min: 0.60, max: 0.72, kind: 'portrait', why: '竖长（约 2:3）→ 立绘/卡面' },
  { min: 0.72, max: 0.88, kind: 'card', why: '竖版（约 3:4）→ 卡面' },
  { min: 0.92, max: 1.08, kind: 'icon', why: '方形（约 1:1）→ 图标' },
  { min: 1.35, max: 1.75, kind: 'background', why: '横版（约 3:2 ~ 16:9）→ 背景/横幅' },
]

export function classifyAsset({ file = '', name = '', size = null, tags = [], expectations = null, specCatalogue = null } = {}) {
  const base = String(name || file.split(/[\\/]/).pop() || '').replace(/\.[a-z0-9]+$/i, '')
  const evidence = []

  // 1) 规格清单
  if (expectations?.[base]?.size) {
    const e = expectations[base]
    return {
      kind: hintKindFromSize(e.size) ?? 'unknown',
      project: '', confidence: 'high',
      evidence: [`规格清单里定义了 ${base}（${e.sizeText ?? `${e.size.width}×${e.size.height}`}）`],
      source: 'spec-list',
    }
  }
  // 2) 文件名前缀
  const lower = base.toLowerCase()
  for (const [prefix, kind] of Object.entries(FILENAME_PREFIX_KINDS)) {
    if (lower.startsWith(prefix)) {
      evidence.push(`文件名前缀「${prefix}」→ ${kind}`)
      return { kind, project: '', confidence: 'high', evidence, source: 'filename' }
    }
  }
  // 3) 尺寸：先精确匹配（游戏规格），再按宽高比推断（生成尺寸）
  //    实测真实素材是 2048×2048 / 1248×832 这种**生成尺寸**，
  //    精确匹配永远命中不了 → 必须靠宽高比兜底，否则大量 unknown。
  if (size?.width && size?.height) {
    const exact = SIZE_HINTS.find((h) => h.width === size.width && h.height === size.height)
    if (exact) {
      evidence.push(`尺寸 ${size.width}×${size.height} 精确匹配常见规格 → ${exact.kind}`)
      return { kind: exact.kind, project: '', confidence: 'high', evidence, source: 'size-exact' }
    }
    const ratio = size.width / size.height
    const byAspect = ASPECT_HINTS.find((h) => ratio >= h.min && ratio < h.max)
    if (byAspect) {
      evidence.push(`宽高比 ${ratio.toFixed(2)}：${byAspect.why}`)
      return {
        kind: byAspect.kind,
        project: '',
        confidence: 'medium',
        evidence,
        source: 'aspect',
        // 诚实标注：宽高比只能定**形状类别**（方/竖/横），定不了**语义类别**（这把剑是图标还是单位立绘）。
        // 所以 aspect 推断出来的类别**只用于按形状批处理**（如统一缩放），
        // 不要用它做"按语义类别差异化"的决策 —— 那需要 asset-specs.json 或命名规范。
        caveat: '按宽高比推断的"形状类别"，不是语义类别。要精确语义请在 asset-specs.json 里声明或规范命名。',
      }
    }
  }
  // 4) 视觉标签
  const tagKinds = { 图标: 'icon', 地块: 'tile', 卡面: 'card', 立绘: 'portrait', 截图: 'screenshot', 切片: 'slice', 横向: 'background', 方形: 'icon', 纵向: 'portrait' }
  for (const tag of tags) {
    if (tagKinds[tag]) {
      evidence.push(`视觉标签「${tag}」→ ${tagKinds[tag]}`)
      return { kind: tagKinds[tag], project: '', confidence: 'low', evidence, source: 'visual-tags' }
    }
  }
  // 判不出来就承认
  return {
    kind: 'unknown',
    project: '',
    confidence: 'none',
    evidence: ['文件名、尺寸、标签都没给出可判定的线索'],
    source: 'none',
    note: '判不出来就标 unknown —— 不硬塞一个分类（错分类比没分类更糟，会让后续按类别处理全错）。',
  }
}

function hintKindFromSize(size) {
  const hit = SIZE_HINTS.find((h) => h.width === size.width && h.height === size.height)
  return hit?.kind ?? null
}

// ───────── M4 批量策略 ─────────

/**
 * M4：一次定义策略，全库生效。
 * 策略 = 规则集 + 分流阈值 + 分类映射 + 各类别的自动权限。
 */
export const DEFAULT_POLICY = {
  version: 1,
  // 哪些类别允许自动通过（其余必须人工）
  auto_approve_kinds: ['icon', 'tile', 'effect'],
  // 哪些类别**永远**不自动通过（如卡面/立绘，审美权重高）
  never_auto_approve: ['card', 'portrait'],
  confidence_approve: 0.85,
  confidence_reject: 0.8,
  min_history: 20,
  reject_below_score: 50,
  sample_after_approve: 0.1,
  rules: DEFAULT_RULES.rules,
}

export function applyPolicy({ policy = DEFAULT_POLICY, items = [], history = {} } = {}) {
  const never = new Set(policy.never_auto_approve ?? [])
  const allowed = new Set(policy.auto_approve_kinds ?? [])
  // unknown 的处理是**策略开关**，不是硬编码：
  //   默认 `unknown_passes: false` → 判不出类别就不自动过（安全优先）
  //   但必须**明确告诉用户"这是为什么"**，否则他会以为自动分流坏了。
  //   实测：真实项目里 ships_zerg_v3 / r67rest_cardart 这类名字根本推不出类别，
  //   如果只是静默挡掉，用户会看到"自动分流从不生效"。
  const unknownPasses = policy.unknown_passes === true
  const blocked = []
  const passed = []
  const unknownBlocked = []
  for (const item of items) {
    const kind = item.kind ?? item.facts?.kind
    if (never.has(kind)) {
      blocked.push({ ...item, policy_block: `类别「${kind}」被策略设为永不自动通过（审美权重高，需人看）` })
    } else if (kind === 'unknown' || !kind) {
      if (unknownPasses) passed.push(item)
      else {
        blocked.push({ ...item, policy_block: `推不出类别（文件名/尺寸/标签都没线索）→ 不自动通过` })
        unknownBlocked.push(item)
      }
    } else if (!allowed.has(kind)) {
      blocked.push({ ...item, policy_block: `类别「${kind}」不在自动通过白名单里（当前白名单：${[...allowed].join('/')}）` })
    } else {
      passed.push(item)
    }
  }
  const routed = routeWithSampling({ items: passed, history, policy })
  const unknownCount = unknownBlocked.length
  return {
    ...routed,
    policy_blocked: blocked,
    unknown_blocked: unknownCount,
    summary: {
      ...routed.summary,
      policy_blocked: blocked.length,
      unknown_blocked: unknownCount,
      human: routed.summary.human + blocked.length,
      human_ratio: items.length > 0 ? Number(((routed.summary.human + blocked.length) / items.length).toFixed(3)) : 0,
    },
    advice: [
      routed.advice,
      blocked.length > 0 ? `另有 ${blocked.length} 张因类别策略直接转人工。` : '',
      // 关键：把"为什么自动分流没生效"直接说清，而不是让用户困惑
      unknownCount > 0 && unknownCount >= blocked.length * 0.5
        ? `⚠ 其中 ${unknownCount} 张是**推不出类别**——真相是它们的文件名没有类别线索。`
          + `两种出路：(a) 给这些素材补类别（改名或用 asset-specs.json 声明）；`
          + `(b) 如果你确认这批图技术层面没问题，把策略设 \`unknown_passes: true\`（风险自负：判不出类别也就无法按类别差异化处理）。`
        : '',
    ].filter(Boolean).join(' '),
  }
}
