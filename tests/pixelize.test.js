/**
 * 像素画净化（pixelize）测试。
 *
 * 移植自 AIPixelImageConversionTool 的算法，验证方式必须是**可判定的**：
 * 先造一张"已知逻辑分辨率"的伪像素图（把小的真像素图用最近邻放大 N 倍，
 * 再在块边界加抗锯齿混合色），然后要求算法**把逻辑图还原回来**。
 * 这比"看起来像像素画"强得多 —— 后者没法断言。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  PIXELIZE_DEFAULTS,
  bestScaleFromRuns,
  computeEdgeMap,
  detectGrid,
  detectIntegerScale,
  extractBlocks,
  lineRuns,
  medianDenoise,
  nearestUpscale,
  oklabToRgb,
  pixelize,
  pixelizePng,
  quantizePalette,
  removeAntiAliasing,
  rgbToOklab,
  toGray,
  uniqueColors,
  uniformBlockSize,
  blocksUniform,
  pixelPurity,
  enforcePixelPurity,
} from '../lib/pixelize.js'
import { decodePngRgba, encodePngRgba } from '../lib/pngcodec.js'
import { fitToTarget } from '../lib/autotrim.js'
import { DEFAULT_SPECS, normalizePixelOptions, applySpecFixes } from '../lib/spec.js'
import { apply } from '../lib/index.js'
import { assetFingerprint } from '../lib/fingerprint.js'
import { normalizeBatchAssets } from '../lib/batch/run.js'
import { computeSlices } from '../lib/sheet.js'
import { sha256 } from '../lib/util.js'
import { pixelStyleFor, pixelPromptSuffix, mentionsPixelArt } from '../lib/prompts.js'
import { Gallery } from '../lib/store.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const T = { quality: '_dsh_external_dsh_gpt_image_quality', generate: '_dsh_external_dsh_gpt_image_generate', config: '_dsh_external_dsh_gpt_image_config' }

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** 真跑一遍插件装配（和 e2e.test.js 同一套做法），拿到能直接调的工具。 */
async function toolHarness() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-px-tool-'))
  const outputDir = path.join(dataDir, 'out')
  const registry = new Map()
  const ctx = {
    tools: { register: (definition) => { registry.set(definition.name, definition); return () => registry.delete(definition.name) } },
    effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    inject() {},
    get() { return undefined },
  }
  apply(ctx, { dataDir, outputDir })
  return {
    dataDir,
    outputDir,
    call: async (name, args) => JSON.parse(await registry.get(name).execute(args)),
    // 直接读盘上的历史，避免依赖工具内部状态
    loadGallery: () => Gallery.load(dataDir),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  }
}

/* ---------------- 造图工具 ---------------- */

/** 确定性的伪随机（测试要可复现，不能用 Math.random）。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 4294967296
  }
}

/** 造一张逻辑 w×h 的真像素 RGBA 图（高对比、颜色互不相同，便于断言）。 */
function logicalArt(w, h, seed = 7) {
  const pixels = new Uint8ClampedArray(w * h * 4)
  const random = rng(seed)
  for (let i = 0; i < w * h; i++) {
    // 用大间隔的色阶，保证相邻块颜色差异明显（不会被 tol 当成同色）
    pixels[i * 4] = 32 + Math.floor(random() * 6) * 40
    pixels[i * 4 + 1] = 32 + Math.floor(random() * 6) * 40
    pixels[i * 4 + 2] = 32 + Math.floor(random() * 6) * 40
    pixels[i * 4 + 3] = 255
  }
  return { pixels, width: w, height: h }
}

/**
 * 造一张**真实形态**的像素画：从有限色板里取色（不是每像素随机色）。
 *
 * 为什么必须有这个而不是用 logicalArt：logicalArt 每像素随机色，1024 个像素
 * 接近 1024 种颜色 —— 那是**噪点，不是像素画**。拿它当"真像素"的基准会把
 * 判据校准到错误的目标上（第一版就是这么把噪声的共线三元色算成抗锯齿的）。
 */
function paletteArt(w, h, { seed = 3, colors = 12 } = {}) {
  const pixels = new Uint8ClampedArray(w * h * 4)
  const random = rng(seed)
  const palette = []
  for (let i = 0; i < colors; i++) {
    palette.push([Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)])
  }
  for (let i = 0; i < w * h; i++) {
    const c = palette[Math.floor(random() * palette.length)]
    pixels[i * 4] = c[0]; pixels[i * 4 + 1] = c[1]; pixels[i * 4 + 2] = c[2]; pixels[i * 4 + 3] = 255
  }
  return { pixels, width: w, height: h, palette }
}

/** 把逻辑图最近邻放大 scale 倍（这就是 AI 生成的"伪像素图"的基本形态）。 */
function upscaleNearest(art, scale) {
  return nearestUpscale(art.pixels, art.width, art.height, art.width * scale, art.height * scale)
}

/** 在块边界做 1px 线性混合（模拟 AI 画出来的抗锯齿）。 */
function addAntiAliasing({ pixels, width, height }, scale) {
  const out = new Uint8ClampedArray(pixels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x % scale !== 0 && y % scale !== 0) continue
      const i = (y * width + x) * 4
      const left = x > 0 ? (y * width + x - 1) * 4 : i
      const right = x < width - 1 ? (y * width + x + 1) * 4 : i
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.round((pixels[left + c] + pixels[right + c]) / 2)
      }
    }
  }
  return out
}

/** 造一张平滑渐变 + 噪点的「插画」，它**不是**像素画。 */
function smoothIllustration(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  const random = rng(99)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      pixels[i] = 40 + (x / width) * 180 + random() * 4
      pixels[i + 1] = 60 + (y / height) * 160 + random() * 4
      pixels[i + 2] = 120 + Math.sin((x + y) / 40) * 40 + random() * 4
      pixels[i + 3] = 255
    }
  }
  return { pixels, width, height }
}

/* ---------------- 颜色空间 ---------------- */

test('OKLab：往返转换误差在 1 个色阶内（AA 判定与调色板聚类都靠它）', () => {
  for (const rgb of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 128, 64], [123, 45, 200], [17, 200, 240]]) {
    const [L, A, B] = rgbToOklab(...rgb)
    const back = oklabToRgb(L, A, B)
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(back[c] - rgb[c]) <= 1, `${rgb} → ${back}（第 ${c} 通道差 ${Math.abs(back[c] - rgb[c])}）`)
    }
  }
  // 越出色域不能崩，要裁到 0..255
  const clipped = oklabToRgb(1, 1, 1)
  for (const v of clipped) assert.ok(v >= 0 && v <= 255, `越界值必须裁剪，实际 ${clipped}`)
})

/* ---------------- 整数尺度（runs/GCD） ---------------- */

test('行程长度：差值大于容差处断开，末端行程要收尾', () => {
  assert.deepEqual(lineRuns([0, 0, 0, 10, 10, 1], 2), [3, 2, 1])
  assert.deepEqual(lineRuns([5], 2), [])
  assert.deepEqual(lineRuns([1, 1, 1, 1], 0), [4])
})

test('runs/GCD：行程是尺度的整数倍时能选出尺度，命中率相同取更大尺度', () => {
  // 行程全是 4 的倍数 → 候选里 4 的命中率最高
  assert.deepEqual(bestScaleFromRuns([4, 8, 12, 4, 8], 3, 40, 1), { scale: 4, hitRate: 1 })
  // 4 与 5 各半：GCD 1 不在范围 → 退到命中率最高的单个长度；4、5 命中率相同取更大
  assert.equal(bestScaleFromRuns([4, 5], 3, 40, 0).scale, 5)
  assert.deepEqual(bestScaleFromRuns([], 3, 40, 1), { scale: 0, hitRate: 0 })
})

