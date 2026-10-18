/**
 * P/Q/R 组 · 调度优化 / 闭环（本地版） / 编排治理。
 *
 * ⚠ 重要前提（用户已确认：**单机游戏**）：
 *   Q1 装机数据回传、Q2 效果反馈校准、Q4 自动补货、P4 自动 A/B、J4 真实 A/B
 *   —— 这些**全部依赖游戏端回传数据**。单机游戏没有回传通道。
 *   所以本文件里：
 *     · Q1/Q2/P4/J4 提供的是**本地可观测的替代**（文件级证据），并**明确标注局限**
 *     · 真正的"玩家数据回流"标注为 **needs_game_telemetry**，不假装能做
 *     · Q3 淘汰 / Q4 补货 用**本地信号**（引用/审核/时间）实现，不依赖玩家数据
 */
import { nowIso } from './util.js'

// ───────── P1 自动参数搜索 ─────────

/**
 * P1：给定一张满意的图，扫 seed/参数附近，找"相似但更多样"的候选。
 *
 * 做法：以满意图的血缘为基准，生成一个探索网格：
 *   - seed：邻近若干（保持风格接近）
 *   - 微调：只动 1 个维度（避免"全变了"导致失去相似性）
 * 明确输出"这批和原图的关系"，让人知道自己在探索什么。
 */
export function planParameterSearch({ lineage, seedRadius = 5, variants = 6, tune = [] } = {}) {
  if (!lineage) return { ok: false, error: '需要血缘（lineage）才能搜索' }
  const baseSeed = Number(lineage.seed)
  const hasSeed = Number.isFinite(baseSeed)
  const candidates = []

  if (hasSeed) {
    // 以上下邻近 seed 为主（相邻 seed 通常风格最接近）
    for (let i = 1; i <= seedRadius && candidates.length < variants; i++) {
      candidates.push({ seed: baseSeed - i, why: `seed -${i}（邻近，风格最接近）` })
      if (candidates.length >= variants) break
      candidates.push({ seed: baseSeed + i, why: `seed +${i}（邻近，风格最接近）` })
    }
  } else {
    // 没有 seed → 只能说"随机抽"，诚实标注
    for (let i = 0; i < variants; i++) candidates.push({ seed: undefined, why: '原图没有 seed → 随机（不能保证相似）' })
  }

  // 参数微调：每次只动一个维度
  const tuning = []
  for (const dim of tune) {
    if (dim === 'size' && lineage.size) tuning.push({ change: 'size', from: lineage.size, why: '换尺寸看构图是否仍然成立' })
    if (dim === 'quality' && lineage.quality) tuning.push({ change: 'quality', from: lineage.quality, why: '换质量看细节是否够用' })
    if (dim === 'ratio' && lineage.ratio) tuning.push({ change: 'ratio', from: lineage.ratio, why: '换比例看构图的适应范围' })
  }

  return {
    ok: true,
    base: { prompt: lineage.prompt, size: lineage.size, quality: lineage.quality, seed: hasSeed ? baseSeed : null, model: lineage.model },
    candidates: candidates.map((c, i) => ({
      name: `search_${String(i + 1).padStart(2, '0')}`,
      prompt: lineage.prompt,
      size: lineage.size,
      quality: lineage.quality,
      ratio: lineage.ratio,
      ...(c.seed !== undefined ? { seed: c.seed } : {}),
      why: c.why,
    })),
    tuning,
    deterministic: hasSeed,
    advice: hasSeed
      ? `以原 seed ${baseSeed} 为中心扫 ±${seedRadius}，共 ${candidates.length} 个候选。`
        + `邻近 seed 的风格最接近 —— 这是"再来几张像的但不要一模一样"的最优策略。`
      : '原图没有 seed，这批只能是**随机**生成 —— 无法保证和原图相似。想可复现，出图时就要带 seed。',
  }
}

// ───────── P2 Prompt 自动优化 ─────────

/**
 * P2：根据驳回原因分布（I2）自动调整模板。
 *
 * 依赖（你的依赖表里说对了）：**I2 审核统计 + F1 模板库**。
 * 做法：驳回原因 → 对应到 prompt 里该加/该删的词，给出**可审阅的模板补丁**。
 * 不自动改模板文件 —— 改提示词是内容决策，必须人看一眼（否则会越改越偏）。
 */
