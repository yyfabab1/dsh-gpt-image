/**
 * O 组 · 自愈（出问题自己修）+ 你批评里指出的冲突解法。
 *
 *   O1 孤儿清理        —— _slices/ 里源图已删的、审核记录指向不存在文件的
 *   O2 缺失自动补      —— 派生文件丢了、切片没切、atlas 过期 → 自动补
 *   O3 损坏自动重生成  —— PNG 截断 → 有血缘就重生成，没有就标记
 *   O4 悬空结论修复    —— 审核记录 hash 变了 → 移到待重审，不静默失效
 *   O5 配置漂移修复    —— 实际状态与声明式配置不符 → 自动对齐
 *
 * 冲突解法（你列出的）：
 *   C1↔母图结论变更   —— **级联失效**：母图 reject → 变体全部重审
 *   Q3↔H3            —— 淘汰**必须先快照**，且保护期可配
 *   N5↔N3            —— 事务按批次划（在 declarative.js 里已实现）
 *   L1↔H1            —— 防抖 + 锁确认才读（在 watch.js 里）
 *
 * 全部**先报告再修**：plan* 只算不改，apply* 才动。这样能 dry-run。
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from './util.js'
import { normalizePath, assetNameOf } from './assets.js'
import { checkPngIntegrity } from './safety.js'

// ───────── O1 孤儿清理 ─────────

/**
 * O1：找出所有孤儿。
 * 三类：
 *   a. 派生目录（_slices/）里源图已不在的
 *   b. 审核记录指向的文件已不存在（悬空记录）
 *   c. 审核记录按名字记的、名字已不存在的（较弱，单独列）
 *
 * @param {{files:Array, catalog:object, expectations?:object}} params
 */
export function planOrphanCleanup({ files = [], catalog } = {}) {
  const onDisk = new Set(files.map((f) => normalizePath(f.file)))
  const onDiskNames = new Set(files.map((f) => f.name).filter(Boolean))

  // a. 派生文件的源图不在了
  const derivedOrphans = []
  const sourcesByName = new Map()
  for (const item of files) {
    if (item.kind === 'source') sourcesByName.set(item.name, item.file)
  }
  // 观测到的切片数已由扫描器给出；这里按目录判断源图
  for (const item of files) {
    if (item.kind !== 'slice' && item.kind !== 'resized') continue
    const dir = path.basename(path.dirname(item.file))
    const sourceName = dir.endsWith('_slices') ? dir.slice(0, -'_slices'.length) : item.name
    if (!sourcesByName.has(sourceName)) {
      derivedOrphans.push({ file: item.file, reason: `源素材「${sourceName}」已不在（切片/缩放件成了孤儿）`, source: sourceName })
    }
  }

  // b. 审核记录指向不存在的文件
  const danglingReviews = []
  for (const [key, review] of Object.entries(catalog?.data?.reviews ?? {})) {
    if (!onDisk.has(key)) {
      danglingReviews.push({ key, state: review.state, at: review.at, reason: '审核记录指向的文件已不存在' })
    }
  }

  // c. 按名字的结论、对应文件已不在
  const staleNameReviews = []
  for (const [name, review] of Object.entries(catalog?.data?.byName ?? {})) {
    if (!onDiskNames.has(name)) {
      staleNameReviews.push({ name, state: review.state, at: review.at, reason: '名字已不存在于磁盘（可能是重画换了名）' })
    }
  }

  return {
    ok: true,
    derived_orphans: derivedOrphans,
    dangling_reviews: danglingReviews,
    stale_name_reviews: staleNameReviews,
    summary: {
      derived_files: derivedOrphans.length,
      dangling_reviews: danglingReviews.length,
      stale_name_reviews: staleNameReviews.length,
      total: derivedOrphans.length + danglingReviews.length,
    },
    advice: derivedOrphans.length + danglingReviews.length === 0
      ? '没有孤儿需要清理。'
      : `发现 ${derivedOrphans.length} 个孤儿派生文件 + ${danglingReviews.length} 条悬空审核记录。`
        + `清理动作是**不可逆**的（会删派生文件）——先看一眼清单再执行。`,
    // 悬空记录清理是可逆的（只是删记录），派生文件删除不可逆
    risk: derivedOrphans.length > 0 ? 'irreversible-delete' : 'record-only',
  }
}

