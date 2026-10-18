/**
 * 磁盘守卫：**在写盘之前**先看一眼还有多少空间，不够就先清理，再不够就不硬写。
 *
 * 这条是被真实事故逼出来的：预览图（`*_labeled.png`）一直是原尺寸，
 * 攒了 535 张吃掉 928MB，加上抽帧中间产物，D 盘被塞到 **0 字节可用** ——
 * 结果插件自己的写盘开始失败（`ENOSPC`），而当时的错误信息完全看不出"是磁盘满了"。
 *
 * 所以这里的职责很明确：
 *   ① 写盘前检查：`diskStatus` 分级（ok / low / critical）
 *   ② 空间紧张时**先自动清理可再生的东西**（预览图、中间产物），再复查
 *   ③ 清完仍不够就**明确拒绝**并说清需要多少、差多少，而不是写一半崩掉
 *
 * 阈值故意保守：low = 5GB（该清了），critical = 1GB（必须清完才能继续）。
 * 视频 / 抽帧这类会产生大量中间文件的操作，进门就先过这一关。
 */
import { statfs } from 'node:fs/promises'
import path from 'node:path'

/** 默认阈值（GB）。 */
export const DEFAULT_THRESHOLDS = { lowGB: 5, criticalGB: 1 }

/**
 * 读某个路径所在卷的剩余空间。
 * 用 `fs.statfs`（Node 18.15+）：跨平台、不依赖 df/PowerShell。
 * @param {string} dir
 */
export async function diskStatus({ dir = '.', thresholds = DEFAULT_THRESHOLDS } = {}) {
  let stats
  try {
    stats = await statfs(path.resolve(dir))
  } catch (error) {
    return { ok: false, error: `读不到磁盘信息：${String(error?.message ?? error)}`, dir }
  }
  const totalBytes = Number(stats.blocks) * Number(stats.bsize)
  const freeBytes = Number(stats.bavail) * Number(stats.bsize)
  const freeGB = freeBytes / 1024 / 1024 / 1024
  const totalGB = totalBytes / 1024 / 1024 / 1024
  const usedPct = totalBytes > 0 ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(1)) : 0
  const level = freeGB >= thresholds.lowGB ? 'ok' : freeGB >= thresholds.criticalGB ? 'low' : 'critical'
  return {
    ok: true,
    dir: path.resolve(dir),
    freeGB: Number(freeGB.toFixed(2)),
    totalGB: Number(totalGB.toFixed(1)),
    usedPct,
    level,
    thresholds,
    note: level === 'ok'
      ? `磁盘充足（剩 ${freeGB.toFixed(1)} GB）`
      : level === 'low'
        ? `磁盘偏紧（剩 ${freeGB.toFixed(1)} GB），建议清理预览图/中间产物`
        : `磁盘告急（只剩 ${freeGB.toFixed(1)} GB），重操作前必须先清`,
  }
}

/**
 * 写盘前的守卫。
 *
 * @param {object} params
 * @param {string} params.dir 要写到的目录（判断哪个卷）
 * @param {number} [params.needMB] 这次预计需要多少 MB
 * @param {Function} [params.cleanup] 清理函数：返回 {freedMB} 之类的对象
 * @param {object} [params.thresholds]
 * @param {boolean} [params.autoClean] 空间不足时是否自动清理（默认 true）
 */
export async function diskGuard({ dir = '.', needMB = 0, cleanup = null, thresholds = DEFAULT_THRESHOLDS, autoClean = true } = {}) {
  const before = await diskStatus({ dir, thresholds })
  if (!before.ok) return { ok: true, skipped: true, reason: before.error, status: before }
  const needGB = Math.max(0, Number(needMB) || 0) / 1024

  // 空间够（且不在 critical）就直接放行
  if (before.level === 'ok') {
    return { ok: true, status: before, cleaned: null }
  }
  // 空间紧张：先清理再复查
  let cleaned = null
  if (autoClean && typeof cleanup === 'function') {
    try {
      cleaned = await cleanup()
    } catch (error) {
      cleaned = { error: String(error?.message ?? error) }
    }
  }
  const after = await diskStatus({ dir, thresholds })
  const enough = after.ok && after.freeGB >= thresholds.criticalGB && after.freeGB >= needGB
  return {
    ok: Boolean(enough),
    status: after,
    before,
    cleaned,
    ...(enough ? {} : {
      error: `磁盘空间不足：需要约 ${needGB.toFixed(2)} GB，当前只剩 ${after.freeGB?.toFixed?.(2) ?? '?'} GB`,
      howToFix: [
        '跑 config(action="disk") 看能清理多少',
        '跑 assets(action="organize", project="…", dry_run=false) 把预览/中间产物收进 _preview/ 和 _tmp/ 后删掉',
        '跑 config(action="set_label", mode="off") 以后不再生成预览图',
      ],
    }),
  }
}

/** 给工具输出用的精简摘要。 */
export function diskSummary(status) {
  if (!status?.ok) return status
  return {
    volume: status.dir,
    free_gb: status.freeGB,
    total_gb: status.totalGB,
    used_pct: status.usedPct,
    level: status.level,
    note: status.note,
  }
}

/**
 * 清理指定的输出目录里**可再生**的文件（预览图 / 中间产物 / 缓存）。
 * 和 spritesheet 里的同名逻辑共用一套规则，避免两处判断不一致。
 */
export async function cleanRecyclableDir({ dir }) {
  const { organizeLayout } = await import('./outputlayout.js')
  const { readdir, rm, stat } = await import('node:fs/promises')
  const organized = await organizeLayout({ dir, dryRun: false, categories: ['preview', 'intermediate'] })
  let freedBytes = 0
  let removed = 0
  const dirSize = async (target) => {
    let bytes = 0
    let count = 0
    const walk = async (current, depth) => {
      if (depth > 5) return
      const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) { await walk(full, depth + 1); continue }
        const info = await stat(full).catch(() => null)
        if (info) { bytes += info.size; count += 1 }
      }
    }
    await walk(target, 0)
    return { bytes, count }
  }
  const purge = async (target, depth = 0) => {
    if (depth > 5) return
    const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(target, entry.name)
      if (entry.isDirectory()) {
        if (/^(_preview|_derived|_tmp)$/.test(entry.name)) {
          const size = await dirSize(full)
          await rm(full, { recursive: true, force: true }).catch(() => {})
          freedBytes += size.bytes
          removed += size.count
          continue
        }
        await purge(full, depth + 1)
        continue
      }
      if (/_labeled\.(png|jpe?g|webp)$/i.test(entry.name) || /\.cache\.json$/i.test(entry.name)) {
        const info = await stat(full).catch(() => null)
        const ok = await rm(full, { force: true }).then(() => true).catch(() => false)
        if (ok) { freedBytes += info?.size ?? 0; removed += 1 }
      }
    }
  }
  await purge(dir)
  return {
    moved: organized.moved,
    removed,
    freedMB: Number((freedBytes / 1024 / 1024).toFixed(1)),
    note: `清掉 ${removed} 个可再生文件，省出 ${(freedBytes / 1024 / 1024).toFixed(1)} MB`,
  }
}
