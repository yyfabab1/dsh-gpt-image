/**
 * 性能与体验批次测试：缩略图 / 引擎导出 / 合并后的 audit。
 *
 * 这一批都是"体验/性能"改动，最容易被改回去而没人发现 —— 所以每个都要有断言。
 * （注：仓库里已有 optimize.test.js 测的是 auto.optimize-prompt，别混。）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getThumbnail, downscale, thumbKey } from '../lib/thumb.js'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'
import { exportForEngine, ENGINES, toGodotSpriteFrames, toCocosPlist, toUnityMeta } from '../lib/engineexport.js'

/** 造一张带透明角的彩色图。 */
function makePng(width, height, color = [200, 80, 60]) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]
      pixels[i + 3] = (x < 4 && y < 4) ? 0 : 255
    }
  }
  return encodePngRgba(width, height, pixels)
}

/* ───────────────── 缩略图 ───────────────── */

test('缩略图：长边被压到目标值，比例不变', () => {
  const source = decodePngRgba(makePng(800, 400))
  const small = downscale(source, 200)
  assert.equal(small.width, 200, '长边应等于 200')
  assert.equal(small.height, 100, '比例要保持（800x400 → 200x100）')
})

test('★ 缩略图：小图不放大（放大只会变糊还更占带宽）', () => {
  const source = decodePngRgba(makePng(64, 64))
  const small = downscale(source, 200)
  assert.equal(small.width, 64, '原图比目标窄时不该放大')
  assert.equal(small.height, 64)
})

test('缩略图：透明区域的 alpha 被保留（不能被填成实心）', () => {
  const source = decodePngRgba(makePng(200, 200))
  const small = downscale(source, 50)
  assert.ok(small.pixels[3] < 200, `左上角应保留透明，实际 alpha=${small.pixels[3]}`)
})

test('缩略图：缓存 key 随 mtime / 宽度变化（原图改了绝不能拿到旧缩略图）', () => {
  const a = thumbKey({ file: 'x.png', mtimeMs: 1000, width: 200 })
  const b = thumbKey({ file: 'x.png', mtimeMs: 1001, width: 200 })
  const c = thumbKey({ file: 'x.png', mtimeMs: 1000, width: 300 })
  assert.notEqual(a, b, 'mtime 变了 key 必须变')
  assert.notEqual(a, c, '宽度变了 key 必须变')
  assert.equal(a, thumbKey({ file: 'x.png', mtimeMs: 1000, width: 200 }), '同样输入要得到同样 key')
})

test('★ 缩略图：第二次命中磁盘缓存（这是"加载快"的关键）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-'))
  try {
    const file = path.join(dir, 'a.png')
    await writeFile(file, makePng(600, 300))
    const first = await getThumbnail({ file, dataDir: dir, maxWidth: 150 })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.cached, false, '第一次应现算')
    const second = await getThumbnail({ file, dataDir: dir, maxWidth: 150 })
    assert.equal(second.ok, true)
    assert.equal(second.cached, true, '第二次应命中缓存')
    // 缓存文件确实比原图小
    assert.ok(second.buffer.length < 600 * 300 * 4, '缩略图应远小于原始 RGBA')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('缩略图：原图不存在时明确报错（面板才不会静默空白）', async () => {
  const result = await getThumbnail({ file: 'D:/绝对不存在的/x.png', dataDir: os.tmpdir() })
  assert.equal(result.ok, false)
  assert.match(result.error, /不存在/)
})

/* ───────────────── 引擎导出 ───────────────── */

const ANIM = {
  name: 'walk',
  image: 'walk_sheet.png',
  imageSize: [400, 200],
  cell: { x: 0, y: 0, w: 100, h: 100 },
  grid: { columns: 4, rows: 2, count: 8 },
  fps: 12,
  loop: true,
  pivot: [0.5, 1],
}

test('引擎导出：三种引擎都能生成非空文件', () => {
  for (const engine of ENGINES) {
    const r = exportForEngine({ animation: ANIM, engine })
    assert.equal(r.ok, true, `${engine} 应成功：${r.error}`)
    assert.equal(r.files.length, 1)
    assert.ok(r.files[0].content.length > 200, `${engine} 文件不该是空的`)
  }
})