test('整数尺度检测：×4 最近邻放大的图能测出 scale=4', () => {
  const art = logicalArt(12, 10)
  const big = upscaleNearest(art, 4)
  const gray = toGray(big.pixels, big.width, big.height)
  const found = detectIntegerScale(gray, big.width, big.height, { minP: 3, maxP: 40 })
  assert.equal(found.scaleX, 4, `x 尺度应为 4，实际 ${found.scaleX}`)
  assert.equal(found.scaleY, 4, `y 尺度应为 4，实际 ${found.scaleY}`)
  assert.ok(found.hitRate >= 0.7, `命中率应 ≥0.7，实际 ${found.hitRate}`)
  assert.ok(found.confidence > 0)
})

test('整数尺度检测：平滑插画给不出强证据（返回 0，不硬猜）', () => {
  const art = smoothIllustration(96, 96)
  const gray = toGray(art.pixels, art.width, art.height)
  const found = detectIntegerScale(gray, art.width, art.height, { minP: 3, maxP: 40 })
  assert.equal(found.confidence, 0, '平滑图不该有整数尺度强证据')
})

test('回归：「是不是整数倍」的容差不能大于半个周期（否则 4 会被当成 8 的倍数）', () => {
  // 真实 bug：tol=12、scale=8 时，长度 4 的行程 round(4/8)=1 → |4-8|=4 ≤ 12 被判为命中，
  // 于是「全是 4 的行程」也能让 8 拿到满分，块尺寸被放大一倍、两个像素并成一个。
  const allFours = Array.from({ length: 20 }, () => 4)
  const picked = bestScaleFromRuns(allFours, 3, 40, 12)
  assert.equal(picked.scale, 4, `全是长度 4 的行程时只能选 4，实际 ${picked.scale}`)
  assert.equal(picked.hitRate, 1)
  // 而真正的 8 倍行程仍然要能识别
  const allEights = Array.from({ length: 20 }, () => 8)
  assert.equal(bestScaleFromRuns(allEights, 3, 40, 12).scale, 8)
})

test('回归：抗锯齿的图也要测出真块尺寸（不能被「运气好」的假周期骗到）', () => {
  // 真实 bug：峰值匹配 F1 会把周期 6 打到 0.800（比真周期 4 的 0.737 还高），
  // 因为峰值只有 7 个且间距不规则，6 恰好落在其中 6 个的 ±1 内。
  // 自相关一眼看穿：lag 4 = +0.25，lag 6 = −0.41（半周期反相关）。
  const art = logicalArt(12, 10, 7)
  const big = upscaleNearest(art, 4)
  big.pixels.set(addAntiAliasing(big, 4))
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40 })
  assert.equal(grid.ok, true, grid.reason)
  assert.equal(grid.px, 4, `块宽应为 4，实际 ${grid.px}`)
  assert.equal(grid.py, 4, `块高应为 4，实际 ${grid.py}`)
  assert.equal(grid.wLogic, 12)
  assert.equal(grid.hLogic, 10)
})

test('回归：网格线匹配容差是固定像素数（默认 1），不能随周期放大', () => {
  // 真实 bug：tol = period×0.15 时周期 12 的容差变成 ±2，它的网格线能"蹭"到
  // 不属于它的峰值，precision 虚高到 1.0，把真周期 4 挤掉。
  assert.equal(PIXELIZE_DEFAULTS.peakTolerance, undefined) // 默认由 detectGrid 内部取 1
  const art = logicalArt(12, 10, 7)
  const big = upscaleNearest(art, 4)
  big.pixels.set(addAntiAliasing(big, 4))
  const tight = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40, peakTolerance: 1 })
  assert.equal(tight.px, 4, '容差 1px 时必须给出真周期 4')
  // 容差放大到 ±4 就会把不相邻的峰值也算成命中 —— 结果不再可靠（这正是当初的 bug）。
  // 这里只断言「确实会变成另一个答案」，把这条路钉成显式的取舍而不是无声的漂移。
  const loose = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40, peakTolerance: 4 })
  assert.notEqual(loose.px, undefined)
  assert.notEqual(loose.px, 4, '±4 的容差过于宽松，会锁到别的周期 —— 所以默认必须是 1')
})

/* ---------------- 网格检测 ---------------- */

test('网格检测：×4 的图测出块 4×4、逻辑分辨率 12×10', () => {
  const art = logicalArt(12, 10)
  const big = upscaleNearest(art, 4)
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40 })
  assert.equal(grid.ok, true, grid.reason)
  assert.equal(grid.px, 4, `块宽应为 4，实际 ${grid.px}`)
  assert.equal(grid.py, 4, `块高应为 4，实际 ${grid.py}`)
  assert.equal(grid.wLogic, 12)
  assert.equal(grid.hLogic, 10)
})

test('网格检测：×8 也要测出 8，不能被放大成 16（倍周期误检）', () => {
  const art = logicalArt(10, 8)
  const big = upscaleNearest(art, 8)
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 48 })
  assert.equal(grid.ok, true, grid.reason)
  assert.equal(grid.px, 8, `块宽应为 8（不是 16），实际 ${grid.px}`)
  assert.equal(grid.py, 8, `块高应为 8（不是 16），实际 ${grid.py}`)
  assert.equal(grid.wLogic, 10)
  assert.equal(grid.hLogic, 8)
})

test('网格检测：显式逻辑分辨率优先级最高（规格已知时不用猜）', () => {
  const art = logicalArt(16, 16)
  const big = upscaleNearest(art, 3)
  const grid = detectGrid(big.pixels, big.width, big.height, { logicalWidth: 16, logicalHeight: 16 })
  assert.equal(grid.ok, true)
  assert.equal(grid.source, 'explicit')
  assert.equal(grid.px, 3)
  assert.equal(grid.wLogic, 16)
})

test('网格检测：平滑插画必须拒绝（宁可不做，也不能把图毁成马赛克）', () => {
  const art = smoothIllustration(128, 128)
  const grid = detectGrid(art.pixels, art.width, art.height, { minPeriod: 3, maxPeriod: 40 })
  assert.equal(grid.ok, false, '插画不该被判成像素网格')
  assert.match(grid.reason, /没检测到明显的像素网格/)
  assert.match(grid.reason, /pixel\.width/, '要告诉用户「知道逻辑分辨率就直接指定」')
})

/* ---------------- 块提取 ---------------- */

test('块提取：均匀块能精确还原逻辑图（核心区采样）', () => {
  const art = logicalArt(12, 10, 3)
  const big = upscaleNearest(art, 4)
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40 })
  assert.equal(grid.ok, true, grid.reason)
  const out = extractBlocks(big.pixels, big.width, big.height, grid, { method: 'median', coreRatio: 0.6 })
  assert.equal(out.width, art.width)
  assert.equal(out.height, art.height)
  // 块内颜色完全一致 → 中位数必须与原始逻辑像素**逐位相同**
  for (let i = 0; i < art.width * art.height; i++) {
    for (let c = 0; c < 3; c++) {
      assert.equal(out.pixels[i * 4 + c], art.pixels[i * 4 + c],
        `第 ${i} 个像素第 ${c} 通道：期望 ${art.pixels[i * 4 + c]}，实际 ${out.pixels[i * 4 + c]}`)
    }
  }
})

test('块提取：alpha 按核心区中位数二值化（真像素画没有半透明）', () => {
  const art = logicalArt(4, 4, 11)
  // 一半透明
  for (let i = 0; i < 8; i++) art.pixels[i * 4 + 3] = 0
  const big = upscaleNearest(art, 4)
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40 })
  const out = extractBlocks(big.pixels, big.width, big.height, grid, {})
  const alphas = new Set()
  for (let i = 0; i < out.width * out.height; i++) alphas.add(out.pixels[i * 4 + 3])
  assert.deepEqual([...alphas].sort(), [0, 255], `透明必须二值化，实际出现 ${[...alphas]}`)
})

test('块提取：softAlpha 保留中间 alpha（特效类素材需要）', () => {
  const art = logicalArt(3, 3, 5)
  const big = upscaleNearest(art, 4)
  // 把整张图的 alpha 压到 100
  for (let i = 3; i < big.pixels.length; i += 4) big.pixels[i] = 100
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40 })
  const binary = extractBlocks(big.pixels, big.width, big.height, grid, {})
  const soft = extractBlocks(big.pixels, big.width, big.height, grid, { softAlpha: true })
  assert.equal(binary.pixels[3], 0, '二值化时 100 < 128 → 0')
  assert.equal(soft.pixels[3], 100, 'softAlpha 时保留 100')
})

