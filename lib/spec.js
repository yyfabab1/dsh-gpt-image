/**
 * A2 · 素材规格即代码（spec registry）。
 *
 * 目的：把「能不能用」从**审美问题**降级成**技术问题**。
 *   审美（这画得好不好看）只能人判 —— 那是审核视图的活。
 *   技术（尺寸对不对、要不要透明、pivot 在不在、帧数够不够）是确定的 —— 代码判，且能修就自动修。
 *
 * 规格来源（优先级从低到高）：
 *   1. 内置默认（按 kind 推断：图标 48×48、卡面 2:3 等）
 *   2. catalogue 文件 <游戏目录>/asset-specs.json（人写在项目里）
 *   3. 「待画素材清单.md」（check.js 已经能解析）里的尺寸/透明要求
 *   4. 调用方显式传入
 *
 * 「能修的修」清单（全部是确定性的像素操作，不需要审美）：
 *   - 尺寸不符      → 按 contain 缩放（保留 alpha），可指定是否允许放大
 *   - 该透明却不透明 → 抠掉纯色背景（只在背景色可确定时才做）
 *   - 毛边/锯齿      → alpha 阈值化 + 边缘收缩（去毛边，A1 也用它）
 *   - 四周多余留白   → 按内容包围盒裁掉（autotrim 已有）
 * 「不能修的才报人」：内容为空/全黑/全白、需透明但背景无法确定、帧数根本不够。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readJson } from './util.js'
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { contentBox, absoluteBox, cropRegion, fitToTarget } from './autotrim.js'
import { imageQuality } from './review.js'
import { pixelize, pixelPurity, enforcePixelPurity } from './pixelize.js'

/** 内置默认规格：按素材类型给一套合理值（不是硬性要求，可被覆盖）。 */
export const DEFAULT_SPECS = {
  icon: { width: 48, height: 48, alpha: 'required', pivot: 'center' },
  ui: { width: 48, height: 48, alpha: 'required', pivot: 'center' },
  item: { width: 48, height: 48, alpha: 'required', pivot: 'center' },
  card: { width: 512, height: 768, alpha: 'opaque', pivot: 'center' },
  portrait: { width: 512, height: 768, alpha: 'opaque', pivot: 'center' },
  tile: { width: 64, height: 64, alpha: 'any', pivot: 'topleft', tileable: true },
  terrain: { width: 64, height: 64, alpha: 'any', pivot: 'topleft', tileable: true },
  unit: { width: 64, height: 64, alpha: 'required', pivot: 'bottom' },
  building: { width: 128, height: 128, alpha: 'required', pivot: 'bottom' },
  effect: { width: 64, height: 64, alpha: 'required', pivot: 'center' },
  animation: { alpha: 'required', pivot: 'center', frames: 2 },
  // 像素画：**规格里写清逻辑分辨率**是让像素化可靠的关键。
  // 这里 64×64 是游戏里最终用的尺寸，pixel.width/height 是"逻辑像素"网格 32×32
  // （也就是 2 倍放大），palette 16 是像素画的常用上限。
  pixel: { width: 64, height: 64, alpha: 'required', pivot: 'center', pixel: { width: 32, height: 32, palette: 16 } },
  default: { alpha: 'any', pivot: 'center' },
}

/** 规格文件名（放在游戏目录里，随项目走）。 */
export const SPEC_FILE = 'asset-specs.json'

/**
 * 把各种来源的规格合成一份最终 spec。
 * @param {{kind?:string, name?:string, fileSpec?:object, catalogue?:object, expectation?:object}} params
 */
