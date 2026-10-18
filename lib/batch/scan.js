/**
 * 素材体检（scan）：一次调用把三件事说清楚
 *   1) 这个游戏还缺哪些素材（引用缺失 + 题材清单）
 *   2) 已经生成的图**达不达标**（尺寸/透明底 vs 清单要求）
 *   3) 已经生成的图**有没有被游戏用上**（哪个文件引用了几次）
 */
import path from 'node:path'
import { checkProject } from '../check.js'
import { safeSegment } from '../util.js'
import { scanProject } from './discover.js'

export async function scanGame({ root = '', brief = '', outputDir = '', project = '', maxAssets = 24 } = {}) {
  const target = safeSegment(project || (root ? path.basename(path.resolve(root)) : 'assets'), 'assets')
  const discovery = (root || brief) ? await scanProject({ root, brief, maxAssets }) : null
  const verification = (root && outputDir) ? await checkProject({ root, outputDir, project: target }) : null

  const result = {
    ok: true,
    project: target,
    root,
    genres: discovery?.genres ?? [],
    existing_assets: discovery?.existing ?? null,
    missing_referenced: discovery?.missing ?? [],
    suggested: discovery?.suggested ?? [],
    style_context: discovery?.style_context ?? '',
    verification: verification?.items ?? [],
    verification_summary: verification?.summary ?? null,
    expectation_sources: verification?.expectationSources ?? [],
    notes: [...(discovery?.notes ?? [])],
  }
  if (verification?.summary) {
    const broken = verification.summary.broken ?? 0
    const notReferenced = verification.summary['not-referenced'] ?? 0
    const okCount = verification.summary.ok ?? 0
    result.conclusion = broken > 0
      ? `⚠️ 有 ${broken} 张图「生成了但用不上」：规格不达标（尺寸/透明底/空图），游戏里就会是黑屏或糊图 —— 先修这些。`
      : notReferenced > 0
        ? `⚠️ 图本身没问题，但有 ${notReferenced} 张游戏代码里没有任何引用 —— 需要登记/改名，否则不会出现在游戏里。`
        : okCount > 0
          ? `✅ ${okCount} 张图规格达标且被游戏引用。`
          : '还没有可核对的图。'
    result.notes.push(result.conclusion)
  } else if (outputDir && !root) {
    result.notes.push('没给 root，无法核对「是否被游戏引用」；带上游戏目录再 scan 一次。')
  }
  return result
}
