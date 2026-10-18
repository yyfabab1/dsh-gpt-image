/**
 * 素材变体：从一张**已经做好的**精灵表派生出同款变体（换配色 / 换调色板 / 明暗）。
 *
 * 为什么需要它：
 *   一个士兵做好之后，"同款换阵营色"（红/蓝）、"缴获版"、"受伤版" 是游戏里最常见的需求。
 *   如果每个变体都重走一遍「锚点 → 图生视频 → 抽帧 → 抠底」，那意味着：
 *     · 每变体几分钟视频生成
 *     · 每变体都可能长得不太一样（模型每次采样都重新决定细节）
 *   而**变体继承**只改颜色，形状/动作/帧数/时序全部继承 ——
 *     · 秒级完成
 *     · 变体之间除了配色，逐像素一致
 *
 * 关键原则：**只改颜色，绝不碰 alpha 和几何**。
 *   alpha 决定了轮廓，动了就会出现毛边/半透明脏边；几何动了帧就对不齐。
 *
 * 支持的操作（可叠加）：
 *   hue        色相旋转（度）。红阵营 → 蓝阵营最常用
 *   saturation 饱和度倍数（0 = 灰，1 = 原样，>1 更艳）
 *   brightness 明度倍数（0.5 = 暗，1 = 原样）
 *   tint       整体偏向某个颜色 { color:[r,g,b], amount:0~1 }（做"光影偏暖/偏冷"）
 *   palette    调色板映射 [[fromRgb, toRgb], ...]：精确换指定几种颜色
 *   grayscale  直接转灰度（0~1 混合量）
 */
import { decodePngRgba, encodePngRgba } from './pngcodec.js'

/* ── 颜色空间转换（只为了改色，不追求色彩科学上的完美） ── */

function rgbToHsl(r, g, b) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h, s, l]
}

function hueToRgb(p, q, t) {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ]
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/**
 * 对整张精灵表做变体处理。
 *
 * @param {object} params
 * @param {Buffer} params.buffer 精灵表 PNG
 * @param {number} [params.hue] 色相旋转（度，可负）
 * @param {number} [params.saturation] 饱和度倍数（1 = 不变）
 * @param {number} [params.brightness] 亮度倍数（1 = 不变）
 * @param {{color:number[], amount:number}} [params.tint] 整体染色
 * @param {Array<[number[], number[]]>} [params.palette] 调色板映射
 * @param {number} [params.grayscale] 灰度混合量 0~1
 * @param {number} [params.paletteTolerance] 调色板匹配容差（默认 24，0 = 必须精确相等）
 * @returns {{ok:boolean, buffer?:Buffer, changed?:number, error?:string}}
 */
export function recolorSheet({
  buffer, hue = 0, saturation = 1, brightness = 1,
  tint = null, palette = null, grayscale = 0, paletteTolerance = 24,
} = {}) {
  const png = decodePngRgba(buffer)
  if (!png) return { ok: false, error: '解不开精灵表（只支持 8bit PNG）' }
  const { pixels } = png

  const hueShift = (Number(hue) || 0) / 360
  const satMul = Number.isFinite(Number(saturation)) ? Math.max(0, Number(saturation)) : 1
  const brightMul = Number.isFinite(Number(brightness)) ? Math.max(0, Number(brightness)) : 1
  const grayMix = Math.min(1, Math.max(0, Number(grayscale) || 0))
  const tintColor = tint?.color && Array.isArray(tint.color) ? tint.color : null
  const tintAmount = Math.min(1, Math.max(0, Number(tint?.amount ?? 0)))
  const maps = Array.isArray(palette)
    ? palette
      .filter((pair) => Array.isArray(pair) && pair.length >= 2 && Array.isArray(pair[0]) && Array.isArray(pair[1]))
      .map(([from, to]) => ({ from, to }))
    : []

  let changed = 0
  for (let i = 0; i < pixels.length; i += 4) {
    // ★ 全透明像素直接跳过：动它没有意义，还可能把 alpha=0 但 RGB 有值的边缘弄脏
    if (pixels[i + 3] === 0) continue
    let r = pixels[i]; let g = pixels[i + 1]; let b = pixels[i + 2]
    const before = (r << 16) | (g << 8) | b

    // ① 调色板映射优先（精确换某几种颜色，比如"把 #5a6a3a 换成 #3a4a8a"）
    let mapped = false
    for (const { from, to } of maps) {
      const d = Math.abs(r - from[0]) + Math.abs(g - from[1]) + Math.abs(b - from[2])
      if (d <= paletteTolerance) {
        r = to[0]; g = to[1]; b = to[2]
        mapped = true
        break
      }
    }

    // ② 色相/饱和/明度
    if (!mapped && (hueShift !== 0 || satMul !== 1 || brightMul !== 1)) {
      const [h, s, l] = rgbToHsl(r, g, b)
      let nh = (h + hueShift) % 1
      if (nh < 0) nh += 1
      const ns = Math.min(1, s * satMul)
      const nl = Math.min(1, l * brightMul)
      const rgb = hslToRgb(nh, ns, nl)
      r = rgb[0]; g = rgb[1]; b = rgb[2]
    }

    // ③ 灰度
    if (grayMix > 0) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b
      r = r + (gray - r) * grayMix
      g = g + (gray - g) * grayMix
      b = b + (gray - b) * grayMix
    }

    // ④ 整体染色
    if (tintColor && tintAmount > 0) {
      r = r + (tintColor[0] - r) * tintAmount
      g = g + (tintColor[1] - g) * tintAmount
      b = b + (tintColor[2] - b) * tintAmount
    }

    pixels[i] = clamp255(r)
    pixels[i + 1] = clamp255(g)
    pixels[i + 2] = clamp255(b)
    // ★ alpha 原样不动
    if (((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]) !== before) changed += 1
  }

  return {
    ok: true,
    buffer: encodePngRgba(png.width, png.height, pixels),
    changed,
    total: png.width * png.height,
    note: `改了 ${changed} 个可见像素（共 ${png.width * png.height}），alpha 与几何完全没动`,
  }
}

/**
 * 常用阵营配色预设。省得每次自己调数字。
 */
export const VARIANT_PRESETS = {
  red: { hue: 0, saturation: 1.15, brightness: 1.02, tint: { color: [210, 60, 45], amount: 0.18 } },
  blue: { hue: 200, saturation: 1.1, brightness: 1.02, tint: { color: [60, 110, 210], amount: 0.18 } },
  green: { hue: 110, saturation: 1.05, brightness: 1.0 },
  purple: { hue: 275, saturation: 1.15, brightness: 1.0 },
  yellow: { hue: 45, saturation: 1.2, brightness: 1.05 },
  captured: { hue: 30, saturation: 0.6, brightness: 0.92, tint: { color: [120, 110, 90], amount: 0.25 } },
  damaged: { saturation: 0.75, brightness: 0.88, tint: { color: [90, 40, 30], amount: 0.12 } },
  ghost: { saturation: 0.15, brightness: 1.15, tint: { color: [180, 210, 255], amount: 0.25 } },
}
