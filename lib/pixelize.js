/**
 * 像素画净化（pixelize）：把 AI 生成的「伪像素图」还原成**真像素图**。
 *
 * 移植自 AIPixelImageConversionTool（MIT，© 2026 qianmozhiyu）
 *   https://github.com/qianmozhiyu/AIPixelImageConversionTool
 * 原项目是 Python + numpy/skimage/sklearn；这里是**零依赖 ESM 移植**，
 * 只保留能确定性地跑、且对游戏素材真正有用的那条主链：
 *
 *   整数尺度（runs/GCD 直方图）→ 网格周期 + 相位 → 块核心区取代表色 → 调色板精炼
 *   （可选：OKLab 三角形不等式 AA 消除）
 *
 * 为什么这件事值得做：AI 生成的「像素画」其实是**高分辨率画出来的方块**——
 * 1024×1024 里每个「像素」占 16×16 甚至 32×32，块边界还带抗锯齿。
 * 直接缩到 32×32 会得到一团糊；正确做法是**先测出块尺寸，再按块取核心区代表色**。
 *
 * 与上游的差异（都是刻意的，逐条写清，免得被当成"移植漏了"）：
 *   1. **不做 nl_means / TV / bilateral 降噪**（那是 skimage 的算法）。只提供 3×3 中值
 *      作为可选的轻降噪，并且**默认关闭** —— 宁可少做，不假装等价。
 *   2. **不做 CLAHE**（skimage.exposure.equalize_adapthist）。理由同上。
 *   3. **不做 Spectral Comb / GPA / cornerSubPix / 仿射外推**。上游自己的实测结论是
 *      「comb 在真实 AI 图上**有害**（把 16px 拉到 4px）、cornerSubPix 与仿射外推在真实图上
 *      无显著增益」，三项默认关闭。这里直接不做，改用上游确认有效的那两条：
 *      **整数尺度（runs/GCD）** + **边缘强度判据 + 子谐波修正**。
 *   4. **保留 alpha**。上游只处理 RGB（素材图通常不带透明）。游戏素材大量需要透明底，
 *      所以这里对 alpha 单独用核心区中位数 + 阈值二值化（真像素画没有半透明）。
 *   5. **支持显式指定逻辑分辨率**。游戏里目标尺寸往往是已知的（规格即代码），
 *      直接给 logical 尺寸比自动检测可靠得多，所以它是**第一优先级**。
 */
import { decodePngRgba, encodePngRgba } from './pngcodec.js'

/* ============================================================================
 * OKLab：感知空间。AA 判定的三角形不等式与调色板聚类都在这里做。
 * 公式与上游 aa_removal.py / color.py 一致（Björn Ottosson 的 OKLab）。
 * ========================================================================== */

/** sRGB 分量（0..1）线性化。 */
function linearize(c) {
  return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92
}

/** 线性分量 → sRGB（0..1）。 */
function delinearize(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055
}

/** RGB(0..255) → OKLab。 */
export function rgbToOklab(r, g, b) {
  const rl = linearize(r / 255)
  const gl = linearize(g / 255)
  const bl = linearize(b / 255)
  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl)
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl)
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

/** OKLab → RGB(0..255)，越出 sRGB 色域的值裁剪（与上游 oklab_to_rgb 一致）。 */
export function oklabToRgb(L, A, B) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  return [
    Math.max(0, Math.min(255, Math.round(delinearize(rl) * 255))),
    Math.max(0, Math.min(255, Math.round(delinearize(gl) * 255))),
    Math.max(0, Math.min(255, Math.round(delinearize(bl) * 255))),
  ]
}

/* ============================================================================
 * 基础像素操作
 * ========================================================================== */

/** BT.601 亮度（与上游 to_gray 一致）。 */
function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** RGBA → 灰度 Float64Array。 */
export function toGray(pixels, width, height) {
  const out = new Float64Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = luminance(pixels[p], pixels[p + 1], pixels[p + 2])
  }
  return out
}

/**
 * Sobel 边缘强度图，归一化到 0..1。
 * 上游 compute_edge_map 的等价物：网格检测、相位搜索、边界带判据都用它。
 */
export function computeEdgeMap(gray, width, height) {
  const out = new Float64Array(width * height)
  const at = (x, y) => gray[y * width + x]
  let max = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const mag = Math.sqrt(gx * gx + gy * gy) / 4
      out[y * width + x] = mag
      if (mag > max) max = mag
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max
  return out
}

/** 投影：把 2D 边缘图压成 1D 剖面。`axis='x'` 沿 y 求平均（看竖直网格线）。 */
function project(edge, width, height, axis) {
  if (axis === 'x') {
    const prof = new Float64Array(width)
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let y = 0; y < height; y++) sum += edge[y * width + x]
      prof[x] = sum / height
    }
    return prof
  }
  const prof = new Float64Array(height)
  for (let y = 0; y < height; y++) {
    let sum = 0
    for (let x = 0; x < width; x++) sum += edge[y * width + x]
    prof[y] = sum / width
  }
  return prof
}

/* ============================================================================
 * 整数尺度检测：runs / GCD
 *
 * 逐字移植上游 src/core/scale_detect.py 的思路：沿采样行/列统计「相邻像素差值 ≤ tol
 * 视为同色」的行程长度 —— 像素图里每块均匀色对应一个行程，行程长度是真实块尺寸的
 * 整数倍。取频次最高的若干行程长度两两求 GCD 得候选尺度，再算命中率选最优。
 *
 * 这是**正交于边缘判据的第二路证据**：块内纹理（渐变、噪点）会污染 FFT 主峰，
 * 但行程长度不会被污染。
 * ========================================================================== */

function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) { const t = x % y; x = y; y = t }
  return x
}

/** 一维线的行程长度：差值 > tol 处断开。 */
export function lineRuns(line, tol) {
  const runs = []
  if (line.length < 2) return runs
  let start = 0
  for (let i = 1; i < line.length; i++) {
    if (Math.abs(line[i] - line[i - 1]) > tol) {
      runs.push(i - start)
      start = i
    }
  }
  runs.push(line.length - start)
  return runs
}

/** 由行程长度直方图推候选整数尺度并评估命中率（命中率相同取更大尺度）。 */
export function bestScaleFromRuns(runs, minP, maxP, tol) {
  const total = runs.length
  if (total === 0) return { scale: 0, hitRate: 0 }
  const hist = new Map()
  for (const len of runs) hist.set(len, (hist.get(len) ?? 0) + 1)
  // 频次前 8；同频次按长度升序，保证确定性（上游 most_common 的并列顺序不确定）
  const top = [...hist.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, 8)
    .map((entry) => entry[0])

  const cands = new Set()
  for (let i = 0; i < top.length; i++) {
    if (top[i] >= minP && top[i] <= maxP) cands.add(top[i])
    for (let j = i + 1; j < top.length; j++) {
      const g = gcd(top[i], top[j])
      if (g >= minP && g <= maxP) cands.add(g)
    }
  }
  if (cands.size === 0) return { scale: 0, hitRate: 0 }

  let bestScale = 0
  let bestRate = 0
  for (const scale of [...cands].sort((a, b) => a - b)) {
    // 「是不是 scale 的整数倍」的容差必须**小于半个周期**，否则短行程会被错认成
    // 一个更大的周期：tol=12、scale=8 时，长度 4 的行程 round(4/8)=1 → |4-8|=4≤12
    // 会被判成命中 —— 结果就是真实块 4 被选成 8，两个像素并成一个。
    // 上游同样把 tol 一物二用，靠另外四个判据兜住；这里直接修掉。
    const multipleTol = Math.min(tol, Math.max(0.5, scale * 0.45))
    let hits = 0
    for (const len of runs) {
      const k = Math.round(len / scale)
      if (k >= 1 && Math.abs(len - k * scale) <= multipleTol) hits += 1
    }
    const rate = hits / total
    if (rate > bestRate + 1e-9 || (Math.abs(rate - bestRate) < 1e-9 && scale > bestScale)) {
      bestScale = scale
      bestRate = rate
    }
  }
  return { scale: bestScale, hitRate: bestRate }
}

