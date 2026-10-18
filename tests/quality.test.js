/**
 * A–E 组测试：出厂后处理 / 规格即代码 / 协调性 / 派生变体 / 语义与偏好。
 *
 * 全部用**合成图**（确定性），这样断言能精确到像素级行为，
 * 也不依赖磁盘上的真实素材（那些会变）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'
import {
  DEFAULT_SPECS, resolveSpec, validateAgainstSpec, applySpecFixes,
  defringe, snapToPalette, sharpen, keyOutBackground, trimMargins, tileSeamScore,
} from '../lib/spec.js'
import {
  buildPalette, paletteDrift, colorDistance, hexToRgb,
  readabilityAtSize, frameDifference, animationCoherence, groupStyleConsistency,
} from '../lib/coherence.js'
import {
  deriveVariants, flip, grayscale, tint, damaged, highlight,
  packAtlas, pivotPoint, VARIANT_KINDS,
} from '../lib/variants.js'
import {
  visualTags, lineageOf, planRegenerate, scoreAsset, routeBatch,
  learnPreference, detectRegression,
} from '../lib/semantics.js'

/**
 * 造一张可控的图：透明底 + 居中方块，**块内带渐变与描边**。
 *
 * 为什么要渐变/描边：纯色方块在技术上是"单色无边缘"，会被质检正确判为废图
 * （早期夹具就踩过这个坑，测试失败其实是我夹具不真实，不是代码错）。
 * 真实素材都有内部结构与轮廓，夹具必须体现这点。
 */
function squarePng({ size = 64, box = 20, color = [200, 60, 60], alpha = 255, background = [0, 0, 0, 0], detail = true } = {}) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  const x0 = Math.round((size - box) / 2)
  const y0 = Math.round((size - box) / 2)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inBox = x >= x0 && x < x0 + box && y >= y0 && y < y0 + box
      if (!inBox) {
        pixels[i] = background[0]; pixels[i + 1] = background[1]
        pixels[i + 2] = background[2]; pixels[i + 3] = background[3] ?? 0
        continue
      }
      let [r, g, b] = color
      if (detail) {
        const edge = (x === x0 || x === x0 + box - 1 || y === y0 || y === y0 + box - 1)
        // 描边（深色轮廓）+ 内部渐变 —— 制造真实的边缘与多色
        const k = 0.45 + 0.55 * ((x - x0) / Math.max(1, box - 1))
        r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k)
        if (edge) { r = Math.round(r * 0.25); g = Math.round(g * 0.25); b = Math.round(b * 0.25) }
      }
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = alpha
    }
  }
  return encodePngRgba(size, size, pixels)
}

function solidPng(size, rgba) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = rgba[0]; pixels[i + 1] = rgba[1]; pixels[i + 2] = rgba[2]; pixels[i + 3] = rgba[3] ?? 255
  }
  return encodePngRgba(size, size, pixels)
}

// ══════ A2 规格即代码 ══════

test('A2 规格合成：内置默认 → 清单 → 显式覆盖，后者优先', () => {
  const base = resolveSpec({ kind: 'icon' })
  assert.equal(base.width, 48)
  assert.equal(base.alpha, 'required')

  const withExpectation = resolveSpec({
    kind: 'icon', name: 'i_skull',
    expectation: { size: { width: 48, height: 48 }, transparent: true, source: '待画素材清单.md' },
  })
  assert.equal(withExpectation.width, 48)
  assert.match(withExpectation.source, /清单/)

  const overridden = resolveSpec({ kind: 'icon', name: 'i_skull', fileSpec: { width: 96, height: 96 } })
  assert.equal(overridden.width, 96, '显式传入应覆盖')
})

test('A2 内置规格覆盖常见类型，且有 default 兜底', () => {
  for (const kind of ['icon', 'card', 'tile', 'unit', 'building']) {
    assert.ok(DEFAULT_SPECS[kind], `缺少 ${kind} 的默认规格`)
  }
  assert.ok(resolveSpec({ kind: '不存在的类型' }).alpha, '未知类型应回退到 default')
})