export function resolveSpec({ kind = 'default', name = '', fileSpec = null, catalogue = null, expectation = null } = {}) {
  const base = DEFAULT_SPECS[kind] ?? DEFAULT_SPECS.default
  const layers = [base]
  // 目录里按 kind 的默认 → 按名字的精确覆盖
  if (catalogue?.kinds?.[kind]) layers.push(catalogue.kinds[kind])
  if (catalogue?.assets?.[name]) layers.push(catalogue.assets[name])
  // 「待画素材清单」里的要求（尺寸 + 透明）
  if (expectation?.size?.width && expectation?.size?.height) {
    layers.push({
      width: expectation.size.width,
      height: expectation.size.height,
      max: Boolean(expectation.size.max),
      ...(expectation.transparent === true ? { alpha: 'required' } : {}),
      ...(expectation.tileable === true ? { tileable: true } : {}),
      source: expectation.source ? `清单：${expectation.source}` : '待画素材清单',
    })
  }
  if (fileSpec) layers.push(fileSpec)
  const spec = Object.assign({}, ...layers)
  if (!spec.source) spec.source = layers.length > 1 ? '合成（默认 + 覆盖）' : '内置默认'
  return spec
}

/** 读游戏目录里的 asset-specs.json（没有就返回空，不报错）。 */
export async function loadSpecCatalogue(root) {
  if (!root) return { kinds: {}, assets: {} }
  const raw = await readJson(path.join(root, SPEC_FILE), null)
  if (!raw || typeof raw !== 'object') return { kinds: {}, assets: {} }
  return {
    kinds: raw.kinds && typeof raw.kinds === 'object' ? raw.kinds : {},
    assets: raw.assets && typeof raw.assets === 'object' ? raw.assets : {},
    ...(raw.defaults ? { kinds: { ...(raw.kinds ?? {}), default: raw.defaults } } : {}),
  }
}

// ---------- 像素级修复（全部确定性，无需审美） ----------

/**
 * 去毛边：把「半透明脏边」清掉。
 * 扩散模型出图常在透明边缘留一圈低 alpha 的杂色，缩小后就是"毛刺"。
 * 做法：alpha 低于阈值的直接归零；边缘做一次收缩（吃掉 1px 的杂边）。
 */
export function defringe({ pixels, width, height, alphaThreshold = 40, shrink = 1 }) {
  const out = new Uint8ClampedArray(pixels)
  const at = (x, y) => (y * width + x) * 4
  // 1) 低 alpha 归零
  for (let i = 3; i < out.length; i += 4) {
    if (out[i] < alphaThreshold) out[i] = 0
  }
  // 2) 边缘收缩：alpha > 0 但四邻有全透明的，且自身不够"实"，就衰减
  for (let pass = 0; pass < shrink; pass++) {
    const snapshot = new Uint8ClampedArray(out)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = at(x, y)
        if (snapshot[i + 3] === 0) continue
        const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        let transparent = 0
        for (const [dx, dy] of neighbours) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) { transparent += 1; continue }
          if (snapshot[at(nx, ny) + 3] === 0) transparent += 1
        }
        if (transparent > 0 && snapshot[i + 3] < 160) out[i + 3] = 0
      }
    }
  }
  return { pixels: out, changed: true }
}

/**
 * 调色板吸附：把颜色量化到给定调色板，让一组图看起来是一套。
 * 只在给了调色板时生效（没给就原样返回 —— 不猜）。
 */
export function snapToPalette({ pixels, palette = [], strength = 1, alphaFloor = 24 }) {
  if (!palette.length) return { pixels, changed: false }
  const targets = palette.map((hex) => {
    const h = String(hex).replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  })
  const out = new Uint8ClampedArray(pixels)
  const k = Math.max(0, Math.min(1, strength))
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < alphaFloor) continue
    let best = targets[0]
    let bestD = Infinity
    for (const t of targets) {
      const d = (out[i] - t[0]) ** 2 + (out[i + 1] - t[1]) ** 2 + (out[i + 2] - t[2]) ** 2
      if (d < bestD) { bestD = d; best = t }
    }
    out[i] = out[i] + (best[0] - out[i]) * k
    out[i + 1] = out[i + 1] + (best[1] - out[i + 1]) * k
    out[i + 2] = out[i + 2] + (best[2] - out[i + 2]) * k
  }
  return { pixels: out, changed: true }
}

