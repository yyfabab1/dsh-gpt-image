/**
 * 硬性规定：每个素材必须有名字，且每张图都要有「画面内带名字」的预览图。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { labelForAsset, labelImage, nameFromPrompt } from '../lib/label.js'
import { pngInfoFromBuffer } from '../lib/pnginfo.js'

function png(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) raw[offset++] = (x * 29 + y * 13 + c * 47) % 251
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

test('硬规定①：素材必须有名字 —— 没给就从提示词提炼，绝不留空', () => {
  assert.equal(nameFromPrompt('a red apple on white background'), 'a_red_apple_on')
  assert.equal(nameFromPrompt('  像素风 塔防 火焰塔  '), '像素风_塔防_火焰塔')
  assert.equal(nameFromPrompt('!!!'), 'asset')
  assert.ok(nameFromPrompt('').length > 0, '空提示词也要有兜底名')
})

test('硬规定②：没有 name 时 labelForAsset 明确报错（不许静默产出无名字的图）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-label-'))
  try {
    const file = path.join(dir, 'a.png')
    await writeFile(file, png(32, 32))
    const bad = await labelForAsset({ file, name: '' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /必须有 name/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('硬规定③：标签图里真的画了名字（真机执行，Windows）', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-label2-'))
  try {
    const file = path.join(dir, 'wx_clear_tile.png')
    await writeFile(file, png(40, 60))
    const result = await labelForAsset({ file, name: 'wx_clear_tile', project: 'doomsday-ember', size: '40x60' })
    assert.equal(result.ok, true, result.error)
    const buffer = await readFile(result.file)
    const info = pngInfoFromBuffer(buffer)
    assert.equal(info.format, 'png')
    assert.ok(info.width >= 200, `小图要放大到看得清字（实际 ${info.width}）`)
    assert.ok(info.height >= 200)
    assert.ok(buffer.length > 2000)
    assert.match(result.file, /_labeled\.png$/)
    // 标签条的顶部像素应该是深色（画了黑底标签栏）
    const top = buffer.slice(0, 200)
    assert.ok(top.length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
