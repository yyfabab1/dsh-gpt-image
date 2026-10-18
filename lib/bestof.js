/**
 * Best-of-N 择优：一次出 N 张，自动挑最好的那张留下，落选的改名带 `_落选_` 前缀。
 *
 * 什么时候值得用：
 *   **关键素材**（主角立绘、封面、商店主视觉）—— 一张画废了返工成本很高，
 *   多花 N 倍钱换"一次定稿"往往划算。
 *   反面：批量小图标别用，N 倍成本换不来等价收益。
 *
 * 打分依据全部是**确定性规则**（复用 review.js 的 reviewImage，不额外调模型）：
 *   几乎单色 / 全黑 / 全白 / 对比度极低 / 无边缘 → 淘汰
 *   尺寸不符 / 该透明不透明 → 扣分
 *   像素模式再叠加纯度
 *
 * 为什么不接"AI 审美打分"：要额外花钱又慢，而且不可复现。
 * 这里做的是**淘汰明显废图**，把"能用/不能用"筛掉，剩下的交给人看 ——
 * 所以它叫"择优"不叫"选美"。
 */
import { readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { reviewImage } from './review.js'

/** 致命问题：出现任意一条就基本是废图（放大缩小救不回来）。 */
const FATAL_PATTERNS = [
  { re: /几乎单色/, penalty: 45 },
  { re: /几乎全黑/, penalty: 45 },
  { re: /几乎全白/, penalty: 45 },
  { re: /对比度极低/, penalty: 35 },
  { re: /几乎没有边缘/, penalty: 30 },
  { re: /不可辨|解不开|读不到/, penalty: 100 },
]
/** 非致命：内容能用，但不如别的候选。 */
const MINOR_PATTERNS = [
  { re: /尺寸/, penalty: 12 },
  { re: /要求透明底/, penalty: 20 },
]

/**
 * 给一张图打分（0~100，越高越好）。
 * @param {string} file
 * @param {{expected?:{width:number,height:number,max?:boolean}, requireAlpha?:boolean, expectedPixelPurity?:number}} [opts]
 */
export async function scoreImageFile(file, { expected, requireAlpha = false } = {}) {
  let buffer
  try {
    buffer = await readFile(file)
  } catch (error) {
    return { score: 0, verdict: 'unreadable', penalties: [`读不到文件：${error?.message ?? error}`], reasons: [], fatal: true, metrics: {} }
  }
  const expect = expected || (requireAlpha ? { transparent: true } : null)
  const review = reviewImage({ buffer, expect })
  const quality = review.quality || {}
  let score = 100
  const penalties = []
  const reasons = []

  for (const problem of review.problems ?? []) {
    let hit = null
    for (const rule of FATAL_PATTERNS) if (rule.re.test(problem)) hit = rule
    if (!hit) for (const rule of MINOR_PATTERNS) if (rule.re.test(problem)) hit = rule
    if (hit) {
      score -= hit.penalty
      penalties.push(`${problem}（-${hit.penalty}）`)
    } else {
      // 有 problem 但没匹配到规则：轻微扣分，避免被无视
      score -= 5
      penalties.push(`${problem}（-5）`)
    }
  }
  if (requireAlpha && (quality.transparentRatio ?? 1) < 0.02) {
    score -= 15
    penalties.push('要求透明底但没有透明像素（-15）')
  }
  if (penalties.length === 0) reasons.push('机械自检全部通过')

  const fatal = (review.problems ?? []).some((p) => /几乎单色|几乎全黑|几乎全白|解不开|读不到/.test(p))
    || review.verdict === 'unreadable'
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    verdict: review.verdict,
    metrics: {
      width: quality.width ?? null,
      height: quality.height ?? null,
      contrast: quality.contrast != null ? Number(quality.contrast.toFixed(3)) : null,
      color_count: quality.colorCount ?? null,
      edge_ratio: quality.edgeRatio != null ? Number(quality.edgeRatio.toFixed(4)) : null,
      transparent_ratio: quality.transparentRatio != null ? Number(quality.transparentRatio.toFixed(3)) : null,
    },
    reasons,
    penalties,
    fatal,
  }
}

/**
 * 从一组候选里挑最好的。
 * @returns {{best:string|null, best_score:number, scores:Array, worst:string[], summary:string, all_bad:boolean, ties:number}}
 */
export async function pickBest(files, options = {}) {
  const scores = []
  for (const file of files) scores.push({ file, ...(await scoreImageFile(file, options)) })
  const usable = scores.filter((s) => !s.fatal)
  if (usable.length === 0) {
    return {
      best: files[0] ?? null,
      best_score: 0,
      scores,
      worst: files.slice(1),
      summary: `全部 ${files.length} 张都有致命问题（单色/全黑/全白/不可解析），保留第一张作占位 —— 建议改提示词重画`,
      all_bad: true,
      ties: 0,
    }
  }
  // 稳定排序：同分保留**先生成**的那张（不随机、可复现）
  const ranked = [...usable].sort((a, b) => (b.score - a.score) || (files.indexOf(a.file) - files.indexOf(b.file)))
  const best = ranked[0]
  const ties = usable.filter((s) => s.score === best.score).length
  const worst = scores.filter((s) => s.file !== best.file).map((s) => s.file)
  return {
    best: best.file,
    best_score: best.score,
    scores,
    worst,
    ties,
    all_bad: false,
    summary: `从 ${files.length} 张里选了最高分 ${best.score}/100`
      + (best.penalties.length ? `（该图扣分项：${best.penalties.join('、')}）` : '（无扣分项）')
      + (ties > 1 ? `；有 ${ties} 张同分，保留先生成的那张` : ''),
  }
}

/**
 * 处理落选的图。默认**不删**，只改名加前缀（可以后悔）；recycle=true 才真删。
 */
export async function disposeLosers(worst, { recycle = false } = {}) {
  const handled = []
  for (const file of worst) {
    if (recycle) {
      const ok = await unlink(file).then(() => true).catch(() => false)
      handled.push({ file, action: ok ? 'deleted' : 'kept' })
      continue
    }
    const target = path.join(path.dirname(file), `_落选_${path.basename(file)}`)
    const ok = await rename(file, target).then(() => true).catch(() => false)
    handled.push(ok ? { file, action: 'renamed', to: target } : { file, action: 'kept' })
  }
  return handled
}