export const REASON_TO_PROMPT_FIX = {
  blurry: { add: ['清晰锐利', '细节清楚', '轮廓明确'], remove: ['柔和', '模糊'], why: '驳回集中在"糊" → 强化清晰度词' },
  low_contrast: { add: ['高对比度', '明确明暗层次'], remove: ['低对比'], why: '驳回集中在"看不清" → 加强对比词' },
  style_drift: { add: ['统一色调', '与现有素材同风格', '限定主色'], remove: [], why: '驳回集中在"不像同一套" → 强化风格锚点' },
  bad_crop: { add: ['主体完整居中', '不要裁切', '四周留边距'], remove: [], why: '驳回集中在"裁切不对" → 明确构图约束' },
  busy: { add: ['简洁', '元素少', '留白'], remove: ['复杂', '丰富细节'], why: '驳回集中在"太乱" → 减法' },
  wrong_orientation: { add: ['正面朝向镜头', '明确朝向'], remove: [], why: '驳回集中在"方向不对" → 明确朝向' },
  dup: { add: [], remove: [], why: '驳回集中在"重复" → 这是**生成端重复**问题，不是提示词能修的：应换 seed 或改主体描述' },
  transparent_missing: { add: ['纯黑背景便于抠图', '背景纯色'], remove: [], why: '驳回集中在"没有透明底" → 加便于抠图的背景描述' },
}

