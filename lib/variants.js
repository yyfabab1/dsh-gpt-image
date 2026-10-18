/**
 * C 组 · 一次审核 → 多份产出。
 *
 *   C1 自动派生变体：一张母图 → 翻转 / 阵营染色 / 受损态 / 高亮态 / 灰度
 *      **继承源图审核结论**（人审 1 张 = N 份产出）—— 与切片继承共用同一套 inherit 逻辑
 *   C2 自动图集打包：approved 素材自动打进图集 + 出 manifest，引擎直接吃
 *
 * 全部是确定性的像素操作（不需要视觉模型），所以可测、可复现。
 * 变体之间"严格一致"靠的是：都从**同一张已归一化的母图**派生（先过 A1 管线再派生）。
 */
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { fitToTarget } from './autotrim.js'

/** 支持的变体类型。 */
export const VARIANT_KINDS = ['flipH', 'flipV', 'gray', 'tint', 'damaged', 'highlight']

export const VARIANT_LABELS = {
  flipH: '水平翻转',
  flipV: '垂直翻转',
  gray: '灰度版',
  tint: '阵营染色',
  damaged: '受损态',
  highlight: '高亮态',
}

/** 从 hex 解析 RGB。 */
function rgb(hex) {
  const h = String(hex ?? '').replace('#', '')
  if (h.length !== 6) return [255, 255, 255]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** C1 · 水平/垂直翻转。 */
export function flip({ pixels, width, height, axis = 'h' }) {
  const out = new Uint8ClampedArray(pixels.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = axis === 'h' ? width - 1 - x : x
      const sy = axis === 'v' ? height - 1 - y : y
      const from = (sy * width + sx) * 4
      const to = (y * width + x) * 4
      out[to] = pixels[from]
      out[to + 1] = pixels[from + 1]
      out[to + 2] = pixels[from + 2]
      out[to + 3] = pixels[from + 3]
    }
  }
  return out
}

/** C1 · 灰度（保留 alpha 与亮度层次）。 */
export function grayscale({ pixels, amount = 1 }) {
  const out = new Uint8ClampedArray(pixels)
  const k = Math.max(0, Math.min(1, amount))
  for (let i = 0; i < out.length; i += 4) {
    const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]
    out[i] = out[i] + (lum - out[i]) * k
    out[i + 1] = out[i + 1] + (lum - out[i + 1]) * k
    out[i + 2] = out[i + 2] + (lum - out[i + 2]) * k
  }
  return out
}

/**
 * C1 · 阵营染色：**只在保留明暗结构的前提下换色相**，不是简单叠加。
 * 做法：算原图亮度，用目标色按亮度重新上色（暗处更暗、亮处更亮），
 * 这样金属/布料的明暗关系还在，只是整体色相换了 → 不同阵营一眼能分辨又同源。
 */
export function tint({ pixels, width, height, color = '#4a9eff', strength = 0.75, alphaFloor = 16 }) {
  const [tr, tg, tb] = rgb(color)
  const out = new Uint8ClampedArray(pixels)
  const k = Math.max(0, Math.min(1, strength))
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < alphaFloor) continue
    // 原亮度（0..1），保留它作为明暗结构
    const lum = (0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]) / 255
    // 用目标色 * 亮度重建，再和原色按 strength 混合
    const nr = tr * lum
    const ng = tg * lum
    const nb = tb * lum
    out[i] = out[i] + (nr - out[i]) * k
    out[i + 1] = out[i + 1] + (ng - out[i + 1]) * k
    out[i + 2] = out[i + 2] + (nb - out[i + 2]) * k
  }
  return out
}

/**
 * C1 · 受损态：压暗 + 降饱和 + 叠一层确定性噪点（用坐标做种子，保证同图同结果）。
 * 为什么不用随机：确定性才能"重跑得到同一张"，也才能测。
 */
