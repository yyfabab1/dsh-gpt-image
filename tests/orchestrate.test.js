/**
 * L–R 组测试：自动化编排。
 *
 * 重点覆盖**用户明确指出的冲突与自检项**：
 *   - L1↔H1：写入未稳定的文件不能读
 *   - L1↔失控：脚本狂写要限流+熔断
 *   - N5↔N3：事务按批次划，失败整批中止不留半成品
 *   - N6 幂等：同批跑两次第二次 noop
 *   - N4 断点续跑：崩了从断点继续
 *   - M2↔责任：自动通过必须可抽查、可批量撤销
 *   - 自动化冷启动：没有历史数据 → 全走人工（不是硬猜）
 *   - C1↔母图：母图 reject → 变体级联失效
 *   - Q3↔H3：淘汰前必须快照
 *   - R3 权限：外部脚本不能改审核结论
 *   - 单机无回传：Q1 只能给本地文件级证据，并明确标注局限
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  parseYamlSubset, PipelineConfig, buildStepGraph, planIncremental, runPipeline,
  STEP_CATALOG, DEFAULT_PIPELINE,
} from '../lib/declarative.js'
import {
  evaluateRules, computeConfidence, routeWithSampling, applyPolicy, classifyAsset,
  ReviewLog, DEFAULT_RULES, DEFAULT_POLICY, getField, PREDICATES,
} from '../lib/decide.js'
import {
  planOrphanCleanup, applyOrphanCleanup, planDanglingVerdicts,
  planCorruptionRepair, planMissingRepair, planConfigDrift, planCascadeInvalidation,
} from '../lib/selfheal.js'
import {
  debounceScan, throttleScan, parseWebhook, buildGitHook, installGitHook,
} from '../lib/watch.js'
import {
  planParameterSearch, analyzeRejections, planActiveSampling,
  planUsageSignals, planRetirement, planRestock,
  pipelineStatus, checkAlerts, checkPermission, planPipelineRollback,
  maintenanceChecklist, DEFAULT_ROLES,
} from '../lib/orchestrate.js'

async function tmp(prefix = 'lq-') {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

// ══════ N1 声明式流水线 ══════

test('N1 YAML 子集解析：支持流水线最常用的 list-of-maps 写法', () => {
  const r = parseYamlSubset(`
name: 我的流水线
on: [manual, new_asset]
steps:
  - id: postprocess
    use: postprocess
    opts: {defringe: true, sharpen: true}
  - id: slice
    use: slice
`)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.name, '我的流水线')
  assert.deepEqual(r.data.on, ['manual', 'new_asset'])
  assert.equal(r.data.steps.length, 2)
  assert.equal(r.data.steps[0].id, 'postprocess')
  assert.deepEqual(r.data.steps[0].opts, { defringe: true, sharpen: true })
})

test('N1 坏 YAML 明确报错并给行号，不静默吞掉', () => {
  const r = parseYamlSubset('steps:\n  - ok\n  - id: x\n    use: install\n')
  // 这一份其实是合法的；用真正坏的：列表项没归属
  const bad = parseYamlSubset('  - orphan_item\n')
  assert.equal(bad.ok, false)
  assert.ok(bad.line >= 1)
})

test('N1 校验：步骤不存在 / 顺序不对都要报错', () => {
  const p1 = new PipelineConfig('', { steps: [{ id: 'nope', use: 'nope' }] })
  assert.equal(p1.validate().ok, false)
  assert.match(p1.validate().errors[0], /不是已知步骤/)

  const p2 = new PipelineConfig('', { steps: [{ id: 'install', use: 'install' }] })
  const v2 = p2.validate()
  assert.equal(v2.ok, false)
  assert.match(v2.errors[0], /需要「review」/)
})

test('N1 默认流水线本身是合法的', () => {
  const p = new PipelineConfig('', structuredClone(DEFAULT_PIPELINE))
  const v = p.validate()
  assert.equal(v.ok, true, v.errors.join('; '))
})

// ══════ N2 依赖图增量 ══════

test('N2 依赖图：正确建立"谁产出谁消费"', () => {
  const steps = [
    { id: 'validate', use: 'validate' },
    { id: 'route', use: 'route' },
    { id: 'auto_review', use: 'auto_review' },
  ]
  const g = buildStepGraph(steps)
  assert.deepEqual(g.producedBy.get('verdict'), ['validate'])
  assert.deepEqual(g.producedBy.get('route'), ['route'])
  // auto_review 消费 route，所以下游包含 route
  assert.ok(g.downstream.get('auto_review').includes('route'))
})

test('N2 增量：没有输入变化 → 整条 noop（也是 N6 幂等的体现）', () => {
  const r = planIncremental({ steps: DEFAULT_PIPELINE.steps, changedInputs: [] })
  assert.equal(r.noop, true)
  assert.match(r.note, /noop|幂等/)
})

// ══════ N4/N5/N6 执行器 ══════

test('N5 事务按批次：某步失败 → 整批中止，不留半成品', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', {
      name: 't',
      steps: [
        { id: 'a', use: 'postprocess' },
        { id: 'b', use: 'validate' },
        { id: 'c', use: 'cleanup' },
      ],
    })
    const ran = []
    const result = await runPipeline({
      pipeline, batchId: 'b1', inputs: ['x.png'], dataDir: dir,
      executors: {
        postprocess: async () => { ran.push('a'); return { ok: true, count: 1 } },
        validate: async () => { ran.push('b'); return { ok: false, error: '校验失败' } },
        cleanup: async () => { ran.push('c'); return { ok: true } },
      },
      retries: 0,
    })
    assert.equal(result.ok, false)
    assert.equal(result.failed_step, 'b')
    assert.ok(!ran.includes('c'), '失败后不该继续跑后面的步骤（事务性）')
    assert.match(result.note, /整批已中止|事务/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('N4 断点续跑：已完成步骤跳过，从断点继续', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', {
      steps: [{ id: 'a', use: 'postprocess' }, { id: 'b', use: 'validate' }],
    })
    let aCalls = 0
    let bCalls = 0
    // 第一轮：b 失败
    await runPipeline({
      pipeline, batchId: 'same', inputs: ['x.png'], dataDir: dir, retries: 0,
      executors: {
        postprocess: async () => { aCalls += 1; return { ok: true, count: 1 } },
        validate: async () => { bCalls += 1; return { ok: false, error: 'boom' } },
      },
    })
    // 第二轮：同 batch → a 应跳过
    const second = await runPipeline({
      pipeline, batchId: 'same', inputs: ['x.png'], dataDir: dir, retries: 0, resume: true,
      executors: {
        postprocess: async () => { aCalls += 1; return { ok: true, count: 1 } },
        validate: async () => { bCalls += 1; return { ok: true, count: 1 } },
      },
    })
    assert.equal(second.ok, true)
    assert.equal(aCalls, 1, 'a 步不该重跑（断点续跑）')
    assert.equal(bCalls, 2, 'b 步该重试')
    assert.ok(second.steps[0].skipped, 'a 应标为 skipped')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('N4 单步失败会重试 N 次', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', { steps: [{ id: 'a', use: 'postprocess' }] })
    let calls = 0
    const result = await runPipeline({
      pipeline, batchId: 'b', inputs: ['x'], dataDir: dir, retries: 2,
      executors: { postprocess: async () => { calls += 1; return calls < 3 ? { ok: false, error: 'flaky' } : { ok: true, count: 1 } } },
    })
    assert.equal(result.ok, true)
    assert.equal(calls, 3, '失败两次后第三次成功')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('N6 幂等：同批同输入跑第二次是 noop', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', { steps: [{ id: 'a', use: 'postprocess' }] })
    let calls = 0
    const run = () => runPipeline({
      pipeline, batchId: 'idem', inputs: ['x'], dataDir: dir,
      executors: { postprocess: async () => { calls += 1; return { ok: true, count: 1 } } },
    })
    await run()
    const second = await run()
    assert.equal(calls, 1, '第二次不该真执行')
    assert.ok(second.steps[0].skipped)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dry_run 只报告不执行', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', { steps: [{ id: 'a', use: 'postprocess' }] })
    let calls = 0
    const result = await runPipeline({
      pipeline, batchId: 'd', inputs: ['x'], dataDir: dir, dryRun: true,
      executors: { postprocess: async () => { calls += 1; return { ok: true } } },
    })
    assert.equal(calls, 0, 'dry_run 不该真跑')
    assert.equal(result.dry_run, true)
    assert.equal(result.steps[0].would_process, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ N3 并行调度 ══════

test('N3 并行：可并行步骤按并发度跑，不可并行步骤强制串行', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', {
      steps: [
        { id: 'validate', use: 'validate' },
        { id: 'route', use: 'route' },
        { id: 'auto_review', use: 'auto_review' },
        { id: 'install', use: 'install' },
      ],
    })
    let active = 0
    let maxActive = 0
    const track = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 15))
      active -= 1
      return { ok: true, count: 1 }
    }
    const r = await runPipeline({
      pipeline, batchId: 'par', inputs: Array.from({ length: 12 }, (_, i) => `f${i}`),
      dataDir: dir, retries: 0, concurrency: 4,
      executors: { validate: track, route: track, auto_review: track, install: track },
    })
    assert.equal(r.ok, true)
    // 步骤级并发度：validate/route 可以并行，auto_review/install 被强制 1
    const byStep = Object.fromEntries(r.steps.map((s) => [s.step, s.concurrency]))
    assert.equal(byStep.validate, 4)
    assert.equal(byStep.route, 4)
    assert.equal(byStep.auto_review, 1, 'auto_review 不可并行')
    assert.equal(byStep.install, 1, 'install 会改同一批目标文件，必须串行')
    assert.ok(maxActive <= 4, `实测并发不该超过 4，实际 ${maxActive}`)
    assert.ok(maxActive >= 2, `应确实并行过，实际最大并发 ${maxActive}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('N3 并行不破坏 N5 事务：某步有失败项 → 整批中止', async () => {
  const dir = await tmp()
  try {
    const pipeline = new PipelineConfig('', {
      steps: [{ id: 'validate', use: 'validate' }, { id: 'route', use: 'route' }],
    })
    const ran = []
    const r = await runPipeline({
      pipeline, batchId: 'x', inputs: ['ok1', 'bad', 'ok2'], dataDir: dir, retries: 0, concurrency: 3,
      executors: {
        validate: async ({ inputs }) => {
          ran.push(inputs[0])
          return inputs[0] === 'bad' ? { ok: false, error: '坏文件' } : { ok: true, count: 1 }
        },
        route: async () => { ran.push('route'); return { ok: true, count: 1 } },
      },
    })
    assert.equal(r.ok, false)
    assert.equal(r.failed_step, 'validate')
    assert.ok(r.failed_items.length >= 1)
    assert.ok(!ran.includes('route'), '整批中止后不该继续下一步')
    assert.match(r.note, /整批已中止/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有执行器的步骤如实报告，不静默跳过', async () => {
  const dir = await tmp()
  try {
    // 用一条**合法**的流水线（依赖链齐全：validate→route→auto_review→atlas），
    // 但故意只给前两步执行器 → 后两步应如实报告"没有执行器"，而不是整条崩掉
    const pipeline = new PipelineConfig('', {
      steps: [
        { id: 'validate', use: 'validate' },
        { id: 'route', use: 'route' },
        { id: 'auto_review', use: 'auto_review' },
        { id: 'atlas', use: 'atlas' },
      ],
    })
    assert.equal(pipeline.validate().ok, true, pipeline.validate().errors?.join('; '))
    const result = await runPipeline({
      pipeline, batchId: 'x', inputs: ['f'], dataDir: dir,
      executors: { validate: async () => ({ ok: true, count: 1 }), route: async () => ({ ok: true, count: 1 }) },
    })
    assert.equal(result.ok, true)
    assert.equal(result.steps.length, 4, '每一步都要有记录（不能整条 steps 变 undefined）')
    assert.equal(result.steps[0].ok, true)
    assert.equal(result.steps[2].skipped, true)
    assert.match(result.steps[2].reason, /没有实现该步骤的执行器/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('流水线定义不合法时，runPipeline 直接拒绝（不跑到一半）', async () => {
  const dir = await tmp()
  try {
    const bad = new PipelineConfig('', { steps: [{ id: 'install', use: 'install' }] })
    const result = await runPipeline({ pipeline: bad, batchId: 'x', inputs: ['f'], dataDir: dir, executors: {} })
    assert.equal(result.ok, false)
    assert.match(result.error, /定义有误/)
    assert.ok(result.errors.length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ M1 规则引擎 ══════

test('M1 规则命中：非 2 的幂图标触发 resize', () => {
  const facts = { kind: 'icon', size: { width: 100, height: 100 }, palette: { drift: 0.1 }, dup: { similarity: 0.1 }, quality: { score: 70 } }
  const r = evaluateRules({ rules: DEFAULT_RULES.rules, facts })
  const ids = r.hits.map((h) => h.rule.id)
  assert.ok(ids.includes('icon-resize-power-of-two'))
})

test('M1 调色板漂移 → 待审（不是自动驳回）', () => {
  const facts = { kind: 'icon', size: { width: 64, height: 64 }, palette: { drift: 0.5 }, dup: { similarity: 0.1 }, quality: { score: 70 } }
  const r = evaluateRules({ rules: DEFAULT_RULES.rules, facts })
  const hit = r.hits.find((h) => h.rule.id === 'palette-drift-review')
  assert.ok(hit)
  assert.equal(hit.action.action, 'mark_pending')
})

test('M1 重复度 > 95% → 自动驳回 dup', () => {
  const facts = { kind: 'icon', size: { width: 64, height: 64 }, palette: { drift: 0.1 }, dup: { similarity: 0.98 }, quality: { score: 90 } }
  const r = evaluateRules({ rules: DEFAULT_RULES.rules, facts })
  assert.ok(r.hits.some((h) => h.action.code === 'dup'))
})

test('M1 谓词：2 的幂判断正确', () => {
  assert.equal(PREDICATES.is_power_of_two(64), true)
  assert.equal(PREDICATES.is_power_of_two(100), false)
  assert.equal(PREDICATES.not_power_of_two(100), true)
  assert.equal(PREDICATES.not_power_of_two(64), false)
})

test('M1 支持 any/all/not 组合与路径取值', () => {
  const facts = { a: { b: 5 } }
  assert.equal(getField(facts, 'a.b'), 5)
  const r = evaluateRules({
    rules: [{ id: 'r', when: [{ any: [{ field: 'a.b', op: '>', value: 10 }, { field: 'a.b', op: '==', value: 5 }] }], then: { action: 'x' } }],
    facts,
  })
  assert.equal(r.hits.length, 1)
})

test('M1 未知操作符/谓词 → 记进 errors，不崩', () => {
  const r = evaluateRules({ rules: [{ id: 'bad', when: [{ field: 'x', op: '~~', value: 1 }], then: {} }], facts: { x: 1 } })
  assert.equal(r.errors.length, 1)
})

// ══════ M2 置信度 + 冷启动 + 抽查 ══════

test('M2 冷启动降级：历史样本不足 → 转人工，不当自动通过', () => {
  const facts = { quality: { score: 88 }, palette: { drift: 0.05 }, readability: { level: 'ok' } }
  const cold = computeConfidence({ facts, history: { approved: 0, rejected: 0 } })
  assert.equal(cold.cold_start, true)
  assert.equal(cold.decision, 'human', '冷启动必须转人工')
  assert.match(cold.note, /冷启动降级/)
  // 样本够了就会自动通过
  const warm = computeConfidence({ facts, history: { approved: 40, rejected: 5 } })
  assert.equal(warm.cold_start, false)
  assert.equal(warm.decision, 'auto_approve')
})

test('M2 明确低分 → 自动驳回；中间地带 → 人工', () => {
  const low = computeConfidence({ facts: { quality: { score: 20 } }, history: { approved: 40, rejected: 5 } })
  assert.equal(low.decision, 'auto_reject')
  const mid = computeConfidence({ facts: { quality: { score: 60 }, palette: { drift: 0.4 } }, history: { approved: 40, rejected: 5 } })
  assert.equal(mid.decision, 'human')
})

test('M2 抽查是确定性的：同 seed 两次抽中同一批', () => {
  const facts = { quality: { score: 88 }, palette: { drift: 0.05 }, readability: { level: 'ok' } }
  const items = Array.from({ length: 50 }, (_, i) => ({ name: `i${i}`, kind: 'icon', facts }))
  const a = routeWithSampling({ items, history: { approved: 40, rejected: 5 }, batchSeed: 's1' })
  const b = routeWithSampling({ items, history: { approved: 40, rejected: 5 }, batchSeed: 's1' })
  assert.deepEqual(a.sampled.map((x) => x.name), b.sampled.map((x) => x.name))
})

test('M2 抽查有保底：10 张 10% 不会一张都不抽', () => {
  const facts = { quality: { score: 88 }, palette: { drift: 0.05 }, readability: { level: 'ok' } }
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `i${i}`, kind: 'icon', facts }))
  const r = routeWithSampling({ items, history: { approved: 40, rejected: 5 }, batchSeed: 'b1' })
  assert.ok(r.sampled.length >= 1, `应至少抽 1 张，实际 ${r.sampled.length}`)
  assert.ok(r.backfilled > 0, '应标出这是保底抽的')
})

test('M2 冷启动时抽查也是 0（因为全转人工）', () => {
  const facts = { quality: { score: 88 }, palette: { drift: 0.05 } }
  const items = Array.from({ length: 20 }, (_, i) => ({ name: `i${i}`, kind: 'icon', facts }))
  const r = routeWithSampling({ items, history: { approved: 0, rejected: 0 }, batchSeed: 's1' })
  assert.equal(r.summary.human, 20, '冷启动全部转人工')
  assert.equal(r.sampled.length, 0)
})

// ══════ M4 策略 ══════

test('M4 策略：卡面/立绘永不自动通过', () => {
  const facts = { quality: { score: 95 }, palette: { drift: 0 }, readability: { level: 'ok' } }
  const items = [
    { name: 'card_x', kind: 'card', facts },
    { name: 'icon_y', kind: 'icon', facts },
  ]
  const r = applyPolicy({ policy: DEFAULT_POLICY, items, history: { approved: 40, rejected: 5 } })
  assert.equal(r.policy_blocked.length, 1)
  assert.equal(r.policy_blocked[0].kind, 'card')
  assert.match(r.policy_blocked[0].policy_block, /永不自动通过/)
})

test('M4 不在白名单的类别也转人工', () => {
  const facts = { quality: { score: 95 }, palette: { drift: 0 } }
  const r = applyPolicy({ policy: DEFAULT_POLICY, items: [{ name: 'z', kind: '截图', facts }], history: { approved: 40, rejected: 5 } })
  assert.equal(r.policy_blocked.length, 1)
  assert.match(r.policy_blocked[0].policy_block, /白名单/)
})

// ══════ M3 自动分类 ══════

test('M3 按文件名前缀分类', () => {
  assert.equal(classifyAsset({ name: 'i_skull' }).kind, 'icon')
  assert.equal(classifyAsset({ name: 'card_hero' }).kind, 'card')
  assert.equal(classifyAsset({ name: 't_grass' }).kind, 'tile')
  assert.equal(classifyAsset({ name: 'wx_rain' }).kind, 'effect')
})

test('M3 规格清单优先于文件名', () => {
  const r = classifyAsset({ name: 'i_skull', expectations: { i_skull: { size: { width: 512, height: 768 } } } })
  assert.equal(r.source, 'spec-list')
})

test('M3 判不出来标 unknown，不硬塞', () => {
  const r = classifyAsset({ name: '随便什么' })
  assert.equal(r.kind, 'unknown')
  assert.equal(r.confidence, 'none')
  assert.match(r.note, /不硬塞|错分类/)
})

test('M3 多线索分类：尺寸与视觉标签都能用（不只是文件名）', () => {
  // 实测：真实项目里 ships_zerg_v3 / r67rest_cardart 这类名字推不出类别，
  // 只给文件名会让大量素材落在 unknown → 自动分流永不生效。
  assert.equal(classifyAsset({ name: 'r67rest_cardart', size: { width: 512, height: 768 } }).kind, 'card')
  assert.equal(classifyAsset({ name: 'whatever', size: { width: 64, height: 64 } }).kind, 'tile')
  assert.equal(classifyAsset({ name: '随便', tags: ['图标'] }).kind, 'icon')
})

test('M3 精确尺寸优先于宽高比（游戏规格比生成尺寸更可信）', () => {
  const exact = classifyAsset({ name: 'x', size: { width: 48, height: 48 } })
  assert.equal(exact.source, 'size-exact')
  assert.equal(exact.confidence, 'high')
})

test('M3 宽高比兜底：真实生成尺寸（2048×2048 / 1248×832）也能分类', () => {
  // 这是修 unknown 永不生效的关键：真实素材是**生成尺寸**不是游戏规格尺寸
  const square = classifyAsset({ name: 'ships_zerg_v3', size: { width: 1024, height: 1024 } })
  assert.equal(square.source, 'aspect')
  assert.equal(square.kind, 'icon', '方形 → 图标形状类')

  const wide = classifyAsset({ name: 'panorama_thing', size: { width: 1248, height: 832 } })
  assert.equal(wide.source, 'aspect')
  assert.equal(wide.kind, 'background')

  const tall = classifyAsset({ name: 'p', size: { width: 832, height: 1248 } })
  assert.equal(tall.source, 'aspect')
  assert.ok(['portrait', 'card'].includes(tall.kind))
})

test('M3 宽高比推断必须**声明局限**：这是形状类别不是语义类别', () => {
  const r = classifyAsset({ name: 'ships_zerg_v3', size: { width: 1024, height: 1024 } })
  assert.match(r.caveat, /形状类别|不是语义类别/, '必须告诉调用方这个类别的可信边界')
})

test('M3 完全无线索才 unknown', () => {
  const r = classifyAsset({ name: 'ships_zerg_v3' })
  assert.equal(r.kind, 'unknown')
  assert.equal(r.confidence, 'none')
})

test('M4 unknown 默认不自动通过，但必须**解释原因**并给两条出路', () => {
  const facts = { quality: { score: 90 }, palette: { drift: 0 } }
  const items = [
    { name: 'a', kind: 'unknown', facts },
    { name: 'b', kind: 'icon', facts },
  ]
  const r = applyPolicy({ policy: DEFAULT_POLICY, items, history: { approved: 40, rejected: 5 } })
  assert.equal(r.unknown_blocked, 1, 'unknown 默认应被挡（安全优先）')
  assert.match(r.advice, /推不出类别/, '必须解释为什么挡')
  assert.match(r.advice, /unknown_passes/, '必须给出可操作的出路')
})

test('M4 策略开关 unknown_passes=true 时 unknown 可以自动通过', () => {
  const facts = { quality: { score: 90 }, palette: { drift: 0 } }
  const items = [{ name: 'a', kind: 'unknown', facts }]
  const r = applyPolicy({ policy: { ...DEFAULT_POLICY, unknown_passes: true }, items, history: { approved: 40, rejected: 5 } })
  assert.equal(r.unknown_blocked, 0)
  assert.equal(r.summary.auto_approved, 1)
})

test('M4 白名单外的类别说明当前白名单内容（便于排错）', () => {
  const facts = { quality: { score: 90 }, palette: { drift: 0 } }
  const r = applyPolicy({ policy: DEFAULT_POLICY, items: [{ name: 'x', kind: '截图', facts }], history: { approved: 40, rejected: 5 } })
  assert.equal(r.policy_blocked.length, 1)
  assert.match(r.policy_blocked[0].policy_block, /白名单/)
  assert.match(r.policy_blocked[0].policy_block, /icon/)   // 列出白名单实际内容
})

// ══════ 审核日志 / 批量撤销 ══════

test('撤销：记录批次后能算出"恢复成什么"', async () => {
  const dir = await tmp()
  try {
    const log = new ReviewLog(path.join(dir, 'log.json'), { version: 1, entries: [] })
    log.record({
      batchId: 'auto_1', by: 'auto', action: 'auto_review',
      changes: [{ file: 'a.png', before: null, after: 'approved' }, { file: 'b.png', before: 'pending', after: 'rejected' }],
    })
    const plan = log.planUndo('auto_1')
    assert.equal(plan.ok, true)
    assert.equal(plan.count, 2)
    assert.deepEqual(plan.restore[0], { file: 'a.png', state: null })
    assert.deepEqual(plan.restore[1], { file: 'b.png', state: 'pending' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('撤销不能重复撤两次', async () => {
  const dir = await tmp()
  try {
    const log = new ReviewLog(path.join(dir, 'log.json'), { version: 1, entries: [] })
    log.record({ batchId: 'b1', by: 'auto', action: 'auto_review', changes: [{ file: 'a', before: null, after: 'approved' }] })
    assert.equal(log.planUndo('b1').ok, true)
    log.markUndone('b1')
    const again = log.planUndo('b1')
    assert.equal(again.ok, false)
    assert.match(again.error, /已经撤销过/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('撤销：查不到批次要给明确错误', () => {
  const log = new ReviewLog('', { version: 1, entries: [] })
  assert.equal(log.planUndo('nope').ok, false)
})

test('审计：查某个文件被改过几次、谁改的（按时间倒序）', () => {
  const log = new ReviewLog('', { version: 1, entries: [] })
  log.record({ batchId: 'b1', by: 'auto', action: 'auto_review', changes: [{ file: 'D:\\x\\a.png', before: null, after: 'approved' }] })
  log.record({ batchId: 'b2', by: 'user', action: 'review', changes: [{ file: 'd:/x/a.png', before: 'approved', after: 'rejected' }] })
  const h = log.historyOf('D:\\X\\A.PNG')
  assert.equal(h.length, 2, '路径大小写/斜杠差异应归一')
  // record() 是 unshift，所以最新的在最前
  assert.equal(h[0].by, 'user', '最新的变更在最前')
  assert.equal(h[1].by, 'auto')
  assert.equal(h[1].after, 'approved')
})

// ══════ O 组 自愈 ══════

test('O1 孤儿：派生件的源图不在了', () => {
  const files = [
    { file: '/o/p/a_slices/a_01.png', name: 'a', kind: 'slice' },
    { file: '/o/p/keep_slices/keep_01.png', name: 'keep', kind: 'slice' },
    { file: '/o/p/keep_1.png', name: 'keep', kind: 'source' },
  ]
  const r = planOrphanCleanup({ files, catalog: { data: { reviews: {}, byName: {} } } })
  assert.equal(r.derived_orphans.length, 1)
  assert.equal(r.derived_orphans[0].source, 'a')
  assert.equal(r.risk, 'irreversible-delete')
})

test('O1 悬空审核记录被查出', () => {
  const r = planOrphanCleanup({
    files: [{ file: '/o/p/a.png', name: 'a', kind: 'source' }],
    catalog: { data: { reviews: { '/o/p/gone.png': { state: 'approved', at: 'x' } }, byName: {} } },
  })
  assert.equal(r.dangling_reviews.length, 1)
})

test('O1 清理先备份到回收目录（Q3↔H3 冲突的解法）', async () => {
  const dir = await tmp()
  try {
    const f = path.join(dir, 'orphan.png')
    await writeFile(f, 'data')
    const plan = { derived_orphans: [{ file: f }], dangling_reviews: [] }
    const catalog = { data: { reviews: {}, byName: {} } }
    const recycle = path.join(dir, 'recycled')
    const r = await applyOrphanCleanup({ plan, catalog, recycleDir: recycle })
    assert.equal(r.removed_files, 1)
    assert.equal(r.recycled_to, recycle)
    // 回收目录里真的有备份
    const kept = await readFile(path.join(recycle, 'orphan.png'), 'utf8')
    assert.equal(kept, 'data')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('O4 悬空结论：内容变了标记失效，不静默', () => {
  const catalog = { reviewOf: () => ({ state: 'approved', contentHash: 'old', at: 'x' }) }
  const r = planDanglingVerdicts({ files: [{ file: 'a.png', name: 'a', contentHash: 'new' }], catalog })
  assert.equal(r.invalidated.length, 1)
  assert.match(r.invalidated[0].reason, /内容在审核后变了/)
  assert.match(r.advice, /不会.*被当成合格/)
})

test('O4 旧记录没 hash → 单独列出（不假装知道）', () => {
  const catalog = { reviewOf: () => ({ state: 'approved' }) }
  const r = planDanglingVerdicts({ files: [{ file: 'a.png', name: 'a', contentHash: 'x' }], catalog })
  assert.equal(r.missing_hash.length, 1)
  assert.match(r.missing_hash[0].reason, /没有内容 hash/)
})

test('O3 损坏：有血缘可重生成，无血缘只能人工（不自动删）', () => {
  const gallery = { list: () => [{ files: ['/o/a.png'], prompt: 'a sword', params: { seed: 42 }, model: 'm' }] }
  const r = planCorruptionRepair({
    files: [{ file: '/o/a.png', broken: true, reason: '截断' }, { file: '/o/b.png', broken: true, reason: '截断' }],
    gallery,
  })
  assert.equal(r.regenerable.length, 1)
  assert.equal(r.regenerable[0].can_reproduce_exactly, true)
  assert.equal(r.manual.length, 1)
  assert.match(r.advice, /不自动删/)
})

test('O3 没有 seed → 明说不能保证一致', () => {
  const gallery = { list: () => [{ files: ['/o/a.png'], prompt: 'p', params: {} }] }
  const r = planCorruptionRepair({ files: [{ file: '/o/a.png', broken: true }], gallery })
  assert.equal(r.regenerable[0].can_reproduce_exactly, false)
  assert.match(r.regenerable[0].plan, /不能保证/)
})

test('O2 缺失：已合格但没切片 → 该切没切', () => {
  const files = [
    { file: '/o/hero_4.png', name: 'hero_4', kind: 'source', review_state: 'approved', observedSlices: 0, slice_rule: { columns: 2, rows: 2 } },
  ]
  const r = planMissingRepair({ files, catalog: {} })
  assert.equal(r.summary.missing_slices, 1)
  assert.match(r.needs[0].reason, /还没有切片/)
})

test('O2 切片不完整也要报', () => {
  const files = [
    { file: '/o/hero_4.png', name: 'hero_4', kind: 'source', review_state: 'approved', observedSlices: 2, slice_rule: { columns: 2, rows: 2 } },
  ]
  const r = planMissingRepair({ files, catalog: {} })
  assert.equal(r.summary.partial_slices, 1)
})

test('O5 配置漂移：声明要装机但没装 → 报漂移', () => {
  const pipeline = { data: { steps: [{ id: 'install', use: 'install' }] }, validate: () => ({ ok: true, errors: [] }) }
  const r = planConfigDrift({ pipeline, state: { approved_count: 10, installed_count: 0 } })
  assert.equal(r.drifts.length, 1)
  assert.equal(r.drifts[0].type, 'install_not_done')
})

test('O5 配置本身有错 → 先修配置（不是漂移）', () => {
  const pipeline = { data: { steps: [{ id: 'x', use: 'nope' }] }, validate: () => ({ ok: false, errors: ['第 1 步不是已知步骤'] }) }
  const r = planConfigDrift({ pipeline, state: {} })
  assert.equal(r.invalid.length, 1)
  assert.match(r.advice, /先修配置/)
})

// ══════ C1 级联失效 ══════

test('C1 母图 reject → 派生件一并驳回（不让再审一遍）', () => {
  const files = [
    { file: '/o/hero_4_1.png', name: 'hero_4', kind: 'source' },
    { file: '/o/hero_4_slices/hero_4_01.png', name: 'hero_4', kind: 'slice' },
    { file: '/o/other.png', name: 'other', kind: 'source' },
  ]
  const catalog = { reviewOf: () => ({ state: 'approved' }) }
  const r = planCascadeInvalidation({ sourceName: 'hero_4', sourceFile: '/o/hero_4_1.png', files, catalog, newState: 'rejected' })
  assert.equal(r.summary.total, 1)
  assert.equal(r.summary.to_reject, 1)
  assert.match(r.advice, /一并驳回/)
})

test('C1 母图转待审 → 派生件也待审', () => {
  const files = [
    { file: '/o/hero_4_1.png', name: 'hero_4', kind: 'source' },
    { file: '/o/hero_4_slices/hero_4_01.png', name: 'hero_4', kind: 'slice' },
  ]
  const r = planCascadeInvalidation({ sourceName: 'hero_4', sourceFile: '/o/hero_4_1.png', files, catalog: { reviewOf: () => null }, newState: 'pending' })
  assert.equal(r.summary.to_pending, 1)
})

test('C1 没有派生件 → 明说无需级联', () => {
  const r = planCascadeInvalidation({ sourceName: 'solo', sourceFile: '/o/solo.png', files: [{ file: '/o/solo.png', name: 'solo', kind: 'source' }], catalog: {}, newState: 'rejected' })
  assert.equal(r.summary.total, 0)
  assert.match(r.advice, /没有派生件/)
})

// ══════ L1 防抖 / 限流 ══════

test('L1↔H1：写入未稳定的文件不能被读（防抖）', () => {
  const now = Date.now()
  const files = [
    { file: 'old.png', mtime: new Date(now - 20000).toISOString(), bytes: 100 },
    { file: 'new.png', mtime: new Date(now - 1000).toISOString(), bytes: 100 },
  ]
  const r = debounceScan({ files, debounceMs: 5000, now })
  assert.deepEqual(r.ready.map((f) => f.file), ['old.png'])
  assert.deepEqual(r.pending.map((f) => f.file), ['new.png'])
  assert.match(r.advice, /写了一半|截断/)
})

test('L1 尺寸仍在变 → 即使 mtime 够旧也等待', () => {
  const now = Date.now()
  const files = [{ file: 'a.png', mtime: new Date(now - 20000).toISOString(), bytes: 200 }]
  const stableAcross = new Map([['a.png', { size: 100 }]])
  const r = debounceScan({ files, debounceMs: 5000, now, stableAcross })
  assert.equal(r.ready.length, 0)
  assert.match(r.pending[0].reason, /尺寸仍在变/)
})

test('L1↔失控：超量限流，连续超量熔断', () => {
  const many = new Array(300).fill({ file: 'x' })
  const t1 = throttleScan({ newFiles: many, maxPerWindow: 200 })
  assert.equal(t1.throttled, true)
  assert.equal(t1.process.length, 200)
  assert.equal(t1.deferred.length, 100)

  const t2 = throttleScan({ newFiles: many, maxPerWindow: 200, consecutiveBursts: 2, breakerAt: 3 })
  assert.equal(t2.tripped, true)
  assert.equal(t2.process.length, 0)
  assert.match(t2.advice, /熔断/)
})

test('L1 正常量不限流', () => {
  const r = throttleScan({ newFiles: new Array(10).fill({}), maxPerWindow: 200 })
  assert.equal(r.throttled, undefined)
  assert.equal(r.process.length, 10)
})

// ══════ L2 webhook ══════

test('L2 webhook：解析上报并带上下文', () => {
  const r = parseWebhook({ writer: 'r67-script', files: ['a.png', 'b.png'], batch_id: 'b1', note: '重制', project: 'p' })
  assert.equal(r.ok, true)
  assert.equal(r.event.writer, 'r67-script')
  assert.equal(r.event.files.length, 2)
  assert.equal(r.event.batchId, 'b1')
  assert.match(r.advice, /精确的|归属/)
})

test('L2 缺 writer → 报错（否则归属只能靠猜）', () => {
  const r = parseWebhook({ files: ['a.png'] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /writer/.test(e)))
})

test('L2 缺 files → 报错', () => {
  assert.equal(parseWebhook({ writer: 'x' }).ok, false)
})

// ══════ L4 git hook ══════

test('L4 git hook 生成：缺图阻止提交、冗余只警告', () => {
  const h = buildGitHook({ hook: 'pre-commit', gameRoot: '/game', blockOnMissing: true })
  assert.match(h.script, /exit 1/, '缺图要 exit 1 阻止')
  assert.match(h.script, /冗余.*不阻止提交|不阻止提交/)
  assert.match(h.caveat, /DSH 不在时.*放行/)
})

test('L4 非 git 目录 → 明确拒绝安装', async () => {
  const dir = await tmp()
  try {
    const r = await installGitHook({ gameRoot: dir })
    assert.equal(r.ok, false)
    assert.match(r.error, /不是 git 仓库|没有 .git/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('L4 已存在 hook 时不覆盖（除非 force）', async () => {
  const dir = await tmp()
  try {
    await mkdir(path.join(dir, '.git', 'hooks'), { recursive: true })
    await writeFile(path.join(dir, '.git', 'hooks', 'pre-commit'), 'existing', 'utf8')
    const r = await installGitHook({ gameRoot: dir, hook: 'pre-commit' })
    assert.equal(r.ok, false)
    assert.match(r.error, /已存在/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ P 组 ══════

test('P1 参数搜索：有 seed 才说确定性', () => {
  const withSeed = planParameterSearch({ lineage: { prompt: 'x', seed: 10 }, variants: 4 })
  assert.equal(withSeed.deterministic, true)
  assert.ok(withSeed.candidates.every((c) => c.seed !== undefined))
  const noSeed = planParameterSearch({ lineage: { prompt: 'x' }, variants: 3 })
  assert.equal(noSeed.deterministic, false)
  assert.match(noSeed.advice, /随机|无法保证/)
})

test('P2 模板优化：驳回原因映射到提示词建议', () => {
  const r = analyzeRejections({ reject_reasons: [{ reason: 'blurry', count: 12 }, { reason: 'dup', count: 3 }] })
  assert.equal(r.total_rejections, 15)
  const blurry = r.patches.find((p) => p.rejection_code === 'blurry')
  assert.equal(blurry.severity, 'major')
  assert.ok(blurry.suggestion.add.length > 0)
  // dup 不是提示词能修的
  const dup = r.patches.find((p) => p.rejection_code === 'dup')
  assert.match(dup.suggestion.why, /不是提示词能修/)
  assert.match(r.caution, /必须人看一眼/)
})

test('P2 没有驳回记录 → 不猜', () => {
  assert.match(analyzeRejections({ reject_reasons: [] }).advice, /不猜|无法给出/)
})

test('P3 主动学习：挑最不确定的（离阈值最近）', () => {
  const items = [
    { name: 'a', kind: 'icon', confidence: 0.20 },
    { name: 'b', kind: 'icon', confidence: 0.84 },
    { name: 'c', kind: 'icon', confidence: 0.86 },
    { name: 'd', kind: 'icon', confidence: 0.10 },
  ]
  const r = planActiveSampling({ items, budget: 2, policy: { confidence_approve: 0.85 } })
  assert.ok(r.picked.some((p) => p.name === 'b' || p.name === 'c'), '应挑靠近阈值的')
  assert.match(r.caveat, /冷启动/)
})

test('P3 覆盖性：不会只推同一类', () => {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ name: `i${i}`, kind: 'icon', confidence: 0.85 })),
    { name: 'c1', kind: 'card', confidence: 0.1 },
  ]
  const r = planActiveSampling({ items, budget: 3, ensureCoverage: true })
  assert.ok(r.picked.some((p) => p.kind === 'card'), 'card 类应被覆盖到')
})

// ══════ Q 组（单机版） ══════

test('Q1 明确标注局限：只有文件级证据，需要游戏埋点才能拿行为数据', () => {
  const r = planUsageSignals({ files: [{ name: 'a', kind: 'source', review_state: 'approved', file: 'a.png' }], referenceGraph: { referenced: [], missing: [] } })
  assert.equal(r.telemetry, 'local-file-evidence')
  assert.match(r.limitation, /不是玩家行为数据/)
  assert.match(r.limitation, /单机/)
  assert.ok(r.needs_game_telemetry.includes('被加载次数'))
})

test('Q1 找出"合格但没被引用"的死重量', () => {
  const r = planUsageSignals({
    files: [
      { name: 'used', kind: 'source', review_state: 'approved', file: 'a' },
      { name: 'dead', kind: 'source', review_state: 'approved', file: 'b' },
    ],
    referenceGraph: { referenced: [{ key: 'used' }], missing: [] },
  })
  assert.equal(r.approved_but_unreferenced, 1)
  assert.equal(r.dead_weight[0].name, 'dead')
})

test('Q3 淘汰必须先快照 + 保护期生效', () => {
  const old = new Date(Date.now() - 60 * 86400000).toISOString()
  const fresh = new Date(Date.now() - 5 * 86400000).toISOString()
  const r = planRetirement({
    files: [
      { name: 'old_dead', kind: 'source', review_state: 'approved', mtime: old, file: 'a' },
      { name: 'new_dead', kind: 'source', review_state: 'approved', mtime: fresh, file: 'b' },
    ],
    referenceGraph: { referenced: [] },
    policy: { protect_days: 30 },
  })
  assert.equal(r.requires_snapshot, true, 'Q3↔H3 解法：必须快照')
  assert.equal(r.retire.length, 1)
  assert.equal(r.protect.length, 1)
  assert.match(r.protect[0].why, /保护期/)
  assert.match(r.safety, /回收目录|不直接删/)
})

test('Q4 补货：类别不足与清单缺失都能查出', () => {
  const r = planRestock({
    files: [
      { name: 'i_a', kind: 'source', review_state: 'approved', asset_kind: 'icon' },
      { name: 'i_b', kind: 'source', review_state: 'approved', asset_kind: 'icon' },
    ],
    expectations: { i_a: {}, i_b: {}, i_missing: {} },
    minPerKind: 3,
  })
  assert.equal(r.shortages.length, 1)
  assert.equal(r.shortages[0].need, 1)
  assert.ok(r.declared_missing.includes('i_missing'))
  assert.match(r.caution, /asset_kind/)
})

// ══════ R 组 ══════

test('R1 状态：从未跑过 / 失败 / 完成 三态清楚', () => {
  const pipeline = { data: { name: 'p', steps: [{ id: 'a', use: 'postprocess' }, { id: 'b', use: 'validate' }] } }
  const never = pipelineStatus({ pipeline, runState: null })
  assert.equal(never.steps[0].state, 'never_run')
  assert.match(never.advice, /dry-run/)

  const failed = pipelineStatus({ pipeline, runState: { batchId: 'x', done: ['a|f1'], failedAt: 'b' } })
  assert.equal(failed.steps[0].state, 'done')
  assert.equal(failed.steps[1].state, 'failed')
  assert.match(failed.advice, /失败/)
})

test('R2 告警：阈值触发 + 明确说没有推送通道', () => {
  const r = checkAlerts({ metrics: { fail_rate: 0.5, disk_free_gb: 1, budget_used: 0.95 } })
  assert.equal(r.count, 3)
  assert.ok(r.alerts.some((a) => a.code === 'fail_rate' && a.level === 'error'))
  assert.equal(r.delivery, 'local-only')
  assert.match(r.limitation, /没有推送通道/)
})

test('R2 没超阈值时零告警', () => {
  const r = checkAlerts({ metrics: { fail_rate: 0.01, disk_free_gb: 100 } })
  assert.equal(r.count, 0)
})

test('R3↔外部脚本：不能改审核结论', () => {
  const r = checkPermission({ actor: 'external-script', action: 'review' })
  assert.equal(r.ok, false)
  assert.equal(r.allowed, false)
  assert.match(r.reason, /不能改审核结论/)
  // 但写文件是允许的（有配额）
  assert.equal(checkPermission({ actor: 'external-script', action: 'install' }).ok, false)
})

test('R3 用户可以做任何事；配额生效', () => {
  assert.equal(checkPermission({ actor: 'user', action: 'review' }).ok, true)
  assert.equal(checkPermission({ actor: 'user', action: 'delete' }).ok, true)
  const over = checkPermission({ actor: 'external-script', action: 'write', usedToday: 500, count: 1 })
  assert.equal(over.ok, false)
})

test('R3 未知角色按最小权限处理（fail closed）', () => {
  const r = checkPermission({ actor: '某个未知脚本', action: 'review' })
  assert.equal(r.allowed, false, '未知身份不能放行（fail closed）')
})

test('R4 回滚：整批回滚；没有更早备份时明确挡住', () => {
  const withBackup = planPipelineRollback({
    batchId: 'b1',
    runState: { at: '2026-10-02T00:00:00Z', done: ['a|x', 'b|y'] },
    backups: [{ id: 'bk1', at: '2026-10-01T00:00:00Z' }],
  })
  assert.equal(withBackup.ok, true)
  assert.ok(withBackup.target_backup)
  assert.match(withBackup.advice, /整批/)

  const noBackup = planPipelineRollback({ batchId: 'b1', runState: { at: '2020-01-01T00:00:00Z' }, backups: [] })
  assert.equal(noBackup.guard, 'blocks_execution')
  assert.match(noBackup.advice, /无法安全回滚/)
})

test('维护清单：明确说定时任务不能建在插件里', () => {
  const r = maintenanceChecklist({ outputDir: '/o', dataDir: '/d' })
  assert.ok(r.tasks.length >= 5)
  assert.match(r.note, /不能建在插件里|无常驻进程/)
  assert.match(r.note, /任务看板|定时/)
})

// ══════ 服务端路由契约（L–R 组新增的接口）══════

test('server 提供 L–R 组的路由：/api/auto、/api/pipeline、/api/health、/api/auto-run', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/server.js', import.meta.url), 'utf8')
  for (const route of ['/api/auto', '/api/pipeline', '/api/health', '/api/auto-run']) {
    assert.ok(src.includes(`sub === '${route}'`), `缺少路由 ${route}`)
  }
  // 危险操作必须在服务端也支持 dry_run（不能只靠前端确认框）
  assert.match(src, /body\.dry_run/, 'auto-run 必须支持 dry_run')
})

test('server 的 POST body 是惰性读取的（避免 body 未初始化）', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/server.js', import.meta.url), 'utf8')
  // 曾经把 /api/auto-run 放在统一 body 解析之前，直接引用 body 会
  // "Cannot access 'body' before initialization"。
  assert.match(src, /function readJsonBody/, '必须有惰性 body 读取器')
  assert.match(src, /req\.__dshBodyPromise/, '必须缓存，避免把流读两次')
  // 统一解析点也要用它
  const unified = src.slice(src.indexOf("req.method !== 'POST'"))
  assert.match(unified.slice(0, 400), /readJsonBody\(req\)/, '统一解析点应使用惰性读取器')
})

test('自动化页必须在 UI 里有入口（L–R 组不能只有 AI 调得到）', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const fn of ['AutoPage', 'AutoIcon', 'useAuto']) {
    assert.match(client, new RegExp(`function\\s+${fn}\\s*\\(`), `缺少 ${fn}`)
  }
  // 侧栏必须有 auto 项且有对应 main 面板
  const side = [...client.matchAll(/inject\('sidebar\.panellist'[\s\S]{0,240}?id:\s*'([^']+)'/g)].map((m) => m[1])
  const main = [...client.matchAll(/inject\('main'[\s\S]{0,240}?key:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(side.includes('auto'), '侧栏应有「自动化」')
  assert.ok(main.includes('auto'), '主区域应有自动化页')
  assert.ok(side.every((id) => main.includes(id)), '每个侧栏项都要有对应 main 面板')
})

test('自动化页覆盖关键能力：分流/撤销/自愈/流水线/告警/备份', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const [label, pat] of [
    ['流水线状态', /pipeline/],
    ['自愈检查', /自愈/],
    ['告警', /告警/],
    ['批量撤销', /撤销/],
    ['备份', /备份/],
    ['冷启动警告', /冷启动/],
    ['维护清单', /维护/],
  ]) {
    assert.match(client, pat, `自动化页缺少：${label}`)
  }
  // 危险操作要有确认（不能一键无声执行）
  assert.match(client, /window\.confirm/, '执行自动分流/自愈应有确认')
})

test('L5 生成后自动后处理：不覆盖原图，且可关闭', async () => {
  const { readFile } = await import('node:fs/promises')
  const run = await readFile(new URL('../lib/run.js', import.meta.url), 'utf8')
  assert.match(run, /function postprocessGenerated/, '要有生成后处理函数')
  assert.match(run, /\.post\.png/, '产物应写 .post.png（不覆盖原图）')
  assert.match(run, /auto_postprocess !== false/, '要能用 auto_postprocess:false 关掉')
  assert.match(run, /postprocess_errors/, '失败要记录，不静默吞')
})

// ══════ 端到端：真的注册插件并调工具（不读源码，而是执行）══════

test('端到端：注册 30 个工具，且 auto.rules 能返回操作符与谓词（回归：曾漏 import）', async () => {
  const { apply } = await import('../lib/index.js')
  const mkdtemp = (await import('node:fs/promises')).mkdtemp
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-auto-'))
  const registry = new Map()
  const scope = {
    tools: { register: (t) => { registry.set(t.name, t); return () => {} } },
    webServer: { register: () => () => {} },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
  }
  try {
    apply({ inject: (d, fn) => { try { fn(scope) } catch { /* 忽略 */ } }, effect: scope.effect, get: () => undefined, tools: scope.tools },
      { dataDir: dir, outputDir: dir })
    assert.equal(registry.size, 30, `应注册 30 个工具，实际 ${registry.size}`)
    const auto = registry.get('_dsh_external_dsh_gpt_image_auto')
    assert.ok(auto, '缺少 auto 工具')
    // 回归：auto.rules 曾因 OPERATORS/PREDICATES 没 import 而报 "OPERATORS is not defined"
    const rules = JSON.parse(await auto.execute({ action: 'rules' }))
    assert.equal(rules.ok, true, JSON.stringify(rules).slice(0, 120))
    assert.ok(rules.count >= 5)
    assert.ok(Array.isArray(rules.operators) && rules.operators.includes('>'))
    assert.ok(Array.isArray(rules.available_predicates) && rules.available_predicates.includes('not_power_of_two'))
  } finally {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
  }
})

