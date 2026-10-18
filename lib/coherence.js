/**
 * 协调性检查（B 组）：单张好 ≠ 一组好。
 *
 *   B1 调色板锁定 + 漂移检测 —— 100 张放一起像一套，而不是像 100 个画师画的
 *   B2 小尺寸可读性预检     —— 拦住「大图精美，进游戏一团泥」
 *   B3 动画连贯性检查       —— 相邻帧突变/首尾不闭合/所有帧一样，自动暴露
 *
 * 全部确定性（可测、可复现），复用已有的 stylefp（取色板/指纹）。
 */
import { decodePngRgba } from './pngcodec.js'
import { fitToTarget } from './autotrim.js'
import { styleFingerprint, styleSimilarity } from './stylefp.js'

// ───────── B1 调色板锁定 + 漂移检测 ─────────

/**
 * 从一组图统计「全游戏主调色板」。
 * 按出现频次 + 覆盖张数加权：一张图里的主色权重高，但**跨多张图都出现的色**更该进统一色板
 * （那才是"这套素材的底色"，而不是某张图的偶然色）。
 *
 * @param {Array<{file?:string, fingerprint:object}>} items
 * @param {{top?:number, minShare?:number}} options
 */
export function buildPalette(items = [], { top = 24, minShare = 0.004 } = {}) {
  const tally = new Map()
  let considered = 0
  for (const item of items) {
    const fp = item?.fingerprint
    if (!fp?.palette?.length) continue
    considered += 1
    // 一张图内部先把色归并，避免某张图的细碎色把总表冲淡
    const local = new Map()
    for (const entry of fp.palette) {
      if ((entry.share ?? 0) < minShare) continue
      local.set(entry.hex, (local.get(entry.hex) ?? 0) + (entry.share ?? 0))
    }
    for (const [hex, share] of local) {
      const record = tally.get(hex) ?? { hex, weight: 0, files: 0 }
      record.weight += share
      record.files += 1
      tally.set(hex, record)
    }
  }
  const palette = [...tally.values()]
    // 覆盖张数优先，其次权重 —— 「很多张都有」比「某张占比很高」更能代表整体风格
    .sort((a, b) => (b.files - a.files) || (b.weight - a.weight))
    .slice(0, top)
    .map((item) => ({
      hex: item.hex,
      files: item.files,
      coverage: considered > 0 ? Number((item.files / considered).toFixed(3)) : 0,
    }))
  return { palette, considered, size: palette.length }
}

/** 两个十六进制色的 RGB 距离（0..441）。 */
export function colorDistance(a, b) {
  const pa = hexToRgb(a)
  const pb = hexToRgb(b)
  if (!pa || !pb) return Infinity
  return Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2)
}

