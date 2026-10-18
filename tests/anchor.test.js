/**
 * 锚点图 + 循环点检测测试。
 *
 * 这两步是"图 → 视频 → 抽帧"流程里最容易被手工搞错的两个环节：
 *   ① 锚点裁错（裁到旁边的变体、尺寸不对、背景不一致）→ 后面每一帧都歪
 *   ② 循环点没找对 → 播到头会顿一下
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'
import { anchorFromSheet, findLoopPoint } from '../lib/anchor.js'

/** 造一张"素材表"：平涂底 + 若干个方块当单位。 */
function makeSheet({ width = 200, height = 100, bg = [143, 151, 135], units = [[10, 20, 30, 60], [80, 20, 30, 60]] } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = bg[0]; pixels[i * 4 + 1] = bg[1]; pixels[i * 4 + 2] = bg[2]; pixels[i * 4 + 3] = 255
  }
  for (const [bx, by, bw, bh] of units) {
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        const i = (y * width + x) * 4
        pixels[i] = 220; pixels[i + 1] = 90; pixels[i + 2] = 60; pixels[i + 3] = 255
      }
    }
  }
  return encodePngRgba(width, height, pixels)
}

/* ---------------- anchor ---------------- */

test('锚点：能从素材表里裁出**一个**单位，并居中放到目标尺寸', () => {
  const sheet = makeSheet({ units: [[10, 20, 30, 60], [80, 20, 30, 60]] })
  const r = anchorFromSheet({ buffer: sheet, targetWidth: 200, targetHeight: 120, index: 0 })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.units, 2, '应认到 2 个单位')
  assert.equal(r.width, 200)
  assert.equal(r.height, 120)
  // 裁出来的是第一个（x=10 那个），左上角应该是背景色
  const out = decodePngRgba(r.buffer)
  const at = (x, y) => {
    const i = (y * out.width + x) * 4
    return [out.pixels[i], out.pixels[i + 1], out.pixels[i + 2]]
  }
  assert.deepEqual(at(1, 1), [143, 151, 135], '画布角落应是背景色')
  // 中间应该有前景
  let fg = 0
  for (let i = 0; i < out.width * out.height; i++) {
    const i4 = i * 4
    if (Math.abs(out.pixels[i4] - 143) + Math.abs(out.pixels[i4 + 1] - 151) + Math.abs(out.pixels[i4 + 2] - 135) > 60) fg += 1
  }
  assert.ok(fg > 500, `裁出来的图里应有明显前景，实际只有 ${fg} 像素`)
})

test('锚点：index 选不同单位，结果不同（不能总是拿第一个）', () => {
  // 两个单位颜色不同，方便区分
  const width = 200; const height = 100
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = 143; pixels[i * 4 + 1] = 151; pixels[i * 4 + 2] = 135; pixels[i * 4 + 3] = 255
  }
  const paint = (bx, by, bw, bh, color) => {
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        const i = (y * width + x) * 4
        pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]
      }
    }
  }
  paint(10, 20, 30, 60, [220, 90, 60])
  paint(120, 20, 30, 60, [60, 90, 220])
  const sheet = encodePngRgba(width, height, pixels)

  const a = anchorFromSheet({ buffer: sheet, targetWidth: 100, targetHeight: 100, index: 0 })
  const b = anchorFromSheet({ buffer: sheet, targetWidth: 100, targetHeight: 100, index: 1 })
  assert.equal(a.ok, true); assert.equal(b.ok, true)
  const center = (buffer) => {
    const p = decodePngRgba(buffer)
    const i = ((p.height >> 1) * p.width + (p.width >> 1)) * 4
    return [p.pixels[i], p.pixels[i + 1], p.pixels[i + 2]]
  }
  const ca = center(a.buffer); const cb = center(b.buffer)
  assert.ok(ca[0] > ca[2], `第 1 个单位应偏红，实际 ${ca}`)
  assert.ok(cb[2] > cb[0], `第 2 个单位应偏蓝，实际 ${cb}`)
})

test('锚点：素材表里没有前景时明确报错', () => {
  const empty = makeSheet({ units: [] })
  const r = anchorFromSheet({ buffer: empty })
  assert.equal(r.ok, false)
  assert.match(r.error, /没找到任何单位/)
})

/* ---------------- 循环点 ---------------- */

/** 造一帧：色块在指定横向位置。 */
function frameAt(x, size = 64) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let y = 20; y < 50; y++) {
    for (let px = x; px < x + 10; px++) {
      if (px < 0 || px >= size) continue
      const i = (y * size + px) * 4
      pixels[i] = 240; pixels[i + 1] = 100; pixels[i + 2] = 60; pixels[i + 3] = 255
    }
  }
  return encodePngRgba(size, size, pixels)
}

test('循环点：能找出"和首帧最像"的那一帧', () => {
  // 模拟一个周期：位置 5 → 15 → 25 → 35 → 回到 5
  const positions = [5, 12, 19, 26, 33, 5, 12, 19]
  const frames = positions.map((p) => frameAt(p))
  const r = findLoopPoint({ frames, minFrames: 3 })
  assert.equal(r.ok, true, r.error)
  // 第 6 帧（index 5）的位置回到 5，和首帧一样 → 应选它
  assert.equal(r.endIndex, 5, `应选 index 5（位置回到 5），实际 ${r.endIndex}`)
  assert.equal(r.length, 5, '循环长度 = endIndex')
  assert.ok(r.candidates.length > 0, '要给出候选，方便人判断')
})

test('循环点：帧太少时明确报错，不瞎猜', () => {
  const r = findLoopPoint({ frames: [frameAt(5)], minFrames: 4 })
  assert.equal(r.ok, false)
  assert.match(r.error, /帧太少|帧数不够/)
})

test('循环点：完全不走动的帧序列，任意点都"最像"，但结果要落在合法范围', () => {
  const frames = Array.from({ length: 10 }, () => frameAt(20))
  const r = findLoopPoint({ frames, minFrames: 4 })
  assert.equal(r.ok, true, r.error)
  assert.ok(r.endIndex >= 4 && r.endIndex <= 9, `endIndex 要在合法范围内，实际 ${r.endIndex}`)
  assert.ok(r.distance < 0.001, '静止序列的差异应接近 0')
})