/** 上游 scale_detect.detect_integer_scale 的等价物。 */
export function detectIntegerScale(gray, width, height, {
  minP = 3, maxP = 40, tol = 12, sampleStride = 4, strongHitRate = 0.7,
} = {}) {
  if (width < 8 || height < 8) return { scaleX: 0, scaleY: 0, hitRate: 0, confidence: 0 }
  const xRuns = []
  for (let y = 0; y < height; y += sampleStride) {
    const line = gray.subarray(y * width, y * width + width)
    for (const run of lineRuns(line, tol)) xRuns.push(run)
  }
  const yRuns = []
  for (let x = 0; x < width; x += sampleStride) {
    const line = new Float64Array(height)
    for (let y = 0; y < height; y++) line[y] = gray[y * width + x]
    for (const run of lineRuns(line, tol)) yRuns.push(run)
  }
  const sx = bestScaleFromRuns(xRuns, minP, maxP, tol)
  const sy = bestScaleFromRuns(yRuns, minP, maxP, tol)
  if (sx.scale <= 0 || sy.scale <= 0) return { scaleX: 0, scaleY: 0, hitRate: 0, confidence: 0 }
  const hitRate = (sx.hitRate + sy.hitRate) / 2
  const consistency = sx.scale === sy.scale ? 1 : 0.7
  const confidence = hitRate * consistency
  // 无强证据时返回 0，让调用方走边缘判据那条路（与上游口径一致）
  if (hitRate < strongHitRate) return { scaleX: 0, scaleY: 0, hitRate, confidence: 0 }
  return { scaleX: sx.scale, scaleY: sy.scale, hitRate, confidence }
}

/* ============================================================================
 * 网格周期 + 相位
 *
 * 上游的口径：**边缘强度判据比 FFT 主峰可靠**（"FFT 主峰易被块内纹理污染，
 * edge 判据不受其影响，故可用 edge 无条件覆盖"）。
 * 所以这里以「网格线上的平均边缘强度」为唯一优化目标，配上上游确认有效的
 * **子谐波修正**（PLAUSIBILITY_EDGE_RATIO=1.3：若 k 倍周期的边界带显著更强，
 * 说明当前周期是块内纹理，采纳更大的那个）。
 * ========================================================================== */

/**
 * 梳状得分：**网格线上**与**格与格之间**的边缘强度之差（on − off）。
 *
 * 为什么不是「网格线上的平均强度」：那个量分不出真周期和它的整数倍。
 * 真实块尺寸是 4 时，取周期 8 采样到的位置**也全是真边界**（只是漏掉一半），
 * 于是两者得分打平甚至更高 —— 结果就是周期被放大一倍、两个像素被并成一个。
 * 减去「格间」的强度后，漏掉边界的周期自然得低分（格间也全是边界），
 * 真周期得高分（格间是块内部，几乎没有边缘）。
 *
 * 这是对上游 comb 得分的一个刻意改进（上游靠五判据投票解决同一问题）。
 */
function combStats(profile, period, phase) {
  let onSum = 0
  let onN = 0
  let offSum = 0
  let offN = 0
  for (let k = 0; k < 8192; k++) {
    const at = Math.round(phase + k * period)
    if (at >= profile.length) break
    if (at >= 0) { onSum += profile[at]; onN += 1 }
    const mid = Math.round(phase + (k + 0.5) * period)
    if (mid >= 0 && mid < profile.length) { offSum += profile[mid]; offN += 1 }
  }
  if (onN < 2) return { on: -1, off: -1, contrast: -1 }
  const on = onSum / onN
  const off = offN > 0 ? offSum / offN : 0
  return { on, off, contrast: on - off }
}

/**
 * 自相关峰：候选周期的**资格判据**。
 *
 * 为什么必须有这一关：峰值匹配的 F1 会被「运气好」的假周期骗到。实测（×4 放大 + 抗锯齿）
 * 里周期 6 的 F1 是 0.800，比真周期 4 的 0.737 还高 —— 因为峰值只有 7 个且间距不规则，
 * 周期 6 恰好能落在其中 6 个的 ±1 内。但自相关一眼看穿：真周期在 lag=p 上是**正的局部极大**
 * （lag 4 → +0.25、8 → +0.41），而 lag 6 是 **−0.41**（半周期反相关），根本不具备周期性。
 * 所以：候选周期必须是自相关正峰，或者有 runs/GCD 的整数尺度证据。
 */
function autocorrPeaks(profile, minP, maxP, { acfMin = 0.1 } = {}) {
  const n = profile.length
  if (n < minP * 3) return []
  let mean = 0
  for (let i = 0; i < n; i++) mean += profile[i]
  mean /= n || 1
  const centred = new Float64Array(n)
  for (let i = 0; i < n; i++) centred[i] = profile[i] - mean
  let zero = 0
  for (let i = 0; i < n; i++) zero += centred[i] * centred[i]
  if (zero <= 0) return []

  const hi = Math.min(maxP, Math.floor(n / 2))
  const acf = new Map()
  for (let p = minP; p <= hi; p++) {
    let sum = 0
    for (let i = 0; i + p < n; i++) sum += centred[i] * centred[i + p]
    acf.set(p, sum / zero)
  }
  const peaks = []
  for (let p = minP; p <= hi; p++) {
    const value = acf.get(p)
    if (value < acfMin) continue
    const prev = p > minP ? acf.get(p - 1) : -Infinity
    const next = p < hi ? acf.get(p + 1) : -Infinity
    if (value >= prev && value >= next) peaks.push({ period: p, acf: value })
  }
  return peaks
}

/**
 * 找投影剖面里的「强边缘位置」——真网格线应该就在这些位置上。
 * 判定：局部极大且高于平均值的 `peakRatio` 倍。
 */
function findPeaks(profile, peakRatio = 1.25) {
  const n = profile.length
  if (n < 3) return []
  let mean = 0
  for (let i = 0; i < n; i++) mean += profile[i]
  mean /= n
  const threshold = mean * peakRatio
  const peaks = []
  for (let i = 1; i < n - 1; i++) {
    if (profile[i] >= profile[i - 1] && profile[i] >= profile[i + 1] && profile[i] > threshold) peaks.push(i)
  }
  return peaks
}

/** 在某周期下搜相位，按「峰值匹配的 F1」择优。 */
function bestPhaseByF1(profile, period, peaks, { peakTolerance = 1 } = {}) {
  const span = Math.max(1, Math.round(period))
  // 容差必须是**固定的小像素数**（网格线定位误差约 1px），不能随周期放大：
  // 按 period×0.15 缩放时，周期 12 的容差变成 ±2，于是它的网格线能"蹭"到
  // 不属于它的峰值，precision 虚高到 1.0，把真周期 4 挤掉（实测踩过）。
  const tol = Math.max(1, Math.floor(peakTolerance))
  let best = null
  for (let phase = 0; phase < span; phase++) {
    const lines = []
    for (let k = 0; k < 8192; k++) {
      const at = Math.round(phase + k * period)
      if (at >= profile.length) break
      if (at >= 0) lines.push(at)
    }
    if (lines.length < 2) continue
    // 命中：网格线旁边（±tol）有强边缘
    let lineHits = 0
    for (const line of lines) {
      for (const peak of peaks) {
        if (Math.abs(peak - line) <= tol) { lineHits += 1; break }
      }
    }
    // 召回：强边缘旁边有网格线
    let peakHits = 0
    for (const peak of peaks) {
      for (const line of lines) {
        if (Math.abs(peak - line) <= tol) { peakHits += 1; break }
      }
    }
    const precision = lines.length > 0 ? lineHits / lines.length : 0
    const recall = peaks.length > 0 ? peakHits / peaks.length : 0
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0
    const stats = combStats(profile, period, phase)
    // F1 为主；平局时取齿更多（覆盖更完整）、相位更小的
    const better = !best
      || f1 > best.f1 + 1e-9
      || (Math.abs(f1 - best.f1) < 1e-9 && lines.length > best.teeth)
      || (Math.abs(f1 - best.f1) < 1e-9 && lines.length === best.teeth && phase < best.phase)
    if (better) best = { phase, f1, precision, recall, teeth: lines.length, period, ...stats }
  }
  return best ?? { phase: 0, f1: 0, precision: 0, recall: 0, teeth: 0, period, on: 0, off: 0, contrast: 0 }
}

/**
 * 检测网格。
 *
 * 优先级（可靠 → 不可靠）：
 *   1. 显式给逻辑分辨率（游戏规格已知）→ 直接算出周期，只搜相位
 *   2. 整数尺度（runs/GCD）强证据 + 自相关 → 候选周期
 *   3. 峰值匹配 F1 选周期（**取基频**，不是得分最高的那个倍数）
 *   4. 都不成立 → ok:false，调用方**不要**动图（宁可不做，也不要把好图毁掉）
 */
