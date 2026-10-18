/**
 * 本轮优化与扩展的回归测试。
 * 锁住的是「这轮踩过的坑别再犯」：参考图打分、提示词库回流、花费预测、使用热度去噪。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { aspectScore, parseAspect, scoreReference } from '../lib/refpick.js'
import { PromptLibrary, normalizePrompt, promptKey } from '../lib/prompts.js'
import { forecastSpend, budgetCalendar } from '../lib/cost.js'
import { usageHeatmap } from '../lib/heatmap.js'
import { SpendLedger } from '../lib/spend.js'

// ── 参考图打分 ──────────────────────────────────────────────────────
test('宽高比解析与相似度：竖版卡牌不该配横版背景', () => {
  assert.deepEqual(parseAspect('1024x1536'), { width: 1024, height: 1536, ratio: 1024 / 1536 })
  assert.deepEqual(parseAspect('40×60'), { width: 40, height: 60, ratio: 40 / 60 })
  assert.equal(parseAspect('自动'), null)
  const portrait = parseAspect('40x60')
  const portrait2 = parseAspect('48x72')
  const landscape = parseAspect('1536x1024')
  assert.ok(aspectScore(portrait, portrait2) > aspectScore(portrait, landscape), '同为竖版应更接近')
  assert.equal(aspectScore(null, portrait), 0.5, '信息不足给中性分，不能直接否决')
})

test('参考图打分：分类一致 + 宽高比 + 指纹 三者都参与', () => {
  const target = { targetKind: 'card', targetSize: '1024x1536', targetFingerprint: { palette: [{ hex: '#ff0000' }], ink: 0.5, saturation: 0.5, edgeDensity: 0.3 } }
  const sameKind = scoreReference({ name: 'card_a.png', kind: 'card', size: '1024x1536', entry: target.targetFingerprint }, target)
  const otherKind = scoreReference({ name: 'bg_a.png', kind: 'background', size: '1536x1024' }, target)
  assert.ok(sameKind.score > otherKind.score, '同类+同宽高比+同指纹必须分更高')
  assert.ok(sameKind.parts.some((part) => part.key === 'same-kind'))
  assert.ok(sameKind.parts.some((part) => part.key === 'aspect'))
  assert.ok(sameKind.parts.some((part) => part.key === 'style'))
})

// ── 提示词库 ────────────────────────────────────────────────────────
test('提示词库：归一化后同一条提示词命中同一个 key', () => {
  assert.equal(normalizePrompt('  A  Cat\n'), 'a cat')
  assert.equal(promptKey('A Cat'), promptKey('  a   cat  '))
})

test('提示词库：成功/失败都记账，能给出可复用模板与避坑清单', () => {
  const library = new PromptLibrary('', {})
  library.record({ prompt: '一只猫', verdict: 'good', kind: 'icon' })
  library.record({ prompt: '一只猫', verdict: 'good', kind: 'icon' })
  library.record({ prompt: '极低对比度尘埃', verdict: 'bad', problems: ['几乎全黑（平均亮度 0.7%）'] })
  const stats = library.stats()
  assert.equal(stats.total, 2)
  assert.equal(stats.good, 1)
  assert.equal(stats.bad, 1)
  assert.equal(stats.reuses, 1, '第二次成功算一次复用')

  const lookup = library.lookup('  一只猫 ')
  assert.equal(lookup.known, undefined === undefined ? lookup.known : lookup.known)
  assert.equal(lookup.verdict, 'good')
  assert.match(lookup.advice, /成功过 2 次/)

  const bad = library.lookup('极低对比度尘埃')
  assert.equal(bad.verdict, 'bad')
  assert.match(bad.advice, /换措辞/)

  const templates = library.goodTemplates({ kind: 'icon' })
  assert.equal(templates.length, 1)
  assert.match(templates[0].prompt, /猫/)
  const pitfalls = library.pitfalls()
  assert.equal(pitfalls.length, 1)
  assert.match(pitfalls[0].problems[0], /全黑/)
})

test('提示词库：没记录过的提示词返回 null（不能瞎猜）', () => {
  const library = new PromptLibrary('', {})
  assert.equal(library.lookup('从来没画过'), null)
})

// ── 花费预测 ────────────────────────────────────────────────────────
test('花费预测：算出这批要多少钱、今天够不够、要分几天', () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 1 } })
  spend.record({ action: 'batch', images: 5, cost: 0.2 })
  const forecast = forecastSpend(spend, { pendingAssets: 24 })
  assert.equal(forecast.planned_images, 24)
  assert.equal(forecast.planned_cost, 0.96)
  assert.equal(forecast.spent_today, 0.2)
  assert.equal(forecast.remaining_today, 0.8)
  assert.equal(forecast.affordable_today, 20, '0.8/0.04 = 20 张')
  assert.equal(forecast.can_finish_today, false, '24 > 20，今天跑不完')
  assert.match(forecast.advice, /分 2 天/)
})

test('花费预测：额度够时明确说够（不要吓唬用户）', () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 1 } })
  const forecast = forecastSpend(spend, { pendingAssets: 5 })
  assert.equal(forecast.can_finish_today, true)
  assert.match(forecast.advice, /今天额度够/)
})

// ── 使用热度 ────────────────────────────────────────────────────────
test('使用热度：只统计游戏运行时代码，工具/测试不算「在用」', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-heat-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, 'tools'), { recursive: true })
    await writeFile(path.join(root, 'src', 'game.js'), "const a='wx_clear_tile';export{a};", 'utf8')
    // i_skull 只在 tools 里被提到 —— 那不是游戏在用
    await writeFile(path.join(root, 'tools', 'probe.mjs'), "console.log('i_skull');", 'utf8')

    const result = await usageHeatmap({
      root,
      projects: { demo: [{ key: 'wx_clear_tile', file: 'a.png' }, { key: 'i_skull', file: 'b.png' }, { key: 'nobody_uses', file: 'c.png' }] },
    })
    assert.equal(result.ok, true)
    // 用 all（完整列表）断言，hot/warm/cold 是三个视角视图
    const byKey = Object.fromEntries(result.all.map((row) => [row.key, row]))
    assert.ok(byKey.wx_clear_tile.used, 'src 里引用了 → 算在用')
    assert.equal(byKey.i_skull.used, false, '只有 tools 引用 → 不算游戏在用（那正是白花钱）')
    assert.equal(byKey.nobody_uses.used, false)
    assert.equal(result.summary.total, 3)
    assert.equal(result.summary.unused, 2)
    assert.equal(result.summary.waste_ratio, 0.67)
    // 被引用但不到 5 次的进 warm，不能两个视图都没有它
    assert.ok(result.warm.some((row) => row.key === 'wx_clear_tile'), '用到的素材必须能在某个视图里找到')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('使用热度：预览图/副本不算独立素材（否则误报白花钱）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-heat2-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'game.js'), "const a='wx_clear_tile';export{a};", 'utf8')
    const result = await usageHeatmap({
      root,
      projects: {
        demo: [
          { key: 'wx_clear_tile', file: 'wx_clear_tile_1.png' },
          { key: 'wx_clear_tile_1_labeled', file: 'wx_clear_tile_1_labeled.png' },
          { key: 'wx_clear_tile_40x60_fixed', file: 'wx_clear_tile_40x60_fixed.png' },
          { key: 'wx_clear_tile', file: 'wx_clear_tile_40x60.png' },
        ],
      },
    })
    assert.equal(result.summary.total, 1, '同一素材的预览图/副本/多尺寸要去重成一个')
    assert.equal(result.all[0].key, 'wx_clear_tile')
    assert.ok(result.all[0].references > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 管线顺序（源码契约） ────────────────────────────────────────────
test('一键工作台：顺序正确，且自检不通过就停下不装机', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'pipeline.js'), 'utf8')
  const generateAt = source.indexOf("record('generate'")
  const reviewAt = source.indexOf("record('review'")
  const installAt = source.indexOf("record('install'")
  const registerAt = source.indexOf("record('register'")
  assert.ok(generateAt > 0 && reviewAt > generateAt, '必须先生成后自检')
  assert.ok(installAt > reviewAt, '必须自检通过后才装机')
  assert.ok(registerAt > installAt, '登记在装机之后')
  assert.match(source, /自检发现 .* 张废图.*已停下不装机/s, '废图必须挡住装机（装进去只会黑屏）')
  assert.match(source, /spend\.check\(/, '花钱前必须过闸门')
})

test('一键工作台：素材来源优先级（需求池 > 顺序计划）', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'pipeline.js'), 'utf8')
  assert.match(source, /assets-from-pool/)
  assert.match(source, /assets-from-order/)
  assert.ok(source.indexOf('assets-from-pool') < source.indexOf('assets-from-order'), '池子优先于顺序计划')
})
