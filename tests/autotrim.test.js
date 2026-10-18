/**
 * 自动对齐（trim + 居中 + 规格缩放）的回归测试。
 *
 * 这里锁的是一个真实踩过的坑：**包围盒坐标系**。
 * contentBox 返回的是「格内相对坐标」，跨格裁剪必须先用 absoluteBox 转成整图绝对坐标；
 * 混用会导致图标被裁到角落、甚至整张空图（第一版就是这样，测试图里 icon_3/icon_6 全透明）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { absoluteBox, contentBox, cropRegion, fitToTarget } from '../lib/autotrim.js'
import { sliceSheet } from '../lib/sheet.js'
import { decodePngRgba, encodePngRgba } from '../lib/pngcodec.js'

/** 造合集图：每格画一个指定大小/位置的实心块，其它透明。 */
function makeSheet({ width, height, blocks }) {
  const pixels = Buffer.alloc(width * height * 4)
  for (const block of blocks) {
    if (!block) continue
    const [bx, by, bw, bh, color] = block
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const i = (y * width + x) * 4
        pixels[i] = color[0]
        pixels[i + 1] = color[1]
        pixels[i + 2] = color[2]
        pixels[i + 3] = 255
      }
    }
  }
  return encodePngRgba(width, height, pixels)
}

/** 统计一张图的非透明包围盒与覆盖率。 */
function measure(pixels, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 16) {
        count++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, count, coverage: count / (width * height) }
}

test('包围盒坐标系：contentBox 返回格内相对坐标，absoluteBox 才能转成整图坐标', () => {
  const sheetW = 300
  const sheetH = 200
  const pixels = Buffer.alloc(sheetW * sheetH * 4)
  // 第二格（x 100..199）里画一块 (105,5)-(164,44)
  for (let y = 5; y < 45; y++) {
    for (let x = 105; x < 165; x++) {
      const i = (y * sheetW + x) * 4
      pixels[i] = 0
      pixels[i + 1] = 255
      pixels[i + 2] = 0
      pixels[i + 3] = 255
    }
  }
  const cell = { x0: 100, y0: 0, w: 100, h: 100 }
  const found = contentBox(pixels, sheetW, sheetH, cell)
  assert.equal(found.empty, false)
  // 相对坐标：内容在格内第 5 列开始
  assert.equal(found.localBox.minX, 5, 'contentBox 必须是格内相对坐标')
  assert.equal(found.localBox.width, 60)
  // 转绝对坐标后应指向 (105,5)
  const abs = absoluteBox(found.localBox, cell)
  assert.equal(abs.minX, 105, 'absoluteBox 必须加上格子的 x0')
  assert.equal(abs.minY, 5)
  assert.equal(abs.width, 60)
  assert.equal(abs.height, 40)
  // 用绝对坐标裁剪，取到的必须是绿色内容
  const cropped = cropRegion(pixels, sheetW, abs)
  assert.equal(cropped[0], 0)
  assert.equal(cropped[1], 255, '裁出来的第一个像素必须是内容色（若不透明才是对的）')
  assert.equal(cropped[3], 255)
})

test('抗噪：角落的孤立杂点不会把包围盒撑满整格', () => {
  const size = 100
  const pixels = Buffer.alloc(size * size * 4)
  // 主体：中间 20x20
  for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) {
    const i = (y * size + x) * 4
    pixels[i + 3] = 255
  }
  // 角落一个孤立像素
  pixels[(2 * size + 2) * 4 + 3] = 255
  const found = contentBox(pixels, size, size, { x0: 0, y0: 0, w: size, h: size })
  assert.equal(found.empty, false)
  assert.ok(found.localBox.minX >= 38, `包围盒不该被杂点拉到左边（实际 minX=${found.localBox.minX}）`)
  assert.equal(found.dropped >= 1, true, '孤立杂点应被丢掉并计数')
  assert.ok(found.localBox.width <= 30, '包围盒应贴着主体')
})

test('空格子识别：全透明格必须报 empty，不能硬裁成垃圾', () => {
  const size = 64
  const pixels = Buffer.alloc(size * size * 4)
  const found = contentBox(pixels, size, size, { x0: 0, y0: 0, w: size, h: size })
  assert.equal(found.empty, true)
  assert.equal(found.box, null)
})

test('缩放：contain 保持宽高比并居中，四周补透明', () => {
  const width = 60
  const height = 20
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = 255
    pixels[i * 4 + 3] = 255
  }
  const fitted = fitToTarget({ pixels, width, height, targetWidth: 48, targetHeight: 48, mode: 'contain' })
  assert.equal(fitted.width, 48)
  assert.equal(fitted.height, 48)
  const m = measure(fitted.pixels, 48, 48)
  assert.ok(Math.abs((m.minX + m.maxX) / 2 - 23.5) < 1, '水平必须居中')
  assert.ok(Math.abs((m.minY + m.maxY) / 2 - 23.5) < 1, '垂直必须居中')
  assert.ok(Math.abs(m.width / m.height - 3) < 0.3, `宽高比要保持 3:1（实际 ${m.width}:${m.height}）`)
})