/* ---------------- 端到端 ---------------- */

test('端到端：抗锯齿的伪像素图 → 还原成逻辑分辨率的真像素图', () => {
  const art = logicalArt(12, 10, 21)
  const big = upscaleNearest(art, 4)
  big.pixels.set(addAntiAliasing(big, 4))
  const result = pixelize({ pixels: big.pixels, width: big.width, height: big.height, options: { minPeriod: 3, maxPeriod: 40 } })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.width, 12, `逻辑宽应为 12，实际 ${result.width}`)
  assert.equal(result.height, 10, `逻辑高应为 10，实际 ${result.height}`)
  assert.equal(result.stats.block.px, 4)
  assert.ok(result.applied.join(' ').includes('块提取'))
  // 核心区采样本来就避开边界，所以 AA 不该污染结果
  for (let i = 0; i < art.width * art.height; i++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(result.pixels[i * 4 + c] - art.pixels[i * 4 + c]) <= 2,
        `第 ${i} 像素第 ${c} 通道：期望≈${art.pixels[i * 4 + c]}，实际 ${result.pixels[i * 4 + c]}`)
    }
  }
})

test('端到端：output=origin 时最近邻放回原尺寸，且逻辑色完全保留', () => {
  const art = logicalArt(8, 8, 33)
  const big = upscaleNearest(art, 6)
  const result = pixelize({
    pixels: big.pixels, width: big.width, height: big.height,
    options: { minPeriod: 3, maxPeriod: 48, output: 'origin' },
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.width, big.width)
  assert.equal(result.height, big.height)
  assert.deepEqual(result.logical, { width: 8, height: 8 })
  // 放大后每 6×6 块内部必须同色（最近邻的硬边不能被糊）
  const at = (x, y) => (y * result.width + x) * 4
  for (const [x, y] of [[0, 0], [6, 6], [12, 6], [result.width - 1, result.height - 1]]) {
    const blockIndex = (Math.floor(y / 6) * 8 + Math.floor(x / 6)) * 4
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(result.pixels[at(x, y) + c] - art.pixels[blockIndex + c]) <= 2,
        `(${x},${y}) 应与逻辑块同色`)
    }
  }
})

test('端到端：不给逻辑分辨率时，插画会被拒绝且**不改动**（ok:false）', () => {
  const art = smoothIllustration(120, 120)
  const result = pixelize({ pixels: art.pixels, width: art.width, height: art.height, options: { minPeriod: 3, maxPeriod: 40 } })
  assert.equal(result.ok, false)
  assert.equal(result.pixels, undefined, '拒绝时不该返回像素，避免调用方误用')
  assert.match(result.reason, /没检测到/)
})

test('端到端：图太大时直接拒绝，不硬刚内存', () => {
  const art = logicalArt(4, 4)
  const result = pixelize({ pixels: art.pixels, width: 4, height: 4, options: { maxPixels: 8 } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /图太大/)
})

test('端到端：调色板精炼在逻辑分辨率上做，颜色数下降且逻辑尺寸不变', () => {
  const art = logicalArt(16, 16, 41)
  const big = upscaleNearest(art, 4)
  const result = pixelize({
    pixels: big.pixels, width: big.width, height: big.height,
    options: { minPeriod: 3, maxPeriod: 40, palette: 6 },
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.width, 16)
  const colors = uniqueColors(result.pixels).colors.length
  assert.ok(colors <= 6, `量化后颜色数应 ≤6，实际 ${colors}`)
  assert.equal(result.stats.palette.length, 6)
  assert.ok(result.applied.join(' ').includes('调色板精炼'))
})

test('端到端：png 版能解码 → 净化 → 再编码，且产物能重新解码', () => {
  const art = logicalArt(10, 10, 55)
  const big = upscaleNearest(art, 4)
  const png = encodePngRgba(big.width, big.height, big.pixels)
  const result = pixelizePng({ buffer: png, options: { minPeriod: 3, maxPeriod: 40 } })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.width, 10)
  const back = decodePngRgba(result.buffer)
  assert.ok(back, '产物必须能重新解码')
  assert.equal(back.width, 10)
  assert.equal(back.height, 10)
  for (let i = 0; i < 100; i++) {
    for (let c = 0; c < 3; c++) {
      assert.equal(back.pixels[i * 4 + c], result.pixels[i * 4 + c])
    }
  }
})

/* ---------------- AA 消除 ---------------- */

test('AA 消除：边界上的混合色被吸附回两侧块色，纯色块本身不动', () => {
  // 左半 40,40,40 / 右半 220,220,220，交界一列是中间值（典型抗锯齿）
  const w = 9
  const h = 5
  const pixels = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = x < 4 ? 40 : x === 4 ? 130 : 220
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255
    }
  }
  const cleaned = removeAntiAliasing(pixels, w, h, { passes: 1 })
  assert.ok(cleaned.touched > 0, '应该吸附到混合色像素')
  // 混合列要变成两侧之一的纯色
  const mixedValue = cleaned.pixels[(2 * w + 4) * 4]
  assert.ok(mixedValue === 40 || mixedValue === 220, `混合列应吸附到 40 或 220，实际 ${mixedValue}`)
  // 远处的纯色块保持不动
  assert.equal(cleaned.pixels[(2 * w + 0) * 4], 40)
  assert.equal(cleaned.pixels[(2 * w + 8) * 4], 220)
})

test('AA 消除：纯色图不该被改动（没有任何「位于两主色之间」的像素）', () => {
  const w = 6
  const h = 6
  const pixels = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = 90; pixels[i * 4 + 1] = 90; pixels[i * 4 + 2] = 90; pixels[i * 4 + 3] = 255
  }
  const cleaned = removeAntiAliasing(pixels, w, h, { passes: 2 })
  assert.equal(cleaned.touched, 0, '纯色图不该有任何改动')
  for (let i = 0; i < pixels.length; i++) assert.equal(cleaned.pixels[i], pixels[i])
})

/* ---------------- 调色板 / 放大 / 降噪 ---------------- */

test('调色板量化：颜色数被压到目标值，且**同样输入永远同样输出**（可复现）', () => {
  const art = logicalArt(32, 32, 77)
  const first = quantizePalette(art.pixels, { nColors: 8, space: 'oklab' })
  const second = quantizePalette(art.pixels, { nColors: 8, space: 'oklab' })
  assert.equal(first.changed, true)
  assert.ok(uniqueColors(first.pixels).colors.length <= 8)
  assert.deepEqual(first.palette, second.palette, '调色板必须可复现（固定种子），否则每次重跑都要重审')
  assert.deepEqual([...first.pixels], [...second.pixels])
})

test('调色板量化：颜色数已经少于目标时不动（不无中生有）', () => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    pixels[i * 4] = i < 8 ? 10 : 200
    pixels[i * 4 + 1] = 10
    pixels[i * 4 + 2] = 10
    pixels[i * 4 + 3] = 255
  }
  const result = quantizePalette(pixels, { nColors: 16 })
  assert.equal(result.changed, false)
  assert.deepEqual([...result.pixels], [...pixels])
})

test('调色板量化：全透明像素不参与统计（否则会把透明色当成一个调色板色）', () => {
  const pixels = new Uint8ClampedArray(2 * 1 * 4)
  pixels[0] = 10; pixels[1] = 10; pixels[2] = 10; pixels[3] = 0     // 全透明
  pixels[4] = 200; pixels[5] = 30; pixels[6] = 30; pixels[7] = 255
  const { colors } = uniqueColors(pixels)
  assert.equal(colors.length, 1, `只应统计不透明色，实际 ${JSON.stringify(colors)}`)
  assert.deepEqual(colors[0], [200, 30, 30])
})