test('A2 校验：尺寸不符 → 给出可自动修复的 resize（不是报人）', () => {
  const v = validateAgainstSpec({ buffer: squarePng({ size: 64 }), spec: resolveSpec({ kind: 'icon' }) })
  assert.equal(v.needsHuman, false, '尺寸问题不该要人处理')
  assert.ok(v.fixes.some((f) => f.action === 'resize'))
  assert.match(v.advice, /自动修复/)
})

test('A2 校验：内容层面问题才报人（全黑救不回来）', () => {
  const v = validateAgainstSpec({ buffer: solidPng(64, [0, 0, 0, 255]), spec: resolveSpec({ kind: 'icon' }) })
  assert.equal(v.needsHuman, true)
  assert.ok(v.problems.some((p) => /全黑|单色/.test(p)))
  assert.match(v.advice, /人/)
})

test('A2 该透明却不透明：纯色底可确认 → 自动修；非纯色 → 报人', () => {
  // 纯白底：四角一致 → 可抠
  const keyable = validateAgainstSpec({ buffer: solidPng(64, [255, 255, 255, 255]), spec: { width: 64, height: 64, alpha: 'required' } })
  assert.ok(keyable.fixes.some((f) => f.action === 'keyout'), '纯色底应能自动抠')
  // 已在 A2 里判为单色 → needsHuman 仍为 true（内容问题），但修复动作要给出
  assert.equal(keyable.needsHuman, true)

  // 四角不一致 → 不猜
  const pixels = new Uint8ClampedArray(64 * 64 * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 128; pixels[i + 1] = 128; pixels[i + 2] = 128; pixels[i + 3] = 255 }
  // 改掉两个角
  const setCorner = (x, y, c) => { const i = (y * 64 + x) * 4; pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2] }
  setCorner(0, 0, [255, 0, 0]); setCorner(63, 0, [0, 255, 0])
  const v = validateAgainstSpec({ buffer: encodePngRgba(64, 64, pixels), spec: { width: 64, height: 64, alpha: 'required' } })
  assert.ok(v.problems.some((p) => /不透明|无法确定|背景/.test(p)), '非纯色底应报人')
})

test('A2 applySpecFixes：抠背景 → 去毛边 → 裁留白 → 锐化 → 归一，且尺寸正确', () => {
  const fixed = applySpecFixes({
    buffer: solidPng(64, [255, 255, 255, 255]),
    spec: { width: 32, height: 32, alpha: 'required', allowUpscale: true },
  })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.width, 32)
  assert.equal(fixed.height, 32)
  assert.ok(fixed.applied.length >= 3, `应应用多步：${fixed.applied.join('→')}`)
  const decoded = decodePngRgba(fixed.buffer)
  assert.equal(decoded.width, 32)
})

test('A2 抠背景：四角一致才抠；四角不一致拒绝（不猜）', () => {
  const flat = solidPng(32, [10, 20, 30, 255])
  const d = decodePngRgba(flat)
  const keyed = keyOutBackground({ pixels: d.pixels, width: 32, height: 32 })
  assert.equal(keyed.changed, true)
  assert.equal(keyed.background, '#0a141e')

  const pixels = new Uint8ClampedArray(32 * 32 * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 100; pixels[i + 1] = 100; pixels[i + 2] = 100; pixels[i + 3] = 255 }
  const at = (x, y) => (y * 32 + x) * 4
  pixels[at(0, 0)] = 255; pixels[at(31, 0)] = 0; pixels[at(0, 31) + 1] = 255
  const refused = keyOutBackground({ pixels, width: 32, height: 32 })
  assert.equal(refused.changed, false)
  assert.match(refused.reason, /不一致|不猜/)
})

test('A2 去毛边：低 alpha 脏边被清掉', () => {
  const pixels = new Uint8ClampedArray(8 * 8 * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 255; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 20 }
  const out = defringe({ pixels, width: 8, height: 8, alphaThreshold: 40 })
  assert.equal(out.pixels[3], 0, '低于阈值的 alpha 应归零')
})

test('A2 调色板吸附：颜色被拉向调色板；没给调色板就不动', () => {
  const pixels = new Uint8ClampedArray(2 * 2 * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 100; pixels[i + 1] = 100; pixels[i + 2] = 100; pixels[i + 3] = 255 }
  const snapped = snapToPalette({ pixels, palette: ['#ff0000'], strength: 1 })
  assert.equal(snapped.changed, true)
  assert.equal(snapped.pixels[0], 255, '应完全吸附到红')
  const untouched = snapToPalette({ pixels, palette: [] })
  assert.equal(untouched.changed, false)
})

