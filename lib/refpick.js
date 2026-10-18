/**
 * 参考图挑选（带指纹匹配）：给定「目标素材」应该长什么样，从素材库里挑最像的。
 *
 * 关键改进：以前只按「目录/文件名」猜同类，现在可以用**宽高比 + 分类 + 风格指纹**打分，
 * 竖版卡牌不会被塞一张横版背景当参考。
 */
import { styleSimilarity } from './stylefp.js'

/** 解析 "1024x1536" / "40×60" → {width,height,ratio} */
export function parseAspect(size) {
  const match = String(size ?? '').match(/(\d{1,5})\s*[x×*]\s*(\d{1,5})/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return null
  return { width, height, ratio: width / height }
}

/** 宽高比接近程度 0~1（比对数是浪费，直接看比值差）。 */
export function aspectScore(a, b) {
  if (!a || !b) return 0.5 // 信息不足时给中性分，别因为缺数据就否决
  const diff = Math.abs(a.ratio - b.ratio) / Math.max(a.ratio, b.ratio)
  return Math.max(0, 1 - diff)
}

/**
 * 给候选参考图打分。
 * @param {{name:string, entry?:object, kind?:string, targetSize?:string, targetKind?:string}} candidate
 * @param {{targetSize?:string, targetKind?:string, targetFingerprint?:object}} target
 */
export function scoreReference(candidate, target = {}) {
  const parts = []
  let score = 0

  // ① 分类一致（卡牌配卡牌、图标配图标）—— 权重最高
  if (target.targetKind && candidate.kind) {
    const same = String(candidate.kind) === String(target.targetKind)
    score += same ? 2.5 : 0
    parts.push({ key: 'same-kind', value: same ? 2.5 : 0 })
  }

  // ② 宽高比接近（竖版卡牌别拿横版背景当参考）
  const aspect = aspectScore(parseAspect(candidate.size ?? candidate.entry?.size), parseAspect(target.targetSize))
  score += aspect * 1.5
  parts.push({ key: 'aspect', value: Number((aspect * 1.5).toFixed(2)) })

  // ③ 风格指纹相似度（最准，但需要索引）
  if (candidate.entry && target.targetFingerprint) {
    const similarity = styleSimilarity(candidate.entry, target.targetFingerprint)
    score += similarity * 4
    parts.push({ key: 'style', value: Number((similarity * 4).toFixed(2)) })
  }

  // ④ 尺寸越接近越好（同尺寸的图最有参考价值）
  const target_A = parseAspect(target.targetSize)
  const candidate_A = parseAspect(candidate.size ?? candidate.entry?.size)
  if (target_A && candidate_A) {
    const sizeDiff = Math.abs(target_A.width - candidate_A.width) / Math.max(target_A.width, candidate_A.width)
      + Math.abs(target_A.height - candidate_A.height) / Math.max(target_A.height, candidate_A.height)
    const sizeScore = Math.max(0, 1 - sizeDiff / 2)
    score += sizeScore
    parts.push({ key: 'size', value: Number(sizeScore.toFixed(2)) })
  }

  return { score: Number(score.toFixed(3)), parts }
}