test('最近邻放大：硬边不糊，块内完全同色', () => {
  const art = logicalArt(4, 4, 13)
  const big = nearestUpscale(art.pixels, 4, 4, 12, 12)
  assert.equal(big.width, 12)
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const src = (Math.floor(y / 3) * 4 + Math.floor(x / 3)) * 4
      const dst = (y * 12 + x) * 4
      for (let c = 0; c < 3; c++) assert.equal(big.pixels[dst + c], art.pixels[src + c])
    }
  }
})

test('3×3 中值降噪：孤立噪点被抹掉，平坦区不动', () => {
  const w = 5
  const h = 5
  const pixels = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = 100; pixels[i * 4 + 1] = 100; pixels[i * 4 + 2] = 100; pixels[i * 4 + 3] = 255
  }
  // 中心一个孤立亮点
  const centre = (2 * w + 2) * 4
  pixels[centre] = 255; pixels[centre + 1] = 255; pixels[centre + 2] = 255
  const out = medianDenoise(pixels, w, h)
  assert.equal(out[centre], 100, '孤立噪点应被中值抹掉')
  assert.equal(out[(0 * w + 0) * 4], 100, '平坦区不动')
})

test('边缘图：全平图没有边缘（避免把纯色图误判成有网格）', () => {
  const pixels = new Uint8ClampedArray(8 * 8 * 4)
  for (let i = 0; i < 64; i++) { pixels[i * 4] = 50; pixels[i * 4 + 1] = 50; pixels[i * 4 + 2] = 50; pixels[i * 4 + 3] = 255 }
  const edge = computeEdgeMap(toGray(pixels, 8, 8), 8, 8)
  let max = 0
  for (const v of edge) max = Math.max(max, v)
  assert.equal(max, 0)
})

test('默认值：AA 消除与降噪默认关闭（与上游一致，不偷偷改用户的图）', () => {
  assert.equal(PIXELIZE_DEFAULTS.aaPasses, 0)
  assert.equal(PIXELIZE_DEFAULTS.denoise, 0)
  assert.equal(PIXELIZE_DEFAULTS.palette, 0)
  assert.equal(PIXELIZE_DEFAULTS.method, 'median')
  assert.equal(PIXELIZE_DEFAULTS.output, 'logical')
})

/* ---------------- 出图阶段的网格约束（"以后"最有效的一步） ---------------- */

test('提示词：pixelStyleFor 会把网格说成可数的行列 + 等大 + 硬边', () => {
  const style = pixelStyleFor({ width: 32, height: 32, colors: 16 })
  assert.match(style, /32×32/)
  assert.match(style, /count exactly 32 columns and 32 rows/)
  assert.match(style, /exactly the same square area/)
  assert.match(style, /at most 16 flat colours/)
  assert.match(style, /no anti-aliasing/)
  assert.match(style, /one flat colour per pixel|solid single colour/)
  // 只给宽也要能生成
  const onlyW = pixelStyleFor({ width: 48 })
  assert.match(onlyW, /48 logical pixels wide/)
})

test('提示词：已经说了是像素画时只补关键约束，不重复整段风格', () => {
  assert.equal(mentionsPixelArt('pixel art sword'), true)
  assert.equal(mentionsPixelArt('像素画 剑'), true)
  assert.equal(mentionsPixelArt('16-bit sprite'), true)
  assert.equal(mentionsPixelArt('a photorealistic cat'), false)

  const suffix = pixelPromptSuffix({ width: 32, height: 32, palette: 16 }, { existingPrompt: 'pixel art sword' })
  assert.match(suffix, /uniform square pixels/)
  assert.match(suffix, /exactly 32×32 logical pixels/)
  assert.match(suffix, /at most 16 flat colours/)
  assert.ok(!suffix.includes('16-bit SNES-era'), '不该把整段风格再塞一遍')
  assert.ok(suffix.length < pixelStyleFor({ width: 32, height: 32, colors: 16 }).length, '应该比完整风格短')

  const full = pixelPromptSuffix({ width: 32, height: 32 }, { existingPrompt: 'a cat' })
  assert.match(full, /PIXEL ART ONLY/, '没提过像素画就给完整风格')
  assert.equal(pixelPromptSuffix(null), '')
  assert.equal(pixelPromptSuffix(false), '')
})