export function hexToRgb(hex) {
  const h = String(hex ?? '').replace('#', '')
  if (h.length !== 6) return null
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * B1：某张图相对锁定调色板的漂移程度。
 *
 * 判据：这张图的颜色有多少比例「离任何锁定色都很远」。
 * 只看有实际占比的颜色（share ≥ 2%），避免抗锯齿噪点造成误报。
 *
 * @returns {{drift:number, level:'ok'|'watch'|'off', offPalette:Array, locked:number}}
 */
export function paletteDrift({ fingerprint, locked = [], tolerance = 64, minShare = 0.02 }) {
  const fp = fingerprint
  if (!fp?.palette?.length || !locked.length) {
    return { drift: 0, level: 'ok', offPalette: [], locked: locked.length, note: '没有锁定调色板或图为空，跳过检测' }
  }
  const lockedHex = locked.map((item) => (typeof item === 'string' ? item : item.hex)).filter(Boolean)
  let totalShare = 0
  let offShare = 0
  const offPalette = []
  for (const entry of fp.palette) {
    const share = entry.share ?? 0
    if (share < minShare) continue
    totalShare += share
    const nearest = Math.min(...lockedHex.map((hex) => colorDistance(entry.hex, hex)))
    if (nearest > tolerance) {
      offShare += share
      offPalette.push({ hex: entry.hex, share: Number(share.toFixed(3)), nearest })
    }
  }
  const drift = totalShare > 0 ? Number((offShare / totalShare).toFixed(3)) : 0
  const level = drift >= 0.5 ? 'off' : drift >= 0.25 ? 'watch' : 'ok'
  return {
    drift,
    level,
    offPalette: offPalette.slice(0, 8),
    locked: lockedHex.length,
    advice: level === 'off'
      ? `偏离明显：${Math.round(drift * 100)}% 的用色不在锁定调色板附近 —— 这张看起来不像同一套。`
      : level === 'watch'
        ? `略有偏离（${Math.round(drift * 100)}%），可以接受但不完全一致。`
        : '与锁定调色板一致。',
  }
}

// ───────── B2 小尺寸可读性预检 ─────────

/**
 * B2：缩到游戏实际渲染尺寸后，还认不认得出？
 *
 * 两个指标（都来自缩完之后的像素）：
 *   contrast  —— 前景与背景的亮度差；太低就是"一团泥"
 *   fillRatio —— 有效像素（非透明、且与主体色差够大）占比；太低说明内容太小/太空
 *
 * 为什么必须**先缩再算**：大图上一切都很清楚，问题只在缩小之后才暴露。
 *
 * @returns {{ok:boolean, level, contrast, fillRatio, size, advice}}
 */
export function readabilityAtSize({ buffer, targetWidth, targetHeight, silhouetteThreshold = 0.12 }) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, level: 'unknown', error: '解不开' }
  if (!targetWidth || !targetHeight) return { ok: true, level: 'unknown', note: '没有目标尺寸，跳过' }

  const fitted = fitToTarget({
    pixels: decoded.pixels, width: decoded.width, height: decoded.height,
    targetWidth, targetHeight, mode: 'contain', allowUpscale: true,
  })
  const { pixels, width, height } = fitted

  // 分两组：不透明像素里，亮度高于中位的是"亮部"，低于的是"暗部"
  const lums = []
  let opaque = 0
  let transparent = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 24) { transparent += 1; continue }
    opaque += 1
    lums.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2])
  }
  const total = width * height
  if (opaque === 0) {
    return { ok: false, level: 'bad', contrast: 0, fillRatio: 0, size: `${width}×${height}`, advice: '缩到游戏尺寸后**整张全透明** —— 内容没了。' }
  }
  lums.sort((a, b) => a - b)
  const p10 = lums[Math.floor(lums.length * 0.1)]
  const p90 = lums[Math.floor(lums.length * 0.9)]
  const contrast = Number(((p90 - p10) / 255).toFixed(3))

  // 有效像素：主体实心部分的占比（用 alpha 门槛 + 亮度跨度共同判定）
  const fillRatio = Number((opaque / total).toFixed(3))

  // 边缘密度：缩小后还有没有轮廓（复用思路，但这里直接算简单梯度）
  let edges = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] < 24) continue
      const right = ((y * width + x + 1) * 4)
      const down = (((y + 1) * width + x) * 4)
      const d = Math.abs(pixels[i] - pixels[right]) + Math.abs(pixels[i] - pixels[down])
      if (d > 48) edges += 1
    }
  }
  const edgeRatio = Number((edges / Math.max(1, opaque)).toFixed(3))

  const problems = []
  if (contrast < silhouetteThreshold) problems.push(`明暗对比只有 ${(contrast * 100).toFixed(0)}%，缩到 ${width}×${height} 后看不出轮廓`)
  if (fillRatio < 0.05) problems.push(`有效像素只占 ${(fillRatio * 100).toFixed(0)}%，内容太小`)
  if (edgeRatio < 0.02) problems.push('缩小后几乎没有边缘，细节糊成一团')

  const level = problems.length >= 2 ? 'bad' : problems.length === 1 ? 'watch' : 'ok'
  return {
    ok: problems.length === 0,
    level,
    contrast,
    fillRatio,
    edgeRatio,
    size: `${width}×${height}`,
    transparentRatio: Number((transparent / total).toFixed(3)),
    problems,
    advice: problems.length === 0
      ? `缩到 ${width}×${height} 仍然清楚。`
      : `缩到 ${width}×${height} 后可读性不足：${problems.join('；')}。建议加大主体、提高明暗对比，或重新设计更简的轮廓。`,
  }
}

// ───────── B3 动画连贯性检查 ─────────

/**
 * 两张图的像素差（0=完全一样，1=完全不同）。只看都有 alpha 的像素。
 * 用于相邻帧突变检测。
 */
export function frameDifference(a, b) {
  if (!a || !b) return null
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  if (w < 2 || h < 2) return null
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      const aa = a.pixels[ia + 3]
      const ab = b.pixels[ib + 3]
      if (aa < 24 && ab < 24) continue
      sum += (Math.abs(a.pixels[ia] - b.pixels[ib]) +
        Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]) +
        Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2])) / 765
      // alpha 差异也算（透明→实心是明显变化）
      sum += Math.abs(aa - ab) / 255
      n += 2
    }
  }
  return n > 0 ? Number((sum / n).toFixed(4)) : null
}

/**
 * B3：一组帧（按顺序）的连贯性报告。
 *
 * 检出三类问题：
 *   - 突变：相邻帧差异远大于平均（动画会"跳"）
 *   - 首尾不闭合：按名字判断是循环动画时，首帧与尾帧差异过大
 *   - 全一样：所有帧几乎相同（动画没动 / 生成失败）
 */