export function damaged({ pixels, width, height, amount = 0.45, noise = 0.12, seed = 7, alphaFloor = 16 }) {
  const out = new Uint8ClampedArray(pixels)
  const k = Math.max(0, Math.min(1, amount))
  let state = (seed * 2654435761) >>> 0
  const next = () => {
    // xorshift32：快、确定、够用
    state ^= state << 13; state >>>= 0
    state ^= state >> 17
    state ^= state << 5; state >>>= 0
    return state / 4294967296
  }
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < alphaFloor) continue
    // 先降饱和
    const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]
    out[i] = out[i] + (lum - out[i]) * k * 0.7
    out[i + 1] = out[i + 1] + (lum - out[i + 1]) * k * 0.7
    out[i + 2] = out[i + 2] + (lum - out[i + 2]) * k * 0.7
    // 再压暗
    const dark = 1 - k * 0.45
    out[i] *= dark
    out[i + 1] *= dark
    out[i + 2] *= dark
    // 噪点（确定性）
    const n = (next() - 0.5) * 2 * noise * 255
    out[i] = Math.max(0, Math.min(255, out[i] + n))
    out[i + 1] = Math.max(0, Math.min(255, out[i + 1] + n))
    out[i + 2] = Math.max(0, Math.min(255, out[i + 2] + n))
  }
  return out
}

/**
 * C1 · 高亮态：提亮 + 轻微增饱和，用于"选中/悬浮"。
 * 只在 alpha 够实的地方做，避免把半透明边缘也提亮显得发虚。
 */
export function highlight({ pixels, width, height, amount = 0.35, alphaFloor = 40 }) {
  const out = new Uint8ClampedArray(pixels)
  const k = Math.max(0, Math.min(1, amount))
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < alphaFloor) continue
    const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]
    // 往白色混一点（提亮），同时把偏离亮度的部分放大一点（增饱和）
    for (let c = 0; c < 3; c++) {
      const saturated = lum + (out[i + c] - lum) * (1 + k * 0.3)
      const brightened = saturated + (255 - saturated) * k
      out[i + c] = Math.max(0, Math.min(255, brightened))
    }
  }
  return out
}

/**
 * C1 主入口：从一张母图生成指定变体。
 * @param {{buffer:Buffer, kinds?:string[], color?:string, targetWidth?:number, targetHeight?:number}} params
 * @returns {{ok:boolean, variants:Array<{kind,label,buffer,width,height}>, error?:string}}
 */
export function deriveVariants({
  buffer, kinds = ['flipH', 'gray', 'tint', 'damaged', 'highlight'],
  color = '#4a9eff', targetWidth = 0, targetHeight = 0,
} = {}) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开（只支持 8bit 非隔行 PNG）', variants: [] }
  let base = { pixels: decoded.pixels, width: decoded.width, height: decoded.height }
  // 先归一尺寸：保证所有变体尺寸一致（"变体之间严格一致"的前提）
  if (targetWidth && targetHeight && (decoded.width !== targetWidth || decoded.height !== targetHeight)) {
    const fitted = fitToTarget({
      pixels: decoded.pixels, width: decoded.width, height: decoded.height,
      targetWidth, targetHeight, mode: 'contain', allowUpscale: true,
    })
    base = { pixels: fitted.pixels, width: fitted.width, height: fitted.height }
  }

  const variants = []
  for (const kind of kinds) {
    if (!VARIANT_KINDS.includes(kind)) continue
    let pixels = null
    if (kind === 'flipH') pixels = flip({ ...base, axis: 'h' })
    else if (kind === 'flipV') pixels = flip({ ...base, axis: 'v' })
    else if (kind === 'gray') pixels = grayscale({ ...base })
    else if (kind === 'tint') pixels = tint({ ...base, color })
    else if (kind === 'damaged') pixels = damaged({ ...base })
    else if (kind === 'highlight') pixels = highlight({ ...base })
    if (!pixels) continue
    variants.push({
      kind,
      label: VARIANT_LABELS[kind] ?? kind,
      pixels,
      width: base.width,
      height: base.height,
      buffer: encodePngRgba(base.width, base.height, pixels),
    })
  }
  return { ok: true, variants, base: { width: base.width, height: base.height } }
}

// ───────── C2 自动图集打包 ─────────

/**
 * C2 · 把若干张图拼成一张图集 + 生成 manifest。
 *
 * 布局：按固定格子排（size × columns），每格 contain 放入（不拉伸，避免变形）。
 * manifest 里给每个素材的 rect/pivot/原始尺寸 —— 引擎直接读，不用手工对齐。
 *
 * 为什么要自动：手工拼图集是苦力活，且 manifest 很容易和实际位置对不上
 * （改了顺序忘了改 manifest）。这里两者由同一次计算产出，天然一致。
 *
 * @param {{sprites:Array<{name:string, buffer:Buffer, pivot?:string}>, cellWidth:number, cellHeight:number,
 *          columns?:number, padding?:number}} params
 */