test('出图：带 pixel 时提示词会自动补上网格约束，并能查到补了什么', async () => {
  let seenBody = null
  const upstream = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      // 返回一张最小的合法 PNG（b64）
      return res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
    }
    res.writeHead(404); res.end('{}')
  })
  const h = await toolHarness()
  try {
    await h.call(T.config, {
      action: 'set_profile',
      profile: { id: 'px', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-t', model: 'gpt-image-2', pricePerImage: 0 },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'px' })

    const result = await h.call(T.generate, {
      prompt: '一把像素风的剑', project: 'pxproj', name: 'sword', n: 1,
      size: '1024x1024', quality: 'low', confirm: true,
      pixel: { width: 32, height: 32, palette: 16 },
    })
    assert.equal(result.ok, true, result.error)
    assert.ok(seenBody, '应该真的发出了请求')
    assert.match(seenBody.prompt, /uniform square pixels|strict uniform square pixel grid/,
      `实际发出的提示词应含网格约束：${seenBody.prompt}`)
    assert.match(seenBody.prompt, /32/, '应该带上逻辑分辨率')
    assert.match(seenBody.prompt, /一把像素风的剑/, '原提示词不能丢')
    // 补了什么要能查到（否则用户看到 prompt 变了会以为被改了提示词）
    const gallery = await h.loadGallery()
    const record = gallery.list({ limit: 50 }).find((item) => item.name === 'sword')
    assert.ok(record, '要有历史记录')
    assert.ok(record.pixel_prompt_added.length > 0, '要记下补进去的网格约束')
    assert.match(record.prompt, /一把像素风的剑/)
  } finally {
    await h.cleanup()
    await upstream.close()
  }
})

test('出图：pixel_prompt=false 时不改提示词（可关）', async () => {
  let seenBody = null
  const upstream = await startServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
    }
    res.writeHead(404); res.end('{}')
  })
  const h = await toolHarness()
  try {
    await h.call(T.config, {
      action: 'set_profile',
      profile: { id: 'px2', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-t', model: 'gpt-image-2', pricePerImage: 0 },
    })
    await h.call(T.config, { action: 'set_active', profile_id: 'px2' })
    const result = await h.call(T.generate, {
      prompt: 'plain cat', project: 'pxproj', name: 'cat', n: 1, size: '1024x1024', quality: 'low', confirm: true,
      pixel: { width: 32 }, pixel_prompt: false,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(seenBody.prompt, 'plain cat', '关掉之后提示词必须原样')
  } finally {
    await h.cleanup()
    await upstream.close()
  }
})

/* ---------------- 合集图：逐格像素化 ---------------- */

/** 造一张 2×2 的合成合集图：每格 8×8 逻辑像素，整体放大 k 倍。 */
function syntheticSheet(k = 6) {
  const cellLogical = 8
  const sheetLogical = cellLogical * 2
  const art = paletteArt(sheetLogical, sheetLogical, { seed: 71, colors: 10 })
  const big = nearestUpscale(art.pixels, art.width, art.height, art.width * k, art.height * k)
  return { ...big, cellLogical, palette: art.palette }
}

test('合集图：整图一次像素化 → 每格正好是给定的逻辑像素数', () => {
  const sheet = syntheticSheet(6) // 96×96
  const decoded = decodePngRgba(encodePngRgba(sheet.width, sheet.height, sheet.pixels))
  const sliced = computeSlices({
    decoded, items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    columns: 2, rows: 2, trim: false, clean: false,
    pixel: { width: 8, height: 8, palette: 10 },
  })
  assert.equal(sliced.ok, true, sliced.error)
  assert.ok(sliced.pixel, '要回报像素化统计')
  assert.equal(sliced.pixel.logical.width, 16, '整图逻辑宽 = 列数 × 每格逻辑宽')
  assert.equal(sliced.pixel.logical.height, 16)
  assert.equal(sliced.slices.length, 4)
  for (const slice of sliced.slices) {
    assert.equal(slice.width, 8, `${slice.name} 每格应正好 8 逻辑像素宽，实际 ${slice.width}`)
    assert.equal(slice.height, 8)
  }
  assert.ok(sliced.pixel_purity, '要给出真像素判定')
  assert.equal(sliced.pixel_purity.aa.pixels, 0, '逐格产物不该有抗锯齿像素')
  assert.ok(sliced.pixel_purity.colors.count <= 10, `调色板应 ≤10 色，实际 ${sliced.pixel_purity.colors.count}`)
})

test('合集图：给了目标尺寸时用整数倍放大（否则格子里像素不等大）', () => {
  const sheet = syntheticSheet(6)
  const decoded = decodePngRgba(encodePngRgba(sheet.width, sheet.height, sheet.pixels))
  const sliced = computeSlices({
    decoded, items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    columns: 2, rows: 2, trim: false, clean: false,
    pixel: { width: 8, height: 8, palette: 10 },
    targetWidth: 20, targetHeight: 20, // 8 → 20 自然倍率 2.5（非整数）→ 必须降到 2
  })
  assert.equal(sliced.ok, true, sliced.error)
  const first = sliced.slices[0]
  assert.equal(first.width, 20)
  assert.equal(first.fitted.width, 16, '应画到 16（8×2 整数倍），居中在 20 里')
  assert.equal(first.fitted.offsetX, 2)
  // 内容区每个 2×2 块必须同色
  assert.equal(blocksUniform(first.pixels, 20, 20, 2, { x: 2, y: 2, w: 16, h: 16 }), true,
    '整数倍放大后每个逻辑像素应占 2×2 个物理像素')
})

test('回归：默认路径（clean=true + trim=true）下逐格像素化不能崩', () => {
  // 真实 bug：像素化之后 work 变成 Uint8ClampedArray（不是 Buffer），
  // 而格子卫生的快照/回滚用了 Buffer 专有的 .copy() → TypeError。
  // 这个坑只在 clean+trim 同时开启时炸，而**那正好是默认值**；
  // 更糟的是当时的测试全都传了 clean:false，于是带着一个必崩的默认路径过了测试。
  const sheet = syntheticSheet(6)
  const decoded = decodePngRgba(encodePngRgba(sheet.width, sheet.height, sheet.pixels))
  const sliced = computeSlices({
    decoded, items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    columns: 2, rows: 2,
    // 不传 trim/clean → 走默认（都是 true）
    pixel: { width: 8, height: 8, palette: 10 },
  })
  assert.equal(sliced.ok, true, `默认路径必须能跑通：${sliced.error}`)
  assert.ok(sliced.pixel, '要回报像素化统计')
  assert.equal(sliced.slices.length, 4)
  for (const slice of sliced.slices) {
    assert.ok(slice.width > 0 && slice.height > 0, `${slice.name} 尺寸必须有效`)
    assert.ok(slice.pixels.length === slice.width * slice.height * 4, `${slice.name} 像素数要对得上`)
  }
})

test('合集图：格子不是正方形时，逻辑高按格子宽高比推（像素必须正方形）', () => {
  // 格子 96×64（3:2），只给每格逻辑宽 16 → 高必须是 11 而不是 16，
  // 否则块会变成 6×4 的长方形 —— 那不是像素，是拉伸。
  const k = 4
  const art = paletteArt(24, 16, { seed: 83, colors: 8 })
  const big = nearestUpscale(art.pixels, art.width, art.height, art.width * k, art.height * k) // 96×64
  const decoded = decodePngRgba(encodePngRgba(big.width, big.height, big.pixels))
  const sliced = computeSlices({
    decoded, items: [{ name: 'a' }], columns: 1, rows: 1, trim: false, clean: false,
    pixel: { width: 16, palette: 8 },
  })
  assert.equal(sliced.ok, true, sliced.error)
  assert.ok(sliced.pixel, '要回报像素化统计')
  const [w, h] = sliced.pixel.per_cell.split('×').map(Number)
  assert.equal(w, 16)
  assert.equal(h, Math.max(1, Math.round(16 * (64 / 96))), `逻辑高应按格子宽高比推，实际 ${h}`)
  // 关键：横竖块尺寸必须接近相等（像素是正方形而不是长方形）
  const pitchX = 96 / w
  const pitchY = 64 / h
  assert.ok(Math.abs(pitchX - pitchY) < 0.7, `块应接近正方形：${pitchX.toFixed(2)}×${pitchY.toFixed(2)}`)
})

test('合集图：没给 pixel 时行为与以前完全一致（纯加法改动）', () => {
  const sheet = syntheticSheet(6)
  const decoded = decodePngRgba(encodePngRgba(sheet.width, sheet.height, sheet.pixels))
  const base = {
    decoded, items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    columns: 2, rows: 2, trim: false, clean: false,
  }
  const withoutPixel = computeSlices(base)
  assert.equal(withoutPixel.ok, true)
  assert.equal(withoutPixel.pixel, null, '没开 pixel 就不该有像素化统计')
  assert.equal(withoutPixel.pixel_purity, null)
  // 固定格子、不 trim → 每格 = 原图格子尺寸
  for (const slice of withoutPixel.slices) {
    assert.equal(slice.width, 48)
    assert.equal(slice.height, 48)
  }
})

test('合集图：像素化失败时回退到旧行为并留下原因（不阻断切图）', () => {
  // 用一张平滑插画当合集图：像素化必然拒绝（没有网格），但切图本身要照常完成
  const smooth = smoothIllustration(96, 96)
  const decoded = decodePngRgba(encodePngRgba(smooth.width, smooth.height, smooth.pixels))
  const sliced = computeSlices({
    decoded, items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    columns: 2, rows: 2, trim: false, clean: false,
    pixel: true, // true = 自动检测网格 → 平滑图会拒绝
  })
  assert.equal(sliced.ok, true, '切图不能因为像素化失败而失败')
  assert.equal(sliced.pixel, null, '没做成就不该报统计')
  assert.ok(sliced.warnings.some((w) => w.includes('像素化跳过')), `要有明确原因，实际 ${JSON.stringify(sliced.warnings)}`)
  for (const slice of sliced.slices) assert.equal(slice.width, 48, '回退到固定格子')
})


test('spec：normalizePixelOptions 三种写法都能归一化，缺高按宽高比补', () => {
  assert.equal(normalizePixelOptions(false), null)
  assert.deepEqual(normalizePixelOptions(true).auto, true)
  assert.deepEqual(normalizePixelOptions('auto').auto, true)
  // 只给宽 → 按原图宽高比补高（原图 200×100，宽 32 → 高 16）
  const derived = normalizePixelOptions({ width: 32 }, { width: 200, height: 100 })
  assert.equal(derived.options.logicalWidth, 32)
  assert.equal(derived.options.logicalHeight, 16)
  assert.equal(derived.auto, false)
  // 显式给全 + 其它参数
  const full = normalizePixelOptions({ width: 48, height: 32, palette: 8, method: 'mode', aaPasses: 2 })
  assert.deepEqual(full.options, { logicalWidth: 48, logicalHeight: 32, palette: 8, method: 'mode', aaPasses: 2 })
})

test('spec：内置 pixel 规格是「逻辑 32×32 → 成品 64×64，16 色」', () => {
  const spec = DEFAULT_SPECS.pixel
  assert.equal(spec.width, 64)
  assert.equal(spec.height, 64)
  assert.equal(spec.pixel.width, 32)
  assert.equal(spec.pixel.height, 32)
  assert.equal(spec.pixel.palette, 16)
})

test('spec：applySpecFixes 带 pixel 时输出正好是目标尺寸，并跳过去毛边/锐化', () => {
  const art = logicalArt(48, 32, 5)
  const big = upscaleNearest(art, 4) // 192×128
  const png = encodePngRgba(big.width, big.height, big.pixels)
  const spec = { width: 96, height: 64, alpha: 'any', pixel: { width: 48, height: 32, palette: 16 } }
  const fixed = applySpecFixes({ buffer: png, spec })
  assert.equal(fixed.ok, true, fixed.error)
  assert.equal(fixed.width, 96, `最终尺寸应归一到 96，实际 ${fixed.width}`)
  assert.equal(fixed.height, 64)
  assert.ok(fixed.pixel, '要回报像素化统计')
  assert.equal(fixed.pixel.logical.width, 48)
  assert.ok(fixed.skipped.some((s) => s.includes('去毛边')), '像素画要跳过去毛边')
  assert.ok(fixed.skipped.some((s) => s.includes('锐化')), '像素画要跳过锐化')
  assert.ok(fixed.applied.some((s) => s.includes('像素化')))
  // 解码回来确认颜色数确实被压到调色板以内
  const back = decodePngRgba(fixed.buffer)
  assert.ok(back)
  assert.ok(uniqueColors(back.pixels).colors.length <= 16)
})

test('spec：像素化失败不阻断 —— 正常的去毛边/归一照做，并留下原因', () => {
  const art = smoothIllustration(120, 120) // 没有网格
  const png = encodePngRgba(art.width, art.height, art.pixels)
  const spec = { width: 64, height: 64, alpha: 'any', pixel: true }
  const fixed = applySpecFixes({ buffer: png, spec })
  assert.equal(fixed.ok, true, '像素化失败不能把整个后处理搞挂')
  assert.equal(fixed.width, 64)
  assert.equal(fixed.height, 64)
  assert.equal(fixed.pixel, null, '没做成时不该谎报统计')
  assert.ok(fixed.skipped.some((s) => s.includes('像素化跳过')), `要留下原因，实际 ${JSON.stringify(fixed.skipped)}`)
  assert.ok(fixed.applied.includes('去毛边'), '没像素化时去毛边照做')
})

test('spec：给了显式调色板时，像素化自己不再量化（避免量化两次颜色跑偏）', () => {
  const art = logicalArt(32, 24, 9)
  const big = upscaleNearest(art, 4)
  const png = encodePngRgba(big.width, big.height, big.pixels)
  const fixed = applySpecFixes({
    buffer: png,
    spec: { alpha: 'any', trim: false, sharpen: false, pixel: { width: 32, height: 24, palette: 16 } },
    palette: ['#000000', '#ffffff', '#ff0000'],
  })
  assert.equal(fixed.ok, true, fixed.error)
  assert.ok(fixed.applied.some((s) => s.includes('调色板吸附(3色)')), '显式调色板要生效')
  const back = decodePngRgba(fixed.buffer)
  // 吸附强度 1（像素化时为保持硬边）→ 颜色只应该来自这 3 个
  const colors = uniqueColors(back.pixels).colors
  for (const color of colors) {
    const hex = color.map((v) => v.toString(16).padStart(2, '0')).join('')
    assert.ok(['000000', 'ffffff', 'ff0000'].includes(hex), `出现了调色板外的颜色 #${hex}`)
  }
})

test('工具：quality action=pixelize 默认只预览，apply 后写出 *.pixel.png 且不覆盖原图', async () => {
  const h = await toolHarness()
  try {
    const art = logicalArt(40, 28, 13)
    const big = upscaleNearest(art, 4)
    const dir = path.join(h.outputDir, 'pxproj')
    await mkdir(dir, { recursive: true })
    const input = path.join(dir, 'hero_1.png')
    const buffer = encodePngRgba(big.width, big.height, big.pixels)
    await writeFile(input, buffer)

    // 预览
    const preview = await h.call(T.quality, { action: 'pixelize', file: input, logical_width: 40, palette: 16 })
    assert.equal(preview.ok, true, JSON.stringify(preview).slice(0, 300))
    assert.equal(preview.results[0].written, false)
    assert.equal(preview.results[0].logical, '40×28')
    assert.ok(preview.results[0].colors <= 16)
    assert.equal(preview.results[0].output_file, undefined)

    // 写盘
    const applied = await h.call(T.quality, { action: 'pixelize', file: input, logical_width: 40, palette: 16, apply: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.results[0].written, true)
    assert.match(applied.results[0].output_file, /hero_1\.pixel\.png$/)
    const written = await readFile(applied.results[0].output_file)
    const decodedWritten = decodePngRgba(written)
    assert.equal(decodedWritten.width, 40)
    assert.equal(decodedWritten.height, 28)
    // 原图必须原样还在
    const original = await readFile(input)
    assert.deepEqual([...original], [...buffer], '原图不能被改动')
  } finally {
    await h.cleanup()
  }
})

test('工具：pixelize 自动检测失败时给出可执行的提示（而不是只说失败）', async () => {
  const h = await toolHarness()
  try {
    const art = smoothIllustration(96, 96)
    const dir = path.join(h.outputDir, 'nopx')
    await mkdir(dir, { recursive: true })
    const input = path.join(dir, 'painting_1.png')
    await writeFile(input, encodePngRgba(art.width, art.height, art.pixels))

    const result = await h.call(T.quality, { action: 'pixelize', file: input })
    assert.equal(result.ok, false, '没有网格就该拒绝')
    assert.equal(result.succeeded, 0)
    assert.match(result.results[0].error, /没检测到明显的像素网格/)
    assert.match(result.results[0].hint, /logical_width/, '要告诉用户下一步怎么走')
  } finally {
    await h.cleanup()
  }
})

test('工具：pixelize 就是不给目标也能跑（dry-run 不写盘）', async () => {
  const h = await toolHarness()
  try {
    const result = await h.call(T.quality, { action: 'pixelize', file: 'D:\\definitely\\not\\here.png' })
    // 读不到文件 → 明确失败，不抛异常
    assert.equal(result.ok, false)
    assert.equal(result.results[0].ok, false)
    assert.match(result.results[0].error, /读不到文件/)
  } finally {
    await h.cleanup()
  }
})

test('工具：pixelize 没有可用目标时说明怎么给目标', async () => {
  const h = await toolHarness()
  try {
    const result = await h.call(T.quality, { action: 'pixelize' })
    assert.equal(result.ok, false)
    assert.match(result.error, /没找到要处理的图/)
  } finally {
    await h.cleanup()
  }
})

test('回归：assetFingerprint 加了 pixel 之后，老指纹必须逐位不变（否则会重复花钱）', () => {
  // 为什么这条重要：指纹参与「这张图以前出过没有」的去重。如果加 pixel 字段时无条件多拼一段，
  // 所有历史指纹都会失效 → 以前出过的图被判成没出过 → 重新生成一遍 = 真金白银重复花一次。
  const legacy = sha256(['prof', 'model-x', '一枚硬币', '1024x1024', '', 'low', 'image'].join('|')).slice(0, 20)
  const withoutPixel = assetFingerprint({
    profileId: 'prof', model: 'model-x', prompt: '一枚硬币', size: '1024x1024', ratio: '', quality: 'low', kind: 'image',
  })
  assert.equal(withoutPixel, legacy, '不传 pixel 时必须与老算法完全一致')
  assert.equal(withoutPixel, assetFingerprint({
    profileId: 'prof', model: 'model-x', prompt: '一枚硬币', size: '1024x1024', ratio: '', quality: 'low', kind: 'image', pixel: undefined,
  }))
  // 传了 pixel 才是新指纹，而且不同 pixel 设置必须区分开（否则「先普通出图再加 pixel 重跑」会被跳过）
  const withPixel = assetFingerprint({
    profileId: 'prof', model: 'model-x', prompt: '一枚硬币', size: '1024x1024', ratio: '', quality: 'low', kind: 'image',
    pixel: { width: 32 },
  })
  const withOtherPixel = assetFingerprint({
    profileId: 'prof', model: 'model-x', prompt: '一枚硬币', size: '1024x1024', ratio: '', quality: 'low', kind: 'image',
    pixel: { width: 48 },
  })
  assert.notEqual(withPixel, legacy)
  assert.notEqual(withPixel, withOtherPixel)
})

test('回归：批量路径（assets=[...]，工具描述里的★推荐用法）必须把 pixel 传下去', () => {
  // 真实 bug：normalizeBatchAssets 是显式白名单，pixel 没在里面 → 走批量时**静默忽略** pixel，
  // 用户以为要的是像素画，拿到的却是普通插画，而且没有任何报错。
  const profile = { id: 'p', model: 'm' }
  const fromTop = normalizeBatchAssets({ assets: ['一枚硬币'], pixel: { width: 32 } }, profile)
  assert.deepEqual(fromTop[0].pixel, { width: 32 }, '顶层 pixel 要下发到每个素材')
  const perAsset = normalizeBatchAssets({ assets: [{ name: 'coin', prompt: 'x', pixel: true }], pixel: { width: 32 } }, profile)
  assert.equal(perAsset[0].pixel, true, '素材自己的 pixel 优先于顶层')
  // 指纹要随 pixel 变，否则「先普通出图再补 pixel 重跑」会被去重直接跳过
  const plain = normalizeBatchAssets({ assets: ['一枚硬币'] }, profile)
  assert.notEqual(fromTop[0].fp, plain[0].fp, 'pixel 必须进指纹')
})

/* ---------------- 「真像素」判定与强制 ---------------- */

test('真像素：整数倍最近邻放大被判定为纯，方块边长 = 倍率', () => {
  const art = logicalArt(24, 16, 31)
  for (const k of [2, 3, 4]) {
    const big = nearestUpscale(art.pixels, art.width, art.height, art.width * k, art.height * k)
    const purity = pixelPurity({ pixels: big.pixels, width: big.width, height: big.height, checkAA: true })
    assert.equal(purity.block.size, k, `${k}× 放大应测出方块边长 ${k}，实际 ${purity.block.size}`)
    assert.equal(uniformBlockSize(big.pixels, big.width, big.height), k)
    assert.equal(purity.pure, true, `${k}× 应该是真像素：${JSON.stringify(purity.reasons)}`)
    assert.equal(purity.aa.pixels, 0, '最近邻放大不该有抗锯齿像素')
  }
})

test('真像素：原生分辨率的像素画**不能**被误判（它本来就没有大于 1 的方块）', () => {
  // 关键回归：第一版的周期判据把「分块同色」写成了「周期重复」，
  // 于是 2× 最近邻放大被判成"没有整数方块结构"；修完之后还要保证
  // 原生分辨率（32×32 直接交付）也不被误判 —— 它靠"无 AA + 有限色板"保证纯度。
  const art = paletteArt(32, 32, { seed: 17, colors: 12 })
  const purity = pixelPurity({ pixels: art.pixels, width: 32, height: 32 })
  assert.equal(purity.block.size, 1, '原生分辨率测不出大于 1 的方块')
  assert.equal(purity.pure, true, `原生像素画必须判为纯：${JSON.stringify(purity.reasons)}`)
  assert.ok(purity.aa.ratio < 0.02, `混合色比例应低于阈值，实际 ${purity.aa.ratio}`)
})

test('反例：每像素随机色的噪点**不是**像素画（颜色数失控）', () => {
  // 这一条把"色板纪律"钉住：光靠抗锯齿判据抓不住噪点（随机三元色偶尔真共线），
  // 必须靠"颜色数相对上限"来抓。所以两条判据是互补的，不是替代关系。
  const art = logicalArt(32, 32, 17) // 每像素随机色 → 约 200+ 种颜色
  const withLimit = pixelPurity({ pixels: art.pixels, width: 32, height: 32, paletteLimit: 16 })
  assert.equal(withLimit.colors.count > 16, true, `随机色应该超过 16 色，实际 ${withLimit.colors.count}`)
  assert.equal(withLimit.pure, false, '颜色数超限必须判不纯')
  assert.ok(withLimit.reasons.some((r) => r.includes('颜色数')), JSON.stringify(withLimit.reasons))
})

test('真像素：居中留透明边不算不纯（均匀性要在内容框里看）', () => {
  const art = logicalArt(20, 12, 23)
  const k = 3
  const up = nearestUpscale(art.pixels, art.width, art.height, art.width * k, art.height * k)
  // 放进一张更大的画布，居中，四周透明
  const W = up.width + 9
  const H = up.height + 7
  const canvas = new Uint8ClampedArray(W * H * 4)
  const ox = 4
  const oy = 3
  for (let y = 0; y < up.height; y++) {
    for (let x = 0; x < up.width; x++) {
      const src = (y * up.width + x) * 4
      const dst = ((oy + y) * W + (ox + x)) * 4
      for (let c = 0; c < 4; c++) canvas[dst + c] = up.pixels[src + c]
    }
  }
  const purity = pixelPurity({
    pixels: canvas, width: W, height: H,
    logicalWidth: art.width, logicalHeight: art.height,
  })
  assert.equal(purity.pure, true, `居中留边不该判为不纯：${JSON.stringify(purity.reasons)}`)
  assert.equal(purity.block.size, k, '内容框里应该测出 3× 方块')
})

test('真像素：非整数倍缩放会被抓出来（这正是"像素不等大"的根源）', () => {
  const art = logicalArt(20, 20, 29)
  // 用盒式缩放做成 45×45（2.25 倍）—— 每个"像素"占 2.25 个物理像素，大小不一
  const target = 45
  const pixels = new Uint8ClampedArray(target * target * 4)
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      const sx = Math.min(art.width - 1, Math.floor((x * art.width) / target))
      const sy = Math.min(art.height - 1, Math.floor((y * art.height) / target))
      const src = (sy * art.width + sx) * 4
      const dst = (y * target + x) * 4
      for (let c = 0; c < 4; c++) pixels[dst + c] = art.pixels[src + c]
    }
  }
  const withLogical = pixelPurity({ pixels, width: target, height: target, logicalWidth: 20, logicalHeight: 20 })
  assert.equal(withLogical.pure, false, '2.25 倍必须判为不纯')
  assert.ok(withLogical.reasons.some((r) => r.includes('整数倍')), JSON.stringify(withLogical.reasons))
  // 期望 2 倍时也要抓出来（边长 1 也能"整除" 2，但那是根本没放大）
  const withExpect = pixelPurity({ pixels, width: target, height: target, expectBlock: 2 })
  assert.equal(withExpect.pure, false, '期望 2× 但每个 2×2 块不同色，必须判不纯')
})

