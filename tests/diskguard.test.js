/**
 * 磁盘守卫测试。
 *
 * 背景（真实事故）：预览图 `*_labeled.png` 一直是原尺寸，攒了 535 张吃掉 928MB，
 * 加上抽帧中间产物，D 盘被塞到 **0 字节可用**。当时插件写盘失败的报错是 `ENOSPC`，
 * 完全看不出"是磁盘满了" —— 所以这层的价值不只是"清理"，而是**提前判断 + 明确报错**。
 *
 * 这里钉住三件事：
 *   ① 分级正确（ok / low / critical）
 *   ② 空间不够时**明确拒绝**并给出可操作的修复建议，而不是写一半崩掉
 *   ③ 清理只删可再生文件 —— **源素材、派生件（切片）绝不碰**
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { diskStatus, diskGuard, diskSummary, cleanRecyclableDir, DEFAULT_THRESHOLDS } from '../lib/diskguard.js'

test('diskStatus：能读出真实的剩余/总量，并给出分级', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-'))
  try {
    const status = await diskStatus({ dir })
    assert.equal(status.ok, true, status.error)
    assert.ok(status.freeGB >= 0)
    assert.ok(status.totalGB > 0)
    assert.ok(['ok', 'low', 'critical'].includes(status.level))
    // 默认阈值下，测试机通常空间充足
    assert.ok(status.usedPct >= 0 && status.usedPct <= 100)
    const summary = diskSummary(status)
    assert.equal(summary.free_gb, status.freeGB)
    assert.ok(summary.note.length > 0, '要有给人看的说明')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diskStatus：阈值可调，能把同一块盘判成 low / critical', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-th-'))
  try {
    // 把 low 阈值拉到天文数字 → 当前一定判为 low 或 critical
    const huge = await diskStatus({ dir, thresholds: { lowGB: 1e9, criticalGB: 1e9 - 1 } })
    assert.ok(huge.level === 'low' || huge.level === 'critical', `拉高阈值后应为 low/critical，实际 ${huge.level}`)
    // 阈值放到 0 → 一定 ok
    const loose = await diskStatus({ dir, thresholds: { lowGB: 0, criticalGB: 0 } })
    assert.equal(loose.level, 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ diskGuard：空间不足时**明确拒绝**并给修复建议（不是写一半崩掉）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-guard-'))
  try {
    // 阈值拉到比实际剩余大得多 → 必然拦
    const blocked = await diskGuard({
      dir, needMB: 100,
      thresholds: { lowGB: 1e9, criticalGB: 1e9 - 1 },
      autoClean: false,
    })
    assert.equal(blocked.ok, false, '空间判定不足时必须拒绝')
    assert.match(blocked.error, /磁盘空间不足/)
    assert.ok(Array.isArray(blocked.howToFix) && blocked.howToFix.length >= 2, '必须给出可操作的修复建议')
    assert.ok(blocked.howToFix.some((h) => h.includes('config(action="disk")')))

    // 正常阈值 → 放行
    const passed = await diskGuard({ dir, needMB: 1, thresholds: { lowGB: 0, criticalGB: 0 } })
    assert.equal(passed.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ 清理只删**可再生**文件：源素材、切片、配置一个都不能动', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-clean-'))
  try {
    // 可再生（该删）
    await writeFile(path.join(dir, 'unit_1_labeled.png'), Buffer.alloc(1024, 1))
    await writeFile(path.join(dir, 'unit.cache.json'), '{}')
    await mkdir(path.join(dir, 'frames'), { recursive: true })
    await writeFile(path.join(dir, 'frames', 'f1.png'), Buffer.alloc(1024, 2))
    // 不可再生（必须保留）
    await writeFile(path.join(dir, 'unit_1.png'), 'source')
    await writeFile(path.join(dir, 'unit.anim.json'), JSON.stringify({ image: 'unit_1.png' }))
    await mkdir(path.join(dir, 'icons_slices'), { recursive: true })
    await writeFile(path.join(dir, 'icons_slices', 'a.png'), 'slice')

    const result = await cleanRecyclableDir({ dir })
    assert.ok(result.removed >= 2, `应删掉预览图和缓存，实际 ${result.removed}`)

    const exists = async (p) => stat(p).then(() => true).catch(() => false)
    assert.equal(await exists(path.join(dir, 'unit_1.png')), true, '源素材不能删')
    assert.equal(await exists(path.join(dir, 'unit.anim.json')), true, '配置不能删')
    assert.equal(await exists(path.join(dir, 'icons_slices', 'a.png')), true, '派生切片默认不能动（可能正被游戏引用）')
    assert.equal(await exists(path.join(dir, 'unit_1_labeled.png')), false, '预览图应被删')
    assert.equal(await exists(path.join(dir, 'unit.cache.json')), false, '缓存应被删')
    assert.equal(await exists(path.join(dir, 'frames')), false, '中间产物应被删')
    assert.ok(result.note.includes('MB'), '要报告省出多少')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diskGuard：允许挂 cleanup 回调，清理后复查空间', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-cb-'))
  try {
    let called = 0
    const result = await diskGuard({
      dir, needMB: 1,
      thresholds: { lowGB: 1e9, criticalGB: 1e9 - 1 },   // 强制走"空间紧张"分支
      cleanup: async () => { called += 1; return { note: '假装清了下', freedMB: 0 } },
    })
    assert.equal(called, 1, 'cleanup 应该被调用一次')
    assert.ok(result.cleaned, '结果里要带清理报告')
    // 清完空间还是不够（阈值本来就不可达）→ 仍然拒绝，但要带上清理报告
    assert.equal(result.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('默认阈值有明确数值（low 5GB / critical 1GB）', () => {
  assert.equal(DEFAULT_THRESHOLDS.lowGB, 5)
  assert.equal(DEFAULT_THRESHOLDS.criticalGB, 1)
})