/**
 * 边缘锐化（unsharp mask 的简化版）：只对非透明像素做 3×3 拉普拉斯增强。
 * 让缩小到游戏尺寸后轮廓仍然清楚（配合 B2 的可读性预检）。
 */
export function sharpen({ pixels, width, height, amount = 0.6, alphaFloor = 24 }) {
  const out = new Uint8ClampedArray(pixels)
  const src = new Uint8ClampedArray(pixels)
  const at = (x, y) => (y * width + x) * 4
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = at(x, y)
      if (src[i + 3] < alphaFloor) continue
      for (let c = 0; c < 3; c++) {
        const centre = src[i + c]
        const around = (
          src[at(x - 1, y) + c] + src[at(x + 1, y) + c] +
          src[at(x, y - 1) + c] + src[at(x, y + 1) + c]
        ) / 4
        out[i + c] = Math.max(0, Math.min(255, centre + (centre - around) * amount))
      }
    }
  }
  return { pixels: out, changed: true }
}

/**
 * 抠掉纯色背景（只在背景色**可确定**时做）。
 * 判据：四角像素颜色接近 → 认为是纯色底；否则不猜（报人）。
 */
export function keyOutBackground({ pixels, width, height, tolerance = 28, alphaFloor = 24 }) {
  const at = (x, y) => (y * width + x) * 4
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
    .map(([x, y]) => { const i = at(x, y); return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]] })
    .filter((c) => c[3] >= alphaFloor)
  if (corners.length < 3) return { pixels, changed: false, reason: '四角不实或已透明，无法确定背景色' }
  // 四角必须彼此接近
  const [r0, g0, b0] = corners[0]
  for (const [r, g, b] of corners) {
    if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) > tolerance * 2) {
      return { pixels, changed: false, reason: '四角颜色不一致，背景不是纯色（不猜）' }
    }
  }
  const out = new Uint8ClampedArray(pixels)
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.abs(out[i] - r0) + Math.abs(out[i + 1] - g0) + Math.abs(out[i + 2] - b0)
    if (d <= tolerance) out[i + 3] = 0
  }
  return { pixels: out, changed: true, background: `#${[r0, g0, b0].map((v) => v.toString(16).padStart(2, '0')).join('')}` }
}

/** 裁掉四周多余留白（复用 autotrim 的包围盒）。 */
export function trimMargins({ pixels, width, height, alphaThreshold = 16 }) {
  const found = contentBox(pixels, width, height, { x0: 0, y0: 0, w: width, h: height }, { alphaThreshold })
  if (found.empty) return { pixels, changed: false, reason: '找不到内容（空图？）' }
  const box = found.localBox ?? found.box
  if (box.width === width && box.height === height) return { pixels, changed: false }
  const cropped = cropRegion(pixels, width, { minX: box.x0 ?? box.minX, minY: box.y0 ?? box.minY, width: box.width, height: box.height })
  return { pixels: cropped, width: box.width, height: box.height, changed: true, saved: `${width - box.width}×${height - box.height}` }
}

// ---------- 校验 + 自动修复 ----------

/**
 * 校验一张图是否符合 spec，并给出**可自动修复的动作**。
 * @param {{buffer:Buffer, spec:object, name?:string}} params
 * @returns {{ok:boolean, needsHuman:boolean, problems:Array, fixes:Array, quality:object|null}}
 */