export function detectGrid(pixels, width, height, options = {}) {
  const minP = Number(options.minPeriod ?? 3)
  const maxP = Math.min(Number(options.maxPeriod ?? 64), Math.floor(Math.min(width, height) / 2))
  const explicitW = Number(options.logicalWidth ?? 0)
  const explicitH = Number(options.logicalHeight ?? 0)
  const peakRatio = Number(options.peakRatio ?? 1.25)
  const minF1 = Number(options.minF1 ?? 0.55)

  const gray = options.gray ?? toGray(pixels, width, height)
  const edge = options.edge ?? computeEdgeMap(gray, width, height)
  const profX = project(edge, width, height, 'x')
  const profY = project(edge, width, height, 'y')
  const meanX = profX.reduce((a, b) => a + b, 0) / (profX.length || 1)
  const meanY = profY.reduce((a, b) => a + b, 0) / (profY.length || 1)
  const peaksX = findPeaks(profX, peakRatio)
  const peaksY = findPeaks(profY, peakRatio)

  const done = (px, py, phaseX, phaseY, source, confidence, note, counts = null) => {
    const wLogic = counts?.width ?? Math.max(1, Math.round((width - phaseX) / px))
    const hLogic = counts?.height ?? Math.max(1, Math.round((height - phaseY) / py))
    const sx = combStats(profX, px, phaseX)
    const sy = combStats(profY, py, phaseY)
    return {
      ok: true, px, py, phaseX, phaseY, wLogic, hLogic, source, confidence, note,
      strengthX: sx.on, strengthY: sy.on,
      contrastX: sx.contrast, contrastY: sy.contrast,
      ratioX: meanX > 0 ? sx.on / meanX : 0,
      ratioY: meanY > 0 ? sy.on / meanY : 0,
      peaks: { x: peaksX.length, y: peaksY.length },
    }
  }

  // 1. 显式逻辑分辨率：最可靠。
  //    注意这里的关键区别：**它不是在「检测」网格，而是在「等分」图像**。
  //    所以输出尺寸必须**正好**是给定的逻辑尺寸（曾经因为按相位反算而漂成 47×31），
  //    并且当匹配度低（说明本来就没有真网格，只是用户选定的目标分辨率）时，
  //    相位取 0 —— 均匀等分，而不是去拟合一个不存在的网格。
  if (explicitW > 0 && explicitH > 0) {
    const px = width / explicitW
    const py = height / explicitH
    if (px >= 1 && py >= 1) {
      const foundX = bestPhaseByF1(profX, px, peaksX, { peakTolerance: options.peakTolerance })
      const foundY = bestPhaseByF1(profY, py, peaksY, { peakTolerance: options.peakTolerance })
      const alignedX = foundX.f1 >= minF1
      const alignedY = foundY.f1 >= minF1
      const phaseX = alignedX ? foundX.phase : 0
      const phaseY = alignedY ? foundY.phase : 0
      return done(px, py, phaseX, phaseY, 'explicit', 1,
        `按给定逻辑分辨率 ${explicitW}×${explicitH} 等分图像（每块 ${px.toFixed(2)}×${py.toFixed(2)}px；`
        + `${alignedX && alignedY ? `相位对齐到实际网格，命中 ${(Math.min(foundX.f1, foundY.f1) * 100).toFixed(0)}%` : '没发现真网格，按原点均匀等分'}）`,
        { width: explicitW, height: explicitH })
    }
  }

  if (peaksX.length < 2 && peaksY.length < 2) {
    return {
      ok: false,
      peaks: { x: peaksX.length, y: peaksY.length },
      reason: '没检测到明显的像素网格（找不到足够强的边缘峰值）—— 硬做只会把图毁成马赛克，'
        + '所以不做。若你知道逻辑分辨率，直接指定它（pixel.width / pixel.height）最稳。',
    }
  }

  // 2. 候选周期：**自相关正峰**（资格）+ runs/GCD 整数尺度（正交证据）
  const runs = detectIntegerScale(gray, width, height, {
    minP, maxP, tol: Number(options.runsTolerance ?? 12), sampleStride: Number(options.sampleStride ?? 4),
  })
  const acfX = autocorrPeaks(profX, minP, maxP, { acfMin: Number(options.acfMin ?? 0.1) })
  const acfY = autocorrPeaks(profY, minP, maxP, { acfMin: Number(options.acfMin ?? 0.1) })

  const eligibleX = new Set(acfX.map((item) => item.period))
  const eligibleY = new Set(acfY.map((item) => item.period))
  // runs/GCD 是正交证据：块内纹理不会污染行程长度，所以它给出的尺度直接放行
  if (runs.scaleX > 0) eligibleX.add(runs.scaleX)
  if (runs.scaleY > 0) eligibleY.add(runs.scaleY)

  const axisBest = (profile, peaks, eligible) => {
    const list = [...eligible].filter((p) => p >= minP && p <= maxP).sort((a, b) => a - b)
    if (list.length === 0) return null
    let best = null
    for (const period of list) {
      const found = bestPhaseByF1(profile, period, peaks, { peakTolerance: options.peakTolerance })
      // 升序遍历 + 「必须显著更优才覆盖」→ 得分接近时**取更小的周期**（真基频），
      // 避免周期被放大成 2×、4× 而把几个像素并成一个
      if (!best || found.f1 > best.f1 + 0.05) best = found
    }
    return best
  }
  const bestX = axisBest(profX, peaksX, eligibleX)
  const bestY = axisBest(profY, peaksY, eligibleY)
  const f1 = Math.max(bestX?.f1 ?? 0, bestY?.f1 ?? 0)
  if (!bestX || !bestY || f1 < minF1) {
    return {
      ok: false, runs, f1, peaks: { x: peaksX.length, y: peaksY.length },
      acf_peaks: { x: acfX.length, y: acfY.length },
      contrast: Math.max(bestX?.contrast ?? 0, bestY?.contrast ?? 0),
      reason: `没检测到明显的像素网格（网格线对强边缘的匹配度 F1 = ${f1.toFixed(2)}，需要 ≥ ${minF1}；`
        + `自相关正峰 x ${acfX.length} 个／y ${acfY.length} 个）—— 硬做只会把图毁成马赛克，所以不做。`
        + '若你知道逻辑分辨率，直接指定它（pixel.width / pixel.height）最稳。',
    }
  }

  // 轴上一致性：相对差 < 0.15 就统一（避免两轴锁到不同周期导致拉伸畸变）
  let px = bestX.period
  let py = bestY.period
  const rel = Math.abs(px - py) / Math.max(px, py)
  if (rel < 0.15) {
    const uniform = Math.round((px + py) / 2)
    px = uniform
    py = uniform
  }

  // 周期被统一后相位要重算
  const phX = bestPhaseByF1(profX, px, peaksX)
  const phY = bestPhaseByF1(profY, py, peaksY)
  const source = runs.confidence > 0 ? 'runs+edge' : 'edge'
  return done(px, py, phX.phase, phY.phase, source,
    Math.min(1, Math.max(runs.confidence, 0) * 0.5 + f1 * 0.5),
    `块尺寸 ${px}×${py}px（${source}：峰值匹配 F1 ${f1.toFixed(2)}、x 命中 ${(phX.f1 * 100).toFixed(0)}%／`
    + `y 命中 ${(phY.f1 * 100).toFixed(0)}%、runs 命中率 ${runs.hitRate.toFixed(2)}）`)
}

/* ============================================================================
 * 块提取：每个块 → 1 个代表色像素
 *
 * 逐字移植上游 src/core/extract.py 的循环实现（含 x/y 双向边界去重、核心区居中、
 * 空块回填），并加上 alpha 处理。
 * ========================================================================== */