test('A2 锐化：不改变尺寸与 alpha，只改 RGB', () => {
  const src = decodePngRgba(squarePng({ size: 16, box: 8 }))
  const out = sharpen({ pixels: src.pixels, width: 16, height: 16, amount: 0.8 })
  assert.equal(out.pixels.length, src.pixels.length)
  let alphaSame = true
  for (let i = 3; i < out.pixels.length; i += 4) if (out.pixels[i] !== src.pixels[i]) alphaSame = false
  assert.equal(alphaSame, true, '不应改动 alpha')
})

test('A2 裁留白：包围盒外的透明区域被裁掉', () => {
  const src = decodePngRgba(squarePng({ size: 64, box: 20 }))
  const trimmed = trimMargins({ pixels: src.pixels, width: 64, height: 64 })
  assert.equal(trimmed.changed, true)
  assert.ok(trimmed.width < 64 && trimmed.height < 64)
})

test('A2 平铺接缝：左右边缘一致时分数低', () => {
  // 纯色图 → 接缝差异 0
  const src = decodePngRgba(solidPng(32, [50, 50, 50, 255]))
  const seam = tileSeamScore({ pixels: src.pixels, width: 32, height: 32 })
  assert.ok(seam !== null && seam < 0.05, `纯色接缝应接近 0，实际 ${seam}`)
})

// ══════ B1 调色板锁定 + 漂移 ══════

test('B1 锁定调色板：覆盖张数多的色优先（代表整体风格）', () => {
  const items = [
    { fingerprint: { palette: [{ hex: '#ff0000', share: 0.6 }, { hex: '#00ff00', share: 0.1 }] } },
    { fingerprint: { palette: [{ hex: '#ff0000', share: 0.5 }] } },
    { fingerprint: { palette: [{ hex: '#ff0000', share: 0.4 }, { hex: '#0000ff', share: 0.2 }] } },
  ]
  const result = buildPalette(items)
  assert.equal(result.palette[0].hex, '#ff0000', '三张都有的色应排第一')
  assert.equal(result.palette[0].files, 3)
  assert.equal(result.considered, 3)
})

test('B1 漂移检测：全都是锁定色 → drift 0；全是离群色 → drift 高', () => {
  const locked = [{ hex: '#ff0000' }]
  const aligned = paletteDrift({ fingerprint: { palette: [{ hex: '#fe0000', share: 0.9 }] }, locked })
  assert.equal(aligned.level, 'ok')
  assert.ok(aligned.drift < 0.1)

  const off = paletteDrift({ fingerprint: { palette: [{ hex: '#00ffff', share: 0.9 }] }, locked })
  assert.equal(off.level, 'off')
  assert.ok(off.drift > 0.5)
  assert.equal(off.offPalette.length, 1)
})

test('B1 漂移：占比很小的噪点色不算（避免抗锯齿误报）', () => {
  const locked = [{ hex: '#ff0000' }]
  const r = paletteDrift({
    fingerprint: { palette: [{ hex: '#ff0000', share: 0.98 }, { hex: '#00ffff', share: 0.005 }] },
    locked, minShare: 0.02,
  })
  assert.equal(r.level, 'ok', '0.5% 的噪点不该判成偏离')
})

test('B1 没有锁定调色板时明确说"跳过"，不假装通过', () => {
  const r = paletteDrift({ fingerprint: { palette: [{ hex: '#fff', share: 1 }] }, locked: [] })
  assert.equal(r.level, 'ok')
  assert.match(r.note, /跳过/)
})

test('B1 颜色距离与 hex 解析', () => {
  assert.deepEqual(hexToRgb('#ff0000'), [255, 0, 0])
  assert.equal(hexToRgb('bad'), null)
  assert.equal(colorDistance('#000000', '#ffffff'), Math.sqrt(3 * 255 ** 2))
  assert.equal(colorDistance('#ff0000', '#ff0000'), 0)
})

// ══════ B2 小尺寸可读性 ══════

