/**
 * 锚点图准备 + 循环点检测
 *
 * 两个都是从"图 → 视频 → 抽帧"这条实测流程里抽出来的通用步骤：
 *
 * ① **anchor**：从一张素材表里裁出**一个**单位，居中放到视频模型的输入尺寸上。
 *    为什么要工具化：手工裁容易带上旁边那个变体、尺寸不对、背景不一致 ——
 *    而 i2v 的首帧一旦混进别的东西，整段视频都会歪。
 *
 * ② **loopPoint**：从连续帧里找"和第一帧最像"的那一帧当结尾。
 *    视频模型给的是一段连续运动，直接取前 N 帧播起来会"顿一下"；
 *    自动找到一轮周期，循环就顺了。
 */
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { findComponents } from './autotrim.js'

/* ============================================================================
 * 一、锚点图
 * ========================================================================== */

/** 取角落颜色当"背景色"（素材表通常是平涂底）。 */
function cornerColor(pixels, width, height) {
  const at = (x, y) => {
    const i = (y * width + x) * 4
    return [pixels[i], pixels[i + 1], pixels[i + 2]]
  }
  const samples = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  // 取出现最多的那个（四个角一般同色；不同色时取第一个够用）
  const counts = new Map()
  for (const s of samples) {
    const key = s.join(',')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return best[0].split(',').map(Number)
}

/**
 * 从素材表里裁出一个单位，做成视频模型的首帧。
 *
 * @param {object} params
 * @param {Buffer} params.buffer 素材表 PNG（本身可以已经有透明底，也可以是平涂底）
 * @param {number} [params.targetWidth] 输出宽（默认 608，对应 minimax 快档）
 * @param {number} [params.targetHeight] 输出高（默认 352）
 * @param {number} [params.index] 选第几个单位（按"从上到下、从左到右"，默认 0）
 * @param {number} [params.fillRatio] 单位高度占画布比例（默认 0.92）
 * @param {number[]} [params.background] 背景色；默认取原图角落色
 * @param {number} [params.bgTolerance] 判前景的颜色容差（默认 60）
 * @param {boolean} [params.keepOriginalScale] true=不缩放单位（原尺寸贴进去）
 * @returns {{ok:boolean, buffer?:Buffer, width?:number, height?:number, units?:number, picked?:object, error?:string}}
 */
export function anchorFromSheet({
  buffer, targetWidth = 608, targetHeight = 352, index = 0,
  fillRatio = 0.92, background = null, bgTolerance = 60, keepOriginalScale = false,
} = {}) {
  const png = decodePngRgba(buffer)
  if (!png) return { ok: false, error: '解不开素材表（只支持 8bit PNG）' }
  const { pixels, width, height } = png
  const bg = Array.isArray(background) ? background : cornerColor(pixels, width, height)
  const isFg = (i) => Math.abs(pixels[i] - bg[0]) + Math.abs(pixels[i + 1] - bg[1]) + Math.abs(pixels[i + 2] - bg[2]) > bgTolerance

  // 已经带 alpha 的图：直接用 alpha 判前景（比颜色更准）
  let hasAlpha = false
  for (let i = 3; i < pixels.length; i += 4 * 97) { if (pixels[i] < 250) { hasAlpha = true; break } }

  const mask = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const si = i * 4
    const fg = hasAlpha ? pixels[si + 3] > 32 : isFg(si)
    mask[si] = pixels[si]; mask[si + 1] = pixels[si + 1]; mask[si + 2] = pixels[si + 2]
    mask[si + 3] = fg ? 255 : 0
  }
  // 只保留像"一个单位"的连通块（过滤噪点和细线）
  const minArea = Math.max(200, Math.round(width * height * 0.0004))
  const comps = findComponents(mask, width, height, { alphaThreshold: 128, maxComponents: 200 })
    .filter((c) => c.count >= minArea)
    .sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX))
  if (comps.length === 0) return { ok: false, error: '素材表里没找到任何单位（全是背景？）' }

  const pick = comps[Math.min(comps.length - 1, Math.max(0, Number(index) || 0))]
  const cw = pick.maxX - pick.minX + 1
  const ch = pick.maxY - pick.minY + 1

  const W = Math.max(16, Math.round(targetWidth))
  const H = Math.max(16, Math.round(targetHeight))
  const out = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255
  }
  const scale = keepOriginalScale ? 1 : Math.min((H * fillRatio) / ch, (W * fillRatio) / cw)
  const dw = Math.max(1, Math.round(cw * scale))
  const dh = Math.max(1, Math.round(ch * scale))
  const dx = Math.floor((W - dw) / 2)
  const dy = Math.floor((H - dh) / 2)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(cw - 1, Math.floor(x / scale))
      const sy = Math.min(ch - 1, Math.floor(y / scale))
      const si = ((pick.minY + sy) * width + (pick.minX + sx)) * 4
      const fg = hasAlpha ? pixels[si + 3] > 32 : isFg(si)
      if (!fg) continue
      const di = ((dy + y) * W + (dx + x)) * 4
      out[di] = pixels[si]; out[di + 1] = pixels[si + 1]; out[di + 2] = pixels[si + 2]; out[di + 3] = 255
    }
  }

  return {
    ok: true,
    buffer: encodePngRgba(W, H, out),
    width: W, height: H,
    units: comps.length,
    picked: { index: Number(index) || 0, source: [pick.minX, pick.minY, cw, ch], placed: [dx, dy, dw, dh], scale: Number(scale.toFixed(3)) },
    background: bg,
    note: `从 ${width}×${height} 里裁出第 ${(Number(index) || 0) + 1}/${comps.length} 个单位（${cw}×${ch}），`
      + `缩放 ${scale.toFixed(2)}× 居中放到 ${W}×${H}，背景色 rgb(${bg.join(',')})`,
  }
}

