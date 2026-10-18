/**
 * 像素化路由测试（核对页的「像素化」按钮打的就是这个口）。
 *
 * 钉住三件事：
 *   ① **绝不覆盖原图**（原图是花钱买来的，写坏了找不回来）—— 另存 *.pixel.png
 *   ② 默认输出保持**原尺寸**（不是逻辑分辨率）：给 8×8 的 93 字节小图，用户会以为处理坏了
 *   ③ 返回值里**不能带 pixels/buffer**（TypedArray 进 JSON 会把响应撑爆、卡死浏览器）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'

const SIZE = 64
const LOGICAL = 8
const PALETTE = [[20, 24, 32], [224, 96, 58], [60, 140, 220], [240, 240, 230]]

/** 造一张「8×8 逻辑像素、每块 8×8」的伪像素图。 */
function fakePixelPng() {
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const bx = Math.floor(x / LOGICAL)
      const by = Math.floor(y / LOGICAL)
      const color = PALETTE[(bx + by * 2) % PALETTE.length]
      const i = (y * SIZE + x) * 4
      pixels[i] = color[0]
      pixels[i + 1] = color[1]
      pixels[i + 2] = color[2]
      pixels[i + 3] = 255
    }
  }
  return encodePngRgba(SIZE, SIZE, pixels)
}

/** 注册插件并拿到面板路由（不起真服务器）。 */
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pixroute-'))
  const outDir = path.join(dir, 'out', 'game')
  await mkdir(outDir, { recursive: true })
  const src = path.join(outDir, 't.png')
  const original = fakePixelPng()
  await writeFile(src, original)

  const routes = new Map()
  const effect = (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } }
  apply({
    tools: { register: () => () => {} },
    effect,
    get: () => undefined,
    inject: (names, fn) => {
      if (names.includes('webServer')) fn({ webServer: { register: (route) => { routes.set(route.path, route); return () => {} } }, effect })
    },
  }, { dataDir: path.join(dir, 'data'), outputDir: path.join(dir, 'out') })
  const route = routes.get('/gpt-image')
  assert.ok(route, '面板路由要注册')

  const call = async (body) => {
    let text = ''
    const req = {
      method: 'POST',
      url: '/gpt-image/api/pixelize',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* gen() { yield Buffer.from(JSON.stringify(body)) },
    }
    const res = { writeHead() { return this }, end(chunk) { if (chunk) text += chunk.toString() } }
    await route.handler(req, res)
    return JSON.parse(text)
  }
  return { dir, src, original, call, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('像素化：默认保持原尺寸（不是逻辑分辨率），且**原图逐字节不变**', async () => {
  const h = await setup()
  try {
    const before = await stat(h.src)
    const result = await h.call({ path: h.src })
    assert.equal(result.ok, true, result.error)
    assert.equal(path.basename(result.output), 't.pixel.png', '另存为 *.pixel.png')
    assert.match(result.note, /原图未改动/)

    // 输出可解码，且**还是 64×64**（默认 origin 而不是 logical 的 8×8）
    const decoded = decodePngRgba(await readFile(result.output))
    assert.ok(decoded, '输出必须是合法 PNG')
    assert.equal(decoded.width, SIZE, `默认应保持原宽 ${SIZE}，实际 ${decoded.width}`)
    assert.equal(decoded.height, SIZE)

    // 原图一个字节都没动
    const after = await stat(h.src)
    assert.equal(after.size, before.size, '原图大小不能变')
    assert.ok((await readFile(h.src)).equals(h.original), '原图内容不能被改写')
  } finally {
    await h.cleanup()
  }
})

test('像素化：显式 output=logical 时给逻辑分辨率（想要真·8×8 的场合）', async () => {
  const h = await setup()
  try {
    const result = await h.call({ path: h.src, output: 'logical' })
    assert.equal(result.ok, true, result.error)
    const decoded = decodePngRgba(await readFile(result.output))
    assert.equal(decoded.width, LOGICAL, `logical 模式应输出 ${LOGICAL}px 宽，实际 ${decoded.width}`)
    assert.equal(decoded.height, LOGICAL)
  } finally {
    await h.cleanup()
  }
})

test('像素化：返回值里不能带 pixels/buffer（TypedArray 进 JSON 会撑爆响应）', async () => {
  const h = await setup()
  try {
    const result = await h.call({ path: h.src })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.pixels, undefined, '不能把像素数组塞进 JSON')
    assert.equal(result.buffer, undefined, '不能把 PNG buffer 塞进 JSON')
    // 体积要合理（几 KB 以内），否则说明混进了大数组
    const size = JSON.stringify(result).length
    assert.ok(size < 8000, `响应体 ${size} 字节，太大了（疑似把像素数组 JSON 化了）`)
    // 该有的元信息要有
    assert.ok(result.width > 0 && result.height > 0)
    assert.ok(result.logical, '要告诉人识别出的逻辑分辨率')
  } finally {
    await h.cleanup()
  }
})

test('像素化：不许碰输出目录/数据目录之外的文件（同源栅栏的补充）', async () => {
  const h = await setup()
  try {
    const outside = path.join(os.tmpdir(), '绝对不该被处理_' + Date.now() + '.png')
    await writeFile(outside, fakePixelPng())
    try {
      const result = await h.call({ path: outside })
      assert.equal(result.ok, false, '输出目录外的文件必须拒绝')
      assert.match(result.error, /输出目录|数据目录/)
    } finally {
      await rm(outside, { force: true })
    }
  } finally {
    await h.cleanup()
  }
})

test('像素化：文件不存在时给出明确错误，而不是抛异常', async () => {
  const h = await setup()
  try {
    const result = await h.call({ path: path.join(h.dir, 'out', 'game', '不存在.png') })
    assert.equal(result.ok, false)
    assert.match(result.error, /读不到文件/)
  } finally {
    await h.cleanup()
  }
})