test('端到端：权限语义——外部脚本改不了结论，用户放行', async () => {
  const { checkPermission, DEFAULT_ROLES } = await import('../lib/orchestrate.js')
  assert.equal(checkPermission({ actor: 'external-script', action: 'review', roles: DEFAULT_ROLES }).allowed, false)
  assert.equal(checkPermission({ actor: 'user', action: 'review', roles: DEFAULT_ROLES }).allowed, true)
  assert.equal(checkPermission({ actor: '不存在的角色', action: 'review', roles: DEFAULT_ROLES }).allowed, false, '未知身份 fail closed')
})

test('端到端：所有 action enum 都指向真实存在的分支（防止"声明了但没实现"）', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/tools.js', import.meta.url), 'utf8')
  // 只抓 **action 字段** 的 enum（不能抓 quality/size/format 那种值枚举）
  const declared = new Set()
  for (const m of src.matchAll(/action:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]+)\]/g)) {
    for (const x of m[1].matchAll(/'([a-z][\w-]*)'/g)) declared.add(x[1])
  }
  /* 实现不一定在 tools.js 里 —— 比如 audio 的动作全在 lib/audio.js。
   * 所以把 lib/ 下所有模块一起扫，否则会误报「声明了没实现」（实测踩过）。 */
  const libDir = new URL('../lib/', import.meta.url)
  const libFiles = (await readdir(libDir)).filter((name) => name.endsWith('.js'))
  let allSource = ''
  for (const name of libFiles) {
    allSource += await readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')
    allSource += '\n'
  }
  const implemented = new Set([...allSource.matchAll(/action === '([a-z][\w-]*)'/g)].map((m) => m[1]))
  // 有些 action 由其它分支处理（如 switch/else），显式白名单
  const handledElsewhere = new Set([
    'list', 'add', 'remove', 'clear', 'show', 'status', 'generate', 'edit', 'review',
    'pending', 'scan', 'batch', 'flatten', 'approve', 'reject', 'set_active', 'test',
    'spend', 'calibrate', 'export', 'import', 'set_output', 'set_caps', 'set_locks',
    'set_profile', 'remove_profile', 'flush', 'grid', 'slice', 'good', 'pitfalls',
    'stats', 'lookup', 'record', 'install', 'audit', 'compare', 'rules-set',
    // 实测确认可用、但不是 `action === 'x'` 写法：
    //   wait  —— job 工具用它和 status 只差 `once: action === 'status'`
    //   index —— style 工具把 index 作为默认分支（`args.action || 'index'`）
    'wait', 'index',
  ])
  const missing = [...declared].filter((a) => !implemented.has(a) && !handledElsewhere.has(a))
  assert.deepEqual(missing, [], `这些 action 声明了但没实现分支：${missing.join(', ')}`)
  assert.ok(declared.size > 50, `应扫到足够多的 action，实际 ${declared.size}`)
})
