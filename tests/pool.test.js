/**
 * 攒批（省钱）与装机（直接用在游戏里）：
 *  - 需求池：不到阈值不生图、按题材给阈值（卡牌 12 张）、给出花费预估、去重
 *  - 装机：按规格缩放后落到游戏目录，并复核尺寸/引用
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DemandPool } from '../lib/pool.js'
import { findDestination, fitToSpec } from '../lib/install.js'

function makePng(width, height, alpha = true) {
  const channels = alpha ? 4 : 3
  const raw = Buffer.alloc(height * (1 + width * channels))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[offset++] = (x * 31 + y * 17 + c * 53) % 251
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
  ihdr[9] = alpha ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('需求池：不到阈值不给跑，到阈值才 ready，花费按单价算', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-pool-'))
  try {
    const pool = await DemandPool.load(dir)
    assert.equal(pool.thresholdFor(''), 8)
    assert.equal(pool.thresholdFor('card'), 12, '卡牌类默认攒 12 张')
    assert.equal(pool.price, 0.04)

    const assets = Array.from({ length: 7 }, (_, i) => ({ name: `card_${i}`, prompt: `卡牌 ${i}`, kind: 'card' }))
    const { added } = pool.enqueue({ project: 'spire', genre: 'card', suggestions: assets })
    assert.equal(added.length, 7)
    await pool.save()

    let report = pool.report({ genre: 'card', project: 'spire' })
    assert.equal(report.pending, 7)
    assert.equal(report.threshold, 12)
    assert.equal(report.ready, false)
    assert.equal(report.need_more, 5)
    assert.equal(report.cost_if_now, 0.28)
    assert.equal(report.cost_at_threshold, 0.48)
    assert.match(report.advice, /还差 5 张/)

    // 再来 5 张 → 达标
    pool.enqueue({ project: 'spire', genre: 'card', suggestions: Array.from({ length: 5 }, (_, i) => ({ name: `card_x${i}`, prompt: `卡牌 x${i}` })) })
    report = pool.report({ genre: 'card', project: 'spire' })
    assert.equal(report.pending, 12)
    assert.equal(report.ready, true)
    assert.match(report.advice, /可以开跑/)

    // 生成完标记掉，池子清空
    const marked = pool.markGenerated(report.items.map((item) => item.name), 'spire')
    assert.equal(marked, 12)
    assert.equal(pool.report({ genre: 'card', project: 'spire' }).pending, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('需求池：已生成过的不再入池（不重复花钱），重复登记只留一条', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-pool2-'))
  try {
    const pool = await DemandPool.load(dir)
    const first = pool.enqueue({ project: 'p', suggestions: [{ name: 'a', prompt: 'A' }, { name: 'a', prompt: 'A' }] })
    assert.equal(first.added.length, 1, '同名同提示词只登记一次')
    assert.equal(first.skipped.length, 1)

    const again = pool.enqueue({ project: 'p', suggestions: [{ name: 'b', prompt: 'B' }], existingFingerprints: new Set([pool.fingerprintOf('p', { name: 'b', prompt: 'B' })]) })
    assert.equal(again.added.length, 0, '指纹命中（已生成）不再入池')
    assert.match(again.skipped[0].why, /已经生成过/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('装机：按规格缩放保留透明通道（真机执行，依赖本机 PowerShell）', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-fit-'))
  try {
    const src = path.join(dir, 'master.png')
    await writeFile(src, makePng(1024, 1536, true))
    const out = path.join(dir, 'fitted.png')
    const result = await fitToSpec({ file: src, outFile: out, width: 40, height: 60 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.width, 40)
    assert.equal(result.height, 60)
    assert.equal(result.hasAlphaChannel, true, '必须保留透明通道')
    assert.ok((await stat(out)).size > 300, '不能缩成空图')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('装机落位：磁盘上已有同名文件就替换它（游戏真正在读的那张）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-dest-'))
  try {
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets', 'wx_clear_tile_40x60.png'), makePng(40, 60))
    const found = await findDestination({ root, key: 'wx_clear_tile' })
    assert.equal(found.kind, 'existing')
    assert.match(found.file.replace(/\\/g, '/'), /assets\/wx_clear_tile_40x60\.png$/)

    // 没有同名文件时，退回代码里引用过的 assets 目录
    const root2 = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-dest2-'))
    try {
      await mkdir(path.join(root2, 'assets'), { recursive: true })
      await writeFile(path.join(root2, 'src.js'), "const a = 'assets/i_skull.png'\n")
      const found2 = await findDestination({ root: root2, key: 'i_skull' })
      assert.equal(found2.kind, 'asset-dir')
      assert.match(found2.file.replace(/\\/g, '/'), /assets\/i_skull\.png$/)
    } finally {
      await rm(root2, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
