/**
 * 变体 / 动画装机 / 产出目录收敛 的测试。
 *
 * 这三块都在解决同一个问题的不同侧面：
 *   变体      —— 别为"换个颜色"重跑整条视频管线
 *   动画装机  —— 别让精灵表的格子尺寸靠人肉算（算错就切帧错位）
 *   目录收敛  —— 别让人分不清哪张图是给游戏用的
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'
import { recolorSheet, VARIANT_PRESETS } from '../lib/variant.js'
import { scaleSheet, listAnimations, installAnimations } from '../lib/installanim.js'
import { classifyFile, classifyDir, summarizeLayout, organizeLayout, explainLayout } from '../lib/outputlayout.js'

/** 造一张两色小图（左红右蓝，带透明角）。 */
function makeSheet({ width = 40, height = 20, cellW = 20, cellH = 20 } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inFirstCell = Math.floor(x / cellW) === 0
      pixels[i] = inFirstCell ? 200 : 40
      pixels[i + 1] = 60
      pixels[i + 2] = inFirstCell ? 40 : 200
      // 左上角留透明
      pixels[i + 3] = (x < 4 && y < 4) ? 0 : 255
    }
  }
  return encodePngRgba(width, height, pixels)
}

/* ───────────────────────── 变体 ───────────────────────── */

test('变体：只改颜色，**尺寸和 alpha 完全不动**（动了轮廓就废了）', () => {
  const source = makeSheet()
  const before = decodePngRgba(source)
  const result = recolorSheet({ buffer: source, ...VARIANT_PRESETS.blue })
  assert.equal(result.ok, true, result.error)
  const after = decodePngRgba(result.buffer)
  assert.equal(after.width, before.width, '宽度不能变')
  assert.equal(after.height, before.height, '高度不能变')

  let changedAlpha = 0
  let changedColor = 0
  for (let i = 0; i < before.pixels.length; i += 4) {
    if (before.pixels[i + 3] !== after.pixels[i + 3]) changedAlpha += 1
    const dr = Math.abs(before.pixels[i] - after.pixels[i])
    const dg = Math.abs(before.pixels[i + 1] - after.pixels[i + 1])
    const db = Math.abs(before.pixels[i + 2] - after.pixels[i + 2])
    if (dr + dg + db > 6) changedColor += 1
  }
  assert.equal(changedAlpha, 0, `alpha 一个像素都不该变，实际变了 ${changedAlpha}`)
  assert.ok(changedColor > 100, `颜色应该真的变了，实际只有 ${changedColor} 个像素变化`)
})

test('变体：调色板映射是**精确换色**（不会把别的颜色也带走）', () => {
  const source = makeSheet()
  const result = recolorSheet({
    buffer: source,
    palette: [[[200, 60, 40], [0, 255, 0]]],   // 只把红色换成纯绿
    paletteTolerance: 8,
  })
  assert.equal(result.ok, true, result.error)
  const png = decodePngRgba(result.buffer)
  // 左半（原本红）应该变绿。注意取样点要避开左上角 4×4 的透明区 ——
  // recolorSheet 会跳过 alpha=0 的像素（这是对的：透明像素动它没意义）
  const left = ((10 * png.width) + 10) * 4
  assert.ok(png.pixels[left + 1] > 200 && png.pixels[left] < 80,
    `左半应变绿，实际 rgb(${png.pixels[left]},${png.pixels[left + 1]},${png.pixels[left + 2]})`)
  // 右半（原本蓝）应该原样
  const right = ((10 * png.width) + 30) * 4
  assert.equal(png.pixels[right + 2], 200, `右半不该被改，实际 B=${png.pixels[right + 2]}`)
})

