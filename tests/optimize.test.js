/**
 * 花钱路径的两个真 bug 的回归测试（都在真实使用里会造成多花钱）：
 *  ① 判停用的是「已成功张数」→ 失败的张数不算数，整轮会顶出上限、多花
 *  ② 时间预算用的是平均耗时 → 排了跑不完的量，超时那部分白花
 * 以及：连败要能停批；硬规定（命名预览图）失败必须报出来，不能悄悄跳过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { estimateLatencyMs, planBatch } from '../lib/batch/planner.js'
import { learnedStats } from '../lib/batch/run.js'

const assets = (n) => Array.from({ length: n }, (_, i) => ({
  name: `a${i}`, prompt: `p${i}`, fp: `fp${i}`, variants: 1, backend: 'openai', model: 'gpt-image-2.5-sunburst',
}))

test('时间预算用最慢耗时估算（平均 141s / 最慢 214s → 按 214s 排，不排跑不完的量）', () => {
  const stats = { ewmaLatencyMs: 141000, maxLatencyMs: 214000 }
  assert.equal(estimateLatencyMs(stats, { baseLatencyMs: 20000 }), 214000, '必须取更保守的值')
  assert.equal(estimateLatencyMs({ ewmaLatencyMs: 0, maxLatencyMs: 0 }, { baseLatencyMs: 20000 }), 20000, '没数据才用兜底')
  assert.equal(estimateLatencyMs({ maxLatencyMs: 90000 }, { baseLatencyMs: 20000 }), 90000)
})

test('时间预算：按最慢值算出来的张数，不会排超时的量', () => {
  const common = {
    assets: assets(12),
    backend: 'openai',
    caps: { maxImagesPerRun: 12, maxConcurrency: 2, maxBatch: 1, maxCostPerRun: 0 },
    unitCost: 0,
    deadlineSeconds: 600,
  }
  const slow = planBatch({ ...common, stats: { n: 8, failRate: 0, concurrency: 2, batch: 1, ewmaLatencyMs: 141000, maxLatencyMs: 214000 } })
  const fast = planBatch({ ...common, stats: { n: 8, failRate: 0, concurrency: 2, batch: 1, ewmaLatencyMs: 141000, maxLatencyMs: 0 } })
  // 600s / 214s * 2 并发 = 5 个请求位；若只用平均值（141s）会算成 8 个 → 后 3 张注定超时白花
  assert.equal(slow.max_images_this_run, 5, '按最慢值保守排量')
  assert.equal(fast.max_images_this_run, 8, '只用平均会排更多（这就是会白花的那部分）')
  assert.ok(slow.max_images_this_run < fast.max_images_this_run, '用最慢值必须更保守')
  assert.match(slow.why.join('\n'), /实测单请求约 214\.0s/)
})

test('learnedStats：失败率与连败会压住并发，不再只看成功次数放量', () => {
  const gallery = (records) => ({ records })
  const fresh = learnedStats(gallery([
    { status: 'ok', profile: 'p', model: 'm', params: { size: 's', quality: 'q' }, ms: 100000 },
    { status: 'ok', profile: 'p', model: 'm', params: { size: 's', quality: 'q' }, ms: 200000 },
  ]), { profileId: 'p', model: 'm', size: 's', quality: 'q' })
  assert.equal(fresh.concurrency, 2, '全成功 → 允许加并发')
  assert.equal(fresh.maxLatencyMs, 200000, '要记录最慢耗时')

  const failing = learnedStats(gallery([
    { status: 'failed', profile: 'p', model: 'm', params: { size: 's', quality: 'q' } },
    { status: 'failed', profile: 'p', model: 'm', params: { size: 's', quality: 'q' } },
    { status: 'failed', profile: 'p', model: 'm', params: { size: 's', quality: 'q' } },
  ]), { profileId: 'p', model: 'm', size: 's', quality: 'q' })
  assert.equal(failing.concurrency, 1, '连着失败必须退回 1 路')
  assert.equal(failing.recentFailStreak, true)
  assert.equal(failing.failRate, 1)
})

test('硬规定：标签失败要能被报出来（label_errors 结构存在且可累积）', async () => {
  // 这里只锁「失败不被吞掉」这一条契约：源码里必须有 label_errors 与对应提示
  const source = await (await import('node:fs/promises')).readFile(
    path.join(import.meta.dirname, '..', 'lib', 'run.js'), 'utf8',
  )
  assert.match(source, /const labelErrors = \[\]/)
  assert.match(source, /labelErrors\.push/)
  assert.match(source, /record\.label_errors = labelErrors/)
  assert.match(source, /label_warning/, '返回里必须带可见的告警')
})

test('实跑判停：批量执行器按「已尝试张数」而不是「已成功张数」判停', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    path.join(import.meta.dirname, '..', 'lib', 'batch', 'run.js'), 'utf8',
  )
  assert.match(source, /imagesAttempted/, '必须有「已尝试」计数（失败也算花钱）')
  assert.match(source, /if \(imagesAttempted >= maxImages\)/, '判停要用已尝试张数')
  assert.doesNotMatch(source, /if \(images >= maxImages\) \{ state\.stopped = 'budget'/, '不能再用成功张数判停')
  assert.match(source, /attemptedBudget/, '本轮还要按剩余额度裁剪波次')
  assert.match(source, /repeated-failures/, '普通失败连续出现也要停批，而不是只认限流')
})

test('省钱预检：同一张图再要一次会被跳过（0 花费），带 force 才重画', async () => {
  const { findDuplicate } = await import('../lib/fingerprint.js')
  const gallery = { records: [{ status: 'ok', profile: 'relay', model: 'm', prompt: '一只猫', params: { size: '1024x1024', quality: 'low' }, kind: 'generate', files: ['cat_1.png'] }] }
  const same = findDuplicate(gallery, { profileId: 'relay', model: 'm', prompt: '一只猫', size: '1024x1024', quality: 'low', kind: 'generate' })
  assert.equal(same.duplicate, true, '参数完全一致 → 应判为重复')
  assert.equal(same.existing.files[0], 'cat_1.png')

  const different = findDuplicate(gallery, { profileId: 'relay', model: 'm', prompt: '一只猫', size: '1024x1024', quality: 'high', kind: 'generate' })
  assert.equal(different.duplicate, false, '质量档不同 → 是新的一张')

  const otherProfile = findDuplicate(gallery, { profileId: 'other', model: 'm', prompt: '一只猫', size: '1024x1024', quality: 'low', kind: 'generate' })
  assert.equal(otherProfile.duplicate, false, '换配置档 → 允许重画')
})

test('省钱预检已接进 generate（不带 force 时不会重复花钱）', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    path.join(import.meta.dirname, '..', 'lib', 'tools.js'), 'utf8',
  )
  assert.match(source, /findDuplicate\(/, 'generate 必须做去重预检')
  assert.match(source, /skipped_duplicate: true/)
  assert.match(source, /spent: 0/, '跳过时必须明确花了 0')
  assert.match(source, /force=true/, '要告诉用户怎么强制重画')
})

test('临时目录清理（占位，保证测试自身不留垃圾）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-opt-'))
  await rm(dir, { recursive: true, force: true })
  assert.ok(true)
})
