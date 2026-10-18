/**
 * 多帧动画（视频 → 精灵表）测试。
 *
 * 这一层的核心主张：**连贯性由视频模型保证，程序只负责抽帧/抠底/对齐/打包**。
 * 所以测试要钉住的是"程序这一半"必须绝对可靠：
 *   ① ffmpeg 找不到时**明确报错并给安装指引**（不静默失败）
 *   ② 抽帧帧率/帧数按预期（count 与 duration 换算正确）
 *   ③ **抠底只吃边缘连通的背景**，角色内部的同色区域不能被挖洞
 *   ④ **所有帧用同一个包围盒**（这是防抖动的关键，逐帧紧裁会抖）
 *   ⑤ 循环动画丢掉与首帧重复的末帧
 *   ⑥ JSON 的 cell/grid/fps/pivot 自洽
 *
 * 依赖 ffmpeg 的用例在找不到 ffmpeg 时会 skip（不让别人的机器红一片），
 * 但纯函数部分（抠底/打包/JSON）永远要跑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  findFfmpeg, probeVideo, extractFrames, alphaFromEdgeBackground,
  packSpriteSheet, buildSheetJson, videoToSpriteSheet,
} from '../lib/spritesheet.js'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'

/* ---------------- 造帧 ---------------- */

/** 白底 + 一个可指定位置的色块（模拟"背景纯色 + 角色"的视频帧）。 */
function frameWithBox({ size = 64, box = [10, 10, 20, 30], bg = [255, 255, 255], color = [224, 96, 58], interiorSameAsBg = false } = {}) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = bg[0]; pixels[i * 4 + 1] = bg[1]; pixels[i * 4 + 2] = bg[2]; pixels[i * 4 + 3] = 255
  }
  const [bx, by, bw, bh] = box
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue
      const i = (y * size + x) * 4
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255
    }
  }
  // 在色块**内部**挖一块和背景同色的区域：泛洪抠底不该把它吃掉
  if (interiorSameAsBg) {
    const cxp = bx + Math.floor(bw / 2) - 2
    const cyp = by + Math.floor(bh / 2) - 2
    for (let y = cyp; y < cyp + 4; y++) {
      for (let x = cxp; x < cxp + 4; x++) {
        const i = (y * size + x) * 4
        pixels[i] = bg[0]; pixels[i + 1] = bg[1]; pixels[i + 2] = bg[2]; pixels[i + 3] = 255
      }
    }
  }
  return encodePngRgba(size, size, pixels)
}

async function writeFrames(dir, specs) {
  await mkdir(dir, { recursive: true })
  const files = []
  for (let i = 0; i < specs.length; i++) {
    const file = path.join(dir, `f_${String(i + 1).padStart(4, '0')}.png`)
    await writeFile(file, frameWithBox(specs[i]))
    files.push(file)
  }
  return files
}

/* ---------------- ffmpeg 发现 ---------------- */