/** 分位数（上游用 np.percentile 的线性插值口径）。 */
function percentile(sorted, q) {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** 取一组像素均值。 */
function meanOf(list) {
  const acc = [0, 0, 0]
  for (const px of list) { acc[0] += px[0]; acc[1] += px[1]; acc[2] += px[2] }
  const n = list.length || 1
  return [acc[0] / n, acc[1] / n, acc[2] / n]
}

/** 核心区代表色（median / mean / mode / kmeans / dominant，与上游逐一对应）。 */
function representativeColor(pixels, method) {
  if (pixels.length === 0) return [0, 0, 0]
  if (method === 'mean') return meanOf(pixels)
  if (method === 'median') {
    const r = [], g = [], b = []
    for (const px of pixels) { r.push(px[0]); g.push(px[1]); b.push(px[2]) }
    r.sort((a, b) => a - b); g.sort((a, b) => a - b); b.sort((a, b) => a - b)
    return [percentile(r, 0.5), percentile(g, 0.5), percentile(b, 0.5)]
  }
  if (method === 'kmeans') {
    // 上游的"kmeans"不是真 K-means：中位数估主色 + 25 分位距离阈值分离渗透色
    if (pixels.length < 4) return meanOf(pixels)
    const centre = representativeColor(pixels, 'median')
    const dists = pixels.map((px) => Math.hypot(px[0] - centre[0], px[1] - centre[1], px[2] - centre[2]))
    const sorted = [...dists].sort((a, b) => a - b)
    const threshold = percentile(sorted, 0.25)
    const main = pixels.filter((_, index) => dists[index] <= threshold)
    return main.length > 0 ? meanOf(main) : meanOf(pixels)
  }
  if (method === 'dominant' || method === 'mode') {
    // mode：RGB 每通道 /32 粗量化取众数 bin，再取 bin 内原始像素均值
    // dominant：同上但先转到 OKLab 感知空间（步长 0.02）——更贴人眼
    const percept = method === 'dominant'
    const step = percept ? 0.02 : 32
    const keys = []
    const bins = []
    for (const px of pixels) {
      const space = percept ? rgbToOklab(px[0], px[1], px[2]) : px
      const key = space.map((v) => Math.round(v / step)).join(',')
      keys.push(key)
      bins.push(key)
    }
    const hist = new Map()
    for (const key of bins) hist.set(key, (hist.get(key) ?? 0) + 1)
    let modeKey = bins[0]
    let modeCount = -1
    for (const [key, count] of hist) {
      if (count > modeCount || (count === modeCount && key < modeKey)) { modeKey = key; modeCount = count }
    }
    const inBin = pixels.filter((_, index) => keys[index] === modeKey)
    if (inBin.length > 0) return meanOf(inBin)
    return representativeColor(pixels, 'median')
  }
  return representativeColor(pixels, 'median')
}

/**
 * 块提取。输出逻辑分辨率的 RGBA。
 *
 * alpha：核心区 alpha 的中位数，再按 `alphaThreshold` 二值化
 * （真像素画没有半透明；要软边就传 softAlpha:true）。
 */
export function extractBlocks(pixels, width, height, grid, options = {}) {
  const method = ['median', 'mean', 'mode', 'kmeans', 'dominant'].includes(options.method) ? options.method : 'median'
  const coreRatio = Number(options.coreRatio ?? 0.6)
  const alphaThreshold = Number(options.alphaThreshold ?? 128)
  const softAlpha = options.softAlpha === true

  const px = grid.px
  const py = grid.py
  const { phaseX, phaseY, wLogic, hLogic } = grid
  const cw = Math.max(1, Math.round(px * coreRatio))
  const ch = Math.max(1, Math.round(py * coreRatio))

  const out = new Uint8ClampedArray(wLogic * hLogic * 4)
  const prevByEnd = new Int32Array(wLogic)

  for (let j = 0; j < hLogic; j++) {
    let lastRep = null
    let prevBxEnd = 0
    for (let i = 0; i < wLogic; i++) {
      let byStart = Math.round(phaseY + j * py)
      let byEnd = Math.round(phaseY + (j + 1) * py)
      let bxStart = Math.round(phaseX + i * px)
      let bxEnd = Math.round(phaseX + (i + 1) * px)
      byStart = Math.max(0, Math.min(byStart, height))
      byEnd = Math.max(0, Math.min(byEnd, height))
      bxStart = Math.max(0, Math.min(bxStart, width))
      bxEnd = Math.max(0, Math.min(bxEnd, width))
      // 边界去重：相邻块不共享像素（x 与 y 双向）
      bxStart = Math.max(bxStart, prevBxEnd)
      if (bxEnd <= bxStart) bxEnd = bxStart + 1
      bxEnd = Math.min(bxEnd, width)
      prevBxEnd = bxEnd
      byStart = Math.max(byStart, prevByEnd[i])
      if (byEnd <= byStart) byEnd = byStart + 1
      byEnd = Math.min(byEnd, height)
      prevByEnd[i] = byEnd

      const dst = (j * wLogic + i) * 4
      if (byEnd <= byStart) {
        if (j > 0) {
          const src = ((j - 1) * wLogic + i) * 4
          out[dst] = out[src]; out[dst + 1] = out[src + 1]; out[dst + 2] = out[src + 2]; out[dst + 3] = out[src + 3]
        }
        continue
      }
      if (bxEnd <= bxStart) {
        const fallback = lastRep ?? (j > 0 ? [out[dst - wLogic * 4], out[dst - wLogic * 4 + 1], out[dst - wLogic * 4 + 2], out[dst - wLogic * 4 + 3]] : [0, 0, 0, 0])
        out[dst] = fallback[0]; out[dst + 1] = fallback[1]; out[dst + 2] = fallback[2]; out[dst + 3] = fallback[3]
        continue
      }

      const blockH = byEnd - byStart
      const blockW = bxEnd - bxStart
      const cyH = Math.min(ch, blockH)
      const cyStart = byStart + Math.floor((blockH - cyH) / 2)
      const cxW = Math.min(cw, blockW)
      const cxStart = bxStart + Math.floor((blockW - cxW) / 2)

      const samples = []
      const alphas = []
      for (let y = cyStart; y < cyStart + cyH; y++) {
        for (let x = cxStart; x < cxStart + cxW; x++) {
          const src = (y * width + x) * 4
          samples.push([pixels[src], pixels[src + 1], pixels[src + 2]])
          alphas.push(pixels[src + 3])
        }
      }
      if (samples.length === 0) continue
      const rep = representativeColor(samples, method)
      alphas.sort((a, b) => a - b)
      const alpha = softAlpha ? percentile(alphas, 0.5) : (percentile(alphas, 0.5) >= alphaThreshold ? 255 : 0)
      out[dst] = Math.max(0, Math.min(255, Math.round(rep[0])))
      out[dst + 1] = Math.max(0, Math.min(255, Math.round(rep[1])))
      out[dst + 2] = Math.max(0, Math.min(255, Math.round(rep[2])))
      out[dst + 3] = Math.round(alpha)
      lastRep = [out[dst], out[dst + 1], out[dst + 2], out[dst + 3]]
    }
  }
  return { pixels: out, width: wLogic, height: hLogic }
}

/* ============================================================================
 * AA 消除：OKLab 三角形不等式
 *
 * 移植上游 src/core/aa_removal.py（思路来自 pixfix）：一个混合色 p 若「位于」
 * 邻域两个主色 a、b 之间（|d(p,a)+d(p,b)-d(a,b)| / d(a,b) 很小），就是抗锯齿
 * 混合色，吸附到更近的那个主色。这比"阈值抠色"稳，因为它只在**两主色之间**
 * 才动手，纯色角点不会被误判。
 * ========================================================================== */

const AA_OFFSETS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
]
const TRIANGLE_TOL = 0.4
const STRICT_TOL = 0.05


