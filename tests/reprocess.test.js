/**
 * 三个提示词的测试：变化摘要 / 审核对比 / 批量重处理。
 *
 * 重点覆盖 prompt 里点名的边界情况 —— 那些正是最容易做错的地方：
 *   - 首次运行不能把已有 900 张全报成"新增"
 *   - touch 过（mtime 变、内容没变）**不该**报成内容变化
 *   - 目录被清空时不刷屏
 *   - 快照损坏要能当首次运行处理，而不是崩掉
 *   - 切片规则歧义：`t_path_64x16` 是尺寸不是 16 格；`i_skull_48` 是清单规格不是 48 格
 *   - 重处理失败要回滚、孤儿要清理、并发要挡住
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseSliceCount, parseScaleTarget, sliceRuleFor, gridFromCount, AssetCatalog, scanAssetCatalog as scanAssetCatalogRaw } from '../lib/assets.js'
import { Snapshot, diffSnapshot, summarizeChanges, captureChanges } from '../lib/snapshot.js'
import { planReprocess, acquireLock, rulesChanged, rulesFingerprint, recordRules } from '../lib/reprocess.js'
import { downscale } from '../lib/compare.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function tmp(prefix = 'p3-') {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 造一条"扫描结果"记录（就是 scanAssetCatalog 输出的形状）。 */
function entry(root, name, { size = 100, mtime = '2026-10-01T00:00:00.000Z', kind = 'source', hash = '' } = {}) {
  return {
    file: path.join(root, name),
    name: name.replace(/\.png$/, ''),
    kind,
    bytes: size,
    mtime,
    contentHash: hash || undefined,
    project: 'p',
    generated: true,
  }
}

// ============ 提示词 1 · 变化摘要 ============