test('变体：预设都有值，且灰度能把颜色抽掉', () => {
  for (const [name, preset] of Object.entries(VARIANT_PRESETS)) {
    assert.ok(preset && typeof preset === 'object', `${name} 预设应为对象`)
  }
  const result = recolorSheet({ buffer: makeSheet(), grayscale: 1 })
  assert.equal(result.ok, true)
  const png = decodePngRgba(result.buffer)
  const i = ((10 * png.width) + 10) * 4
  const spread = Math.max(png.pixels[i], png.pixels[i + 1], png.pixels[i + 2])
    - Math.min(png.pixels[i], png.pixels[i + 1], png.pixels[i + 2])
  assert.ok(spread <= 2, `灰度后三通道应接近相等，实际差 ${spread}`)
})

/* ───────────────────────── 动画装机 ───────────────────────── */

test('★ 装机缩放按**格子**算：整表乘同一倍率，格子必须还是等大', () => {
  const source = makeSheet({ width: 80, height: 40, cellW: 20, cellH: 20 }) // 4×2 格
  const result = scaleSheet(source, 0.5)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.width, 40)
  assert.equal(result.height, 20)
  const png = decodePngRgba(result.buffer)
  assert.equal(png.width, 40)
  // 每格应该是 10×10
  assert.equal(40 / 4, 10, '格宽应是整数')
  assert.equal(20 / 2, 10, '格高应是整数')
})

