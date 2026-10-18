/**
 * 六项优化 + 三项扩展的回归测试。
 * 重点锁「省钱」与「不白干」：热启动不重复探针、真实单价校准、重试有上限、
 * 风格指纹可比、依赖图先通用后具体、自检能揪出废图、登记不写生成物。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { mergeLearnings, exactKey, sharedKey } from '../lib/warmstart.js'
import { budgetCalendar, calibratePrice, calendarText, extractActualCost } from '../lib/cost.js'
import { styleFingerprint, styleLabel, styleSimilarity, fingerprintPrompt, decodeJpegSample } from '../lib/stylefp.js'
import { classifyAsset, planGenerationOrder } from '../lib/depgraph.js'
import { reviewImage } from '../lib/review.js'
import { detectGenerated, findKeyPattern } from '../lib/register.js'
import { SpendLedger } from '../lib/spend.js'

function png(width, height, fill) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y)
      raw[offset++] = r; raw[offset++] = g; raw[offset++] = b; raw[offset++] = a
    }
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

// ── ① 热启动 ────────────────────────────────────────────────────────
test('热启动：换尺寸/质量不再冷启动 —— 共享经验也算「热」', () => {
  assert.equal(exactKey({ model: 'm', size: '1024x1536', quality: 'low' }), 'm|1024x1536|low')
  assert.equal(sharedKey({ provider: 'openai', model: 'm' }), 'openai|m')

  // 老键有 6 次成功经验，新尺寸没有任何精确经验
  const shared = { n: 6, concurrency: 4, failRate: 0, ewmaLatencyMs: 141000, maxLatencyMs: 214000 }
  const merged = mergeLearnings({ exact: { n: 0 }, shared })
  assert.equal(merged.warmed, true, '有共享经验就不该再探针')
  assert.equal(merged.concurrency, 4, '共享并发要继承下来')
  assert.equal(merged.maxLatencyMs, 214000, '延迟也继承（总比默认 20s 准）')

  const cold = mergeLearnings({ exact: { n: 0 }, shared: { n: 0 } })
  assert.equal(cold.warmed, false, '真第一次才探针')
  assert.equal(cold.concurrency, 1)
})

test('热启动：精确经验优先于共享（同尺寸更准）', () => {
  const merged = mergeLearnings({
    exact: { n: 4, concurrency: 2, ewmaLatencyMs: 100000, maxLatencyMs: 120000 },
    shared: { n: 20, concurrency: 4, ewmaLatencyMs: 200000, maxLatencyMs: 300000 },
  })
  assert.equal(merged.ewmaLatencyMs, 100000, '同尺寸的延迟更可信')
  assert.equal(merged.maxLatencyMs, 120000)
})

// ── ② 真实单价校准 ──────────────────────────────────────────────────
test('真实单价：手动报账可校准，之后预算按真实价算', () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04 })
  const result = calibratePrice(spend, { images: 12, actualCost: 0.48 })
  assert.equal(result.ok, true)
  assert.equal(result.price_per_image, 0.04, '0.48/12 = 0.04，与默认一致')
  const second = calibratePrice(spend, { images: 10, actualCost: 0.30 })
  assert.equal(second.price_per_image, 0.03, '校准成 3 分')
  assert.equal(spend.price, 0.03)
  assert.match(second.hint, /校准/)
  // 校准后闸门按新单价估算
  const gate = spend.check({ images: 10, action: 'generate' })
  assert.equal(gate.estimate, 0.3)
})

test('真实单价：能从上游响应里挖出实际花费（多种字段）', () => {
  assert.equal(extractActualCost({ usage: { total_cost: 0.12 } }), 0.12)
  assert.equal(extractActualCost({ cost: 0.5 }), 0.5)
  assert.equal(extractActualCost({ billing: { cost: 0.07 } }), 0.07)
  assert.equal(extractActualCost({ nothing: true }), null)
})

test('预算日历：按天聚合 + 趋势 + 文本条形图', () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04 })
  const today = new Date().toISOString().slice(0, 10)
  spend.record({ action: 'batch', images: 5, cost: 0.2 })
  const calendar = budgetCalendar(spend, { days: 30 })
  assert.equal(calendar.today, today)
  assert.equal(calendar.spent_today, 0.2)
  assert.equal(calendar.total_images, 5)
  const chart = calendarText(calendar.calendar)
  assert.match(chart, /0\.2000/)
  assert.match(chart, /█/)
})

// ── ③ 失败重试（在 batch 里，用源码契约锁） ──────────────────────────
test('失败重试：同素材最多重试 1 次，且重试仍计入花费', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'batch', 'run.js'), 'utf8')
  assert.match(source, /maxAttempts = Math\.max\(1, Math\.min\(2, Number\(args\.retries \?\? 1\) \+ 1\)\)/, '默认重试 1 次')
  assert.match(source, /imagesAttempted \+= entry\.images/, '重试也要计入已尝试张数')
  assert.match(source, /retryable/, '只有可重试的错误才重试')
  assert.match(source, /sleep\(Math\.min\(20_000/, '要有退避')
})

// ── ④ 风格指纹 ──────────────────────────────────────────────────────
test('风格指纹：能测出主色/明暗/线条密度，且同风格更相似', () => {
  // 同一套配色、不同尺寸 → 应该很像
  const a = styleFingerprint(png(64, 64, (x, y) => (x + y) % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]))
  const b = styleFingerprint(png(96, 96, (x, y) => (x + y) % 2 ? [250, 5, 5, 255] : [5, 5, 250, 255]))
  const c = styleFingerprint(png(64, 64, () => [10, 10, 10, 255]))
  assert.ok(a && b && c)
  assert.ok(a.palette.length >= 2, '要采到主色')
  assert.ok(styleSimilarity(a, b) > styleSimilarity(a, c), '同风格应比全黑更相似')
  assert.ok(styleSimilarity(a, b) > 0.6)
  assert.match(fingerprintPrompt(a), /dominant palette/)
  assert.ok(styleLabel(a).length > 0)
})

test('风格指纹：纯色/全黑能被判成可疑废图', () => {
  const black = reviewImage({ buffer: png(64, 64, () => [0, 0, 0, 255]) })
  assert.equal(black.ok, false)
  assert.ok(black.problems.some((p) => /全黑|单色/.test(p)))
  const flat = reviewImage({ buffer: png(64, 64, () => [128, 128, 128, 255]) })
  assert.equal(flat.ok, false)
  assert.ok(flat.problems.some((p) => /单色/.test(p)))
  const good = reviewImage({ buffer: png(64, 64, (x, y) => [(x * 7) % 256, (y * 11) % 256, ((x + y) * 13) % 256, 255]) })
  assert.equal(good.ok, true, JSON.stringify(good.problems))
})

test('风格指纹：JPEG 也能解（不解就等于整库索引失败）', () => {
  // 最小 JPEG 头（SOI），解不出内容但不应崩
  const fake = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  assert.equal(decodeJpegSample(fake), null)
  assert.equal(styleFingerprint(fake), null, '解不出要返回 null 而不是抛异常')
})

// ── ⑤ 依赖图：先通用后具体 ──────────────────────────────────────────
test('依赖图：分类正确，通用件排在具体件之前', () => {
  assert.equal(classifyAsset('ui_frame_panel').generic, true)
  assert.equal(classifyAsset('card_frame_rare').generic, true)
  assert.equal(classifyAsset('card_art_fire').generic, false)
  assert.equal(classifyAsset('t_wall').generic, true)
})

test('依赖图：真实项目里能排出「先 UI/地形、后具体图」的批次', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-dep-'))
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'game.js'), [
      "const a = 'ui_frame_panel';",
      "const b = 't_wall';",
      "const c = 'card_art_fire';",
      "const d = 'card_art_ice';",
      "const e = 'wx_clear_tile';",
      'export { a, b, c, d, e };',
    ].join('\n'), 'utf8')
    const result = await planGenerationOrder({ root })
    assert.equal(result.ok, true)
    const groups = result.batches.map((batch) => batch.group)
    const uiIndex = groups.indexOf('ui')
    const artIndex = groups.indexOf('card-art')
    assert.ok(uiIndex >= 0, '要识别出 UI 通用件')
    assert.ok(artIndex < 0 || uiIndex < artIndex, '通用件必须在具体件之前')
    assert.ok(result.batches[0].generic, '第一批必须是通用件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── ⑥ 自动登记 ──────────────────────────────────────────────────────
test('自动登记：认得出真实登记格式，且拒绝写构建生成物', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-reg-'))
  try {
    // 真实格式（实测自 96_rpgasset.js）： "key":{"s":"data:...","w":40,"h":60,"base":0,"g":"wx","label":"x"}
    const registry = path.join(root, 'src_assets_data.js')
    await writeFile(registry, '"wx_clear_tile":{"s":"","w":0,"h":0,"base":0,"g":"wx","label":"晴天"};', 'utf8')
    const found = findKeyPattern(await readFile(registry, 'utf8'), 'wx_clear_tile')
    assert.ok(found, '要能匹配真实格式')
    assert.match(found[0], /"label":"晴天"/, 'label 等字段必须在匹配范围内')

    const generated = path.join(root, 'generated.js')
    await writeFile(generated, '/* 由 build.mjs 自动生成，请勿手改 */\n"a_b":{"s":"","w":0,"h":0};', 'utf8')
    const detection = await detectGenerated(generated)
    assert.ok(detection, '构建生成物必须被识别')
    assert.match(detection.evidence, /请勿手改|build\.mjs/)

    const normal = path.join(root, 'normal.js')
    await writeFile(normal, '"a_b":{"s":"","w":0,"h":0};', 'utf8')
    assert.equal(await detectGenerated(normal), null, '普通文件不该被误判')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