export function animationCoherence({ frames = [], loop = null, jumpFactor = 2.5, identicalThreshold = 0.002 } = {}) {
  const decoded = frames.map((frame) => (frame.decoded ?? frame))
  if (decoded.length < 2) {
    return { ok: true, level: 'unknown', frames: decoded.length, note: '不足两帧，无法判断连贯性' }
  }
  const diffs = []
  for (let i = 1; i < decoded.length; i++) {
    diffs.push(frameDifference(decoded[i - 1], decoded[i]))
  }
  const valid = diffs.filter((d) => d !== null)
  const avg = valid.length ? valid.reduce((s, d) => s + d, 0) / valid.length : 0
  // 判"突变"要用**中位数**而不是平均值：
  // 平均值会被突变本身拉高（实测 3 帧 0.09/0.08/0.74 → avg 0.30，
  // 0.74 除以 0.30 只有 2.5 倍，恰好卡在阈值上检不出来）。
  // 中位数不受离群值影响，才是"正常帧间差异"的稳定估计。
  const median = valid.length ? [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)] : 0
  const baseline = median > 0 ? median : avg

  const problems = []
  const jumps = []
  diffs.forEach((d, i) => {
    if (d === null) return
    if (baseline > 0 && d > baseline * jumpFactor && d > 0.02) {
      jumps.push({ from: i, to: i + 1, diff: d, baseline: Number(baseline.toFixed(4)), ratio: Number((d / baseline).toFixed(2)) })
    }
  })
  if (jumps.length > 0) {
    problems.push(`第 ${jumps.map((j) => `${j.from}→${j.to}`).join('、')} 帧之间差异突变（差值 ${jumps.map((j) => j.diff).join('、')}，是平常的 ${jumps.map((j) => j.ratio + '倍').join('、')}）—— 动画会"跳"`)
  }

  // 全一样
  const allSame = valid.length > 0 && valid.every((d) => d <= identicalThreshold)
  if (allSame) problems.push(`所有帧几乎完全相同（平均差异 ${avg.toFixed(4)}）—— 动画没动，或生成时没按序列出`)

  // 首尾闭合（只有明确是循环时才报）
  const isLoop = loop ?? /loop|cycle|循环/i.test(String(frames[0]?.name ?? ''))
  let loopDiff = null
  if (isLoop) {
    loopDiff = frameDifference(decoded[0], decoded[decoded.length - 1])
    // 用中位数做基线（同突变检测的理由）；且首尾闭合要求比普通帧更严
    if (loopDiff !== null && baseline > 0 && loopDiff > baseline * 2.5 && loopDiff > 0.03) {
      problems.push(`标为循环，但首尾差异 ${loopDiff} 是平常帧间差异（${baseline.toFixed(4)}）的 ${(loopDiff / baseline).toFixed(1)} 倍 —— 循环会看到接缝`)
    }
  }

  const level = problems.length > 0 ? 'watch' : 'ok'
  return {
    ok: problems.length === 0,
    level,
    frames: decoded.length,
    diffs,
    average_diff: Number(avg.toFixed(4)),
    median_diff: Number(median.toFixed(4)),
    baseline_diff: Number(baseline.toFixed(4)),
    max_diff: valid.length ? Math.max(...valid) : 0,
    min_diff: valid.length ? Math.min(...valid) : 0,
    jumps,
    loop,
    loop_diff: loopDiff,
    all_identical: allSame,
    problems,
    advice: problems.length === 0
      ? `帧间差异平稳（中位 ${median.toFixed(4)}），连贯性没问题。`
      : problems.join('；'),
  }
}

/** 从一组指纹看整组的风格一致性（B1 的"整组概览"）。 */
export function groupStyleConsistency(fingerprints = []) {
  const list = fingerprints.filter(Boolean)
  if (list.length < 2) return { ok: true, level: 'unknown', count: list.length, note: '不足两张，无法比较一致性' }
  const scores = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const s = styleSimilarity(list[i], list[j])
      if (typeof s === 'number') scores.push(s)
    }
  }
  if (scores.length === 0) return { ok: true, level: 'unknown', count: list.length }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  const min = Math.min(...scores)
  const level = avg >= 0.75 ? 'ok' : avg >= 0.5 ? 'watch' : 'off'
  return {
    ok: level === 'ok',
    level,
    count: list.length,
    pairs: scores.length,
    average: Number(avg.toFixed(3)),
    min: Number(min.toFixed(3)),
    advice: level === 'ok'
      ? `整组风格一致（平均相似度 ${avg.toFixed(2)}）。`
      : level === 'watch'
        ? `整组基本一致（${avg.toFixed(2)}），最低的一对只有 ${min.toFixed(2)} —— 有少数几张偏离。`
        : `整组风格不一致（平均 ${avg.toFixed(2)}）—— 看起来不像同一套，建议先定调色板再批量重出。`,
  }
}

export { styleFingerprint }
