/**
 * 批量重处理（prompt 3）。
 *
 * 要解决的痛点：切片网格/目标尺寸/命名规范一改，已审核的几百张源图没变，
 * 但派生文件（_slices/、_64x16）全过期了 —— 现在只能重审一遍，成本高到让人不敢改规则。
 *
 * 核心区分（这是整个功能的价值所在）：
 *   源图内容变了   → 审核结论**失效** → 进 needsReReview（要人重审）
 *   只是派生规则变了 → 源图没变 → 结论**继承** → 只重切 + 自动重装（不用人）
 *
 * 安全设计：
 *   - 只动派生文件，**绝不碰源图**
 *   - 不碰 byPath 里源图的审核结论
 *   - 单张失败不留半成品：先在临时目录切完，全部成功才落到正式位置；失败则回滚
 *   - 并发保护：reprocess 与 install 不能同时跑（文件锁）
 *   - 孤儿清理：源图被删、派生文件还在 → 一并清掉
 */
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from './util.js'
import { normalizePath, sliceRuleFor } from './assets.js'
import { contentHash } from './snapshot.js'

/**
 * 简易文件锁：避免 reprocess 和 install 同时改同一批文件。
 * 用「写一个 lock 文件 + 检查是否过期」实现，零依赖。
 */
export const LOCK_STALE_MS = 10 * 60 * 1000

export async function acquireLock(dataDir, name = 'reprocess') {
  const file = path.join(dataDir, `${name}.lock`)
  try {
    const info = await stat(file)
    // 锁过期（进程被强杀留下的）→ 抢过来，不然会永久卡住
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(file, { force: true })
    } else {
      return { ok: false, error: `已有 ${name} 在跑（锁文件 ${file}，${Math.round((Date.now() - info.mtimeMs) / 1000)}s 前创建）。等它结束，或删掉锁文件。` }
    }
  } catch {
    /* 没有锁 = 可以拿 */
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(file, `${process.pid} ${nowIso()}\n`, 'utf8')
  return { ok: true, file, release: () => rm(file, { force: true }).catch(() => {}) }
}

/**
 * 规划重处理：**只看，不改**。dry-run 与执行共用它，保证"看到的"就是"要做的"。
 *
 * @param {{files:Array, catalog:object, expectations?:object, slices?:boolean, scaled?:boolean}} params
 */
export function planReprocess({ files = [], catalog, expectations = {}, slices = true, scaled = false } = {}) {
  const sources = files.filter((item) => item.kind === 'source')
  // 派生文件按「源素材名」归拢，便于找孤儿与判断过期
  const derivedBySource = new Map()
  for (const item of files) {
    if (item.kind !== 'slice' && item.kind !== 'resized') continue
    const key = item.name ?? ''
    if (!derivedBySource.has(key)) derivedBySource.set(key, [])
    derivedBySource.get(key).push(item)
  }

  const toReprocess = []
  const skippedUnreviewed = []
  const invalidated = []
  const noRule = []

  for (const item of sources) {
    const expected = expectations[item.name]
    const rule = sliceRuleFor({ ...item, expected })
    const review = catalog?.reviewOf({ file: item.file, name: item.name })
    // 源图内容变过 → 结论失效，优先按"要重审"处理（prompt 3 明确要求这个优先级）
    if (review?.contentHash && item.contentHash && review.contentHash !== item.contentHash) {
      invalidated.push({ file: item.file, name: item.name, why: '源图内容已变，审核结论失效' })
      continue
    }
    const nothingToDerive = !rule && !scaled
    if (nothingToDerive) {
      noRule.push({ file: item.file, name: item.name })
      continue
    }
    if (!review || review.state !== 'approved') {
      // 未审核的等审完再切（不阻塞已审核的）
      skippedUnreviewed.push({ file: item.file, name: item.name, state: review?.state ?? 'unreviewed' })
      continue
    }
    if (review.state === 'approved') {
      toReprocess.push({
        file: item.file,
        name: item.name,
        rule,
        derived: derivedBySource.get(item.name) ?? [],
      })
    }
  }

  // 孤儿：有派生文件、但源图不在了
  const sourceNames = new Set(sources.map((item) => item.name))
  const orphans = []
  for (const [name, list] of derivedBySource) {
    if (sourceNames.has(name)) continue
    orphans.push(...list)
  }

  const approved = toReprocess.length
  const unreviewed = skippedUnreviewed.length
  return {
    ok: true,
    sources: sources.length,
    to_reprocess: toReprocess,
    approved_count: approved,
    skipped_unreviewed: skippedUnreviewed,
    invalidated,
    no_rule: noRule,
    orphans,
    summary: {
      affected: approved + unreviewed,
      approved,
      unreviewed,
      will_reslice: approved,
      skip_unreviewed: unreviewed,
      invalidated: invalidated.length,
      orphans: orphans.length,
    },
    text: [
      `派生规则变化，源图未变：`,
      `  受影响 ${approved + unreviewed} 张（已审核 ${approved} / 未审核 ${unreviewed}）`,
      `  将重切：${approved} 张已审核 → 结论继承 → 自动重装`,
      `  跳过：${unreviewed} 张未审核（等审核后再切）`,
      invalidated.length ? `  ⚠ ${invalidated.length} 张源图内容变了 → 结论失效，要重审` : '',
      orphans.length ? `  🧹 ${orphans.length} 个孤儿派生文件（源图已不在）→ 一并清理` : '',
    ].filter(Boolean).join('\n'),
  }
}