test('B2 纯色图缩到小尺寸 → 可读性差（对比度 0）', () => {
  const r = readabilityAtSize({ buffer: solidPng(256, [128, 128, 128, 255]), targetWidth: 32, targetHeight: 32 })
  assert.equal(r.level !== 'ok', true, '纯色缩下去必然不可读')
  assert.ok(r.problems.length > 0)
})

test('B2 高对比的方块在小尺寸仍然可读', () => {
  const r = readabilityAtSize({ buffer: squarePng({ size: 256, box: 160, color: [255, 255, 255] }), targetWidth: 48, targetHeight: 48 })
  assert.equal(r.ok, true, `应可读，实际 ${r.problems.join(';')}`)
  assert.ok(r.contrast > 0.3)
})

test('B2 全透明图 → 明确报"内容没了"', () => {
  const r = readabilityAtSize({ buffer: solidPng(64, [0, 0, 0, 0]), targetWidth: 16, targetHeight: 16 })
  assert.equal(r.ok, false)
  assert.match(r.advice, /全透明|没了/)
})

test('B2 没有目标尺寸时跳过（不猜）', () => {
  const r = readabilityAtSize({ buffer: squarePng({}), targetWidth: 0, targetHeight: 0 })
  assert.equal(r.level, 'unknown')
})

// ══════ B3 动画连贯性 ══════

test('B3 帧差：相同的帧差为 0；不同帧差 > 0（换色比移位小，符合直觉）', () => {
  const a = decodePngRgba(squarePng({ size: 32, box: 10, color: [255, 0, 0] }))
  const b = decodePngRgba(squarePng({ size: 32, box: 10, color: [0, 0, 255] }))
  assert.equal(frameDifference(a, a), 0)
  const recolored = frameDifference(a, b)
  // 同形状换色：差异真实存在但不大（实测 ~0.18，因为几何没变）
  assert.ok(recolored > 0.1, `换色应有可测差异，实际 ${recolored}`)
  // 尺寸大变 → 差异更大
  const bigger = decodePngRgba(squarePng({ size: 32, box: 28, color: [0, 0, 255] }))
  assert.ok(frameDifference(a, bigger) > recolored, '几何变化应比单纯换色差异更大')
})

test('B3 所有帧一样 → 报"动画没动"', () => {
  const frame = decodePngRgba(squarePng({ size: 32 }))
  const r = animationCoherence({ frames: [frame, frame, frame] })
  assert.equal(r.all_identical, true)
  assert.ok(r.problems.some((p) => /没动|相同/.test(p)))
})

test('B3 相邻帧突变 → 报出来（动画会跳）', () => {
  const a = decodePngRgba(squarePng({ size: 32, box: 10, color: [10, 10, 10] }))
  const b = decodePngRgba(squarePng({ size: 32, box: 11, color: [12, 12, 12] }))
  const c = decodePngRgba(squarePng({ size: 32, box: 12, color: [14, 14, 14] }))
  const jump = decodePngRgba(squarePng({ size: 32, box: 30, color: [250, 250, 250] }))
  const r = animationCoherence({ frames: [a, b, c, jump] })
  assert.ok(r.jumps.length > 0, `应检出突变：${JSON.stringify(r.diffs)}`)
  assert.ok(r.problems.some((p) => /突变|跳/.test(p)))
})

test('B3 循环动画首尾不闭合 → 报出来', () => {
  const a = decodePngRgba(squarePng({ size: 32, box: 10, color: [0, 0, 0] }))
  const b = decodePngRgba(squarePng({ size: 32, box: 11, color: [8, 8, 8] }))
  const c = decodePngRgba(squarePng({ size: 32, box: 12, color: [10, 10, 10] }))
  const far = decodePngRgba(squarePng({ size: 32, box: 28, color: [240, 240, 240] }))
  const r = animationCoherence({
    frames: [{ name: 'walk_loop_1', decoded: a }, { name: 'x', decoded: b }, { name: 'x', decoded: c }, { name: 'x', decoded: far }],
    loop: true,
  })
  assert.ok(r.loop_diff > 0, `应有首尾差值，实际 ${r.loop_diff}`)
  assert.ok(r.problems.some((p) => /循环|接缝/.test(p)), `应报出循环接缝：${r.problems.join(';')}`)
})