export function removeAntiAliasing(pixels, width, height, { threshold = 0.5, passes = 2 } = {}) {
  let arr = new Float64Array(width * height * 3)
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 4, q += 3) {
    arr[q] = pixels[p]; arr[q + 1] = pixels[p + 1]; arr[q + 2] = pixels[p + 2]
  }
  const oklab = new Float64Array(width * height * 3)
  for (let i = 0, q = 0; i < width * height; i++, q += 3) {
    const lab = rgbToOklab(arr[q], arr[q + 1], arr[q + 2])
    oklab[q] = lab[0]; oklab[q + 1] = lab[1]; oklab[q + 2] = lab[2]
  }
  const at = (x, y) => (y * width + x)
  const clampXY = (v, max) => (v < 0 ? 0 : v >= max ? max - 1 : v)
  let touched = 0

  for (let pass = 0; pass < Math.max(1, Math.floor(passes)); pass++) {
    const nextRgb = Float64Array.from(arr)
    const nextLab = Float64Array.from(oklab)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = at(x, y)
        const q = idx * 3
        // 1) 8 邻域的 RGB 粗量化类别标签（每通道 32 级，base-8 打包 ≤ 511）
        const labels = new Int32Array(8)
        let n = 0
        for (const [dy, dx] of AA_OFFSETS) {
          const nx = clampXY(x + dx, width)
          const ny = clampXY(y + dy, height)
          const nq = at(nx, ny) * 3
          const l0 = Math.floor(arr[nq] / 32)
          const l1 = Math.floor(arr[nq + 1] / 32)
          const l2 = Math.floor(arr[nq + 2] / 32)
          labels[n++] = l0 * 64 + l1 * 8 + l2
        }
        const selfLabel = Math.floor(arr[q] / 32) * 64 + Math.floor(arr[q + 1] / 32) * 8 + Math.floor(arr[q + 2] / 32)
        // 2) 各类频次（8×8 逐对比较，与上游 counts 的语义一致）
        const counts = new Int32Array(8)
        for (let k = 0; k < 8; k++) {
          let c = 0
          for (let l = 0; l < 8; l++) if (labels[l] === labels[k]) c += 1
          counts[k] = c
        }
        const topTwo = (mask) => {
          let a0 = -1; let a1 = -1
          let c0 = -1; let c1 = -1
          for (let k = 0; k < 8; k++) {
            if (mask && labels[k] === selfLabel) continue
            if (counts[k] > c0) { c1 = c0; a1 = a0; c0 = counts[k]; a0 = k }
            else if (counts[k] > c1) { c1 = counts[k]; a1 = k }
          }
          return [a0, a1]
        }
        const [k0, k1] = topTwo(false)
        const [k0n, k1n] = topTwo(true)
        if (k0 < 0 || k1 < 0) continue

        // 3) 每类取邻域均值作主色（RGB 与 OKLab 各一份）
        const acc = (target) => {
          const rgb = [0, 0, 0]
          const ok = [0, 0, 0]
          let cnt = 0
          for (let k = 0; k < 8; k++) {
            if (labels[k] !== target) continue
            const [dy, dx] = AA_OFFSETS[k]
            const nq = at(clampXY(x + dx, width), clampXY(y + dy, height)) * 3
            rgb[0] += arr[nq]; rgb[1] += arr[nq + 1]; rgb[2] += arr[nq + 2]
            ok[0] += oklab[nq]; ok[1] += oklab[nq + 1]; ok[2] += oklab[nq + 2]
            cnt += 1
          }
          const d = Math.max(cnt, 1)
          return { rgb: rgb.map((v) => v / d), ok: ok.map((v) => v / d), count: cnt }
        }
        const A = acc(labels[k0])
        const B = acc(labels[k1])
        const An = k0n >= 0 ? acc(labels[k0n]) : null
        const Bn = k1n >= 0 ? acc(labels[k1n]) : null

        const dist = (p, q2) => Math.hypot(p[0] - q2[0], p[1] - q2[1], p[2] - q2[2])
        const pOk = [oklab[q], oklab[q + 1], oklab[q + 2]]

        // 4) 三角形不等式
        const dAB = dist(A.ok, B.ok)
        const dPA = dist(pOk, A.ok)
        const dPB = dist(pOk, B.ok)
        const tri = Math.abs(dPA + dPB - dAB) / Math.max(dAB, 1e-12)
        const pSolid = selfLabel === labels[k0] || selfLabel === labels[k1]
        const mainHit = !pSolid && dAB > threshold && tri < TRIANGLE_TOL && dPA > 1e-4 && dPB > 1e-4

        let hit = mainHit
        let nearer = null
        if (mainHit) nearer = dPA <= dPB ? A.rgb : B.rgb
        else if (pSolid && An && Bn) {
          // 回退路径：交叉 AA 模式下中心像素自身类最多 → 用非中心类严格判定
          const dABn = dist(An.ok, Bn.ok)
          const dPAn = dist(pOk, An.ok)
          const dPBn = dist(pOk, Bn.ok)
          const trin = Math.abs(dPAn + dPBn - dABn) / Math.max(dABn, 1e-12)
          if (dABn > threshold && trin < STRICT_TOL && dPAn > 1e-4 && dPBn > 1e-4) {
            hit = true
            nearer = dPAn <= dPBn ? An.rgb : Bn.rgb
          }
        }
        if (hit && nearer) {
          nextRgb[q] = nearer[0]; nextRgb[q + 1] = nearer[1]; nextRgb[q + 2] = nearer[2]
          const lab = rgbToOklab(nearer[0], nearer[1], nearer[2])
          nextLab[q] = lab[0]; nextLab[q + 1] = lab[1]; nextLab[q + 2] = lab[2]
          touched += 1
        }
      }
    }
    arr = nextRgb
    for (let i = 0; i < oklab.length; i++) oklab[i] = nextLab[i]
  }

  const out = new Uint8ClampedArray(pixels)
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 4, q += 3) {
    out[p] = Math.round(arr[q]); out[p + 1] = Math.round(arr[q + 1]); out[p + 2] = Math.round(arr[q + 2])
  }
  return { pixels: out, touched }
}

/* ============================================================================
 * 调色板精炼：OKLab 加权 K-means
 *
 * 上游用 sklearn KMeans（random_state=42）。这里自己实现 K-means++ + Lloyd 迭代，
 * 用固定种子的 PRNG 保证**同样的输入永远得到同样的调色板**（可复现很重要：
 * 否则每次重跑同一张图都要重审）。
 * 聚类在 OKLab 做，簇心映射回 RGB（与上游 color_quantize 的 space="oklab" 一致）。
 * ========================================================================== */

/** mulberry32：小而确定的 PRNG。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 聚合唯一色与频次（上游的 np.unique + counts；不聚合会让大图 KMeans 慢到不可用）。 */
export function uniqueColors(pixels) {
  const hist = new Map()
  for (let p = 0; p < pixels.length; p += 4) {
    if (pixels[p + 3] === 0) continue // 全透明像素不参与调色板
    const key = (pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2]
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  const colors = []
  const counts = []
  for (const [key, count] of hist) {
    colors.push([(key >> 16) & 255, (key >> 8) & 255, key & 255])
    counts.push(count)
  }
  return { colors, counts }
}

/**
 * K-means 量化到 nColors。`space='oklab'` 时在感知空间聚类（更贴人眼），默认。
 * 样本数 ≤ nColors 时原样返回（与上游一致）。
 */
export function quantizePalette(pixels, { nColors = 16, space = 'oklab', seed = 42, maxIterations = 24 } = {}) {
  if (!(nColors > 0)) return { pixels, changed: false, palette: [] }
  const { colors, counts } = uniqueColors(pixels)
  if (colors.length <= nColors) {
    return { pixels, changed: false, palette: colors.map((c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`) }
  }

  const toSpace = space === 'rgb' ? (c) => c : (c) => rgbToOklab(c[0], c[1], c[2])
  const fromSpace = space === 'rgb' ? (c) => c.map((v) => Math.round(v)) : (c) => oklabToRgb(c[0], c[1], c[2])
  const points = colors.map(toSpace)
  const total = counts.reduce((a, b) => a + b, 0)
  const dims = points[0].length

  // K-means++ 初始化（按频次加权），固定种子 → 可复现
  const random = mulberry32(seed)
  const distTo = (point, centre) => {
    let sum = 0
    for (let d = 0; d < dims; d++) sum += (point[d] - centre[d]) ** 2
    return sum
  }
  const centres = [points[0].slice()]
  while (centres.length < nColors) {
    const weights = new Float64Array(points.length)
    let sum = 0
    for (let i = 0; i < points.length; i++) {
      let best = Infinity
      for (const centre of centres) best = Math.min(best, distTo(points[i], centre))
      weights[i] = best * counts[i]
      sum += weights[i]
    }
    if (sum <= 0) break
    let target = random() * sum
    let picked = points.length - 1
    for (let i = 0; i < points.length; i++) {
      target -= weights[i]
      if (target <= 0) { picked = i; break }
    }
    centres.push(points[picked].slice())
  }

  // Lloyd 迭代
  const labels = new Int32Array(points.length)
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let moved = 0
    for (let i = 0; i < points.length; i++) {
      let best = 0
      let bestD = Infinity
      for (let k = 0; k < centres.length; k++) {
        const d = distTo(points[i], centres[k])
        if (d < bestD) { bestD = d; best = k }
      }
      if (labels[i] !== best) { labels[i] = best; moved += 1 }
    }
    const sums = centres.map(() => new Array(dims).fill(0))
    const weights = new Float64Array(centres.length)
    for (let i = 0; i < points.length; i++) {
      const k = labels[i]
      for (let d = 0; d < dims; d++) sums[k][d] += points[i][d] * counts[i]
      weights[k] += counts[i]
    }
    for (let k = 0; k < centres.length; k++) {
      if (weights[k] <= 0) continue
      for (let d = 0; d < dims; d++) centres[k][d] = sums[k][d] / weights[k]
    }
    if (moved === 0 && iteration > 0) break
  }

  const rgbCentres = centres.map(fromSpace)
  const keyToLabel = new Map()
  for (let i = 0; i < colors.length; i++) {
    keyToLabel.set((colors[i][0] << 16) | (colors[i][1] << 8) | colors[i][2], labels[i])
  }
  const out = new Uint8ClampedArray(pixels)
  for (let p = 0; p < out.length; p += 4) {
    if (out[p + 3] === 0) continue
    const key = (out[p] << 16) | (out[p + 1] << 8) | out[p + 2]
    const label = keyToLabel.get(key)
    if (label === undefined) continue
    const rgb = rgbCentres[label]
    out[p] = rgb[0]; out[p + 1] = rgb[1]; out[p + 2] = rgb[2]
  }
  return {
    pixels: out,
    changed: true,
    palette: rgbCentres.map((c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`),
    total,
  }
}

/* ============================================================================
 * 「真像素」判定与强制（PIXEL PURITY）
 *
 * 前面都在讲「怎么把伪像素图变成像像素的图」。这一节回答另一个问题：
 * **怎么确定结果真的是像素图，而不是"看起来像"？**
 *
 * 把定义写死，这件事才能被度量、被执行、被断言。「真像素」= 同时满足：
 *   ① 有限色板：不透明像素的颜色都恰好是调色板里的值（**没有中间色**）；
 *   ② 硬边：不存在抗锯齿混合色（一个像素如果"位于两个邻色之间"，它就是混合出来的）；
 *   ③ 方块均匀：要么是原生逻辑分辨率，要么是某个**整数倍**的最近邻放大
 *      （每一块内的像素完全相同）—— 非整数倍放大必然产生大小不一的"像素"；
 *   ④ alpha 二值：只有 0 和 255（真像素画没有半透明）。
 *
 * ①④ 由 pixelize 的构造保证；②③ 是真正容易破的地方 ——
 * 尤其 ③：**普通缩放（contain）会算出非整数倍**，于是每个"像素"占 2.13 个物理像素，
 * 大小不一，画面看着就"脏"。这是本节要堵的洞。
 * ========================================================================== */

/** 非透明内容的包围盒（居中留边时，均匀性只能在这个范围内看）。 */
function alphaBounds(pixels, width, height, alphaThreshold = 1) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] >= alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height, empty: true }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, empty: false }
}