export function validateAgainstSpec({ buffer, spec = {}, name = '' }) {
  const problems = []
  const fixes = []
  const decoded = decodePngRgba(buffer)
  const quality = imageQuality(buffer)
  if (!decoded) {
    return { ok: false, needsHuman: true, problems: ['图片解不开（格式不支持或文件损坏）'], fixes: [], quality: null }
  }
  const { width, height, pixels } = decoded

  // 内容本身的硬问题（修不了 → 报人）
  if (quality) {
    if (quality.colorCount <= 2) problems.push(`几乎单色（${quality.colorCount} 种颜色）`)
    if (quality.avgLuminance < 0.04) problems.push('几乎全黑')
    if (quality.avgLuminance > 0.97) problems.push('几乎全白')
    if (quality.edgeRatio < 0.005 && quality.colorCount <= 16) problems.push('画面是空的（没有边缘）')
  }

  // 尺寸
  if (spec.width && spec.height) {
    const tooBig = spec.max ? (width > spec.width || height > spec.height) : (width !== spec.width || height !== spec.height)
    if (tooBig) {
      // 能修：按 contain 缩放（保留 alpha）
      fixes.push({
        action: 'resize',
        to: `${spec.width}×${spec.height}`,
        mode: spec.max ? 'max' : 'contain',
        why: `当前 ${width}×${height}`,
      })
    }
  }

  // 透明要求
  const alphaRequired = spec.alpha === 'required'
  const actualAlpha = quality ? quality.transparentRatio : 0
  if (alphaRequired && actualAlpha < 0.02) {
    // 能修的条件：有可确定的纯色背景 → 抠掉；否则报人
    const keyed = keyOutBackground({ pixels, width, height })
    if (keyed.changed) {
      fixes.push({ action: 'keyout', background: keyed.background, why: '该透明但检测到不透明背景（已确认是纯色底）' })
    } else {
      problems.push(`要求透明底，但没有透明像素，且${keyed.reason ?? '背景无法确定'} —— 需要人处理`)
    }
  }

  // 留白（信息密度）
  if (spec.trim !== false) {
    const trimmed = trimMargins({ pixels, width, height })
    if (trimmed.changed && trimmed.saved) {
      const savedPct = 1 - (trimmed.width * trimmed.height) / (width * height)
      if (savedPct > 0.25) fixes.push({ action: 'trim', why: `四周留白偏多（可省 ${trimmed.saved}，约 ${Math.round(savedPct * 100)}%）` })
    }
  }

  // 可平铺性（tileable）：只提示，不做修复判定（需要真正的边缘连续性检查）
  if (spec.tileable === true) {
    const seam = tileSeamScore({ pixels, width, height })
    if (seam !== null && seam > 0.35) problems.push(`要求无缝平铺，但左右/上下接缝差异偏大（${seam.toFixed(2)}）`)
  }

  const needsHuman = problems.length > 0
  return {
    ok: !needsHuman,
    needsHuman,
    problems,
    fixes,
    quality,
    size: `${width}×${height}`,
    spec_source: spec.source ?? '',
    advice: needsHuman
      ? '这些是内容层面的问题，缩放/裁剪救不回来 —— 需要人看或重画。'
      : fixes.length > 0
        ? `有 ${fixes.length} 项可自动修复，跑 applySpecFixes 即可。`
        : '完全符合规格。',
  }
}

/**
 * 接缝差异（0=完美平铺，1=完全对不上）。
 * 比较「左边缘 vs 右边缘」「上边缘 vs 下边缘」的平均色差。
 */
export function tileSeamScore({ pixels, width, height, alphaFloor = 24 }) {
  if (width < 4 || height < 4) return null
  const at = (x, y) => (y * width + x) * 4
  let leftRight = 0
  let topBottom = 0
  let n = 0
  for (let y = 0; y < height; y++) {
    const a = at(0, y)
    const b = at(width - 1, y)
    if (pixels[a + 3] < alphaFloor || pixels[b + 3] < alphaFloor) continue
    leftRight += (Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1]) + Math.abs(pixels[a + 2] - pixels[b + 2])) / 765
    n += 1
  }
  const m1 = n > 0 ? leftRight / n : 0
  n = 0
  for (let x = 0; x < width; x++) {
    const a = at(x, 0)
    const b = at(x, height - 1)
    if (pixels[a + 3] < alphaFloor || pixels[b + 3] < alphaFloor) continue
    topBottom += (Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1]) + Math.abs(pixels[a + 2] - pixels[b + 2])) / 765
    n += 1
  }
  const m2 = n > 0 ? topBottom / n : 0
  return Math.max(m1, m2)
}