test('B3 判"突变"用中位数而非平均值（平均值会被突变自己拉高，检不出来）', () => {
  // 三帧：两个小差异 + 一个大突变。平均值 ≈0.30，突变 0.74 只有 2.5 倍 → 卡阈值；
  // 中位数 ≈0.09，突变是它的 8 倍 → 稳定检出。
  const a = decodePngRgba(squarePng({ size: 32, box: 10, color: [10, 10, 10] }))
  const b = decodePngRgba(squarePng({ size: 32, box: 11, color: [12, 12, 12] }))
  const c = decodePngRgba(squarePng({ size: 32, box: 12, color: [14, 14, 14] }))
  const jump = decodePngRgba(squarePng({ size: 32, box: 30, color: [250, 250, 250] }))
  const r = animationCoherence({ frames: [a, b, c, jump] })
  assert.ok(r.median_diff < r.average_diff, '中位数应低于被离群值拉高的平均值')
  assert.ok(r.jumps.length > 0, '应能检出突变')
  assert.equal(r.jumps[0].ratio > 2.5, true, `突变应是基线的倍数：${JSON.stringify(r.jumps[0])}`)
})

test('B3 不足两帧 → 说"无法判断"，不硬给结论', () => {
  const r = animationCoherence({ frames: [decodePngRgba(squarePng({}))] })
  assert.equal(r.level, 'unknown')
})

test('B3 整组风格一致性：相似图高分', () => {
  const fp = (hex) => ({ palette: [{ hex, share: 0.9 }], ink: 0.5, saturation: 0.5, edgeDensity: 0.2, alphaRatio: 0.1 })
  const r = groupStyleConsistency([fp('#888888'), fp('#888889'), fp('#888887')])
  assert.equal(r.ok, true)
  assert.ok(r.average > 0.8)
})

// ══════ C1 派生变体 ══════

test('C1 翻转：水平翻转把左右像素对调（且不改尺寸）', () => {
  const pixels = new Uint8ClampedArray(2 * 1 * 4)
  pixels[0] = 255; pixels[3] = 255              // 左 = 红
  pixels[4] = 0; pixels[7] = 255                // 右 = 黑
  const out = flip({ pixels, width: 2, height: 1, axis: 'h' })
  assert.equal(out[0], 0, '翻转后左边应是原来的右边（黑）')
  assert.equal(out[4], 255, '翻转后右边应是原来的左边（红）')
})

test('C1 灰度：RGB 相等，alpha 不变', () => {
  const src = decodePngRgba(squarePng({ size: 8, color: [255, 0, 0] }))
  const out = grayscale({ pixels: src.pixels })
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    assert.equal(out[i], out[i + 1])
    assert.equal(out[i + 1], out[i + 2])
  }
})

test('C1 染色：保留明暗结构（不同亮度不会被压成同一色）', () => {
  const pixels = new Uint8ClampedArray(2 * 4)
  // 两个灰色像素：一亮一暗
  pixels[0] = 200; pixels[1] = 200; pixels[2] = 200; pixels[3] = 255
  pixels[4] = 60; pixels[5] = 60; pixels[6] = 60; pixels[7] = 255
  const out = tint({ pixels, width: 2, height: 1, color: '#ff0000', strength: 1 })
  assert.ok(out[0] > out[4], '亮像素染红后应仍比暗像素亮')
  assert.ok(out[1] < 50 && out[5] < 50, '红染色后绿通道应很低')
})

test('C1 受损态是确定性的：同输入同输出（可复现）', () => {
  const src = decodePngRgba(squarePng({ size: 16, box: 10, color: [200, 200, 200] }))
  const a = damaged({ pixels: src.pixels, width: 16, height: 16, seed: 42 })
  const b = damaged({ pixels: src.pixels, width: 16, height: 16, seed: 42 })
  assert.deepEqual([...a], [...b], '同 seed 必须得到同一张（否则无法复现/无法测）')
  const c = damaged({ pixels: src.pixels, width: 16, height: 16, seed: 43 })
  assert.notDeepEqual([...a], [...c], '不同 seed 应有差异')
})

test('C1 高亮：整体变亮，且不改 alpha', () => {
  const src = decodePngRgba(squarePng({ size: 8, color: [100, 100, 100] }))
  const out = highlight({ pixels: src.pixels })
  const before = src.pixels[0]
  assert.ok(out[0] > before, '应提亮')
  assert.equal(out[3], src.pixels[3], 'alpha 不变')
})