test('Godot：帧数 = grid.count，每帧一个 AtlasTexture，区域按格子算', () => {
  const text = toGodotSpriteFrames({ animation: ANIM, texturePath: 'res://walk_sheet.png' })
  assert.match(text, /\[gd_resource type="SpriteFrames"/)
  assert.match(text, /res:\/\/walk_sheet\.png/)
  const regions = [...text.matchAll(/region = Rect2\(([^)]+)\)/g)].map((m) => m[1])
  assert.equal(regions.length, 8, `应有 8 个 AtlasTexture，实际 ${regions.length}`)
  assert.equal(regions[0], '0, 0, 100, 100', '第 1 帧在左上')
  assert.equal(regions[4], '0, 100, 100, 100', '第 5 帧换行（4 列 → x 回 0，y=100）')
  assert.match(text, /"speed": 12\.0/)
  assert.match(text, /"loop": true/)
})

test('★ Cocos：plist 的 y 要翻成**左下原点**（写错就是整套图错位）', () => {
  const text = toCocosPlist({ animation: ANIM })
  const first = text.match(/walk_0\.png<\/key>\s*<dict>\s*<key>frame<\/key><string>\{\{0,(\d+)\},\{100,100\}\}<\/string>/)
  assert.ok(first, '应能找到第 1 帧的 frame 定义')
  assert.equal(Number(first[1]), 100, `第 1 帧 y 应翻成 100（200-100），实际 ${first[1]}`)
  assert.match(text, /<key>format<\/key><integer>3<\/integer>/)
  assert.match(text, /<key>size<\/key><string>\{400,200\}<\/string>/)
  assert.match(text, /<key>textureFileName<\/key><string>walk_sheet\.png<\/string>/)
})

test('Unity：.meta 里每帧一个 sprite，pivot 的 y 也要翻（Unity 左下原点）', () => {
  const text = toUnityMeta({ animation: ANIM })
  assert.match(text, /fileFormatVersion: 2/)
  assert.match(text, /spriteMode: 2/, '多图切片模式')
  const sprites = [...text.matchAll(/      name: walk_(\d+)/g)]
  assert.equal(sprites.length, 8, `应有 8 个 sprite，实际 ${sprites.length}`)
  assert.match(text, /spritePivot: \{x: 0\.5, y: 0\}/)
  assert.match(text, /guid: [0-9a-f]{32}/)
})

test('引擎导出：缺 cell/grid 的 JSON 明确拒绝，不生成半成品', () => {
  const r = exportForEngine({ animation: { name: 'x', image: 'x.png' }, engine: 'godot' })
  assert.equal(r.ok, false)
  assert.match(r.error, /缺少 image \/ cell \/ grid/)
})

test('引擎导出：未知引擎明确报错并列出可用值', () => {
  const r = exportForEngine({ animation: ANIM, engine: 'unreal' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unity \/ godot \/ cocos/)
})

/* ───────────────── audit（合并后的体检工具） ───────────────── */

test('★ audit：工具总数 29（31 − 3 合并 + 1），旧的三个不再单独注册', async () => {
  const { default: createModule } = await import('../lib/tools.js')
  // tools.js 导出的是 createTools
  const createTools = createModule?.createTools ?? (await import('../lib/tools.js')).createTools
  const tools = createTools({ runtime: { loadState: async () => ({}) }, register: () => {} })
  const names = tools.map((t) => t.name)
  assert.equal(names.length, 29, `应注册 29 个工具，实际 ${names.length}`)
  assert.ok(names.includes('_dsh_external_dsh_gpt_image_audit'), 'audit 应在清单里')
  for (const gone of ['scan', 'heatmap', 'order']) {
    assert.equal(names.includes(`_dsh_external_dsh_gpt_image_${gone}`), false,
      `${gone} 应已合并进 audit，不再单独注册`)
  }
})