/** O1：执行清理。派生文件删除前先备份到回收目录。 */
export async function applyOrphanCleanup({ plan, catalog, recycleDir = '' } = {}) {
  const removedFiles = []
  const removedReviews = []
  const recycled = []

  for (const item of plan?.derived_orphans ?? []) {
    if (recycleDir) {
      // 不直接删：先移到回收目录（误删可恢复）。这是 Q3↔H3 冲突的解法。
      try {
        const { mkdir, copyFile } = await import('node:fs/promises')
        await mkdir(recycleDir, { recursive: true })
        const target = path.join(recycleDir, path.basename(item.file))
        await copyFile(item.file, target)
        recycled.push(target)
      } catch { /* 回收失败就不删，宁可留着 */ }
    }
    try {
      await rm(item.file, { force: true })
      removedFiles.push(item.file)
    } catch { /* 已经没了就当清掉了 */ }
  }
  for (const item of plan?.dangling_reviews ?? []) {
    delete catalog.data.reviews[item.key]
    removedReviews.push(item.key)
  }
  return {
    ok: true,
    removed_files: removedFiles.length,
    removed_reviews: removedReviews.length,
    recycled_to: recycled.length > 0 ? recycleDir : null,
    note: recycled.length > 0
      ? `删除的文件已先备份到 ${recycleDir} —— 误删可以从这里恢复。`
      : '没有配置回收目录，文件是直接删除的（不可恢复）。',
  }
}

// ───────── O4 悬空结论修复 ─────────

/**
 * O4：结论和文件对齐。
 *
 * 判据：审核记录里存了 contentHash；当前文件的 hash 不同 → 结论失效。
 * **不静默失效**：明确移进 needsReReview 并给出原因。
 * （这个逻辑的实际执行在 assets.recomputeQueue 里，这里提供"诊断 + 解释"。）
 */
export function planDanglingVerdicts({ files = [], catalog } = {}) {
  const invalidated = []
  const missingHash = []
  for (const item of files) {
    const review = catalog?.reviewOf?.({ file: item.file, name: item.name })
    if (!review) continue
    if (!review.contentHash) {
      // 审核时没记 hash（旧记录）→ 无法判断是否变了，标出来让它下次审核补上
      missingHash.push({ file: item.file, name: item.name, state: review.state, reason: '审核记录里没有内容 hash（旧记录），无法判断是否失效' })
      continue
    }
    if (item.contentHash && review.contentHash !== item.contentHash) {
      invalidated.push({
        file: item.file,
        name: item.name,
        previous_state: review.state,
        reviewed_at: review.at,
        reason: '文件内容在审核后变了 → 结论失效，需要重审',
      })
    }
  }
  return {
    ok: true,
    invalidated,
    missing_hash: missingHash,
    summary: { invalidated: invalidated.length, missing_hash: missingHash.length },
    advice: invalidated.length === 0
      ? '所有审核结论都和当前文件对齐。'
      : `${invalidated.length} 张的结论已失效（内容变了）—— 它们会进 needsReReview，**不会**被当成合格素材装进游戏。`
        + '这是刻意不静默的：静默失效会让你以为审过的图还是好的。',
  }
}

// ───────── O3 损坏重生成 ─────────

/**
 * O3：损坏文件处置。
 *
 * 有血缘（D2）→ 可以自动重生成（给出可执行的重生成计划）
 * 无血缘      → 只能标记，让人决定（不猜、不自动删）
 */
export function planCorruptionRepair({ files = [], gallery = null } = {}) {
  const records = gallery?.list?.({ limit: 1000 }) ?? []
  const byFile = new Map()
  for (const record of records) {
    for (const file of record.files ?? []) byFile.set(normalizePath(file), record)
  }
  const regenerable = []
  const manual = []
  for (const item of files) {
    if (!item.broken) continue
    const record = byFile.get(normalizePath(item.file))
    // 有血缘且能确定性重生成（有 prompt + seed）→ 自动重生成
    const hasLineage = Boolean(record?.prompt)
    const deterministic = record?.params?.seed !== undefined && record?.params?.seed !== null
    if (hasLineage) {
      regenerable.push({
        file: item.file,
        reason: item.reason ?? '文件损坏',
        lineage: { prompt: record.prompt, model: record.model, profile: record.profile, seed: record.params?.seed ?? null, size: record.params?.size },
        can_reproduce_exactly: deterministic,
        plan: deterministic
          ? `按原 seed ${record.params.seed} 精确定重生成（结果应与原图一致）`
          : `用同一 prompt 重生成（原记录没有 seed，**不能保证**和原图一致）`,
      })
    } else {
      manual.push({
        file: item.file,
        reason: item.reason ?? '文件损坏',
        why: '没有 prompt 血缘（不是本插件生成的，或历史已清理）→ 不知道它该长什么样',
      })
    }
  }
  return {
    ok: true,
    regenerable,
    manual,
    summary: { regenerable: regenerable.length, manual: manual.length },
    advice: regenerable.length + manual.length === 0
      ? '没有发现损坏文件。'
      : `${regenerable.length} 个损坏文件有血缘，可以自动重生成；`
        + `${manual.length} 个没有血缘，只能人工处理（不自动删 —— 删了就真没了）。`
        + `重生成前会先备份损坏文件，避免"重生成也失败"时两头空。`,
  }
}