/**
 * 把 spec.pixel 归一化成 pixelize 的选项。
 * 支持三种写法：
 *   pixel: true / 'auto'          → 自动检测网格（检测不到就跳过，不硬做）
 *   pixel: { width: 32 }          → 只给逻辑宽，高按比例推（**推荐**：最可靠）
 *   pixel: { width: 32, height: 32, palette: 16, method: 'median', ... }
 */
export function normalizePixelOptions(pixel, { width, height } = {}) {
  if (!pixel || pixel === false) return null
  if (pixel === true || pixel === 'auto') return { auto: true, options: {} }
  if (typeof pixel !== 'object') return { auto: true, options: {} }
  const options = {}
  const logicalW = Number(pixel.width) || 0
  const logicalH = Number(pixel.height) || 0
  if (logicalW > 0) {
    options.logicalWidth = logicalW
    if (logicalH > 0) options.logicalHeight = logicalH
    else if (width > 0 && height > 0) options.logicalHeight = Math.max(1, Math.round((height / width) * logicalW))
  }
  for (const key of ['palette', 'paletteSpace', 'method', 'coreRatio', 'alphaThreshold', 'softAlpha',
    'aaPasses', 'denoise', 'output', 'minPeriod', 'maxPeriod', 'minF1', 'peakRatio', 'logicalHeight']) {
    if (pixel[key] !== undefined) options[key] = pixel[key]
  }
  return { auto: !options.logicalWidth, options }
}

/**
 * 执行自动修复，返回**新图**（不写盘，调用方决定存哪）。
 *
 * 顺序有讲究（这是 A1 管线的一部分）：
 *   抠背景 → **像素化** → 去毛边 → 裁留白 → 调色板吸附 → 锐化 → 缩放
 *
 * 为什么像素化排这么前、以及它一来就跳过两步：
 *   - 像素化要在**全分辨率**上做（块的边界信息只在原图上存在），所以必须早做；
 *   - 抠背景必须在它之前（透明信息要在块采样时被算进 alpha）；
 *   - **去毛边要跳过**：那是"边缘收 1px"，在逻辑分辨率上做等于把像素画吃掉一整圈轮廓；
 *   - **锐化要跳过**：锐化会造出调色板之外的颜色，正好把刚做好的硬边和有限色板破坏掉。
 * 失败不阻断：没检测到网格时只记一条原因，后面的常规修复照常做。
 */