test('真像素：抗锯齿混合色会被抓出来', () => {
  const art = logicalArt(16, 12, 37)
  const k = 4
  const big = nearestUpscale(art.pixels, art.width, art.height, art.width * k, art.height * k)
  const clean = pixelPurity({ pixels: big.pixels, width: big.width, height: big.height })
  assert.equal(clean.aa.pixels, 0)
  assert.equal(clean.pure, true)
  // 加一层 1px 抗锯齿（块边界取两侧均值）
  big.pixels.set(addAntiAliasing(big, k))
  const aa = pixelPurity({ pixels: big.pixels, width: big.width, height: big.height })
  assert.ok(aa.aa.pixels > 0, '应该数出抗锯齿像素')
  assert.equal(aa.pure, false, '有抗锯齿就不该判为真像素')
  assert.ok(aa.reasons.some((r) => r.includes('抗锯齿')), JSON.stringify(aa.reasons))
  assert.ok(aa.score < clean.score, '分数要下降')
})

test('真像素：半透明 alpha 会被抓出来（除非显式允许软边）', () => {
  const art = logicalArt(8, 8, 41)
  const k = 2
  const big = nearestUpscale(art.pixels, art.width, art.height, art.width * k, art.height * k)
  for (let p = 3; p < big.pixels.length; p += 4) big.pixels[p] = 128 // 全半透明
  const strict = pixelPurity({ pixels: big.pixels, width: big.width, height: big.height })
  assert.equal(strict.pure, false)
  assert.ok(strict.reasons.some((r) => r.includes('半透明')))
  const soft = pixelPurity({ pixels: big.pixels, width: big.width, height: big.height, allowSoftAlpha: true })
  assert.equal(soft.alpha.ok, true)
})