test('findFfmpeg：找不到时返回 null（由上层给安装指引，不静默失败）', async () => {
  const original = process.env.FFMPEG_PATH
  try {
    process.env.FFMPEG_PATH = ''
    // 显式给一个肯定不存在的路径 + 不给扫描根 → 必须返回 null 而不是抛异常
    const result = await findFfmpeg({ explicit: path.join(os.tmpdir(), '绝对不存在_' + Date.now(), 'ffmpeg.exe'), scanRoots: [], fresh: true })
    assert.equal(result, null)
  } finally {
    if (original === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = original
  }
})

test('findFfmpeg：显式路径可用时直接返回，并带版本号', async () => {
  const found = await findFfmpeg()
  if (!found) return // 这台机器没 ffmpeg → 跳过（其余依赖 ffmpeg 的用例也会自然跳过）
  const again = await findFfmpeg({ explicit: found.path, fresh: true })
  assert.ok(again, '显式指定就该找到')
  assert.equal(again.path, found.path)
  assert.ok(again.version.length > 0, '要有版本号')
})

/* ---------------- 抠底 ---------------- */

test('抠底：只吃边缘连通的背景，角色内部同色区域**不能**被挖洞', () => {
  const buffer = frameWithBox({ interiorSameAsBg: true })
  const result = alphaFromEdgeBackground(buffer)
  assert.equal(result.ok, true, result.error)
  const out = decodePngRgba(result.buffer)
  const size = 64
  // 角落（背景）必须透明
  assert.equal(out.pixels[(2 * size + 2) * 4 + 3], 0, '角落背景没抠掉')
  // 色块内部那块"和背景同色"的小区域必须**保留**（它不和外面连通）
  const cxp = 10 + Math.floor(20 / 2) - 2 + 1
  const cyp = 10 + Math.floor(30 / 2) - 2 + 1
  assert.equal(out.pixels[(cyp * size + cxp) * 4 + 3], 255,
    '角色内部的同色区域被误抠了 —— 全图颜色匹配就会犯这个错')
  // 色块本体保留
  assert.equal(out.pixels[((10 + 2) * size + (10 + 2)) * 4 + 3], 255)
})

test('抠底：边缘颜色不统一时**拒绝**抠（硬抠会挖出奇怪的洞）', () => {
  const size = 48
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // 做成渐变：边缘颜色差异大
      pixels[i] = Math.round((x / size) * 255)
      pixels[i + 1] = Math.round((y / size) * 255)
      pixels[i + 2] = 128
      pixels[i + 3] = 255
    }
  }
  const result = alphaFromEdgeBackground(encodePngRgba(size, size, pixels))
  assert.equal(result.ok, false)
  assert.match(result.error, /边缘颜色不统一|不像纯色背景/)
})

/* ---------------- 打包（防抖动的核心） ---------------- */