/** 行内某区间是否**按 k 分块各块同色**（对齐区间左端）。k=1 恒真。 */
function rowBlocksUniform(pixels, width, y, x0, len, k) {
  if (k <= 1) return true
  if (len % k !== 0) return false
  for (let x = k; x < len; x++) {
    if (x % k === 0) continue
    const a = (y * width + x0 + x) * 4
    const b = (y * width + x0 + (x - (x % k))) * 4
    if (pixels[a] !== pixels[b] || pixels[a + 1] !== pixels[b + 1]
      || pixels[a + 2] !== pixels[b + 2] || pixels[a + 3] !== pixels[b + 3]) return false
  }
  return true
}

/** 列内某区间是否按 k 分块各块同色。 */
function colBlocksUniform(pixels, width, x, y0, len, k) {
  if (k <= 1) return true
  if (len % k !== 0) return false
  for (let y = k; y < len; y++) {
    if (y % k === 0) continue
    const a = ((y0 + y) * width + x) * 4
    const b = ((y0 + (y - (y % k))) * width + x) * 4
    if (pixels[a] !== pixels[b] || pixels[a + 1] !== pixels[b + 1]
      || pixels[a + 2] !== pixels[b + 2] || pixels[a + 3] !== pixels[b + 3]) return false
  }
  return true
}

/**
 * 盒内以 k 为边长的方块是否**每块内部完全同色**（方块对齐盒原点）。
 *
 * 注意这里是「分块同色」而不是「周期重复」：
 *   分块同色（对）：line = [c0,c0,c1,c1,c2,c2]，k=2 → x=2 比 x-0=0 处？不是。
 *     正确比法：x 与 x-(x%k)。x=2 → 比 x=0（c0 vs c1）→ 不同 ✓ 但这是**块首**，跳过；
 *     x=3 → 比 x=2（c1 vs c1）→ 相同 ✓；x=1 → 比 x=0（c0 vs c0）✓。
 *   周期重复（错）：x 与 x%k。x=2 会比 x=0 → c1 vs c0 → 误判成不周期。
 * 我第一版就是写成了"周期重复"，于是 2× 最近邻放大的图被判成"没有整数方块结构"。
 */
export function blocksUniform(pixels, width, height, k, box = null) {
  if (k <= 1) return true
  const bx = box?.x ?? 0
  const by = box?.y ?? 0
  const bw = box?.w ?? width
  const bh = box?.h ?? height
  if (bw % k !== 0 || bh % k !== 0) return false
  for (let y = by; y < by + bh; y++) {
    if (!rowBlocksUniform(pixels, width, y, bx, bw, k)) return false
  }
  for (let x = bx; x < bx + bw; x++) {
    if (!colBlocksUniform(pixels, width, x, by, bh, k)) return false
  }
  return true
}

/**
 * 盒内**最大**的方块边长 k（≤ maxScale、且能整除盒宽高）使每块内部同色。
 * 至少返回 1（"原生分辨率 / 看不出放大"）。
 *
 * 与 `blocksUniform` 的分工：这个用来**推断**实际像素边长（报告用），
 * 验收则应该用 `blocksUniform(k)` 直接验证**期望**的那个倍率 ——
 * 因为"能整除"是不够的：期望 2× 时方块边长 1 也能整除 2，但那说明根本没放大。
 */
export function uniformBlockSize(pixels, width, height, maxScale = 64, box = null) {
  const bw = box?.w ?? width
  const bh = box?.h ?? height
  // 上限是 min/2：k 等于整个盒子宽时"只有一块"，恒真但毫无意义（等于说整图是 1 个像素）。
  // 第一版没排除它，于是原生 32×32 的像素画被报成"方块边长 32"。
  const lim = Math.min(maxScale, Math.floor(bw / 2), Math.floor(bh / 2))
  let best = 1
  for (let k = 2; k <= lim; k++) {
    if (bw % k !== 0 || bh % k !== 0) continue
    if (blocksUniform(pixels, width, height, k, box)) best = k
  }
  return best
}

/**
 * 数出「抗锯齿混合色」像素。
 *
 * 判据（比复用 AA 消除更直接、也更灵敏）：一个像素 p 如果**夹在左右（或上下）
 * 两个不同的邻色之间**、且与两者都不同，那它就是混合出来的中间色。
 * 硬边长这样：`[A, A, B, B]` —— 任何位置 p 都等于某一侧，所以数出来是 0。
 * 抗锯齿长这样：`[A, (A+B)/2, B]` —— 中间那个像素被数出来。
 *
 * 为什么不用 removeAntiAliasing 的 touched：它带一个 `d(a,b) > 0.5` 的门槛，
 * 只管"两主色差别很大"的情况；而真实的抗锯齿恰恰常出现在**相近色**之间
 * （阴影过渡、描边内侧），那种情况它会漏掉（实测：合成图里 AA 一个都没数出来）。
 */
/**
 * AA 判据的两个参数与阈值，都是**实测校准**出来的（scripts/calibrate-aa.mjs）：
 *
 * | 输入 | tol .02/minEnd .3 下的混合色比例 |
 * |---|---|
 * | 12 色像素画·原生 64×64 | 0.83% |
 * | 12 色像素画·4× 最近邻 | **0.00%** |
 * | 12 色像素画·4× + 1px 抗锯齿 | **12.82%** ← 要抓的就是它 |
 * | 随机噪点 | 1.68% |
 *
 * 阈值取 2%：真像素画 0.83% 有 2.4 倍余量，抗锯齿 12.8% 超阈 6.4 倍。
 * 注意噪点是 1.68%（因为随机三元色偶尔真的共线），所以**光靠这一项抓不住噪点** ——
 * 噪点要靠色板纪律（颜色数）来抓，两者互补，不是替代关系。
 */
const AA_TOLERANCE = 0.02
const AA_MIN_END = 0.3
const AA_RATIO_LIMIT = 0.02

function countBlendPixels(pixels, width, height, tolerance = AA_TOLERANCE, minEnd = AA_MIN_END) {
  const okAt = (x, y) => {
    const i = (y * width + x) * 4
    return rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2])
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const between = (p, a, b) => {
    const dAB = dist(a, b)
    if (dAB < 1e-4) return false // 两侧同色 → 这里没有边
    const dPA = dist(p, a)
    const dPB = dist(p, b)
    if (dPA < 1e-4 || dPB < 1e-4) return false // p 就是某一侧的颜色 → 硬边
    return Math.abs(dPA + dPB - dAB) / dAB < tolerance
  }
  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] === 0) continue
      const p = rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2])
      if (x > 0 && x < width - 1 && between(p, okAt(x - 1, y), okAt(x + 1, y))) { count += 1; continue }
      if (y > 0 && y < height - 1 && between(p, okAt(x, y - 1), okAt(x, y + 1))) { count += 1 }
    }
  }
  return count
}