test('缩放：stretch 填满目标框', () => {
  const width = 60
  const height = 20
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) pixels[i * 4 + 3] = 255
  const fitted = fitToTarget({ pixels, width, height, targetWidth: 32, targetHeight: 32, mode: 'stretch' })
  const m = measure(fitted.pixels, 32, 32)
  assert.equal(m.width, 32)
  assert.equal(m.height, 32)
})

test('端到端切图：大小不一/位置歪的图标 → 全部居中且按规格输出', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-trim-'))
  try {
    const sheetFile = path.join(dir, 'sheet.png')
    await writeFile(sheetFile, makeSheet({
      width: 300,
      height: 200,
      blocks: [
        [10, 10, 20, 20, [255, 0, 0]],     // 格1：小 + 左上角
        [105, 5, 60, 40, [0, 255, 0]],     // 格2：大 + 偏上
        [230, 85, 30, 15, [0, 0, 255]],    // 格3：右下角
        [5, 120, 40, 60, [255, 255, 0]],   // 格4：左边长条
        null,                              // 格5：空
        [220, 130, 25, 25, [255, 0, 255]], // 格6
      ],
    }))
    const result = await sliceSheet({
      sheetFile,
      outDir: path.join(dir, 'slices'),
      items: Array.from({ length: 6 }, (_, index) => ({ name: `icon_${index + 1}` })),
      columns: 3,
      rows: 2,
      trim: true,
      targetWidth: 48,
      targetHeight: 48,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.auto_trim, true)
    assert.equal(result.slices.length, 6)
    // 每个非空格子都必须是 auto-trim（旧 bug 下会裁到角落、内容为空）
    for (const name of ['icon_1', 'icon_2', 'icon_3', 'icon_4', 'icon_6']) {
      const slice = result.slices.find((item) => item.name === name)
      assert.equal(slice.alignment, 'auto-trim', `${name} 应被自动裁剪`)
      assert.equal(slice.width, 48)
      assert.equal(slice.height, 48)
      const decoded = decodePngRgba(await readFile(slice.file))
      const m = measure(decoded.pixels, 48, 48)
      assert.ok(m.count > 0, `${name} 裁出来不能是全透明（这就是坐标系 bug 的症状）`)
      assert.ok(Math.abs((m.minX + m.maxX) / 2 - 23.5) <= 1.5, `${name} 水平应居中，实际中心 ${(m.minX + m.maxX) / 2}`)
      assert.ok(Math.abs((m.minY + m.maxY) / 2 - 23.5) <= 1.5, `${name} 垂直应居中，实际中心 ${(m.minY + m.maxY) / 2}`)
    }
    // 空格子要有警告
    assert.ok(result.warnings.some((text) => /icon_5/.test(text)), '空格子必须给警告')
    // 内容色要保留（第一格红色）
    const first = decodePngRgba(await readFile(result.slices[0].file))
    const center = ((24 * 48) + 24) * 4
    assert.deepEqual(
      [first.pixels[center], first.pixels[center + 1], first.pixels[center + 2]],
      [255, 0, 0],
      '第一格应是红色内容（说明裁的是正确位置）',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端切图：trim=false 时保持旧行为（固定格子）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-notrim-'))
  try {
    const sheetFile = path.join(dir, 'sheet.png')
    await writeFile(sheetFile, makeSheet({ width: 120, height: 80, blocks: [[10, 10, 20, 20, [255, 0, 0]]] }))
    const result = await sliceSheet({
      sheetFile,
      outDir: path.join(dir, 'out'),
      items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      columns: 2,
      rows: 2,
      trim: false,
    })
    assert.equal(result.auto_trim, false)
    for (const slice of result.slices) {
      assert.equal(slice.alignment, 'fixed-cell')
      assert.equal(slice.width, 60)
      assert.equal(slice.height, 40)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('单张规格可以逐格覆盖（每格不同目标尺寸）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-percell-'))
  try {
    await mkdir(path.join(dir, 'out'), { recursive: true })
    const sheetFile = path.join(dir, 'sheet.png')
    await writeFile(sheetFile, makeSheet({
      width: 200,
      height: 100,
      blocks: [[10, 10, 30, 30, [255, 0, 0]], [110, 10, 40, 40, [0, 255, 0]]],
    }))
    const result = await sliceSheet({
      sheetFile,
      outDir: path.join(dir, 'out'),
      items: [{ name: 'small', width: 24, height: 24 }, { name: 'big', width: 64, height: 64 }],
      columns: 2,
      rows: 1,
      trim: true,
    })
    assert.equal(result.slices[0].width, 24)
    assert.equal(result.slices[0].height, 24)
    assert.equal(result.slices[1].width, 64)
    assert.equal(result.slices[1].height, 64)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