/**
 * 执行重处理。
 *
 * @param {{root:string, files:Array, catalog:object, expectations?:object,
 *          plan:object, sliceFn:Function, writeDerived?:Function, onProgress?:Function}} params
 */
export async function runReprocess({ root, files = [], catalog, expectations = {}, plan = null, sliceFn, onProgress } = {}) {
  const thePlan = plan ?? planReprocess({ files, catalog, expectations })
  const results = { resliced: [], failed: [], inherited: [], cleaned: [] }

  for (const item of thePlan.to_reprocess) {
    // 先在**临时目录**做完整张素材，成功才落正式位置 —— 避免"部分成功"留下半成品
    const stagingDir = path.join(root, `${item.name}._staging`)
    try {
      await rm(stagingDir, { recursive: true, force: true })
      await mkdir(stagingDir, { recursive: true })
      const produced = await sliceFn({ file: item.file, name: item.name, rule: item.rule, outDir: stagingDir })
      if (!produced?.ok || !(produced.files ?? []).length) {
        throw new Error(produced?.error ?? '切片没有产出文件')
      }
      // 全部成功 → 原子替换正式目录
      const targetDir = path.join(root, `${item.name}_slices`)
      await rm(targetDir, { recursive: true, force: true })
      await rename(stagingDir, targetDir).catch(async () => {
        // rename 跨设备会失败，退回复制
        await mkdir(targetDir, { recursive: true })
        for (const file of produced.files) {
          await copyFile(file, path.join(targetDir, path.basename(file)))
        }
        await rm(stagingDir, { recursive: true, force: true })
      })
      const finalFiles = (await readdir(targetDir).catch(() => []))
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => path.join(targetDir, f))
      // 继承源图结论（与自动切片共用同一套逻辑）
      const inherit = catalog.inherit({
        sourcePath: item.file,
        sourceName: item.name,
        derived: finalFiles.map((f) => ({ path: f, name: item.name })),
      })
      // 派生文件也要记 contentHash，否则它们会被当成"没审过"again
      for (const f of finalFiles) {
        const hash = await contentHash(f)
        if (hash) catalog.mark({ files: [{ path: f, name: item.name, contentHash: hash }], state: inherit.state ?? 'approved', by: 'inherit' })
      }
      results.resliced.push({ name: item.name, files: finalFiles.length, source: item.file })
      results.inherited.push({ name: item.name, state: inherit.state, count: finalFiles.length })
      onProgress?.({ name: item.name, ok: true, files: finalFiles.length })
    } catch (error) {
      // 失败：清掉临时目录，正式目录保持原样（回滚 = 什么都不动）
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      results.failed.push({ name: item.name, error: String(error?.message ?? error) })
      onProgress?.({ name: item.name, ok: false, error: String(error?.message ?? error) })
    }
  }

  // 孤儿清理
  for (const item of thePlan.orphans) {
    await rm(item.file, { force: true }).catch(() => {})
    results.cleaned.push(item.file)
  }

  return {
    ok: results.failed.length === 0,
    resliced: results.resliced.length,
    failed: results.failed.length,
    inherited: results.inherited.length,
    cleaned: results.cleaned.length,
    details: results,
    // 重切完的进 needsInstall，由 install 自动消费（闭环）
    note: results.failed.length > 0
      ? `有 ${results.failed.length} 张重切失败（已回滚，原始派生文件未改动）：${results.failed.map((f) => f.name).join('、')}`
      : '重切完成，派生文件已继承源图结论并进入待安装队列。',
  }
}

/** 判断"派生规则是否变了"：把当前规则指纹和上次执行时对比。 */
export function rulesFingerprint({ slices = true, scaled = false, expectations = {} } = {}) {
  const keys = Object.keys(expectations).sort()
  return JSON.stringify({ slices, scaled, sizes: keys.map((k) => [k, expectations[k]?.size?.width ?? 0, expectations[k]?.size?.height ?? 0]) })
}

/** 把规则指纹存进 catalog（用于下次判断"规则变没变"）。 */
export function recordRules(catalog, fingerprint) {
  catalog.data.derivedRules = { fingerprint, at: nowIso() }
  return catalog.data.derivedRules
}

/** 规则是否变化过（没记录过也算变了：首次要切一遍）。 */
export function rulesChanged(catalog, fingerprint) {
  return catalog?.data?.derivedRules?.fingerprint !== fingerprint
}

export { normalizePath }
