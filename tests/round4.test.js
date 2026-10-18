/**
 * 第四轮：审批流 / 跨项目风格 / 图标集批量生成 的回归测试。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ApprovalQueue, approvalText, approvalToken } from '../lib/approval.js'
import { gridFor, sheetPrompt, sliceSheet } from '../lib/sheet.js'
import { decodePngRgba, encodePngRgba } from '../lib/pngcodec.js'
import { profileOf, compareProjects } from '../lib/crossstyle.js'
import { pngInfoFromBuffer } from '../lib/pnginfo.js'

/** 造一张 sheet：每个格子一种纯色，验证切图落到正确的格子。 */
function makeSheet(width, height, columns, rows) {
  const pixels = Buffer.alloc(width * height * 4)
  const cellW = Math.floor(width / columns)
  const cellH = Math.floor(height / rows)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const column = Math.floor(x / cellW)
      const row = Math.floor(y / cellH)
      const i = (y * width + x) * 4
      pixels[i] = 40 * column + 20
      pixels[i + 1] = 40 * row + 20
      pixels[i + 2] = 128
      pixels[i + 3] = 255
    }
  }
  return encodePngRgba(width, height, pixels)
}

// ── 审批流 ──────────────────────────────────────────────────────────
test('审批流：不超阈值不需要审批，超了就要', () => {
  const queue = new ApprovalQueue('', { threshold: 5 })
  assert.equal(queue.needsApproval({ cost: 0.4 }).required, false, '小额直接放行')
  const big = queue.needsApproval({ cost: 6 })
  assert.equal(big.required, true)
  assert.match(big.reason, /超过审批阈值/)
})

test('审批流：单号由参数决定 —— 参数变了单子作废（防批 A 跑 B）', () => {
  const base = { action: 'batch', project: 'demo', names: ['a', 'b'], images: 6, cost: 0.24 }
  assert.equal(approvalToken(base), approvalToken({ ...base }), '同参数同单号')
  assert.notEqual(approvalToken(base), approvalToken({ ...base, images: 7 }), '张数变了单号必须变')
  assert.notEqual(approvalToken(base), approvalToken({ ...base, project: 'other' }), '项目变了单号必须变')
  assert.equal(approvalToken(base), approvalToken({ ...base, names: ['b', 'a'] }), '名字顺序不影响')
})

test('审批流：批准后才放行；驳回不放行；重复处理被拒', () => {
  const queue = new ApprovalQueue('', { threshold: 5 })
  const item = queue.create({ action: 'batch', project: 'demo', names: ['a'], images: 6, cost: 6 })
  assert.equal(queue.needsApproval({ cost: 6, token: item.token }).required, true, 'pending 状态不算批准')
  assert.equal(queue.decide(item.token, 'approve').ok, true)
  assert.equal(queue.needsApproval({ cost: 6, token: item.token }).required, false, '批准后放行')
  assert.equal(queue.decide(item.token, 'approve').ok, false, '不能重复批准')

  const other = queue.create({ action: 'batch', project: 'demo', names: ['b'], images: 6, cost: 6 })
  queue.decide(other.token, 'reject')
  assert.equal(queue.needsApproval({ cost: 6, token: other.token }).required, true, '驳回后仍要审批')
})

test('审批流：待批准单文本包含花费/用途/影响范围/单号', () => {
  const queue = new ApprovalQueue('', { threshold: 5 })
  const item = queue.create({
    action: 'pipeline', project: 'doomsday-ember', names: ['wx_clear_tile', 't_path'],
    images: 12, cost: 0.48, purpose: '补天气层素材', impact_files: ['src/84_assetmap.js'],
  })
  const text = approvalText(item)
  assert.match(text, /要花：0\.48/)
  assert.match(text, /12 张/)
  assert.match(text, /补天气层素材/)
  assert.match(text, /wx_clear_tile/)
  assert.match(text, /src\/84_assetmap\.js/)
  assert.match(text, new RegExp(item.token))
})

test('审批流：超过 24h 未处理会被标 stale', () => {
  const queue = new ApprovalQueue('', { threshold: 5 })
  const item = queue.create({ action: 'batch', project: 'p', names: [], images: 6, cost: 6 })
  item.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  const listed = queue.list({ status: 'pending' })
  assert.equal(listed[0].stale, true)
})

// ── 图标集 ──────────────────────────────────────────────────────────
test('网格推算：尽量接近正方形，容量够放', () => {
  assert.deepEqual(gridFor(1), { columns: 1, rows: 1, capacity: 1 })
  assert.deepEqual(gridFor(4), { columns: 2, rows: 2, capacity: 4 })
  assert.deepEqual(gridFor(9), { columns: 3, rows: 3, capacity: 9 })
  assert.equal(gridFor(10).capacity >= 10, true)
  assert.equal(gridFor(16).columns, 4)
})

test('合集提示词：明确网格、编号、风格一致、无文字', () => {
  const prompt = sheetPrompt({ items: ['金币', '红药水', '蓝药水', '钥匙'], columns: 2, rows: 2, style: 'pixel art' })
  assert.match(prompt, /strict 2x2 grid/)
  assert.match(prompt, /1\. 金币/)
  assert.match(prompt, /4\. 钥匙/)
  assert.match(prompt, /consistent art style/)
  assert.match(prompt, /no text, no labels/)
  assert.match(prompt, /pixel art/)
})