export function applySpecFixes({ buffer, spec = {}, palette = null }) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开（只支持 8bit 非隔行 PNG）' }
  let { width, height, pixels } = decoded
  const applied = []
  const skipped = []
  let pixelInfo = null

  if (spec.alpha === 'required') {
    const keyed = keyOutBackground({ pixels, width, height })
    if (keyed.changed) { pixels = keyed.pixels; applied.push(`抠背景 ${keyed.background}`) }
  }

  // 像素化：把 AI 生成的「伪像素图」还原成真像素图（块核心区采样 + 调色板精炼）
  const pixelPlan = normalizePixelOptions(spec.pixel, { width, height })
  if (pixelPlan) {
    const result = pixelize({
      pixels,
      width,
      height,
      // 有显式调色板时就把自动量化关掉：精确十六进制吸附交给后面的 snapToPalette，
      // 否则先 K-means 再吸附等于量化两次，颜色会跑偏
      options: { ...pixelPlan.options, palette: palette?.length ? 0 : (pixelPlan.options.palette ?? 0) },
    })
    if (result.ok) {
      pixels = result.pixels
      width = result.width
      height = result.height
      pixelInfo = result.stats
      applied.push(`像素化 → ${width}×${height}（${result.applied.join('；')}）`)
    } else {
      skipped.push(`像素化跳过：${result.reason}`)
    }
  }
  const pixelized = Boolean(pixelInfo)

  if (pixelized) {
    skipped.push('去毛边（像素画是硬边，收 1px 会把轮廓吃掉）')
    skipped.push('锐化（会造出调色板外的颜色，破坏硬边）')
  } else {
    const defringed = defringe({ pixels, width, height })
    pixels = defringed.pixels
    applied.push('去毛边')
  }

  if (spec.trim !== false) {
    const trimmed = trimMargins({ pixels, width, height })
    if (trimmed.changed) {
      pixels = trimmed.pixels
      width = trimmed.width ?? width
      height = trimmed.height ?? height
      applied.push(`裁留白 ${trimmed.saved}`)
    }
  }

  if (palette?.length) {
    const snapped = snapToPalette({ pixels, palette, strength: spec.paletteStrength ?? (pixelized ? 1 : 0.5) })
    if (snapped.changed) { pixels = snapped.pixels; applied.push(`调色板吸附(${palette.length}色)`) }
  }

  if (spec.sharpen !== false && !pixelized) {
    const sharpened = sharpen({ pixels, width, height, amount: spec.sharpenAmount ?? 0.5 })
    pixels = sharpened.pixels
    applied.push('边缘锐化')
  }

  // 到这里 width×height **就是逻辑分辨率**（像素化已经把它降到逻辑尺寸了）。
  // 必须在 fitToTarget 之前记下来：后面会被整数倍放大并居中留边，
  // 验收时要靠这个数字判断"每个逻辑像素是不是等大"。
  const logicalAfterFixes = pixelized ? { width, height } : null

  if (spec.width && spec.height) {
    const fitted = fitToTarget({
      pixels, width, height,
      targetWidth: spec.width, targetHeight: spec.height,
      mode: 'contain', allowUpscale: spec.allowUpscale !== false,
      // 像素画**必须**整数倍放大：否则每个"像素"占 2.13 个物理像素，大小不一，
      // 画面立刻显脏（这不是抗锯齿问题，是像素本身不等大）
      integerScale: pixelized,
    })
    pixels = fitted.pixels
    width = fitted.width
    height = fitted.height
    applied.push(`尺寸归一 → ${width}×${height}`
      + (pixelized && fitted.integer_scale ? `（${fitted.integer_scale}× 整数倍最近邻）` : ''))
    if (pixelized && fitted.integer_scale === 0) {
      skipped.push('整数倍放大：目标尺寸比逻辑分辨率还小，只能缩小（要真像素就得调大规格或调小逻辑分辨率）')
    }
  }

  // 「真像素」验收：前面每一步都可能把它弄脏（非整数倍缩放、吸附强度不足、
  // 半透明 alpha…）。这里**判定 + 强制修复**，并把结论如实回报。
  // 只在确实做了像素化时才验收 —— 普通素材不该被套上像素画的规矩。
  let purity = null
  if (pixelized) {
    const purityArgs = {
      logicalWidth: logicalAfterFixes?.width ?? 0,
      logicalHeight: logicalAfterFixes?.height ?? 0,
      allowSoftAlpha: Boolean(pixelPlan.options.softAlpha),
    }
    purity = pixelPurity({ pixels, width, height, ...purityArgs })
    if (!purity.pure) {
      const enforced = enforcePixelPurity({
        pixels, width, height,
        ...purityArgs,
        method: pixelPlan.options.method ?? 'median',
        coreRatio: pixelPlan.options.coreRatio ?? 0.6,
      })
      if (enforced.purity.pure) {
        pixels = enforced.pixels
        width = enforced.width
        height = enforced.height
        applied.push(`真像素强制修复：${enforced.applied.join('；')}`)
        purity = enforced.purity
      } else {
        // 修不好就**如实说**，不能假装是真像素
        skipped.push(`真像素验收未通过：${enforced.purity.reasons.join('；')}`)
        purity = enforced.purity
      }
    }
  }

  return {
    ok: true, pixels, width, height, applied, skipped, pixel: pixelInfo, purity,
    buffer: encodePngRgba(width, height, pixels),
  }
}