test('★ 打包用**共同包围盒**：不同位置的色块在同一格里位置不同（不是各自居中）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-'))
  try {
    // 三帧：色块从左往右移动。各自居中会让它看起来"原地不动"，那是错的
    const files = await writeFrames(dir, [
      { box: [5, 20, 16, 24] },
      { box: [24, 20, 16, 24] },
      { box: [43, 20, 16, 24] },
    ])
    const keyed = []
    for (const file of files) {
      const r = alphaFromEdgeBackground(await readFile(file))
      assert.equal(r.ok, true, r.error)
      const out = file.replace(/\.png$/, '.a.png')
      await writeFile(out, r.buffer)
      keyed.push(out)
    }
    const packed = await packSpriteSheet({ frames: keyed, columns: 3, dropDuplicateLast: false })
    assert.equal(packed.ok, true, packed.error)
    assert.equal(packed.count, 3)
    // union 应该覆盖"色块移动的整个范围"，而不是单帧大小
    assert.ok(packed.union.w > 16, `union 宽度应大于单个色块（实际 ${packed.union.w}）`)

    // 检查三格里色块的横向位置递增（说明保留了真实位移）
    const sheet = decodePngRgba(packed.buffer)
    const [cw, ch] = packed.cell
    const boxCenterX = (index) => {
      const x0 = (index % 3) * cw
      const y0 = Math.floor(index / 3) * ch
      let sum = 0; let n = 0
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (sheet.pixels[((y0 + y) * sheet.width + (x0 + x)) * 4 + 3] > 8) { sum += x; n += 1 }
        }
      }
      return n ? sum / n : -1
    }
    const centers = [0, 1, 2].map(boxCenterX)
    assert.ok(centers[0] < centers[1] && centers[1] < centers[2],
      `色块在格里应保持递增位移（各自居中的话三个中心会一样）：${centers.map((c) => c.toFixed(1))}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('打包：循环动画里与首帧重复的末帧会被丢掉（否则播完多停一帧）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-loop-'))
  try {
    const files = await writeFrames(dir, [
      { box: [10, 10, 16, 20] },
      { box: [30, 10, 16, 20] },
      { box: [10, 10, 16, 20] },   // 和首帧一样 → 循环的末帧
    ])
    const keyed = []
    for (const file of files) {
      const r = alphaFromEdgeBackground(await readFile(file))
      const out = file.replace(/\.png$/, '.a.png')
      await writeFile(out, r.buffer)
      keyed.push(out)
    }
    const looped = await packSpriteSheet({ frames: keyed, dropDuplicateLast: true })
    assert.equal(looped.count, 2, `循环时应丢掉重复末帧，实际 ${looped.count} 帧`)
    assert.equal(looped.droppedLast, true)

    const full = await packSpriteSheet({ frames: keyed, dropDuplicateLast: false })
    assert.equal(full.count, 3, '不丢的时候要保留全部 3 帧')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('打包：全透明帧会明确报错（抠底抠过头的典型症状）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-empty-'))
  try {
    const blank = encodePngRgba(32, 32, new Uint8ClampedArray(32 * 32 * 4))
    const files = []
    for (let i = 0; i < 3; i++) {
      const file = path.join(dir, `b_${i}.png`)
      await writeFile(file, blank)
      files.push(file)
    }
    const packed = await packSpriteSheet({ frames: files })
    assert.equal(packed.ok, false)
    assert.match(packed.error, /全透明|抠底/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('打包：帧尺寸不一致时明确拒绝（不能悄悄拉伸）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-mismatch-'))
  try {
    const a = path.join(dir, 'a.png')
    const b = path.join(dir, 'b.png')
    await writeFile(a, frameWithBox({ size: 64 }))
    await writeFile(b, frameWithBox({ size: 48 }))
    const packed = await packSpriteSheet({ frames: [a, b] })
    assert.equal(packed.ok, false)
    assert.match(packed.error, /尺寸不一致/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------- JSON ---------------- */

test('精灵表 JSON：cell/grid/frames 自洽，pivot 默认底边中点', () => {
  const json = buildSheetJson({
    name: 'walk', sheet: 'walk.png', sheetWidth: 400, sheetHeight: 200,
    cell: [100, 100], columns: 4, rows: 2, count: 8, fps: 12, loop: true,
  })
  assert.equal(json.version, 1)
  assert.deepEqual(json.cell, { x: 0, y: 0, w: 100, h: 100 })
  assert.deepEqual(json.grid, { columns: 4, rows: 2, count: 8 })
  assert.equal(json.fps, 12)
  assert.equal(json.frameDurationMs, 83)
  assert.deepEqual(json.pivot, [0.5, 1], '站立角色默认贴地锚点')
  assert.equal(json.frames.length, 8)
  // 每帧的坐标必须落在格的整数倍上
  for (const frame of json.frames) {
    assert.equal(frame.x, frame.col * 100)
    assert.equal(frame.y, frame.row * 100)
    assert.ok(frame.x + frame.w <= 400, '帧不能超出表宽')
    assert.ok(frame.y + frame.h <= 200, '帧不能超出表高')
  }
  // 最后一帧应在右下角
  assert.equal(json.frames[7].col, 3)
  assert.equal(json.frames[7].row, 1)
})

/* ---------------- 端到端（需要 ffmpeg） ---------------- */

test('端到端：视频 → 抽帧 → 抠底 → 精灵表 + JSON', async () => {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) {
    console.log('  （本机没有 ffmpeg，跳过端到端用例）')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-e2e-'))
  try {
    // 用 ffmpeg 自己造一段测试视频：白底 + 移动的橙块
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const video = path.join(dir, 'walk.mp4')
    await run(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=128x128:r=12:d=1',
      '-f', 'lavfi', '-i', 'color=c=0xe0603a:s=24x40:r=12:d=1',
      '-filter_complex', "[0][1]overlay=x='16+50*t':y=44",
      '-pix_fmt', 'yuv420p', video,
    ], { timeout: 60000, windowsHide: true })

    const probed = await probeVideo({ ffmpeg: ffmpeg.path, video })
    assert.equal(probed.ok, true, probed.error)
    assert.equal(probed.width, 128)
    assert.ok(Math.abs(probed.durationSec - 1) < 0.2, `时长应约 1s，实际 ${probed.durationSec}`)

    const result = await videoToSpriteSheet({
      video, outDir: path.join(dir, 'out'), count: 6, name: 'walk', columns: 3, scale: 2, loop: true,
      ffmpeg: ffmpeg.path,
    })
    assert.equal(result.ok, true, result.error ?? result.stage)
    assert.equal(result.frames.count, 6, `应抽 6 帧，实际 ${result.frames.count}`)
    assert.equal(result.sheet.count, 6)
    assert.equal(result.sheet.columns, 3)
    assert.equal(result.sheet.rows, 2)
    assert.ok(result.sheet.width > 0 && result.sheet.height > 0)

    // 精灵表能解码，且不是全透明
    const sheet = decodePngRgba(await readFile(result.sheet.file))
    assert.ok(sheet, '精灵表要是合法 PNG')
    let opaque = 0
    for (let i = 3; i < sheet.pixels.length; i += 4) if (sheet.pixels[i] > 8) opaque += 1
    assert.ok(opaque > 500, `精灵表几乎全透明（不透明像素只有 ${opaque}）`)

    // JSON 能解析且自洽
    const json = JSON.parse(await readFile(result.json, 'utf8'))
    assert.equal(json.grid.count, 6)
    assert.deepEqual(json.cell.w, result.sheet.cell[0])
    assert.equal(json.loop, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：抽帧的帧数/帧率换算正确（count 优先）', async () => {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-extract-'))
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const video = path.join(dir, 'v.mp4')
    await run(ffmpeg.path, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=10:d=2', '-pix_fmt', 'yuv420p', video], { timeout: 60000, windowsHide: true })

    const byCount = await extractFrames({ ffmpeg: ffmpeg.path, video, outDir: path.join(dir, 'a'), count: 6, durationSec: 2 })
    assert.equal(byCount.ok, true, byCount.error)
    assert.equal(byCount.count, 6, `要 6 帧就该给 6 帧，实际 ${byCount.count}`)
    assert.ok(Math.abs(byCount.fps - 3) < 0.2, `2 秒要 6 帧 → 3fps，实际 ${byCount.fps}`)

    const byFps = await extractFrames({ ffmpeg: ffmpeg.path, video, outDir: path.join(dir, 'b'), fps: 10, durationSec: 2 })
    assert.equal(byFps.ok, true, byFps.error)
    assert.ok(byFps.count >= 18, `10fps × 2 秒 ≈ 20 帧，实际 ${byFps.count}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ 抽完帧默认**删掉源视频**、删掉未抠底的原始帧，只留可用的帧', async () => {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-clean-'))
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const video = path.join(dir, 'v.mp4')
    await run(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=96x96:r=10:d=1',
      '-f', 'lavfi', '-i', 'color=c=0xe0603a:s=20x36:r=10:d=1',
      '-filter_complex', "[0][1]overlay=x='10+40*t':y=30",
      '-pix_fmt', 'yuv420p', video,
    ], { timeout: 60000, windowsHide: true })
    assert.ok(await stat(video).then((s) => s.isFile()), '视频应已存在')

    const outDir = path.join(dir, 'out')
    const r = await videoToSpriteSheet({ video, outDir, count: 5, name: 'c', ffmpeg: ffmpeg.path })
    assert.equal(r.ok, true, r.error ?? r.stage)

    // ① 源视频被删掉
    assert.equal(await stat(video).then(() => true).catch(() => false), false,
      '抽完帧后源视频应当被删掉（默认行为）')
    assert.equal(r.cleaned.video, video, '结果里要报告删了哪个视频')

    // ② 帧目录里只留 .alpha.png，不再有原始帧
    const files = await readdir(path.join(outDir, 'frames'))
    const raw = files.filter((f) => /^f_\d+\.png$/.test(f))
    const keyed = files.filter((f) => /\.alpha\.png$/.test(f))
    assert.ok(keyed.length > 0, '抠好的帧要留着')
    assert.equal(raw.length, 0, `未抠底的原始帧应被删掉，实际还剩 ${raw.length} 张`)

    // ③ 精灵表和 JSON 还在
    assert.ok(await stat(r.sheet.file).then((s) => s.isFile()))
    assert.ok(await stat(r.json).then((s) => s.isFile()))

    // ④ keep_video=true 时不删
    const video2 = path.join(dir, 'v2.mp4')
    await run(ffmpeg.path, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=10:d=1', '-pix_fmt', 'yuv420p', video2], { timeout: 60000, windowsHide: true })
    // 纯色视频没有前景，会失败——换个有前景的
    await run(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=96x96:r=10:d=1',
      '-f', 'lavfi', '-i', 'color=c=0x3060e0:s=20x36:r=10:d=1',
      '-filter_complex', "[0][1]overlay=x='10+40*t':y=30",
      '-pix_fmt', 'yuv420p', video2,
    ], { timeout: 60000, windowsHide: true })
    const r2 = await videoToSpriteSheet({ video: video2, outDir: path.join(dir, 'out2'), count: 4, name: 'k', ffmpeg: ffmpeg.path, deleteVideo: false, keepRawFrames: true })
    assert.equal(r2.ok, true, r2.error ?? r2.stage)
    assert.equal(await stat(video2).then(() => true).catch(() => false), true,
      'keep_video=true 时不能删源视频')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ 两段式抽帧：先用小图找周期，再只抽要的那几帧（不白写 80% 的帧）', async () => {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-2pass-'))
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const video = path.join(dir, 'p.mp4')
    await run(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=128x128:r=24:d=3',
      '-f', 'lavfi', '-i', 'color=c=0xe0603a:s=24x40:r=24:d=3',
      '-filter_complex', "[0][1]overlay=x='30+40*sin(2*PI*t)':y=44",
      '-pix_fmt', 'yuv420p', video,
    ], { timeout: 60000, windowsHide: true })

    const outDir = path.join(dir, 'out')
    const r = await videoToSpriteSheet({
      video, outDir, count: 8, loop: 'auto', name: 'p', ffmpeg: ffmpeg.path, keepVideo: true, deleteVideo: false,
    })
    assert.equal(r.ok, true, r.error ?? r.stage)

    // ① 走了两段式
    assert.ok(r.loop?.two_pass, '应报告走了两段式')
    assert.match(r.loop.two_pass, /粗筛/)
    assert.match(r.loop.two_pass, /精抽/)

    // ② 粗筛目录用完就删掉了
    assert.equal(await stat(path.join(outDir, 'frames_probe')).then(() => true).catch(() => false), false,
      'frames_probe 用完应删掉')

    // ③ frames 目录里只有最终要的帧（不是粗筛的 40+ 张）
    const files = await readdir(path.join(outDir, 'frames'))
    const alpha = files.filter((f) => /\.alpha\.png$/.test(f))
    assert.ok(alpha.length <= 8, `最终只该留 ≤8 张抠好的帧，实际 ${alpha.length}`)
    assert.ok(alpha.length > 0, '要有抠好的帧')

    // ④ 帧数不会超过周期（周期比要的帧数短时按周期封顶，不硬凑重复帧）
    if (r.loop.cycleFrames < 8) {
      assert.ok(r.sheet.count <= r.loop.cycleFrames,
        `帧数不能超过周期：周期 ${r.loop.cycleFrames}，实际 ${r.sheet.count}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ 缓存：同样的视频+参数第二次直接命中，改参数或 force 才重跑', async () => {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-cache-'))
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const video = path.join(dir, 'c.mp4')
    await run(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=128x128:r=24:d=3',
      '-f', 'lavfi', '-i', 'color=c=0xe0603a:s=24x40:r=24:d=3',
      '-filter_complex', "[0][1]overlay=x='30+40*sin(2*PI*t)':y=44",
      '-pix_fmt', 'yuv420p', video,
    ], { timeout: 60000, windowsHide: true })
    const outDir = path.join(dir, 'out')
    const base = { video, outDir, count: 8, loop: 'auto', name: 'c', ffmpeg: ffmpeg.path, deleteVideo: false }

    const first = await videoToSpriteSheet(base)
    assert.equal(first.ok, true, first.error ?? first.stage)
    assert.notEqual(first.cached, true, '第一次不该是缓存命中')

    const second = await videoToSpriteSheet(base)
    assert.equal(second.ok, true)
    assert.equal(second.cached, true, '同样的视频+参数第二次应命中缓存')
    assert.match(second.note, /命中缓存/)

    // 改参数 → 不命中
    const changed = await videoToSpriteSheet({ ...base, count: 6 })
    assert.notEqual(changed.cached, true, '参数变了就不该命中缓存')

    // force → 不命中
    const forced = await videoToSpriteSheet({ ...base, force: true })
    assert.notEqual(forced.cached, true, 'force=true 必须重跑')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ 相位偏移：phase 真的把起始角度平移了（八面图靠它拿到 8 个不同朝向）', async () => {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sheet-phase-'))
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    // 偏心方块整体转 360°（5 秒）——模拟环绕镜头
    const video = path.join(dir, 'orbit.mp4')
    await run(ffmpeg.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=160x160:r=24:d=5',
      '-f', 'lavfi', '-i', 'color=c=0xc03020:s=40x18:r=24:d=5',
      '-filter_complex', "[0][1]overlay=x=100:y=70,rotate='2*PI*t/5':fillcolor=white:ow=160:oh=160",
      '-pix_fmt', 'yuv420p', video,
    ], { timeout: 90000, windowsHide: true })

    const fingerprintOf = async (file) => {
      const keyed = alphaFromEdgeBackground(await readFile(file))
      const png = decodePngRgba(keyed.buffer)
      const size = 16
      const cells = new Float64Array(size * size)
      for (let y = 0; y < png.height; y++) {
        const cy = Math.min(size - 1, Math.floor((y / png.height) * size))
        for (let x = 0; x < png.width; x++) {
          const cx = Math.min(size - 1, Math.floor((x / png.width) * size))
          const i = (y * png.width + x) * 4
          cells[cy * size + cx] += 0.299 * png.pixels[i] + 0.587 * png.pixels[i + 1] + 0.114 * png.pixels[i + 2]
        }
      }
      return cells
    }
    const diff = (a, b) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
      return s / a.length
    }
    const firstFrame = async (outDir) => {
      const files = (await readdir(path.join(outDir, 'frames'))).filter((f) => f.endsWith('.alpha.png')).sort()
      return fingerprintOf(path.join(outDir, 'frames', files[0]))
    }

    const base = { video, count: 8, loop: 'auto', columns: 8, name: 'o', ffmpeg: ffmpeg.path, deleteVideo: false }
    const a = await videoToSpriteSheet({ ...base, outDir: path.join(dir, 'a') })
    const b = await videoToSpriteSheet({ ...base, outDir: path.join(dir, 'b'), phase: 0.5 })
    assert.equal(a.ok, true, a.error ?? a.stage)
    assert.equal(b.ok, true, b.error ?? b.stage)

    // ① 两种相位下帧数一致、都没有重复帧
    assert.equal(a.sheet.count, 8)
    assert.equal(b.sheet.count, 8)

    // ② phase=0.5 的起始帧必须和 phase=0 明显不同（差半圈）
    const fa = await firstFrame(path.join(dir, 'a'))
    const fb = await firstFrame(path.join(dir, 'b'))
    assert.ok(diff(fa, fb) > 5, `phase=0.5 的首帧应该和 phase=0 明显不同，实际差异只有 ${diff(fa, fb).toFixed(2)}`)

    // ③ auto 循环应该识别出"转一圈"的周期（≈整个视频长度）
    assert.ok(a.loop?.cycleFrames > 20, `应识别出接近全片的周期，实际 ${a.loop?.cycleFrames}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ 视频限流冷却：429 之后短期**秒失败**，不再白等 20+ 秒', async () => {
  const { videoRateLimitCooldown, __setVideoRateLimitForTest } = await import('../lib/video.js')
  try {
    // ① 默认不冷却
    __setVideoRateLimitForTest(0)
    assert.deepEqual(videoRateLimitCooldown(), { cooling: false, remainingSeconds: 0 })

    // ② 置位后处于冷却
    __setVideoRateLimitForTest(60 * 1000)
    const cooling = videoRateLimitCooldown()
    assert.equal(cooling.cooling, true)
    assert.ok(cooling.remainingSeconds > 55 && cooling.remainingSeconds <= 60,
      `剩余秒数应在 55~60，实际 ${cooling.remainingSeconds}`)

    // ③ 清除后恢复
    __setVideoRateLimitForTest(0)
    assert.equal(videoRateLimitCooldown().cooling, false)
  } finally {
    __setVideoRateLimitForTest(0)
  }
})