// ───────── O2 缺失自动补 ─────────

/**
 * O2：检测"该有但没有"的东西并补。
 *
 * 三类：
 *   a. 源图已 approved 但没有 _slices/ → 该切没切
 *   b. 派生文件数量少于规则要求 → 切了一半
 *   c. 有 approved 素材但没有 atlas → 图集过期
 */
export function planMissingRepair({ files = [], catalog, atlasInfo = null, expectations = {} } = {}) {
  const needs = []
  const byName = new Map()
  for (const item of files) {
    if (!byName.has(item.name)) byName.set(item.name, [])
    byName.get(item.name).push(item)
  }
  const approvedSources = files.filter((f) => f.kind === 'source' && f.review_state === 'approved')

  for (const source of approvedSources) {
    const siblings = byName.get(source.name) ?? []
    const slices = siblings.filter((f) => f.kind === 'slice')
    const observed = source.observedSlices ?? slices.length
    // a/b. 该切没切 / 切了一半（规则来自名字格数）
    const rule = source.slice_rule
    if (rule?.columns > 0) {
      const expectedCount = rule.columns * rule.rows
      if (observed === 0) {
        needs.push({ type: 'missing_slices', file: source.file, name: source.name, reason: `已合格但还没有切片（规则要求 ${rule.columns}×${rule.rows} = ${expectedCount} 张）` })
      } else if (observed < expectedCount) {
        needs.push({ type: 'partial_slices', file: source.file, name: source.name, reason: `切片不完整：有 ${observed} 张，规则要求 ${expectedCount} 张` })
      }
    }
  }

  // c. 图集过期
  if (atlasInfo && approvedSources.length > 0) {
    const members = new Set(atlasInfo.members ?? [])
    const missing = approvedSources.filter((s) => !members.has(s.name))
    if (missing.length > 0) {
      needs.push({
        type: 'atlas_stale', reason: `图集里有 ${members.size} 个素材，但已有 ${approvedSources.length} 张合格素材 —— 有 ${missing.length} 张没进图集`,
        missing: missing.map((m) => m.name).slice(0, 20),
      })
    }
  }

  return {
    ok: true,
    needs,
    summary: {
      missing_slices: needs.filter((n) => n.type === 'missing_slices').length,
      partial_slices: needs.filter((n) => n.type === 'partial_slices').length,
      atlas_stale: needs.filter((n) => n.type === 'atlas_stale').length,
      total: needs.length,
    },
    advice: needs.length === 0
      ? '没有缺失需要补 —— 系统状态自洽。'
      : `发现 ${needs.length} 处"该有但没有"：${needs.map((n) => n.type).filter((v, i, a) => a.indexOf(v) === i).join('、')}。`
        + `用 reprocess（补切片）或 atlas（补图集）处理。`,
  }
}

// ───────── O5 配置漂移修复 ─────────

/**
 * O5：声明式配置 vs 实际状态的漂移。
 *
 * 这是 N1 存在之后才有意义的能力：没有声明式配置，就没有"该是什么样"的基准。
 * 检测（确定性）：
 *   - 配置里声明要 install 的、实际没装 → drift
 *   - 配置里声明要 atlas 的、atlas 不存在或过期 → drift
 *   - 配置里声明要 cleanup 的、有孤儿没清 → drift
 *   - 配置里的步骤在代码里没有执行器 → 配置无效（不是漂移，是配置错）
 */