test('真像素：声明的调色板外有像素会被抓出来', () => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    pixels[i * 4] = 10; pixels[i * 4 + 1] = 20; pixels[i * 4 + 2] = 30; pixels[i * 4 + 3] = 255
  }
  // 一个板外像素
  pixels[0] = 200; pixels[1] = 200; pixels[2] = 200
  const purity = pixelPurity({ pixels, width: 4, height: 4, palette: ['#0a141e', '#ffffff'] })
  assert.equal(purity.pure, false, '板外像素必须被抓出来')
  assert.equal(purity.colors.outside, 1)
  assert.ok(purity.colors.outsideRatio > 0)
})

test('强制：色板 + alpha + 几何三项都能被修成真像素', () => {
  const art = logicalArt(20, 20, 43)
  // 造一张「2.25 倍最近邻 + 半透明 + 多色」的脏图
  const target = 45
  const dirty = new Uint8ClampedArray(target * target * 4)
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      const sx = Math.min(art.width - 1, Math.floor((x * art.width) / target))
      const sy = Math.min(art.height - 1, Math.floor((y * art.height) / target))
      const src = (sy * art.width + sx) * 4
      const dst = (y * target + x) * 4
      for (let c = 0; c < 3; c++) dirty[dst + c] = art.pixels[src + c]
      dirty[dst + 3] = 200 // 半透明
    }
  }
  const fixed = enforcePixelPurity({
    pixels: dirty, width: target, height: target,
    logicalWidth: 20, logicalHeight: 20, paletteLimit: 8,
  })
  assert.ok(fixed.applied.length > 0, '应该报告做了哪些修复')
  assert.equal(fixed.purity.alpha.ok, true, 'alpha 必须被二值化')
  assert.ok(fixed.purity.colors.count <= 8, `颜色数应 ≤8，实际 ${fixed.purity.colors.count}`)
  assert.equal(fixed.purity.pure, true, `修完必须是真的真像素：${JSON.stringify(fixed.purity.reasons)}`)
  // 修完的图必须是整数倍均匀方块
  assert.ok(fixed.purity.block.size >= 2, `应该有整数方块，实际 ${fixed.purity.block.size}`)
})