/** `#rrggbb` → [r,g,b]；解不出返回 null。 */
function hexToRgb(hex) {
  const h = String(hex ?? '').replace('#', '').trim()
  if (!/^[0-9a-f]{6}$/i.test(h)) return null
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * 判定一张图是不是「真像素」。
 *
 * @param {object} params
 * @param {Uint8ClampedArray} params.pixels RGBA
 * @param {number} [params.paletteLimit] 允许的最大颜色数（0 = 不限）
 * @param {string[]} [params.palette] 声明的调色板（给了就要求每个像素**恰好**是其中之一）
 * @param {number} [params.logicalWidth] / [params.logicalHeight] 已知的逻辑分辨率 → 要求整数倍
 * @param {boolean} [params.allowSoftAlpha] 允许半透明（特效类素材）
 * @param {boolean} [params.checkAA] 是否跑抗锯齿检测（默认 true；大图可关掉换速度）
 * @returns {{pure:boolean, score:number, reasons:string[], block:object, colors:object, aa:object, alpha:object, verdict:string}}
 */
export function pixelPurity({
  pixels, width, height,
  palette = null, paletteLimit = 0,
  logicalWidth = 0, logicalHeight = 0,
  expectBlock = 0,
  allowSoftAlpha = false, checkAA = true, maxScale = 64,
} = {}) {
  const reasons = []
  const total = width * height

  // ---- ① 色板 ----
  const { colors } = uniqueColors(pixels)
  const targets = Array.isArray(palette) ? palette.map(hexToRgb).filter(Boolean) : []
  let outside = 0
  let opaque = 0
  for (let p = 0; p < pixels.length; p += 4) {
    if (pixels[p + 3] === 0) continue
    opaque += 1
    if (targets.length === 0) continue
    let hit = false
    for (const t of targets) {
      if (t[0] === pixels[p] && t[1] === pixels[p + 1] && t[2] === pixels[p + 2]) { hit = true; break }
    }
    if (!hit) outside += 1
  }
  const outsideRatio = opaque > 0 ? outside / opaque : 0
  const limit = Number(paletteLimit) || targets.length || 0
  if (targets.length > 0 && outside > 0) reasons.push(`${outside} 个像素（${(outsideRatio * 100).toFixed(1)}%）不在声明的调色板里 —— 有中间色，不是硬边`)
  if (limit > 0 && colors.length > limit) reasons.push(`颜色数 ${colors.length} 超过上限 ${limit}`)

  // ---- ③ 方块均匀（整数倍） ----
  // 在**内容框**里判定：居中留的透明边会破坏整行的对齐，但内容本身是干净的。
  const box = alphaBounds(pixels, width, height)
  const block = uniformBlockSize(pixels, width, height, maxScale, box)
  let blockOk = true
  let expectScale = 0
  if (logicalWidth > 0 && logicalHeight > 0) {
    const sx = box.w / logicalWidth
    const sy = box.h / logicalHeight
    expectScale = sx
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || sx !== sy) {
      blockOk = false
      reasons.push(`内容 ${box.w}×${box.h} 不是逻辑分辨率 ${logicalWidth}×${logicalHeight} 的整数倍（实际 ${sx.toFixed(3)}×／${sy.toFixed(3)}×）—— 每个"像素"占的物理像素大小不一`)
    } else if (!blocksUniform(pixels, width, height, sx, box)) {
      // 直接验证**期望的那个倍率**：期望 2× 就得每个 2×2 块完全同色。
      // 不能用"block 能整除 sx"来代替 —— 边长 1 也整除 2，但那是根本没放大。
      blockOk = false
      reasons.push(`期望每个逻辑像素占 ${sx}×${sx} 个物理像素，但方块大小不一致 —— 做过非最近邻缩放（插值）`)
    }
  } else if (expectBlock > 1) {
    if (!blocksUniform(pixels, width, height, expectBlock, box)) {
      blockOk = false
      reasons.push(`期望 ${expectBlock}× 整数倍放大，但方块大小不一致（像素不等大）`)
    }
  }
  // 未声明逻辑分辨率、也没给期望倍率时不判几何 —— 原生分辨率的真像素画
  // 本来就看不出"倍率"，它的纯度靠"无抗锯齿 + 有限色板 + alpha 二值"保证。

  // ---- ④ alpha 二值 ----
  let partial = 0
  for (let p = 3; p < pixels.length; p += 4) {
    const a = pixels[p]
    if (a !== 0 && a !== 255) partial += 1
  }
  const alphaOk = allowSoftAlpha || partial === 0
  if (!allowSoftAlpha && partial > 0) reasons.push(`${partial} 个像素是半透明（alpha 既不是 0 也不是 255）`)

  // ---- ② 硬边：抗锯齿混合色 ----
  let aaPixels = 0
  if (checkAA) {
    try {
      aaPixels = countBlendPixels(pixels, width, height)
    } catch { aaPixels = 0 }
  }
  const aaRatio = total > 0 ? aaPixels / total : 0
  const aaOk = !checkAA || aaRatio <= AA_RATIO_LIMIT
  if (!aaOk) reasons.push(`${aaPixels} 个像素（${(aaRatio * 100).toFixed(2)}%）是抗锯齿混合色 —— 边缘不够硬`)

  const pure = reasons.length === 0
  // 分数：四项各占一份，AA 与色板按比例递减（便于排序"哪张更像真像素"）
  const colorScore = targets.length > 0 ? 1 - outsideRatio : (limit > 0 ? Math.min(1, limit / Math.max(1, colors.length)) : 1)
  const aaScore = checkAA ? Math.max(0, 1 - aaRatio / (AA_RATIO_LIMIT * 4)) : 1
  const blockScore = blockOk ? 1 : (block > 0 ? 0.5 : 0)
  const alphaScore = allowSoftAlpha ? 1 : Math.max(0, 1 - partial / Math.max(1, total) / 0.1)
  const score = Math.max(0, Math.min(1, (colorScore + aaScore + blockScore + alphaScore) / 4))

  const verdict = pure
    ? `真像素（${colors.length} 色${block > 1 ? `，${block}× 整数倍放大` : '，原生分辨率'}）`
    : `不是真像素：${reasons[0]}`

  return {
    pure,
    score: Number(score.toFixed(4)),
    reasons,
    verdict,
    block: { size: block, scale: expectScale || null, ok: blockOk },
    colors: { count: colors.length, limit, outside, outsideRatio: Number(outsideRatio.toFixed(4)), palette: targets.length },
    aa: { pixels: aaPixels, ratio: Number(aaRatio.toFixed(5)), ok: aaOk, checked: checkAA },
    alpha: { partial, ok: alphaOk },
  }
}

/**
 * 把一张图**强制修成真像素**。
 *
 * 能修的修，修不了的说清（不假装成功）：
 *   ① 色板 → 精确吸附到调色板（strength=1，不留中间色）
 *   ② alpha → 按阈值二值化
 *   ③ 几何 → 尺寸不是逻辑分辨率的整数倍时：先按块采样回逻辑分辨率，再用**整数倍**
 *      最近邻放大回原尺寸（居中，余量透明）。这是"非整数像素"的唯一根治办法。
 *
 * @returns {{pixels, width, height, applied:string[], purity:object, repaired:boolean}}
 */
export function enforcePixelPurity({
  pixels, width, height,
  palette = null, paletteLimit = 0,
  logicalWidth = 0, logicalHeight = 0,
  allowSoftAlpha = false, alphaThreshold = 128,
  method = 'median', coreRatio = 0.6,
} = {}) {
  let out = new Uint8ClampedArray(pixels)
  let w = width
  let h = height
  const applied = []

  // ① 色板：先用 K-means 求调色板（若没给），再**精确**吸附
  let targets = Array.isArray(palette) ? palette.map(hexToRgb).filter(Boolean) : []
  if (targets.length === 0 && Number(paletteLimit) > 0) {
    const quantized = quantizePalette(out, { nColors: Number(paletteLimit), space: 'oklab' })
    out = quantized.pixels
    targets = (quantized.palette ?? []).map(hexToRgb).filter(Boolean)
    applied.push(`调色板量化 → ${targets.length} 色`)
  }
  if (targets.length > 0) {
    const before = out
    for (let p = 0; p < out.length; p += 4) {
      if (out[p + 3] === 0) continue
      let best = targets[0]
      let bestD = Infinity
      for (const t of targets) {
        const d = (out[p] - t[0]) ** 2 + (out[p + 1] - t[1]) ** 2 + (out[p + 2] - t[2]) ** 2
        if (d < bestD) { bestD = d; best = t }
      }
      out[p] = best[0]; out[p + 1] = best[1]; out[p + 2] = best[2]
    }
    if (before !== out) applied.push(`精确吸附到 ${targets.length} 色调色板（不留中间色）`)
  }

  // ② alpha 二值化
  if (!allowSoftAlpha) {
    let changed = 0
    for (let p = 3; p < out.length; p += 4) {
      const a = out[p]
      const next = a >= alphaThreshold ? 255 : 0
      if (next !== a) { out[p] = next; changed += 1 }
    }
    if (changed > 0) applied.push(`alpha 二值化（改了 ${changed} 个像素）`)
  }

  // ③ 几何：非整数倍就重做成整数倍
  if (logicalWidth > 0 && logicalHeight > 0) {
    const sx = w / logicalWidth
    const sy = h / logicalHeight
    const integerNow = Number.isInteger(sx) && Number.isInteger(sy) && sx === sy
    const bx0 = alphaBounds(out, w, h)
    const cleanNow = integerNow && blocksUniform(out, w, h, sx, bx0)
    if (!cleanNow) {
      // 先回逻辑分辨率（按块取代表色，避开被插值糊掉的边缘）
      const grid = {
        px: sx, py: sy, phaseX: 0, phaseY: 0,
        wLogic: logicalWidth, hLogic: logicalHeight, source: 'enforce',
      }
      const extracted = extractBlocks(out, w, h, grid, { method, coreRatio, alphaThreshold, softAlpha: allowSoftAlpha })
      // 再用整数倍放大回去：取能放下的最大整数倍，居中，余量透明
      const k = Math.max(1, Math.floor(Math.min(sx, sy)))
      if (k > 1) {
        const up = nearestUpscale(extracted.pixels, extracted.width, extracted.height, extracted.width * k, extracted.height * k)
        const canvas = new Uint8ClampedArray(w * h * 4)
        const offX = Math.floor((w - up.width) / 2)
        const offY = Math.floor((h - up.height) / 2)
        for (let y = 0; y < up.height; y++) {
          for (let x = 0; x < up.width; x++) {
            const dx = offX + x
            const dy = offY + y
            if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue
            const src = (y * up.width + x) * 4
            const dst = (dy * w + dx) * 4
            for (let c = 0; c < 4; c++) canvas[dst + c] = up.pixels[src + c]
          }
        }
        out = canvas
        applied.push(`几何重建为 ${k}× 整数倍最近邻（${logicalWidth}×${logicalHeight} 逻辑像素，居中留透明边）`)
      } else {
        out = extracted.pixels
        w = extracted.width
        h = extracted.height
        applied.push(`几何重建为逻辑分辨率 ${w}×${h}（原尺寸放不下整数倍，直接给逻辑图）`)
      }
    }
  }

  const purity = pixelPurity({
    pixels: out, width: w, height: h,
    palette: targets.length ? targets.map((t) => `#${t.map((v) => v.toString(16).padStart(2, '0')).join('')}`) : palette,
    paletteLimit, logicalWidth, logicalHeight, allowSoftAlpha,
  })
  return { pixels: out, width: w, height: h, applied, purity, repaired: applied.length > 0 }
}

