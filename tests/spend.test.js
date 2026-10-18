/**
 * 花钱闸门（多道锁）与风格参考：
 *  - 四道锁：总闸 / 单次张数 / 超过 N 张要 confirm / 日预算
 *  - 每笔记账，可随时查今天花了多少
 *  - 风格参考：从游戏现有素材里挑参考图，避免风格漂移
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { SpendLedger } from '../lib/spend.js'
import { pickStyleRefs, stylePrompt } from '../lib/styleref.js'

function bigPng(width = 160, height = 160) {
  const channels = 4
  const raw = Buffer.alloc(height * (1 + width * channels))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[offset++] = (x * 37 + y * 11 + c * 61) % 251
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

const ledger = () => new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 1.0, perRunMaxImages: 12, confirmAboveImages: 1, spendDisabled: false } })

test('锁①总闸：spendDisabled 时任何付费调用都被拒', () => {
  const spend = ledger()
  spend.data.locks.spendDisabled = true
  const gate = spend.check({ images: 1, action: 'generate' })
  assert.equal(gate.allow, false)
  assert.match(gate.refusals.join(''), /总闸关着/)
  assert.match(gate.hint, /没有花任何钱/)
})

test('锁②单次张数：超过 perRunMaxImages 直接拒绝', () => {
  const spend = ledger()
  const gate = spend.check({ images: 20, action: 'batch', confirm: true })
  assert.equal(gate.allow, false)
  assert.match(gate.refusals.join(''), /单次最多 12 张/)
})

test('锁③确认锁：一次多于 1 张必须 confirm（1 张放行）', () => {
  const spend = ledger()
  const one = spend.check({ images: 1, action: 'generate' })
  assert.equal(one.allow, true, '单张探针不用确认')
  const many = spend.check({ images: 8, action: 'pool.flush' })
  assert.equal(many.allow, false)
  assert.equal(many.needConfirm, true)
  assert.match(many.hint, /确认就再调一次并带 confirm=true/)
  assert.equal(many.estimate, 0.32)
  const confirmed = spend.check({ images: 8, action: 'pool.flush', confirm: true })
  assert.equal(confirmed.allow, true)
})

test('锁④日预算：今天花掉的钱会累计，超预算直接拒绝', () => {
  const spend = ledger()
  // 先花 20 张 = 0.8 元
  spend.record({ action: 'pool.flush', images: 20, cost: 0.8, project: 'p' })
  assert.equal(spend.todaySpent(), 0.8)
  assert.equal(spend.todayImages(), 20)
  const ok = spend.check({ images: 5, action: 'batch', confirm: true }) // 0.8 + 0.2 = 1.0
  assert.equal(ok.allow, true, '正好到预算上限可以跑')
  const blocked = spend.check({ images: 8, action: 'batch', confirm: true }) // 0.8 + 0.32 > 1.0
  assert.equal(blocked.allow, false)
  assert.match(blocked.refusals.join(''), /日预算 1 CNY/)
  assert.equal(blocked.today.cost, 0.8)
})

test('记账：totals 与今日统计、最近记录都对得上', () => {
  const spend = ledger()
  spend.record({ action: 'generate', images: 1, project: 'a', names: ['x'] })
  spend.record({ action: 'pool.flush', images: 8, project: 'a' })
  assert.equal(spend.data.totals.images, 9)
  assert.equal(spend.data.totals.runs, 2)
  assert.ok(Math.abs(spend.data.totals.cost - (0.04 + 0.32)) < 1e-9)
  assert.equal(spend.data.records.length, 2)
})

test('风格参考：优先游戏里同分类的现有素材，其次本项目已生成的图', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-style-'))
  try {
    await mkdir(path.join(root, 'assets', 'cards'), { recursive: true })
    const blob = Buffer.alloc(5000, 7) // styleref 只看文件大小（太小/太薄不当参考），不需要真 PNG
    await writeFile(path.join(root, 'assets', 'cards', 'card_fire.png'), blob)
    await writeFile(path.join(root, 'assets', 'cards', 'card_ice.png'), blob)
    await writeFile(path.join(root, 'assets', 'bg_forest.png'), blob)

    const picked = await pickStyleRefs({ root, kind: 'card', max: 2 })
    assert.equal(picked.files.length, 2)
    assert.ok(picked.files.every((file) => /card_/.test(path.basename(file))), '卡牌类优先挑卡牌素材')
    assert.match(picked.note, /风格参考/)

    const none = await pickStyleRefs({ root: path.join(root, 'nope'), kind: 'card' })
    assert.equal(none.files.length, 0)
    assert.match(none.note, /没找到可用作风格参考/)

    const prompt = stylePrompt('一张火焰卡牌', picked.files)
    assert.match(prompt, /一张火焰卡牌/)
    assert.match(prompt, /match the art style/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