/* ============================================================================
 * 二、循环点检测
 * ========================================================================== */

/** 把一帧缩成很小的灰度指纹，用于快速比较。 */
function fingerprint(png, size = 16) {
  const { pixels, width, height } = png
  const cells = new Float64Array(size * size)
  const counts = new Float64Array(size * size)
  for (let y = 0; y < height; y++) {
    const cy = Math.min(size - 1, Math.floor((y / height) * size))
    for (let x = 0; x < width; x++) {
      const cx = Math.min(size - 1, Math.floor((x / width) * size))
      const i = (y * width + x) * 4
      const a = pixels[i + 3] / 255
      const lum = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) * a
      cells[cy * size + cx] += lum
      counts[cy * size + cx] += 1
    }
  }
  for (let i = 0; i < cells.length; i++) cells[i] = counts[i] > 0 ? cells[i] / counts[i] : 0
  return cells
}

function fingerprintDistance(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/**
 * 在连续帧里找"和首帧最像"的那一帧 → 用它当循环的最后一帧。
 *
 * 为什么要它：视频模型给的是一段连续运动，直接取前 N 帧播起来会"顿一下"
 * （最后一帧的姿势接不回第一帧）。自动找一轮周期，循环就顺了。
 *
 * @param {object} params
 * @param {Buffer[]} params.frames 已抠底的帧
 * @param {number} [params.minFrames] 最短循环长度（默认 4）
 * @param {number} [params.maxFrames] 最长循环长度（默认全部）
 * @returns {{ok:boolean, endIndex:number, length:number, distance:number, candidates:Array, error?:string}}
 */
export function findLoopPoint({ frames = [], minFrames = 4, maxFrames = null, fingerprintSize = 16 } = {}) {
  const decoded = []
  for (const buffer of frames) {
    const png = decodePngRgba(buffer)
    if (!png) return { ok: false, error: '帧解不开' }
    decoded.push(png)
  }
  if (decoded.length < 2) return { ok: false, error: '帧太少，没法找循环点' }
  const first = fingerprint(decoded[0], fingerprintSize)
  const limit = Math.min(decoded.length - 1, Number(maxFrames) || decoded.length - 1)
  const min = Math.max(1, Number(minFrames) || 4)
  const scored = []
  for (let i = min; i <= limit; i++) {
    scored.push({ index: i, distance: fingerprintDistance(first, fingerprint(decoded[i], fingerprintSize)) })
  }
  if (scored.length === 0) return { ok: false, error: `帧数不够（需要至少 ${min + 1} 帧才能找循环）` }
  scored.sort((a, b) => a.distance - b.distance)
  /* 选距离最小的那个当结尾。注意：**不选"最近但太短"的** —— minFrames 已经挡掉了；
   * 同分时取更长的那个（周期更长 = 动作更完整）。 */
  const best = scored[0]
  const candidates = scored.slice(0, 6).map((s) => ({ index: s.index, distance: Number(s.distance.toFixed(3)), length: s.index }))
  return {
    ok: true,
    endIndex: best.index,           // frames[0..endIndex-1] 就是一轮（不含重复的结尾帧）
    length: best.index,
    distance: Number(best.distance.toFixed(3)),
    candidates,
    coverage: Number((best.index / Math.max(1, decoded.length - 1)).toFixed(2)),
    note: `第 1 帧最像第 ${best.index + 1} 帧（差异 ${best.distance.toFixed(2)}），所以循环长度取 ${best.index} 帧`,
  }
}