export function analyzeRejections({ reject_reasons = [], templates = [] } = {}) {
  if (reject_reasons.length === 0) {
    return { ok: true, patches: [], advice: '还没有驳回记录，无法给出提示词优化建议（不猜）。' }
  }
  const total = reject_reasons.reduce((s, r) => s + (r.count ?? 0), 0)
  const patches = []
  for (const item of reject_reasons) {
    const code = String(item.reason ?? '').split(/[\s:：（(]/)[0].trim()
    const fix = REASON_TO_PROMPT_FIX[code]
    if (!fix) continue
    patches.push({
      rejection_code: code,
      count: item.count,
      share: total > 0 ? Number(((item.count / total) * 100).toFixed(1)) : 0,
      suggestion: fix,
      patch: fix.add.length > 0 || fix.remove.length > 0
        ? {
            添加: fix.add,
            移除: fix.remove,
            示例: `在模板末尾追加：${fix.add.join('，')}。`,
          }
        : { 说明: fix.why },
      severity: total > 0 && item.count / total > 0.3 ? 'major' : 'minor',
    })
  }
  patches.sort((a, b) => b.count - a.count)
  const major = patches.filter((p) => p.severity === 'major')
  return {
    ok: true,
    total_rejections: total,
    patches,
    advice: patches.length === 0
      ? '驳回原因里没有可映射到提示词问题的类别（可能是别的原因）。'
      : major.length > 0
        ? `最主要的问题是「${major[0].rejection_code}」（占驳回的 ${major[0].share}%）—— ${major[0].suggestion.why}。`
          + `建议改模板「${templates[0]?.id ?? '(未指定)'}」后小批试跑验证，别一次全改。`
        : `有 ${patches.length} 条可优化项，但都很分散 —— 说明不是单一提示词问题，可能是流程问题。`,
    caution: '这是**建议**不是自动改 —— 提示词是内容决策，必须人看一眼。'
      + '自动改提示词会越改越偏（每次都按上一次的结果调，容易过拟合到某个局部）。',
  }
}

// ───────── P3 主动学习采样 ─────────

/**
 * P3：优先推**模型最不确定**的样本给人审（而不是随机）。
 * 依赖（你说对了）：M2 的置信度。
 *
 * 做法：按 |置信度 − 阈值| 升序 —— 越靠近决策边界越不确定，审它学到的最多。
 * 同时保证覆盖：不能只推同一类的（那样会偏）。
 */
export function planActiveSampling({ items = [], budget = 50, policy = {}, ensureCoverage = true } = {}) {
  const threshold = Number(policy.confidence_approve ?? 0.85)
  const scored = items.map((item) => {
    const conf = Number(item.confidence ?? 0.5)
    // 不确定性 = 离阈值越近越不确定
    const uncertainty = 1 - Math.min(1, Math.abs(conf - threshold) / 0.5)
    return { ...item, uncertainty: Number(uncertainty.toFixed(3)), distance_to_threshold: Number(Math.abs(conf - threshold).toFixed(3)) }
  }).sort((a, b) => b.uncertainty - a.uncertainty)

  let picked = scored.slice(0, budget)
  // 覆盖性：如果某一类一个都没进，用该类的最高不确定性项替换掉全局最低的
  if (ensureCoverage && picked.length > 0) {
    const kinds = new Set(items.map((i) => i.kind).filter(Boolean))
    const pickedKinds = new Set(picked.map((p) => p.kind))
    for (const kind of kinds) {
      if (pickedKinds.has(kind)) continue
      const candidate = scored.find((s) => s.kind === kind && !picked.includes(s))
      if (candidate) picked[picked.length - 1] = candidate
    }
  }
  return {
    ok: true,
    budget,
    picked: picked.map((p) => ({ ...p, why: `不确定性 ${p.uncertainty}（置信度 ${p.confidence} 距阈值 ${p.distance_to_threshold}）` })),
    total_candidates: items.length,
    advice: items.length === 0
      ? '没有候选可采样。'
      : `从 ${items.length} 张里挑出最不确定的 ${picked.length} 张 —— 审它们比随机审 100 张学到的更多。`
        + `（越靠近决策边界越不确定：审一张"机器拿不准"的，等于修正一片判断。）`,
    caveat: '主动学习需要置信度已存在（M2）。冷启动时置信度不可靠 → 这时**随机抽样**反而更好（避免被错的置信度带偏）。',
  }
}

// ───────── Q 组：闭环（单机版） ─────────

/**
 * Q1：装机数据回传 —— **单机游戏没有回传通道**。
 *
 * 所以这里做**本地可观测的替代**：用"文件里有没有被引用"作为"用没用上"的证据。
 * 这不是玩家行为数据，但足以回答"这张图是死重量吗"。
 */
export function planUsageSignals({ files = [], referenceGraph = null } = {}) {
  const referenced = new Set()
  if (referenceGraph) {
    for (const item of referenceGraph.referenced ?? []) referenced.add(item.key)
    for (const item of referenceGraph.missing ?? []) referenced.add(item.key)
  }
  const rows = files.filter((f) => f.kind === 'source').map((f) => ({
    name: f.name,
    file: f.file,
    review: f.review_state,
    referenced: referenced.has(f.name),
    mtime: f.mtime,
  }))
  const used = rows.filter((r) => r.referenced)
  const dead = rows.filter((r) => !r.referenced && r.review === 'approved')
  return {
    ok: true,
    total: rows.length,
    referenced: used.length,
    approved_but_unreferenced: dead.length,
    dead_weight: dead.slice(0, 50),
    telemetry: 'local-file-evidence',
    limita: '',
    limitation: '⚠ 这是**文件级证据**（代码里有没有引用），不是玩家行为数据。'
      + '单机游戏没有回传通道 → 无法知道"玩家实际用得多不多"。'
      + '它能回答"这张图是不是死重量"，不能回答"这张图好不好玩"。',
    needs_game_telemetry: ['被加载次数', '玩家交互', '崩溃关联', '留存/点击'],
    advice: rows.length === 0
      ? '没有素材可分析。'
      : `${rows.length} 张源图里 ${used.length} 张被代码引用，${dead.length} 张**合格但没被引用**（死重量的候选）。`
        + '要做真正的使用分析，需要在游戏里加埋点 —— 单机游戏这条路是断的。',
  }
}

/**
 * Q3：自动淘汰 —— 用**本地信号**（不需要玩家数据）。
 *
 * 冲突解法（你指出的 Q3↔H3）：**淘汰前必须先快照**，且保护期可配。
 * 这里返回的是**计划**，真正执行由调用方先备份再删。
 */
export function planRetirement({ files = [], referenceGraph = null, policy = {}, now = Date.now() } = {}) {
  const protectDays = Number(policy.protect_days ?? 30)
  const minScore = Number(policy.min_score ?? 50)
  const referenced = new Set()
  if (referenceGraph) {
    for (const item of referenceGraph.referenced ?? []) referenced.add(item.key)
  }
  const protectMs = protectDays * 24 * 3600 * 1000

  const retire = []
  const protect = []
  for (const item of files) {
    if (item.kind !== 'source') continue
    const age = now - new Date(item.mtime ?? 0).getTime()
    const isReferenced = referenced.has(item.name)
    const score = Number(item.score ?? item.quality?.score ?? -1)
    const neverReferenced = !isReferenced
    const tooNew = age < protectMs
    const lowScore = score >= 0 && score < minScore
    const rejected = item.review_state === 'rejected'

    if ((neverReferenced || rejected || lowScore) && tooNew) {
      protect.push({ name: item.name, file: item.file, why: `在保护期内（${Math.round(age / 86400000)} 天 < ${protectDays} 天）—— 不淘汰`, signals: { isReferenced, score, rejected } })
      continue
    }
    if (rejected && !tooNew) {
      retire.push({ name: item.name, file: item.file, reason: '已驳回且过了保护期', recoverable: true })
    } else if (neverReferenced && lowScore && !tooNew) {
      retire.push({ name: item.name, file: item.file, reason: `未被引用且质量分低（${score}）`, recoverable: true })
    } else if (neverReferenced && !tooNew) {
      retire.push({ name: item.name, file: item.file, reason: '从未被代码引用（死重量候选）', recoverable: true, needs_confirm: true })
    }
  }
  return {
    ok: true,
    retire,
    protect,
    summary: { retire: retire.length, protect: protect.length },
    requires_snapshot: true,
    advice: retire.length === 0
      ? '没有可淘汰的素材。'
      : `${retire.length} 张可淘汰（${retire.filter((r) => r.needs_confirm).length} 张需要你确认 —— "没被引用"可能是还没来得及接上）。`
        + `⚠ **执行前必须先快照**（备份），且默认进回收目录而不是直接删。`
        + `保护期 ${protectDays} 天，${protect.length} 张在保护期内被挡住。`,
    safety: 'Q3↔H3 冲突的解法：先 createBackup → 再移到回收目录（不直接删）→ 记进 provenance。任何一步失败都不继续。',
  }
}

/**
 * Q4：自动补货 —— 检测某类别素材不足。
 *
 * 单机版：只看**本地库存**（数量、合格数、被引用数）。
 * 「火系卡面只有 3 张」这种需要**类别知识**，从文件名/清单/标签推，推不出就报不足但不编类别。
 */
export function planRestock({ files = [], expectations = null, minPerKind = 3, catalogue = null } = {}) {
  const byKind = new Map()
  for (const item of files) {
    if (item.kind !== 'source') continue
    const kind = item.asset_kind ?? 'unknown'
    const bucket = byKind.get(kind) ?? { kind, total: 0, approved: 0, names: [] }
    bucket.total += 1
    if (item.review_state === 'approved') bucket.approved += 1
    if (bucket.names.length < 8) bucket.names.push(item.name)
    byKind.set(kind, bucket)
  }
  // 清单里声明了但一张都没有的 → 明确缺货
  const expectedKeys = Object.keys(expectations ?? {})
  const haveNames = new Set(files.map((f) => f.name))
  const declaredMissing = expectedKeys.filter((k) => !haveNames.has(k))

  const shortages = [...byKind.values()]
    .filter((b) => b.approved < minPerKind)
    .map((b) => ({
      kind: b.kind,
      have: b.total,
      approved: b.approved,
      need: minPerKind - b.approved,
      existing: b.names.slice(0, 5),
      suggestion: `这个类别只有 ${b.approved} 张合格，低于阈值 ${minPerKind} —— 可以生成 ${minPerKind - b.approved} 张候选补充`,
    }))
  return {
    ok: true,
    by_kind: [...byKind.values()],
    shortages,
    declared_missing: declaredMissing.slice(0, 30),
    summary: { kinds: byKind.size, shortages: shortages.length, declared_missing: declaredMissing.length },
    advice: shortages.length === 0 && declaredMissing.length === 0
      ? '各类别库存都够。'
      : `有 ${shortages.length} 个类别低于阈值，另有 ${declaredMissing.length} 个清单里声明但一张都没有。`
        + `补货生成的候选仍然是**素材**，要走同样的审核流程 —— 不是"自动补齐就不用审了"。`,
    caution: '「某类别不足」的判断依赖 `asset_kind` 的准确性 —— 如果分类是 M3 猜的，缺货判断也会跟着偏。',
  }
}

// ───────── R 组：编排与治理 ─────────

/**
 * R1：工作流可视化 —— 一页看流水线各步状态。
 */
export function pipelineStatus({ pipeline, runState = null, scan = null } = {}) {
  const steps = pipeline?.data?.steps ?? []
  const done = new Set(runState?.done ?? [])
  const failedAt = runState?.failedAt ?? null
  const summary = scan?.tally ?? {}
  return {
    ok: true,
    pipeline: pipeline?.data?.name ?? '(未命名)',
    batch_id: runState?.batchId ?? '(还没跑过)',
    steps: steps.map((step, index) => {
      const id = step.id ?? step.use
      const finished = [...done].some((k) => String(k).startsWith(`${id}|`))
      const state = failedAt === id ? 'failed' : finished ? 'done' : (runState ? 'pending' : 'never_run')
      return {
        index: index + 1,
        id,
        use: step.use ?? id,
        state,
        state_label: { done: '完成', failed: '失败', pending: '待跑', never_run: '从未运行' }[state],
        done_items: [...done].filter((k) => String(k).startsWith(`${id}|`)).length,
      }
    }),
    failed_step: failedAt,
    inventory: { total: summary.total, approved: summary.approved, unreviewed: summary.unreviewed },
    advice: !runState
      ? '还没跑过这条流水线。建议先 dry-run 看会做什么。'
      : failedAt
        ? `上次跑到第「${failedAt}」步失败了（整批已中止）。修掉原因后 resume 重跑。`
        : '上次运行正常。',
  }
}

/**
 * R2：自动告警。
 *
 * 诚实说明：插件**没有推送通道**（不能发邮件/企微）。
 * 所以这里做的是**阈值检查 + 生成告警清单**，由外部消费（面板显示 / cron 卡 /
 * 你手动看）。不假装能"自动通知"。
 */
export const DEFAULT_ALERT_THRESHOLDS = {
  fail_rate: 0.3,
  queue_backlog: 500,
  disk_free_gb: 5,
  budget_used: 0.9,
  unreviewed_ratio: 0.9,
}

export function checkAlerts({ metrics = {}, thresholds = DEFAULT_ALERT_THRESHOLDS } = {}) {
  const alerts = []
  const push = (level, code, message, action) => alerts.push({ level, code, message, action })
  if (metrics.fail_rate !== undefined && metrics.fail_rate > thresholds.fail_rate) {
    push('error', 'fail_rate', `失败率 ${(metrics.fail_rate * 100).toFixed(0)}% 超过阈值 ${(thresholds.fail_rate * 100).toFixed(0)}%`, '检查上游服务商状态与 Key；看最近失败的共同原因')
  }
  if (metrics.queue_backlog !== undefined && metrics.queue_backlog > thresholds.queue_backlog) {
    push('warn', 'queue_backlog', `待处理积压 ${metrics.queue_backlog} 超过 ${thresholds.queue_backlog}`, '跑一次流水线；或检查是否有脚本失控刷文件（L1 熔断）')
  }
  if (metrics.disk_free_gb !== undefined && metrics.disk_free_gb < thresholds.disk_free_gb) {
    push('error', 'disk', `磁盘剩余 ${metrics.disk_free_gb}GB 低于 ${thresholds.disk_free_gb}GB`, '清回收目录 / 跑 Q3 淘汰（先快照）')
  }
  if (metrics.budget_used !== undefined && metrics.budget_used > thresholds.budget_used) {
    push('warn', 'budget', `今日预算已用 ${(metrics.budget_used * 100).toFixed(0)}%`, '切免费档，或等明天')
  }
  if (metrics.unreviewed_ratio !== undefined && metrics.unreviewed_ratio > thresholds.unreviewed_ratio) {
    push('info', 'review_backlog', `未审核占比 ${(metrics.unreviewed_ratio * 100).toFixed(0)}% 偏高`, '自动化（M2）需要审核结论作基准；先清一批待审')
  }
  return {
    ok: true,
    alerts,
    count: alerts.length,
    delivery: 'local-only',
    limitation: '⚠ 本插件没有推送通道（发不了邮件/IM）—— 这里只做阈值检查并给出告警清单。'
      + '要"自动通知"，用 DSH 的定时任务每天跑一次并读这份清单。',
    advice: alerts.length === 0
      ? '没有触发任何告警阈值。'
      : `${alerts.length} 条告警（${alerts.filter((a) => a.level === 'error').length} 条 error）。`,
  }
}

/**
 * R3：权限与配额 —— 不同 agent/脚本的权限分开。
 *
 * 你指出的关键点："外部脚本不能乱改你的审核结论"。
 * 做法：一份**能力清单**，按 owner 判定允许做什么；越权操作被拒绝并留痕。
 */
export const DEFAULT_ROLES = {
  user: { can_review: true, can_auto_approve: true, can_configure: true, can_install: true, can_delete: true, write_quota: -1 },
  'dsh-agent': { can_review: true, can_auto_approve: true, can_configure: false, can_install: true, can_delete: false, write_quota: 2000 },
  'external-script': { can_review: false, can_auto_approve: false, can_configure: false, can_install: false, can_delete: false, write_quota: 500 },
  automation: { can_review: true, can_auto_approve: true, can_configure: false, can_install: true, can_delete: false, write_quota: 5000 },
}

export function checkPermission({ actor = 'external-script', action = 'review', roles = DEFAULT_ROLES, usedToday = 0, count = 1 } = {}) {
  const role = roles[actor] ?? roles['external-script']
  const key = `can_${action}`
  const allowed = role[key] !== false
  const quota = Number(role.write_quota ?? -1)
  const quotaLeft = quota < 0 ? Infinity : Math.max(0, quota - usedToday)
  const quotaOk = quotaLeft >= count
  return {
    ok: allowed && quotaOk,
    actor,
    action,
    allowed,
    quota: { limit: quota, used: usedToday, left: quota === -1 ? 'unlimited' : quotaLeft },
    reason: !allowed
      ? `「${actor}」没有 ${action} 权限 —— 外部脚本不能改审核结论（这是刻意的：否则你的审核结果会被脚本覆盖）。`
      : !quotaOk
        ? `「${actor}」今日配额已用完（${usedToday}/${quota}）`
        : '允许。',
    note: '越权会被拒绝并留痕（记进审核日志），不是静默忽略。',
  }
}

/**
 * R4：一键回滚整条流水线（H3 的延伸）。
 *
 * 关键：回滚**整批**，不是单步 —— 避免"回滚到一半，前后不一致"。
 * 回滚本身也要先快照（回错了还能回来）。
 */
export function planPipelineRollback({ batchId, runState = null, backups = [], catalogSnapshot = null } = {}) {
  if (!batchId) return { ok: false, error: '需要 batchId' }
  const candidates = (backups ?? []).filter((b) => !b.at || String(b.at) <= String(runState?.at ?? nowIso()))
  const target = candidates[0] ?? null
  return {
    ok: true,
    batch_id: batchId,
    target_backup: target,
    plan: [
      '1. 先给**当前**状态做一份快照（回滚本身也要可回滚）',
      `2. 恢复状态文件到 ${target?.id ?? '(没有更早的备份！)'}`,
      '3. 把本轮流水线产生的派生文件移到回收目录（不直接删）',
      '4. 记进审核日志（谁、什么时候、回滚了哪批）',
    ],
    steps_affected: runState?.done?.length ?? 0,
    urgency: 'high',
    advice: target
      ? `将把「${batchId}」这批的影响整体回滚到 ${target.at} 的状态。因为是**整批**回滚，不会出现"一半新一半旧"。`
      : `⚠ 找不到比这批更早的备份 —— **无法安全回滚**。这也说明：应该在跑流水线**之前**先备份。`,
    guard: target ? null : 'blocks_execution',
  }
}

/** 给 DSH 定时任务用的维护清单（L3 的正确落点）。 */
export function maintenanceChecklist({ outputDir = '', dataDir = '' } = {}) {
  return {
    ok: true,
    title: '每日素材维护',
    tasks: [
      { step: '1. 扫变更', tool: 'assets', action: 'changes', why: '知道自上次以来多了什么' },
      { step: '2. 清孤儿', tool: 'studio', action: 'selfheal孤儿', why: '派生件的源图可能已删' },
      { step: '3. 查损坏', tool: 'studio', action: 'corruption', why: '外部脚本写崩会留截断文件' },
      { step: '4. 悬空结论', tool: 'studio', action: '悬空结论', why: '内容变了结论要失效' },
      { step: '5. 健康报告', tool: 'studio', action: 'health', why: '一页看全状态' },
      { step: '6. 备份', tool: 'studio', action: 'backup', why: '自动化敢放开跑的前提' },
      { step: '7. 告警检查', tool: 'studio', action: 'alerts', why: '失败率/积压/磁盘/预算' },
    ],
    note: '⚠ 定时任务**不能建在插件里**（插件无常驻进程）。'
      + '用 DSH 的任务看板定时卡（cron）每天调一次这些 action —— 那才是常驻的正确位置。',
    schedule_hint: '每天一次即可；素材量很大时可以每天两次（上午/晚上）。',
  }
}