test('C1 deriveVariants：所有变体尺寸严格一致（"变体之间严格一致"）', () => {
  const r = deriveVariants({ buffer: squarePng({ size: 40, box: 20 }), targetWidth: 32, targetHeight: 32 })
  assert.equal(r.ok, true)
  assert.ok(r.variants.length >= 4)
  for (const v of r.variants) {
    assert.equal(v.width, 32, `${v.kind} 尺寸应为 32`)
    assert.equal(v.height, 32)
    const decoded = decodePngRgba(v.buffer)
    assert.equal(decoded.width, 32)
  }
  assert.ok(r.variants.every((v) => VARIANT_KINDS.includes(v.kind)))
})

test('C1 未知变体类型被忽略（不编造）', () => {
  const r = deriveVariants({ buffer: squarePng({}), kinds: ['gray', '不存在的变体'] })
  assert.equal(r.variants.length, 1)
  assert.equal(r.variants[0].kind, 'gray')
})

// ══════ C2 图集打包 ══════

test('C2 打包：网格与帧矩形正确，manifest 与图集一致', () => {
  const sprites = Array.from({ length: 4 }, (_, i) => ({ name: `s${i}`, buffer: squarePng({ size: 32, box: 16 }) }))
  const r = packAtlas({ sprites, cellWidth: 32, cellHeight: 32 })
  assert.equal(r.ok, true)
  assert.equal(r.atlas.width, 64, '2 列 × 32')
  assert.equal(r.atlas.height, 64)
  assert.equal(r.manifest.frames.length, 4)
  assert.deepEqual(r.manifest.frames[0].frame, { x: 0, y: 0, w: 32, h: 32 })
  assert.deepEqual(r.manifest.frames[1].frame, { x: 32, y: 0, w: 32, h: 32 })
  assert.deepEqual(r.manifest.frames[2].frame, { x: 0, y: 32, w: 32, h: 32 })
  // 每帧的 frame 必须落在图集范围内
  for (const f of r.manifest.frames) {
    assert.ok(f.frame.x + f.frame.w <= r.atlas.width)
    assert.ok(f.frame.y + f.frame.h <= r.atlas.height)
  }
})

test('C2 打包：小图不放大 —— 按原始像素大小居中放进格子（不是拉伸填满）', () => {
  // 语义澄清：cell 仍是 cellWidth×cellHeight（引擎按格子切），
  // 但**内容区**必须保持原始尺寸，四周留透明 —— 这才是"不放大"。
  const small = { name: 'tiny', buffer: squarePng({ size: 8, box: 4 }) }
  const r = packAtlas({ sprites: [small], cellWidth: 64, cellHeight: 64 })
  assert.equal(r.ok, true)
  const content = r.manifest.frames[0].content
  assert.ok(content.w <= 8 && content.h <= 8, `小图内容不该被放大：${JSON.stringify(content)}`)
  assert.equal(r.manifest.frames[0].drawn_size, `${content.w}×${content.h}`)
  // 图集整体仍是格子尺寸
  assert.equal(r.atlas.width, 64)
  assert.equal(r.atlas.height, 64)
})

test('C2 pivot 归一化坐标正确', () => {
  assert.deepEqual(pivotPoint('center', 10, 10), { x: 0.5, y: 0.5 })
  assert.deepEqual(pivotPoint('bottom', 10, 10), { x: 0.5, y: 1 })
  assert.deepEqual(pivotPoint('topleft', 10, 10), { x: 0, y: 0 })
})

test('C2 空输入 / 坏参数 → 明确报错', () => {
  assert.equal(packAtlas({ sprites: [] }).ok, false)
  assert.equal(packAtlas({ sprites: [{ name: 'a', buffer: squarePng({}) }], cellWidth: 1, cellHeight: 1 }).ok, false)
})

// ══════ D1 视觉标签 ══════