test('首次运行只建基线，不把已有图全报成"新增"', async () => {
  const root = await tmp()
  const dataDir = await tmp('snap-')
  try {
    const files = Array.from({ length: 916 }, (_, i) => entry(root, `a${i}.png`))
    const diff = await diffSnapshot({ files, previous: await Snapshot.load(dataDir) })
    assert.equal(diff.first_run, true)
    assert.equal(diff.stats.added, 0, '首次运行绝不能报 916 新增')
    assert.equal(diff.stats.total, 916)
    assert.match(diff.summary, /已建立基线/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('第二次扫描能报出新增 / 消失 / 内容变化', async () => {
  const root = await tmp()
  const dataDir = await tmp('snap-')
  try {
    const first = [entry(root, 'a.png', { size: 100, mtime: 'm1' }), entry(root, 'b.png', { size: 100, mtime: 'm1' })]
    await captureChanges({ files: first, dataDir })

    const second = [
      entry(root, 'a.png', { size: 100, mtime: 'm1' }),          // 没变
      entry(root, 'c.png', { size: 200, mtime: 'm3' }),          // 新增
    ]                                                            // b.png 消失
    const diff = await diffSnapshot({ files: second, previous: await Snapshot.load(dataDir) })
    assert.equal(diff.first_run, false)
    assert.equal(diff.stats.added, 1)
    assert.equal(diff.stats.removed, 1)
    assert.equal(diff.added[0].name, 'c')
    assert.equal(diff.removed[0].name, 'b.png')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('size 变了 → 算内容变化（不读内容也能判）', async () => {
  const root = await tmp()
  const dataDir = await tmp('snap-')
  try {
    await captureChanges({ files: [entry(root, 'a.png', { size: 100, mtime: 'm1' })], dataDir })
    const diff = await diffSnapshot({
      files: [entry(root, 'a.png', { size: 999, mtime: 'm1' })],
      previous: await Snapshot.load(dataDir),
    })
    assert.equal(diff.stats.changed, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('touch 过（mtime 变但内容没变）**不该**报成内容变化', async () => {
  const root = await tmp()
  const dataDir = await tmp('snap-')
  try {
    // 真文件，这样能算 hash
    const file = path.join(root, 'a.png')
    await writeFile(file, PNG)
    const info = await stat(file)
    const real = { ...entry(root, 'a.png', { size: info.size, mtime: info.mtime.toISOString() }), file }
    // 首次带 hash 存基线
    real.contentHash = undefined
    const first = await captureChanges({ files: [{ ...real, contentHash: undefined }], dataDir })
    assert.equal(first.first_run, true)

    // 重新读一次拿 hash（模拟正常路径：可疑项才算）
    await utimes(file, new Date(), new Date())   // touch：mtime 变，内容不变
    const after = await stat(file)
    const diff = await diffSnapshot({
      files: [{ ...entry(root, 'a.png', { size: after.size, mtime: after.mtime.toISOString() }), file }],
      previous: await Snapshot.load(dataDir),
    })
    assert.equal(diff.stats.changed, 0, 'mtime 变了但内容没变 → 不能报内容变化')
    assert.equal(diff.stats.added, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('大量文件同时消失 → 摘要说明"可能是目录被清空"，不逐条刷屏', () => {
  const text = summarizeChanges({ added: 0, changed: 0, removed: 900, total: 900 }, { removedMassive: true })
  assert.match(text, /消失 900/)
  assert.match(text, /清空|移动/)
})

test('没有任何变化 → 明确说"没有变化"', () => {
  assert.equal(summarizeChanges({ added: 0, changed: 0, removed: 0 }), '自上次以来没有变化。')
})

test('快照损坏（JSON 坏/结构不对）→ 当首次运行，不崩', async () => {
  const dataDir = await tmp('snap-')
  try {
    await writeFile(path.join(dataDir, 'snapshot.json'), '{ this is not json', 'utf8')
    const snap = await Snapshot.load(dataDir)
    assert.equal(snap.hasBaseline, false)
    const diff = await diffSnapshot({ files: [entry('r', 'a.png')], previous: snap })
    assert.equal(diff.first_run, true)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('目录被移动/重命名 → 表现为"旧的消失 + 新的新增"，不会误判成内容变化', async () => {
  const root = await tmp()
  const dataDir = await tmp('snap-')
  try {
    await captureChanges({ files: [entry(root, 'old/a.png', { size: 1, mtime: 'm' })], dataDir })
    const diff = await diffSnapshot({
      files: [entry(root, 'new/a.png', { size: 1, mtime: 'm' })],
      previous: await Snapshot.load(dataDir),
    })
    assert.equal(diff.stats.added, 1)
    assert.equal(diff.stats.removed, 1)
    assert.equal(diff.stats.changed, 0, '路径变了不等于内容变了')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

// ============ 切片规则（提示词 2 依赖的基础） ============

test('格数解析：实测的名字全部正确', () => {
  assert.equal(parseSliceCount('pilot_cardart_4'), 4)
  assert.equal(parseSliceCount('r67_frames_8'), 8)
  assert.equal(parseSliceCount('icon_drug_12'), 12)
  assert.equal(parseSliceCount('card_atk_pilot16'), 16)
  assert.equal(parseSliceCount('icon_relic_18'), 18)
  assert.equal(parseSliceCount('t_path_64x16'), 0, '_64x16 是尺寸后缀，不是网格')
  assert.equal(parseSliceCount('hero_1'), 0, '序号 _1 不是网格')
})

test('扫磁盘能观测到 _slices 里真实的切片数（归到源素材名）', async () => {
  const root = await tmp('obs-')
  try {
    const proj = path.join(root, 'p')
    await mkdir(path.join(proj, 'r67_frames_8_slices'), { recursive: true })
    for (let i = 1; i <= 8; i++) {
      await writeFile(path.join(proj, 'r67_frames_8_slices', `r67_frames_8_0${i}.png`), PNG)
    }
    await writeFile(path.join(proj, 'r67_frames_8_1.png'), PNG)
    const scan = await scanAssetCatalogRaw({ outputDir: root, gallery: { list: () => [] } })
    // 观测值应归到源素材名 r67_frames_8，而不是切片自己的名字
    assert.equal(scan.observedSlices['r67_frames_8'], 8)
    assert.ok(!scan.observedSlices['r67_frames_8_01'], '不该按切片自己的名字统计')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('_64x16 解析成缩放目标，且不再被当成网格', () => {
  assert.deepEqual(parseScaleTarget('t_path_64x16'), { width: 64, height: 16 })
  const rule = sliceRuleFor({ name: 't_path_64x16', kind: 'source' })
  assert.equal(rule.slices, 0)
  assert.deepEqual(rule.scaled, { width: 64, height: 16 })
})

test('清单声明了尺寸时，结尾数字按尺寸理解（i_skull_48）', () => {
  // 有清单：48 是规格 → 没有切片规则（返回 null）
  assert.equal(sliceRuleFor({ name: 'i_skull_48', kind: 'source', expected: { size: { width: 48, height: 48 } } }), null)
  // 没清单：只能按格数理解
  assert.equal(sliceRuleFor({ name: 'i_skull_48', kind: 'source' }).slices, 48)
})

test('观测值优先于名字猜测（名字会骗人，磁盘不会）', () => {
  // r67tpath_dark2：名字看像 2 格，但如果磁盘上 _slices 里真是 2 个文件，就用 2
  const byName = sliceRuleFor({ name: 'r67tpath_dark2', kind: 'source' })
  assert.equal(byName.slices, 2, '没有观测时按名字猜')
  // 有观测且与名字不同 → 以观测为准
  const byObserved = sliceRuleFor({ name: 'r67tpath_dark2', kind: 'source', observedSlices: 6 })
  assert.equal(byObserved.slices, 6, '观测到的才是事实')
  assert.equal(byObserved.observed, true)
  assert.match(byObserved.source, /已存在的切片数/)
})

test('观测值为 0 时不覆盖名字解析（没切过的用名字）', () => {
  const rule = sliceRuleFor({ name: 'pilot_cardart_4', kind: 'source', observedSlices: 0 })
  assert.equal(rule.slices, 4)
  assert.equal(rule.observed, false)
})

test('preview / screenshot 没有切片规则（对比视图据此退化两格）', () => {
  assert.equal(sliceRuleFor({ name: 'x_4', kind: 'preview' }), null)
  assert.equal(sliceRuleFor({ name: 'shot_x_4', kind: 'screenshot' }), null)
})

test('网格排布与 sheet.js 的策略一致（4 → 2×2，12 → 4×3）', () => {
  assert.deepEqual(gridFromCount(4), { columns: 2, rows: 2, capacity: 4 })
  assert.deepEqual(gridFromCount(12), { columns: 4, rows: 3, capacity: 12 })
})

// ============ 审核队列与继承 ============

test('队列重算：未审进 needsReview，合格进 needsInstall，内容变了进 needsReReview', async () => {
  const dataDir = await tmp('cat-')
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: 'a/ok.png', name: 'ok', contentHash: 'h1' }], state: 'approved' })
    const files = [
      { file: 'a/ok.png', name: 'ok', kind: 'source', contentHash: 'h1' },     // 合格且没变 → 待装
      { file: 'a/new.png', name: 'new', kind: 'source' },                       // 没审 → 待审
      { file: 'a/chg.png', name: 'chg', kind: 'source', contentHash: 'h2' },    // 审过但内容变了
      { file: 'a/pv.png', name: 'pv', kind: 'preview' },                        // 预览图 → 不进队列
    ]
    catalog.mark({ files: [{ path: 'a/chg.png', name: 'chg', contentHash: 'h1' }], state: 'approved' })
    const q = catalog.recomputeQueue({ files })
    assert.deepEqual(q.needsInstall, ['a/ok.png'])
    assert.deepEqual(q.needsReview, ['a/new.png'])
    assert.deepEqual(q.needsReReview, ['a/chg.png'])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('继承：源图 approved → 派生文件自动 approved（人审 1 张 = N 张切片）', async () => {
  const dataDir = await tmp('cat-')
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: 'src/hero.png', name: 'hero' }], state: 'approved' })
    const derived = Array.from({ length: 4 }, (_, i) => ({ path: `src/hero_slices/hero_0${i + 1}.png`, name: 'hero' }))
    const res = catalog.inherit({ sourcePath: 'src/hero.png', sourceName: 'hero', derived })
    assert.equal(res.ok, true)
    assert.equal(res.count, 4)
    for (const item of derived) {
      assert.equal(catalog.reviewOf({ file: item.path }).state, 'approved')
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('继承：源图没结论时拒绝继承（不能凭空造一个合格）', async () => {
  const dataDir = await tmp('cat-')
  try {
    const catalog = await AssetCatalog.load(dataDir)
    const res = catalog.inherit({ sourcePath: 'x.png', sourceName: 'x', derived: [{ path: 'x_1.png' }] })
    assert.equal(res.ok, false)
    assert.match(res.error, /没有审核结论/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

// ============ 提示词 3 · 批量重处理 ============

test('重处理只动已审核的源图；未审核的跳过、源图变了的失效', async () => {
  const dataDir = await tmp('rep-')
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: '/o/p/hero_4.png', name: 'hero_4', contentHash: 'h1' }], state: 'approved' })
    catalog.mark({ files: [{ path: '/o/p/gone_4.png', name: 'gone_4', contentHash: 'old' }], state: 'approved' })
    const files = [
      { file: '/o/p/hero_4.png', name: 'hero_4', kind: 'source', contentHash: 'h1' },        // 可重切
      { file: '/o/p/draft_4.png', name: 'draft_4', kind: 'source' },                        // 未审 → 跳过
      { file: '/o/p/gone_4.png', name: 'gone_4', kind: 'source', contentHash: 'new' },      // 内容变了 → 失效
      { file: '/o/p/old_4_slices/old_4_01.png', name: 'old_4', kind: 'slice' },             // 孤儿
    ]
    const plan = planReprocess({ files, catalog, expectations: {}, slices: true })
    assert.equal(plan.to_reprocess.length, 1)
    assert.equal(plan.to_reprocess[0].name, 'hero_4')
    assert.equal(plan.skipped_unreviewed.length, 1)
    assert.equal(plan.invalidated.length, 1)
    assert.match(plan.invalidated[0].why, /内容已变/)
    assert.equal(plan.orphans.length, 1, '源图不在的派生文件应算孤儿')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('源图同时"内容变了 + 规则变了" → 优先按内容变化（要重审）', async () => {
  const dataDir = await tmp('rep-')
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: '/o/p/x_4.png', name: 'x_4', contentHash: 'old' }], state: 'approved' })
    const plan = planReprocess({
      files: [{ file: '/o/p/x_4.png', name: 'x_4', kind: 'source', contentHash: 'new' }],
      catalog, expectations: {}, slices: true,
    })
    assert.equal(plan.to_reprocess.length, 0, '不能重切——它需要的是重审')
    assert.equal(plan.invalidated.length, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('没有切片规则的源图不进重切清单（no_rule）', async () => {
  const dataDir = await tmp('rep-')
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: '/o/p/plain.png', name: 'plain' }], state: 'approved' })
    const plan = planReprocess({
      files: [{ file: '/o/p/plain.png', name: 'plain', kind: 'source' }],
      catalog, expectations: {}, slices: true,
    })
    assert.equal(plan.to_reprocess.length, 0)
    assert.equal(plan.no_rule.length, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('规则指纹：同样的规则判为未变，改了网格/尺寸则判为变', () => {
  const a = rulesFingerprint({ slices: true, scaled: false, expectations: { x: { size: { width: 48, height: 48 } } } })
  const b = rulesFingerprint({ slices: true, scaled: false, expectations: { x: { size: { width: 48, height: 48 } } } })
  const c = rulesFingerprint({ slices: true, scaled: false, expectations: { x: { size: { width: 64, height: 64 } } } })
  assert.equal(a, b)
  assert.notEqual(a, c)

  const catalog = { data: {} }
  assert.equal(rulesChanged(catalog, a), true, '没记录过 = 变过（首次要切一遍）')
  recordRules(catalog, a)
  assert.equal(rulesChanged(catalog, a), false)
  assert.equal(rulesChanged(catalog, c), true)
})

test('并发保护：锁被占时明确拒绝（reprocess 与 install 不能同时跑）', async () => {
  const dataDir = await tmp('lock-')
  try {
    const first = await acquireLock(dataDir, 'reprocess')
    assert.equal(first.ok, true)
    const second = await acquireLock(dataDir, 'reprocess')
    assert.equal(second.ok, false)
    assert.match(second.error, /已有 reprocess 在跑/)
    await first.release()
    const third = await acquireLock(dataDir, 'reprocess')
    assert.equal(third.ok, true, '释放后应该能再拿到')
    await third.release()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('过期锁能被抢过来（进程被强杀后不会永久卡住）', async () => {
  const dataDir = await tmp('lock-')
  try {
    const lockFile = path.join(dataDir, 'reprocess.lock')
    await writeFile(lockFile, 'stale', 'utf8')
    const old = new Date(Date.now() - 11 * 60 * 1000)  // 11 分钟前 > 10 分钟阈值
    await utimes(lockFile, old, old)
    const got = await acquireLock(dataDir, 'reprocess')
    assert.equal(got.ok, true, '过期锁应被抢占')
    await got.release()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

// ============ 提示词 2 · 对比视图的降采样 ============

test('超大图降采样到上限内，且比例正确（4K 不该卡死）', () => {
  const width = 4096
  const height = 4096
  const pixels = new Uint8ClampedArray(width * height * 4)
  const out = downscale({ width, height, pixels }, 768)
  assert.equal(out.scaled, true)
  assert.ok(Math.max(out.width, out.height) <= 768)
  assert.equal(out.width, out.height, '正方形应保持正方形')
  assert.equal(out.pixels.length, out.width * out.height * 4)
  assert.equal(out.from, '4096×4096')
})

test('小图不降采样（避免无谓重算）', () => {
  const out = downscale({ width: 128, height: 128, pixels: new Uint8ClampedArray(128 * 128 * 4) }, 768)
  assert.equal(out.scaled, false)
  assert.equal(out.width, 128)
})

test('非正方形降采样保持宽高比', () => {
  const out = downscale({ width: 2000, height: 1000, pixels: new Uint8ClampedArray(2000 * 1000 * 4) }, 768)
  assert.equal(out.width, 768)
  assert.equal(out.height, 384)
})
