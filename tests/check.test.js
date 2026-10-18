/**
 * 素材核对（合并进来的第二个「生图程序」里最有用的那部分）：
 * 把「游戏要求的规格 / 代码引用」和「实际生成的图」对上 —— 这就是
 * 「我生图的内容到底有没有用在游戏里 / 为什么黑屏」的答案来源。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { assetKeyOf, checkProject, judge, parseExpectations } from '../lib/check.js'
import { parseSizeSpec, pngInfoFromBuffer } from '../lib/pnginfo.js'

/** 造一张真 PNG：指定尺寸 + 是否带透明通道（colorType 6 / 2），像素带噪声避免被当成纯色空图。 */
function makePng(width, height, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3
  const raw = Buffer.alloc(height * (1 + width * channels))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) raw[offset++] = (x * 31 + y * 17 + c * 53) % 251
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    // CRC 内容对读头解析无关紧要，这里填 0
    return Buffer.concat([length, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = alpha ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('PNG 头解析：尺寸与透明通道', () => {
  const rgba = makePng(40, 60, { alpha: true })
  const rgb = makePng(48, 48, { alpha: false })
  assert.deepEqual(pngInfoFromBuffer(rgba), { format: 'png', width: 40, height: 60, bitDepth: 8, colorType: 6, hasAlphaChannel: true })
  assert.equal(pngInfoFromBuffer(rgb).hasAlphaChannel, false)
  assert.deepEqual(pngInfoFromBuffer(Buffer.from('not a png')), { format: 'unknown' })
})

test('尺寸规格解析：40×60 与 ≤110×72', () => {
  assert.deepEqual(parseSizeSpec('40×60，透明、可平铺'), { width: 40, height: 60, max: false })
  assert.deepEqual(parseSizeSpec('≤110×72'), { width: 110, height: 72, max: true })
  assert.equal(parseSizeSpec('没有尺寸'), null)
})

test('待画清单解析：读出 key / 尺寸 / 透明 / 可平铺', () => {
  const text = [
    '| 素材 | sprite key | 规格 | 说明 |',
    '|---|---|---|---|',
    '| 晴天叠加层 | `wx_clear_tile` | 40×60，透明、可平铺 | 全屏平铺 |',
    '| 骷髅图标 | `i_skull` | 48×48，透明底 | 图标 |',
  ].join('\n')
  const parsed = parseExpectations(text)
  assert.equal(parsed.wx_clear_tile.size.width, 40)
  assert.equal(parsed.wx_clear_tile.transparent, true)
  assert.equal(parsed.wx_clear_tile.tileable, true)
  assert.equal(parsed.i_skull.size.height, 48)
  assert.equal(parsed.i_skull.tileable, false)
})

test('文件名 → 素材 key：去掉 _1 / _40x60 这类尾巴', () => {
  assert.equal(assetKeyOf('wx_clear_tile_1.png'), 'wx_clear_tile')
  assert.equal(assetKeyOf('wx_clear_tile_40x60.png'), 'wx_clear_tile')
  assert.equal(assetKeyOf('i_skull_48.png'), 'i_skull')
  assert.equal(assetKeyOf('prof_lin.png'), 'prof_lin')
})

test('判定：尺寸不符 / 缺透明通道 / 空图 都要报出来', () => {
  const expected = { size: { width: 40, height: 60, max: false }, transparent: true, tileable: true }
  const big = judge({ actual: { format: 'png', width: 1024, height: 1536, hasAlphaChannel: true, bytes: 500000 }, expected })
  assert.equal(big.verdict, 'mismatch')
  assert.match(big.problems.join(''), /要求 40×60，实际生成 1024×1536/)
  const opaque = judge({ actual: { format: 'png', width: 40, height: 60, hasAlphaChannel: false, bytes: 3000 }, expected })
  assert.equal(opaque.verdict, 'broken')
  assert.match(opaque.problems.join(''), /透明通道/)
  const empty = judge({ actual: { format: 'png', width: 40, height: 60, hasAlphaChannel: true, bytes: 450 }, expected })
  assert.equal(empty.verdict, 'broken')
  assert.match(empty.problems.join(''), /空图/)
  const good = judge({ actual: { format: 'png', width: 40, height: 60, hasAlphaChannel: true, bytes: 9000 }, expected })
  assert.equal(good.verdict, 'ok')
})

test('端到端核对：规格 / 引用 / 空图三种结论都能给出来', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-check-'))
  try {
    const outputDir = path.join(root, 'out')
    const gameDir = path.join(root, 'game')
    await mkdir(path.join(outputDir, 'my-game'), { recursive: true })
    await mkdir(path.join(gameDir, 'src'), { recursive: true })

    // 清单要求：wx_clear_tile 40×60 透明可平铺；i_skull 48×48 透明底
    await writeFile(path.join(gameDir, '待画素材清单.md'), [
      '| 素材 | key | 规格 | 说明 |',
      '|---|---|---|---|',
      '| 晴天叠加层 | `wx_clear_tile` | 40×60，透明、可平铺 | 平铺整屏 |',
      '| 骷髅图标 | `i_skull` | 48×48，透明底 | 图标 |',
    ].join('\n'), 'utf8')

    // 生成的：一张尺寸不对(RGBA)，一张空图(450B 级别)，一张达标
    await writeFile(path.join(outputDir, 'my-game', 'wx_clear_tile_1.png'), makePng(64, 96))
    await writeFile(path.join(outputDir, 'my-game', 'i_skull_48.png'), makePng(48, 48))
    await writeFile(path.join(outputDir, 'my-game', 'hero_idle_1.png'), makePng(48, 64))

    // 游戏代码引用：wx_clear_tile 引用了，i_skull 没有，hero_idle 引用了
    await writeFile(path.join(gameDir, 'src', 'assetmap.js'), 'export const A = { wx_clear_tile: 1, hero_idle: 2 }\n', 'utf8')

    const result = await checkProject({ root: gameDir, outputDir, project: 'my-game' })
    assert.equal(result.ok, true)
    assert.equal(result.generated, 3)
    const byKey = Object.fromEntries(result.items.map((item) => [item.key, item]))

    assert.equal(byKey.wx_clear_tile.expected.size, '40×60，透明、可平铺')
    assert.equal(byKey.wx_clear_tile.size, '64×96')
    assert.equal(byKey.wx_clear_tile.verdict, 'mismatch')
    assert.ok(byKey.wx_clear_tile.referencedBy.some((ref) => ref.file === 'src/assetmap.js'))

    assert.equal(byKey.i_skull.verdict, 'not-referenced', '达标但没被引用 → 要提示登记')
    assert.equal(byKey.i_skull.referenceCount, 0)

    assert.equal(byKey.hero_idle.verdict, 'unknown-spec', '清单里没有它的规格')
    assert.ok(result.expectationSources.includes('待画素材清单.md'))
    assert.match(await readFile(path.join(gameDir, '待画素材清单.md'), 'utf8'), /wx_clear_tile/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