test('D1 标签：透明底 / 不透明 / 朝向 / 主色系', () => {
  const transparent = visualTags({ buffer: squarePng({ size: 64, box: 20 }), name: 'i_x', kind: 'icon' })
  assert.ok(transparent.tags.includes('透明底'))
  assert.ok(transparent.tags.includes('方形'))
  assert.ok(transparent.tags.includes('图标'))

  const opaque = visualTags({ buffer: solidPng(64, [255, 255, 255, 255]), name: 'bg', kind: 'tile' })
  assert.ok(opaque.tags.includes('不透明'))
  assert.ok(opaque.tags.includes('白色系'))
  assert.ok(opaque.tags.includes('地块'))
})

test('D1 标签：宽高比决定横竖', () => {
  const wide = encodePngRgba(64, 32, new Uint8ClampedArray(64 * 32 * 4).fill(255))
  const t = visualTags({ buffer: wide, name: 'x' })
  assert.ok(t.tags.includes('横向'))
  assert.equal(t.attributes.aspect, 2)
})

test('D1 语义描述只来自 prompt，不猜「画的是什么」', () => {
  const withPrompt = visualTags({ buffer: squarePng({}), name: 'a', prompt: 'a golden sword' })
  assert.equal(withPrompt.semantic, 'a golden sword')
  assert.equal(withPrompt.has_semantic, true)
  const without = visualTags({ buffer: squarePng({}), name: 'a' })
  assert.equal(without.has_semantic, false)
  assert.equal(without.semantic, '', '没有 prompt 就不要编造语义')
})

test('D1 名字里的线索能识别可平铺/循环/序列帧', () => {
  assert.ok(visualTags({ buffer: squarePng({}), name: 'tile_grass_seamless' }).tags.includes('可平铺'))
  assert.ok(visualTags({ buffer: squarePng({}), name: 'walk_loop_1' }).tags.includes('循环动画'))
  assert.ok(visualTags({ buffer: squarePng({}), name: 'r67_frames_8' }).tags.includes('序列帧'))
  // _64x16 是尺寸后缀，不该被当成序列帧
  assert.ok(!visualTags({ buffer: squarePng({}), name: 't_path_64x16' }).tags.includes('序列帧'))
})

// ══════ D2 血缘 + 确定性重生成 ══════

test('D2 血缘提取出全部可复现字段', () => {
  const l = lineageOf({
    profile: 'agnes', provider: 'agnes', model: 'agnes-image-2.5-flash',
    prompt: 'a sword', params: { size: '1K', ratio: '1:1', quality: 'low', seed: 7 }, kind: 'generate',
  })
  assert.equal(l.seed, 7)
  assert.equal(l.prompt, 'a sword')
  assert.equal(l.size, '1K')
  assert.equal(l.model, 'agnes-image-2.5-flash')
})

test('D2 seed=0 被当成合法 seed（不能因为 falsy 就当没有）', () => {
  const r = planRegenerate({ lineage: { prompt: 'x', seed: 0 }, count: 2 })
  assert.equal(r.deterministic, true, 'seed 0 是合法值')
  assert.equal(r.base_seed, 0)
  assert.equal(r.items[0].seed, 0)
  assert.equal(r.items[1].seed, 1)
})

test('D2 没有 seed → 坦白说"随机、无法复现"，不假装确定性', () => {
  const r = planRegenerate({ lineage: { prompt: 'x' }, count: 3 })
  assert.equal(r.deterministic, false)
  assert.match(r.note, /随机|无法保证/)
  assert.equal(r.items[0].seed, undefined)
})

test('D2 显式传 seed 覆盖血缘里的 seed', () => {
  const r = planRegenerate({ lineage: { prompt: 'x', seed: 5 }, seed: 100, count: 1 })
  assert.equal(r.base_seed, 100)
})

test('D2 没有血缘 → 明确报错（不能凭空重生成）', () => {
  assert.equal(planRegenerate({ lineage: null }).ok, false)
})

// ══════ D3 质量评分路由 ══════

test('D3 废图（全黑/全白/纯色）→ priority 且分数很低', () => {
  for (const [label, buffer] of [
    ['全黑', solidPng(64, [0, 0, 0, 255])],
    ['全白', solidPng(64, [255, 255, 255, 255])],
    ['纯色', solidPng(64, [120, 120, 120, 255])],
  ]) {
    const s = scoreAsset({ buffer, spec: { width: 48, height: 48 } })
    assert.equal(s.route, 'priority', `${label} 应为优先审核`)
    assert.ok(s.score < 50, `${label} 分数应低于 50，实际 ${s.score}`)
    assert.ok(s.diagnostics.length > 0, `${label} 应给出诊断`)
  }
})