/* ============================================================================
 * 编排
 * ========================================================================== */

export const PIXELIZE_DEFAULTS = {
  minPeriod: 3,
  maxPeriod: 64,
  coreRatio: 0.6,
  method: 'median',     // median | mean | mode | kmeans | dominant
  palette: 0,           // 0 = 不量化；>0 时在逻辑分辨率上做 OKLab K-means
  paletteSpace: 'oklab',
  alphaThreshold: 128,
  softAlpha: false,
  aaPasses: 0,          // 0 = 不做 AA 消除（与上游默认一致：AA 消除默认关闭）
  denoise: 0,           // 0 = 不降噪；1 = 3×3 中值（**不是**上游的 nl_means，见文件头）
  logicalWidth: 0,      // >0 时直接用这个逻辑宽度（最可靠）
  logicalHeight: 0,
  minContrast: 1.15,
  runsTolerance: 12,
  sampleStride: 4,
  // 输出：'logical' 保持逻辑分辨率；'origin' 最近邻放回原尺寸；'both' 两个都出
  output: 'logical',
  maxPixels: 4096 * 4096, // 安全上限，超大图不硬刚
}

/** 3×3 中值（上游用 skimage 的 nl_means/TV/bilateral，这里明确换成中值 —— 不是等价物）。 */
export function medianDenoise(pixels, width, height) {
  const out = new Uint8ClampedArray(pixels)
  const at = (x, y) => (y * width + x) * 4
  const window = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y)
      for (let c = 0; c < 3; c++) {
        window.length = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(0, Math.min(width - 1, x + dx))
            const ny = Math.max(0, Math.min(height - 1, y + dy))
            window.push(pixels[at(nx, ny) + c])
          }
        }
        window.sort((a, b) => a - b)
        out[i + c] = window[4]
      }
    }
  }
  return out
}

/** 最近邻放大（像素艺术必须用最近邻，双线性会把硬边糊掉）。 */
export function nearestUpscale(pixels, width, height, targetWidth, targetHeight) {
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / targetHeight))
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / targetWidth))
      const src = (sy * width + sx) * 4
      const dst = (y * targetWidth + x) * 4
      out[dst] = pixels[src]; out[dst + 1] = pixels[src + 1]
      out[dst + 2] = pixels[src + 2]; out[dst + 3] = pixels[src + 3]
    }
  }
  return { pixels: out, width: targetWidth, height: targetHeight }
}

/**
 * 主入口：把一张（已经很可能是伪像素的）RGBA 图净化成真像素图。
 *
 * **不会**在没检测到网格时硬做 —— 那时返回 ok:false 并说明原因，调用方保留原图。
 * 这一点很重要：把一张正常的插画当像素图去块采样，等于把它毁掉。
 *
 * @returns {{ok:boolean, pixels?:Uint8ClampedArray, width?:number, height?:number,
 *            logical?:{width:number,height:number}, grid?:object, stats?:object,
 *            applied?:string[], reason?:string}}
 */
export function pixelize({ pixels, width, height, options = {} }) {
  const opts = { ...PIXELIZE_DEFAULTS, ...options }
  const applied = []
  const started = Date.now()

  // 只给了逻辑宽（或只给了高）就按原图宽高比补另一个 —— 调用方不用自己算。
  if (opts.logicalWidth > 0 && !(opts.logicalHeight > 0) && width > 0 && height > 0) {
    opts.logicalHeight = Math.max(1, Math.round((height / width) * opts.logicalWidth))
  } else if (opts.logicalHeight > 0 && !(opts.logicalWidth > 0) && width > 0 && height > 0) {
    opts.logicalWidth = Math.max(1, Math.round((width / height) * opts.logicalHeight))
  }

  if (width * height > opts.maxPixels) {
    return { ok: false, reason: `图太大（${width}×${height} > ${opts.maxPixels} 像素上限）；先缩小再像素化，或调大 maxPixels` }
  }

  let work = new Uint8ClampedArray(pixels)
  let w = width
  let h = height

  if (opts.aaPasses > 0) {
    const cleaned = removeAntiAliasing(work, w, h, { passes: opts.aaPasses })
    work = cleaned.pixels
    applied.push(`AA 消除 ×${opts.aaPasses}（吸附了 ${cleaned.touched} 个混合色像素）`)
  }
  if (opts.denoise > 0) {
    work = medianDenoise(work, w, h)
    applied.push('3×3 中值降噪（注意：不是上游的 nl_means/TV/bilateral，只是轻降噪）')
  }

  const gray = toGray(work, w, h)
  const edge = computeEdgeMap(gray, w, h)
  const grid = detectGrid(work, w, h, { ...opts, gray, edge })
  if (!grid.ok) return { ok: false, reason: grid.reason, grid, applied }

  const extracted = extractBlocks(work, w, h, grid, opts)
  applied.push(`块提取（${opts.method}，核心区 ${(opts.coreRatio * 100).toFixed(0)}%，块 ${grid.px}×${grid.py}px）→ 逻辑分辨率 ${extracted.width}×${extracted.height}`)

  let logicalPixels = extracted.pixels
  let palette = []
  if (opts.palette > 0) {
    const quantized = quantizePalette(logicalPixels, { nColors: opts.palette, space: opts.paletteSpace })
    logicalPixels = quantized.pixels
    palette = quantized.palette ?? []
    applied.push(quantized.changed
      ? `调色板精炼 → ${palette.length} 色（${opts.paletteSpace} 空间 K-means）`
      : `只有 ${palette.length} 种颜色 ≤ 目标 ${opts.palette} 色，不需要量化`)
  }

  const logical = { width: extracted.width, height: extracted.height }
  const stats = {
    block: { px: grid.px, py: grid.py },
    phase: { x: grid.phaseX, y: grid.phaseY },
    source: grid.source,
    contrast: { x: Number(grid.contrastX?.toFixed(3)), y: Number(grid.contrastY?.toFixed(3)) },
    logical,
    colors: palette.length || uniqueColors(logicalPixels).colors.length,
    palette,
    ratio: `${(width / logical.width).toFixed(2)}×`,
    ms: Date.now() - started,
    note: grid.note,
  }

  if (opts.output === 'origin' || opts.output === 'both') {
    const back = nearestUpscale(logicalPixels, extracted.width, extracted.height, width, height)
    applied.push(`最近邻放回原尺寸 ${width}×${height}`)
    if (opts.output === 'both') {
      return { ok: true, pixels: logicalPixels, width: extracted.width, height: extracted.height, logical, grid, stats, applied, also: back }
    }
    return { ok: true, pixels: back.pixels, width: back.width, height: back.height, logical, grid, stats, applied }
  }

  return { ok: true, pixels: logicalPixels, width: extracted.width, height: extracted.height, logical, grid, stats, applied }
}

/** PNG 版：解码 → 净化 → 编码。`write` 由调用方决定（这里不碰磁盘）。 */
export function pixelizePng({ buffer, options = {} }) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开（只支持 8bit 非隔行 PNG）' }
  const result = pixelize({
    pixels: decoded.pixels,
    width: decoded.width,
    height: decoded.height,
    options,
  })
  if (!result.ok) return { ok: false, error: result.reason, grid: result.grid, applied: result.applied }
  const encode = (pixels, w, h) => encodePngRgba(w, h, pixels)
  const output = { ...result, buffer: encode(result.pixels, result.width, result.height) }
  if (result.also) {
    output.also = { ...result.also, buffer: encode(result.also.pixels, result.also.width, result.also.height) }
  }
  return output
}