export function packAtlas({ sprites = [], cellWidth = 64, cellHeight = 64, columns = 0, padding = 0 }) {
  if (sprites.length === 0) return { ok: false, error: '没有素材可打包', atlas: null, manifest: null }
  if (cellWidth < 2 || cellHeight < 2) return { ok: false, error: '格子太小' }

  const decoded = sprites.map((sprite) => {
    const d = decodePngRgba(sprite.buffer)
    return d ? { name: sprite.name, pivot: sprite.pivot ?? 'center', ...d } : null
  })
  if (decoded.some((item) => !item)) return { ok: false, error: '有素材解不开' }

  const cols = columns > 0 ? columns : Math.max(1, Math.ceil(Math.sqrt(decoded.length)))
  const rows = Math.max(1, Math.ceil(decoded.length / cols))
  const inner = { w: cellWidth - padding * 2, h: cellHeight - padding * 2 }
  if (inner.w < 2 || inner.h < 2) return { ok: false, error: `padding 太大（格子 ${cellWidth}×${cellHeight}）` }

  const atlasWidth = cols * cellWidth
  const atlasHeight = rows * cellHeight
  const atlas = new Uint8ClampedArray(atlasWidth * atlasHeight * 4)  // 全透明底

  const frames = []
  decoded.forEach((sprite, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const fitted = fitToTarget({
      pixels: sprite.pixels, width: sprite.width, height: sprite.height,
      targetWidth: inner.w, targetHeight: inner.h, mode: 'contain', allowUpscale: false,
    })
    // 关键：用 fitted.drawn（实际画出来的尺寸），不能用 fitted.width/height
    // —— 后者是**画布**尺寸（恒等于 inner），小图会被误报成"填满整格"，
    // 引擎拿这个 manifest 就会把小图放大到整格。实测踩过这个坑。
    const drawn = fitted.drawn ?? { width: fitted.width, height: fitted.height, offsetX: 0, offsetY: 0 }
    // 居中放进格子（+padding）
    const originX = col * cellWidth + padding + drawn.offsetX
    const originY = row * cellHeight + padding + drawn.offsetY
    for (let y = 0; y < drawn.height; y++) {
      for (let x = 0; x < drawn.width; x++) {
        const from = (y * drawn.width + x) * 4
        const to = ((originY + y) * atlasWidth + (originX + x)) * 4
        atlas[to] = fitted.pixels[from]
        atlas[to + 1] = fitted.pixels[from + 1]
        atlas[to + 2] = fitted.pixels[from + 2]
        atlas[to + 3] = fitted.pixels[from + 3]
      }
    }
    frames.push({
      name: sprite.name,
      // manifest 用「像素矩形」，引擎直接切
      frame: { x: col * cellWidth, y: row * cellHeight, w: cellWidth, h: cellHeight },
      // 内容在格内的实际位置（有的引擎要精确包围盒）—— 必须是 drawn 的尺寸
      content: { x: originX, y: originY, w: drawn.width, h: drawn.height },
      source_size: `${sprite.width}×${sprite.height}`,
      drawn_size: `${drawn.width}×${drawn.height}`,
      // 是否被缩放过（引擎有时需要知道）
      scaled: drawn.width !== sprite.width || drawn.height !== sprite.height,
      pivot: sprite.pivot,
      // pivot 归一化坐标（很多引擎要 0..1）
      pivot_point: pivotPoint(sprite.pivot, drawn.width, drawn.height),
      rotated: false,
      trimmed: false,
    })
  })

  return {
    ok: true,
    atlas: { pixels: atlas, width: atlasWidth, height: atlasHeight, buffer: encodePngRgba(atlasWidth, atlasHeight, atlas) },
    manifest: {
      format: 'dsh-atlas/1',
      atlas: { image: 'atlas.png', size: `${atlasWidth}×${atlasHeight}`, width: atlasWidth, height: atlasHeight },
      grid: { cellWidth, cellHeight, columns: cols, rows, padding },
      frames,
      generated_consistency: 'frame 与 content 由同一次计算产出，不会出现 manifest 与实际位置不符',
    },
  }
}

/** pivot → 归一化坐标（0..1）。 */
export function pivotPoint(pivot, width, height) {
  switch (pivot) {
    case 'bottom': return { x: 0.5, y: 1 }
    case 'topleft': return { x: 0, y: 0 }
    case 'top': return { x: 0.5, y: 0 }
    case 'left': return { x: 0, y: 0.5 }
    default: return { x: 0.5, y: 0.5 }
  }
}

/** manifest 转成常见的 JSON 文本（给引擎吃）。 */
export function manifestToJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