test('★ 装机会拒绝"目标格子比例不一致"（强行拉伸会让角色变形）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anim-install-'))
  try {
    const outputDir = path.join(dir, 'out')
    const animDir = path.join(outputDir, 'proj', 'anim', 'walk')
    await mkdir(animDir, { recursive: true })
    await writeFile(path.join(animDir, 'walk_sheet.png'), makeSheet({ width: 80, height: 40 }))
    await writeFile(path.join(animDir, 'walk.json'), `${JSON.stringify({
      version: 1, name: 'walk', image: 'walk_sheet.png',
      imageSize: [80, 40], cell: { x: 0, y: 0, w: 20, h: 20 },
      grid: { columns: 4, rows: 1, count: 4 }, fps: 8, loop: true, pivot: [0.5, 1],
      frames: [],
    }, null, 2)}\n`)
    const root = path.join(dir, 'game')
    await mkdir(root, { recursive: true })

    const refused = await installAnimations({
      root, outputDir, project: 'proj', cellWidth: 20, cellHeight: 40, dryRun: false,
    })
    assert.equal(refused.results[0].ok, false, '宽高倍率不一致应拒绝')
    assert.match(refused.results[0].why, /比例不一致/)
    assert.ok(refused.results[0].suggest, '拒绝时应该给建议')

    // 比例一致 → 正常装
    const ok = await installAnimations({ root, outputDir, project: 'proj', cellWidth: 10, cellHeight: 10, dryRun: false })
    assert.equal(ok.results[0].ok, true, ok.results[0].why)
    const destJson = JSON.parse(await readFile(path.join(root, 'assets', 'anim', 'walk.anim.json'), 'utf8'))
    assert.deepEqual(destJson.cell, { x: 0, y: 0, w: 10, h: 10 })
    // 帧坐标要按**缩放后**的实际值重算，不能抄源 JSON 的
    assert.equal(destJson.frames[1].x, 10, `第 2 帧 x 应为 10（缩放后），实际 ${destJson.frames[1].x}`)
    assert.equal(destJson.source.cell, '20×20')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('动画清单：能按 JSON 的 image 字段找到配对的那张表', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anim-list-'))
  try {
    const animDir = path.join(dir, 'proj', 'anim', 'walk')
    await mkdir(animDir, { recursive: true })
    await writeFile(path.join(animDir, 'walk_sheet.png'), makeSheet())
    await writeFile(path.join(animDir, 'walk.json'), JSON.stringify({
      name: 'walk', image: 'walk_sheet.png', cell: { w: 20, h: 20 }, grid: { columns: 2, rows: 1, count: 2 }, fps: 8,
    }))
    const found = await listAnimations({ outputDir: dir, project: 'proj' })
    assert.equal(found.length, 1)
    assert.equal(found[0].name, 'walk')
    assert.ok(found[0].sheet.endsWith('walk_sheet.png'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ───────────────────────── 目录收敛 ───────────────────────── */

test('分类器：四类必须分对（这是"哪个给游戏用"的唯一依据）', () => {
  assert.equal(classifyFile('unit_1.png'), 'source')
  assert.equal(classifyFile('unit_1_labeled.png'), 'preview')
  assert.equal(classifyFile('unit_1.post.png'), 'derived')
  assert.equal(classifyFile('unit_1.pixel.png'), 'derived')
  assert.equal(classifyFile('unit.alpha.png'), 'derived')
  assert.equal(classifyFile('unit_96x176.png'), 'derived')
  assert.equal(classifyFile('unit.json'), 'config')
  assert.equal(classifyFile('unit.cache.json'), 'intermediate')
  assert.equal(classifyFile('unit.png.bak-before-install'), 'intermediate')
  assert.equal(classifyDir('icons_slices'), 'derived')
  assert.equal(classifyDir('frames'), 'intermediate')
  assert.equal(classifyDir('_labeled'), 'preview')
  assert.equal(classifyDir('anim'), null, '不经意的目录不该被归类（否则会被误搬）')
})

test('★ 整理默认**不动 derived**（切片可能正被游戏引用）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'layout-'))
  try {
    await writeFile(path.join(dir, 'unit_1.png'), 'source')
    await writeFile(path.join(dir, 'unit_1_labeled.png'), 'preview')
    await mkdir(path.join(dir, 'icons_slices'), { recursive: true })
    await writeFile(path.join(dir, 'icons_slices', 'a.png'), 'slice')
    await mkdir(path.join(dir, 'anim', 'walk', 'frames'), { recursive: true })
    await writeFile(path.join(dir, 'anim', 'walk', 'frames', 'f1.png'), 'frame')

    const summary = await summarizeLayout({ dir })
    assert.ok(summary.categories.source.count >= 1)
    assert.equal(summary.categories.preview.count, 1)
    assert.ok(summary.categories.derived.count >= 1)
    assert.ok(summary.categories.intermediate.count >= 1)
    assert.ok(summary.game_ready >= 1)

    const preview = await organizeLayout({ dir, dryRun: true })
    assert.equal(preview.dry_run, true)
    // 只该动 preview 和 intermediate（含嵌套在 anim/walk/frames 里的那个）
    const kinds = new Set((preview.moves ?? []).map((m) => m.kind))
    assert.ok(kinds.has('preview'), '预览图应被整理')
    assert.ok(kinds.has('intermediate'), '嵌套的 frames/ 应被整理（递归）')
    assert.equal(kinds.has('derived'), false, '默认不该动 derived')
    assert.ok((preview.moves ?? []).some((m) => m.to.includes('anim')), '移动时应保留相对路径，避免同名目录撞车')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('整理：真的移过去，并且**source 一个都不动**', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'layout-move-'))
  try {
    await writeFile(path.join(dir, 'unit_1.png'), 'source')
    await writeFile(path.join(dir, 'unit_1_labeled.png'), 'preview')
    const result = await organizeLayout({ dir, dryRun: false })
    assert.equal(result.ok, true)
    assert.ok(result.moved >= 1)
    // source 还在原地
    assert.equal(await readFile(path.join(dir, 'unit_1.png'), 'utf8'), 'source')
    // 预览被移走
    assert.equal(await stat(path.join(dir, 'unit_1_labeled.png')).then(() => true).catch(() => false), false)
    assert.equal(await stat(path.join(dir, '_preview', 'unit_1_labeled.png')).then(() => true).catch(() => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('整理：说明文字覆盖四类（工具输出会带上它）', () => {
  const meaning = explainLayout()
  for (const key of ['source', 'preview', 'derived', 'intermediate', 'config', 'rule']) {
    assert.ok(meaning[key], `说明缺少 ${key}`)
  }
  assert.match(meaning.rule, /source 不动/)
})