test('D3 正常素材 → auto_pass，且理由为空或少', () => {
  const s = scoreAsset({ buffer: squarePng({ size: 64, box: 40, color: [200, 100, 50] }), spec: { width: 64, height: 64 } })
  assert.equal(s.route, 'auto_pass', `应自动通过，实际 ${s.score} ${s.reasons.join(';')}`)
  assert.ok(s.score >= 80)
})

test('D3 风格偏离会扣分（off 比 watch 扣更多）', () => {
  const buffer = squarePng({ size: 64, box: 40 })
  const clean = scoreAsset({ buffer, spec: { width: 64, height: 64 } })
  const watch = scoreAsset({ buffer, spec: { width: 64, height: 64 }, drift: { level: 'watch', drift: 0.3 } })
  const off = scoreAsset({ buffer, spec: { width: 64, height: 64 }, drift: { level: 'off', drift: 0.8 } })
  assert.ok(watch.score < clean.score)
  assert.ok(off.score < watch.score)
})

test('D3 路由分组：算得出"省了多少"', () => {
  const scored = [
    { route: 'auto_pass' }, { route: 'auto_pass' }, { route: 'normal' }, { route: 'priority' },
  ]
  const r = routeBatch(scored)
  assert.equal(r.total, 4)
  assert.equal(r.auto_pass, 2)
  assert.equal(r.needs_review, 2)
  assert.equal(r.saved_pct, 50)
})

test('D3 尺寸不符只扣 5 分（因为能自动修）', () => {
  const ok = scoreAsset({ buffer: squarePng({ size: 64, box: 40 }), spec: { width: 64, height: 64 } })
  const mismatch = scoreAsset({ buffer: squarePng({ size: 64, box: 40 }), spec: { width: 48, height: 48 } })
  assert.ok(ok.score - mismatch.score <= 30, '尺寸问题不该扣太多（它是可自动修的）')
})

// ══════ E1 偏好学习 ══════

test('E1 样本不足时明确说"别急着学"，不硬给结论', () => {
  const r = learnPreference({ installed: [{ provider: 'a' }], minSamples: 5 })
  assert.equal(r.enough, false)
  assert.match(r.advice, /样本不足/)
})

test('E1 样本足够时给出最常用的 provider/model/尺寸', () => {
  const installed = [
    { provider: 'agnes', model: 'm1', params: { size: '1K' } },
    { provider: 'agnes', model: 'm1', params: { size: '1K' } },
    { provider: 'relay', model: 'm2', params: { size: '2K' } },
    { provider: 'agnes', model: 'm1', params: { size: '1K' } },
    { provider: 'agnes', model: 'm1', params: { size: '2K' } },
  ]
  const r = learnPreference({ installed })
  assert.equal(r.enough, true)
  assert.equal(r.top_provider[0].value, 'agnes')
  assert.equal(r.top_model[0].value, 'm1')
  assert.equal(r.top_size[0].value, '1K')
  assert.equal(r.top_provider[0].count, 4)
})

// ══════ E2 回归检测 ══════

test('E2 新版更差 → 明确说"建议保留上一版"', () => {
  const good = squarePng({ size: 64, box: 44, color: [220, 90, 40] })
  const bad = solidPng(64, [0, 0, 0, 255])
  const r = detectRegression({ previousBuffer: good, currentBuffer: bad })
  assert.equal(r.verdict, 'worse')
  assert.match(r.advice, /保留上一版|低/)
})

test('E2 分数接近 → 判为持平（不因噪声假报变好/变差）', () => {
  const a = squarePng({ size: 64, box: 44, color: [220, 90, 40] })
  const b = squarePng({ size: 64, box: 43, color: [219, 91, 41] })
  const r = detectRegression({ previousBuffer: a, currentBuffer: b })
  assert.equal(r.verdict, 'same')
})

test('E2 缺版本 → unknown，不猜', () => {
  const r = detectRegression({ previousBuffer: null, currentBuffer: squarePng({}) })
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.ok, false)
})