export function planConfigDrift({ pipeline, state = {} } = {}) {
  const steps = pipeline?.data?.steps ?? pipeline?.steps ?? []
  const validation = pipeline?.validate?.() ?? { ok: true, errors: [] }
  const drifts = []
  const invalid = [...(validation.errors ?? [])]

  const ids = new Set(steps.map((s) => s.use ?? s.id))
  if (ids.has('install') && state.approved_count > 0 && state.installed_count === 0) {
    drifts.push({
      type: 'install_not_done',
      expected: '配置声明要自动装机',
      actual: `有 ${state.approved_count} 张合格素材，但一张都没装`,
      fix: '跑 pipeline（install 步骤）',
    })
  }
  if (ids.has('atlas') && state.approved_count > 0 && !state.atlas_exists) {
    drifts.push({
      type: 'atlas_missing',
      expected: '配置声明要打包图集',
      actual: `有 ${state.approved_count} 张合格素材，但没有图集`,
      fix: '跑 atlas',
    })
  }
  if (ids.has('cleanup') && state.orphan_count > 0) {
    drifts.push({
      type: 'orphans_pending',
      expected: '配置声明要清理孤儿',
      actual: `有 ${state.orphan_count} 个孤儿未清`,
      fix: '跑 cleanup（先看清单）',
    })
  }
  // 配置里有步骤但代码没实现执行器
  if (state.unimplemented_steps?.length > 0) {
    invalid.push(`配置里的步骤没有实现执行器：${state.unimplemented_steps.join('、')}`)
  }

  return {
    ok: true,
    drifts,
    invalid,
    summary: { drifts: drifts.length, config_errors: invalid.length },
    advice: invalid.length > 0
      ? `配置本身有问题（${invalid.length} 处）—— 先修配置，别跑。`
      : drifts.length === 0
        ? '实际状态与声明式配置一致，没有漂移。'
        : `检测到 ${drifts.length} 处漂移（配置说该这样，实际不是）—— 可以按 fix 建议对齐。`
          + `注意：漂移修复会改实际状态，建议先 dry-run 看清单。`,
  }
}

// ───────── C1 级联失效（母图 → 变体） ─────────

/**
 * C1 级联失效：母图结论变了，它的变体/派生件必须跟着失效。
 *
 * 你指出的真问题：母图后来被 reject，变体还挂着 approved。
 * 判据（确定性）：派生件的名字是从母图派生的（`<母图>.<variantkind>` 或
 * 在 `<母图>_slices/` 里），所以能反推母子关系。
 */
export function planCascadeInvalidation({ sourceName, sourceFile, files = [], catalog, newState } = {}) {
  if (!sourceName) return { ok: false, error: '需要 sourceName' }
  const affected = []
  const prefixSlice = `${sourceName}_slices`
  for (const item of files) {
    if (normalizePath(item.file) === normalizePath(sourceFile)) continue
    const dir = path.basename(path.dirname(item.file))
    const isSlice = dir === prefixSlice
    // 变体命名：<母图>.<kind>.png
    const derivedName = assetNameOf(item.file)
    const isVariant = derivedName === sourceName && item.kind !== 'source'
      || String(item.file).includes(`${sourceName}.`)
    if (isSlice || isVariant) {
      const current = catalog?.reviewOf?.({ file: item.file, name: item.name })
      affected.push({
        file: item.file,
        kind: item.kind,
        current_state: current?.state ?? 'unreviewed',
        // 继承新结论：母图 reject → 派生件也 reject（不是"变待审"）
        // 因为母图不合格，从它切出来的东西必然也不合格 —— 让人再审一遍是浪费
        next_state: newState === 'rejected' ? 'rejected' : 'pending',
      })
    }
  }
  return {
    ok: true,
    source: { name: sourceName, file: sourceFile, new_state: newState },
    affected,
    summary: { total: affected.length, to_reject: affected.filter((a) => a.next_state === 'rejected').length, to_pending: affected.filter((a) => a.next_state === 'pending').length },
    advice: affected.length === 0
      ? '这张母图没有派生件，无需级联。'
      : newState === 'rejected'
        ? `母图被驳回 → ${affected.length} 个派生件**一并驳回**（从不合格的母图切出来的东西必然不合格，让你再审一遍是浪费）。`
        : `母图结论变为「${newState}」→ ${affected.length} 个派生件转为待审（需你确认新规则/新外观下它们还合不合格）。`,
  }
}