test('PNG 编解码：RGBA 往返一致，透明通道保留', () => {
  const width = 8
  const height = 4
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = i % 256
    pixels[i * 4 + 1] = (i * 3) % 256
    pixels[i * 4 + 2] = (i * 7) % 256
    pixels[i * 4 + 3] = i % 3 === 0 ? 0 : 255 // 制造透明像素
  }
  const encoded = encodePngRgba(width, height, pixels)
  const info = pngInfoFromBuffer(encoded)
  assert.equal(info.width, width)
  assert.equal(info.height, height)
  assert.equal(info.hasAlphaChannel, true)
  const decoded = decodePngRgba(encoded)
  assert.equal(decoded.width, width)
  assert.equal(decoded.pixels.equals(pixels), true, '像素必须完全一致（无损）')
})

test('切图：每格切到正确的颜色块，且输出是合法 PNG', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-sheet-'))
  try {
    const sheetFile = path.join(dir, 'sheet.png')
    await writeFile(sheetFile, makeSheet(120, 80, 3, 2))
    const result = await sliceSheet({
      sheetFile,
      outDir: path.join(dir, 'slices'),
      items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }, { name: 'f' }],
      columns: 3,
      rows: 2,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.slices.length, 6)
    assert.equal(result.grid.cellWidth, 40)
    assert.equal(result.grid.cellHeight, 40)
    assert.equal(result.slices[0].cell, '0,0')
    assert.equal(result.slices[2].cell, '2,0')
    assert.equal(result.slices[3].cell, '0,1')

    // 第一格应该是 (20,20,128)，第四格 (20,60,128) —— 验证没切错位置
    const first = decodePngRgba(await readFile(result.slices[0].file))
    const fourth = decodePngRgba(await readFile(result.slices[3].file))
    assert.equal(first.pixels[0], 20)
    assert.equal(first.pixels[1], 20)
    assert.equal(fourth.pixels[1], 60, '第 4 张应来自第 2 行')
    const info = pngInfoFromBuffer(await readFile(result.slices[0].file))
    assert.equal(info.format, 'png')
    assert.equal(info.hasAlphaChannel, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('切图：网格太密时明确报错而不是产出垃圾', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-sheet2-'))
  try {
    const sheetFile = path.join(dir, 'tiny.png')
    await writeFile(sheetFile, makeSheet(8, 8, 2, 2))
    const result = await sliceSheet({ sheetFile, outDir: path.join(dir, 'out'), items: [{ name: 'a' }], columns: 64, rows: 64 })
    assert.equal(result.ok, false)
    assert.match(result.error, /网格太密/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 跨项目风格 ──────────────────────────────────────────────────────
test('跨项目对比：两套美术语言会给出「别互相参考」的警告', () => {
  const doomsday = { samples: 5, palette: [{ hex: '#080808' }, { hex: '#e8e8d8' }], ink: 0.5, saturation: 0.08, edgeDensity: 0.5 }
  const starcraft = { samples: 5, palette: [{ hex: '#204080' }, { hex: '#ffcc00' }], ink: 0.3, saturation: 0.8, edgeDensity: 0.1 }
  const close = { samples: 5, palette: [{ hex: '#080808' }, { hex: '#e8e8d8' }], ink: 0.52, saturation: 0.09, edgeDensity: 0.49 }
  const result = compareProjects({ doomsday, starcraft, close })
  const pair = result.pairs.find((entry) => entry.a === 'doomsday' && entry.b === 'starcraft')
  assert.ok(pair.similarity < 0.35, `差异应很大，实际 ${pair.similarity}`)
  assert.match(pair.verdict, /别互相引用参考图/)
  const similar = result.pairs.find((entry) => (entry.a === 'doomsday' && entry.b === 'close') || (entry.a === 'close' && entry.b === 'doomsday'))
  assert.ok(similar.similarity > pair.similarity, '同风格应比跨风格更相似')
  assert.match(result.warning, /同项目/)
})

test('跨项目对比：档案取中位数，抗离群', () => {
  const profile = profileOf([
    { ink: 0.5, saturation: 0.1, edgeDensity: 0.4, palette: [{ hex: '#000000', share: 0.5 }], alphaRatio: 0 },
    { ink: 0.5, saturation: 0.1, edgeDensity: 0.4, palette: [{ hex: '#000000', share: 0.5 }], alphaRatio: 0 },
    { ink: 0.9, saturation: 0.9, edgeDensity: 0.9, palette: [{ hex: '#ffffff', share: 0.1 }], alphaRatio: 1 },
  ])
  assert.equal(profile.samples, 3)
  assert.equal(profile.ink, 0.5, '中位数不受离群影响')
  assert.equal(profile.palette[0].hex, '#000000')
})

test('同项目参考约束：没指定项目时不许跨项目挑参考图', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'styleref.js'), 'utf8')
  assert.match(source, /crossProjectBlocked/, '必须有跨项目拦截标记')
  assert.match(source, /绝不跨项目挑/, '注释要写明原因')
  assert.match(source, /cross_project_blocked/, '结果里要暴露这个状态')
})