test('缩放：integerScale 把放大降到整数倍（像素画唯一能接受的放大方式）', () => {
  const art = logicalArt(30, 30, 47)
  // 30 → 64：自然倍率 2.13（非整数）→ 必须降到 2 倍
  const pixelPerfect = fitToTarget({
    pixels: art.pixels, width: 30, height: 30, targetWidth: 64, targetHeight: 64, integerScale: true,
  })
  assert.equal(pixelPerfect.width, 64)
  assert.equal(pixelPerfect.integer_scale, 2, `应降到 2 倍，实际 ${pixelPerfect.integer_scale}`)
  // 内容 60×60 居中 → 每个 2×2 块同色
  const box = { x: 2, y: 2, w: 60, h: 60 }
  assert.equal(blocksUniform(pixelPerfect.pixels, 64, 64, 2, box), true, '整数倍放大必须块块同色')
  assert.equal(pixelPurity({
    pixels: pixelPerfect.pixels, width: 64, height: 64, logicalWidth: 30, logicalHeight: 30,
  }).pure, true)

  // 对照：不开启时是 2.13 倍 → 方块大小不一
  const naive = fitToTarget({ pixels: art.pixels, width: 30, height: 30, targetWidth: 64, targetHeight: 64 })
  assert.equal(naive.integer_scale, null)
  const naiveBox = { x: 2, y: 2, w: 60, h: 60 }
  assert.equal(blocksUniform(naive.pixels, 64, 64, 2, naiveBox), false,
    '非整数倍缩放必然导致每个"像素"不等大 —— 这正是要避免的')
})

test('缩放：目标比逻辑分辨率还小时如实标记做不到整数倍（不假装）', () => {
  const art = logicalArt(40, 40, 51)
  const shrunk = fitToTarget({
    pixels: art.pixels, width: 40, height: 40, targetWidth: 20, targetHeight: 20, integerScale: true,
  })
  assert.equal(shrunk.integer_scale, 0, '缩小做不到整数倍，必须标记为 0 而不是假装成功')
})

test('端到端：spec 管线交付的成品必须是 pure:true（这是"以后像素都是真像素"的验收点）', () => {
  const art = logicalArt(48, 32, 53)
  const big = upscaleNearest(art, 4) // 192×128 的伪像素图
  const png = encodePngRgba(big.width, big.height, big.pixels)
  // 30 的逻辑宽 → 目标 90 是 3 倍（整数）；故意用 100（非整数）来逼出整数倍逻辑
  const fixed = applySpecFixes({
    buffer: png,
    spec: { width: 100, height: 66, alpha: 'any', trim: false, pixel: { width: 48, palette: 16 } },
  })
  assert.equal(fixed.ok, true, fixed.error)
  assert.ok(fixed.purity, '像素化后必须给出真像素判定')
  assert.equal(fixed.purity.pure, true,
    `管线交付的成品必须是真像素，实际：${JSON.stringify(fixed.purity.reasons)}｜skipped=${JSON.stringify(fixed.skipped)}`)
  assert.ok(fixed.applied.some((s) => s.includes('整数倍')), `应有整数倍缩放：${JSON.stringify(fixed.applied)}`)
  // 独立复核一遍（不信任管线自报）
  const back = decodePngRgba(fixed.buffer)
  const recheck = pixelPurity({ pixels: back.pixels, width: back.width, height: back.height })
  assert.ok(recheck.aa.pixels === 0, '成品不该有抗锯齿像素')
  assert.ok(recheck.block.size >= 2, '成品必须是整数倍均匀方块')
})

test('端到端：像素化后普通去毛边/锐化确实被跳过（否则会把硬边和色板毁掉）', () => {
  const art = logicalArt(32, 16, 59)
  const big = upscaleNearest(art, 4)
  const fixed = applySpecFixes({
    buffer: encodePngRgba(big.width, big.height, big.pixels),
    spec: { alpha: 'any', trim: false, pixel: { width: 32, palette: 16 } },
  })
  assert.equal(fixed.ok, true)
  assert.ok(fixed.skipped.some((s) => s.includes('去毛边')))
  assert.ok(fixed.skipped.some((s) => s.includes('锐化')))
  assert.ok(!fixed.applied.includes('边缘锐化'), '锐化绝不能出现在像素画的 applied 里')
})

test('幂等：已经是真像素的图再跑一次管线不会被二次劣化', () => {
  // README 里写了「幂等」，这里把它验成事实而不是说法。
  const art = paletteArt(32, 24, { seed: 67, colors: 12 })
  const big = nearestUpscale(art.pixels, art.width, art.height, art.width * 4, art.height * 4)
  const spec = { width: 128, height: 96, alpha: 'any', trim: false, pixel: { width: 32, height: 24, palette: 12 } }

  const first = applySpecFixes({ buffer: encodePngRgba(big.width, big.height, big.pixels), spec })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.purity.pure, true, JSON.stringify(first.purity.reasons))

  // 把第一次的产物当作输入再跑一次完全一样的管线
  const second = applySpecFixes({ buffer: first.buffer, spec })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.width, first.width)
  assert.equal(second.height, first.height)
  assert.equal(second.purity.pure, true, `第二次也必须还是真像素：${JSON.stringify(second.purity.reasons)}`)
  // 逐像素必须完全一致（同尺寸 → 直接比）
  const a = decodePngRgba(first.buffer)
  const b = decodePngRgba(second.buffer)
  assert.deepEqual([...b.pixels], [...a.pixels], '再跑一次不该改变任何像素')
})

test('方法：median / mean / mode / kmeans / dominant 都能跑通，且均匀块下结果一致', () => {

  const art = logicalArt(8, 8, 61)
  const big = upscaleNearest(art, 4)
  const grid = detectGrid(big.pixels, big.width, big.height, { minPeriod: 3, maxPeriod: 40 })
  assert.equal(grid.ok, true, grid.reason)
  for (const method of ['median', 'mean', 'mode', 'kmeans', 'dominant']) {
    const out = extractBlocks(big.pixels, big.width, big.height, grid, { method })
    assert.equal(out.width, 8, method)
    for (let i = 0; i < 64; i++) {
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(out.pixels[i * 4 + c] - art.pixels[i * 4 + c]) <= 1,
          `${method}：第 ${i} 像素第 ${c} 通道偏差过大`)
      }
    }
  }
})
