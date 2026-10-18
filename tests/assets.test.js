/**
 * 素材目录 + 审核状态测试。
 *
 * 最要紧的两条：
 *   ① 磁盘上有、历史里没有的图**必须能被列出来**（这正是"大量素材只在文件夹里"的根因）；
 *   ② 审核结论要能按素材名继承（重画同名的图不该丢掉人的判断）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AssetCatalog,
  REVIEW_STATES,
  assetNameOf,
  classifyFile,
  normalizePath,
  reviewStateLabel,
  scanAssetCatalog,
} from '../lib/assets.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function makeTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assetcat-'))
  const proj = path.join(root, 'proj')
  await mkdir(path.join(proj, 'hero_slices'), { recursive: true })
  await writeFile(path.join(proj, 'hero_1.png'), PNG)
  await writeFile(path.join(proj, 'hero_1_labeled.png'), PNG)
  await writeFile(path.join(proj, 'hero_64x16.png'), PNG)
  await writeFile(path.join(proj, 'hero_slices', 'hero_01.png'), PNG)
  await writeFile(path.join(proj, 'shot_test_2026.png'), PNG)
  await writeFile(path.join(proj, 'notes.txt'), 'not an image')
  return { root, proj }
}

// ---- 路径与命名 ----

test('normalizePath：统一小写与斜杠，避免同一文件被算两份', () => {
  assert.equal(normalizePath('D:\\A\\B\\C.PNG'), 'd:/a/b/c.png')
  assert.equal(normalizePath('d:/a/b/c.png'), 'd:/a/b/c.png')
})

test('assetNameOf：剥掉序号 / _labeled / 尺寸后缀', () => {
  assert.equal(assetNameOf('D:\\x\\hero_1.png'), 'hero')
  assert.equal(assetNameOf('hero_1_labeled.png'), 'hero')
  assert.equal(assetNameOf('hero_64x16.png'), 'hero')
  assert.equal(assetNameOf('r67rest_cardart_28.png'), 'r67rest_cardart')
})

test('classifyFile：区分正式素材 / 切片 / 缩放件 / 预览图 / 截图', () => {
  assert.equal(classifyFile('p/hero_1.png'), 'source')
  assert.equal(classifyFile('p/hero_slices/hero_01.png'), 'slice')
  assert.equal(classifyFile('p/hero_labeled.png'), 'preview')
  assert.equal(classifyFile('p/hero_64x16.png'), 'resized')
  assert.equal(classifyFile('p/shot_x.png'), 'screenshot')
})

test('reviewStateLabel 有中文标签，未知状态原样返回', () => {
  assert.equal(reviewStateLabel('approved'), '合格')
  assert.equal(reviewStateLabel('rejected'), '不合格')
  assert.equal(reviewStateLabel(''), '未审核')
  assert.deepEqual(REVIEW_STATES, ['approved', 'rejected', 'pending'])
})

// ---- 扫磁盘：核心能力 ----

test('扫磁盘能列出历史里没有的图（这正是以前看不见的那批）', async () => {
  const { root } = await makeTree()
  try {
    // 历史里只有 hero_1.png 一张
    const gallery = {
      list: () => [{ files: [path.join(root, 'proj', 'hero_1.png')], labeled: [], name: 'hero', prompt: 'p', provider: 'openai', model: 'm' }],
    }
    const r = await scanAssetCatalog({ outputDir: root, gallery })
    assert.equal(r.ok, true)
    const names = r.files.map((f) => path.basename(f.file)).sort()
    // 5 张图都应该在（txt 不算）
    assert.deepEqual(names, ['hero_01.png', 'hero_1.png', 'hero_1_labeled.png', 'hero_64x16.png', 'shot_test_2026.png'])
    // 只有 hero_1.png 是"本插件生成"
    const generated = r.files.filter((f) => f.generated)
    assert.equal(generated.length, 1)
    assert.equal(path.basename(generated[0].file), 'hero_1.png')
    assert.equal(generated[0].prompt, 'p', '有历史时要带上提示词')
    assert.equal(r.tally.total, 5)
    assert.equal(r.tally.external, 4, '外部产物应有 4 张')
    assert.equal(r.external_files.length, 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('按类别统计：正式素材/切片/缩放件/预览图/截图 各归各类', async () => {
  const { root } = await makeTree()
  try {
    const r = await scanAssetCatalog({ outputDir: root, gallery: { list: () => [] } })
    assert.equal(r.by_kind.source, 1)
    assert.equal(r.by_kind.slice, 1)
    assert.equal(r.by_kind.resized, 1)
    assert.equal(r.by_kind.preview, 1)
    assert.equal(r.by_kind.screenshot, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project 过滤：只看指定项目', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assetcat2-'))
  try {
    await mkdir(path.join(root, 'a'), { recursive: true })
    await mkdir(path.join(root, 'b'), { recursive: true })
    await writeFile(path.join(root, 'a', 'x_1.png'), PNG)
    await writeFile(path.join(root, 'b', 'y_1.png'), PNG)
    const r = await scanAssetCatalog({ outputDir: root, gallery: { list: () => [] }, project: 'a' })
    assert.equal(r.files.length, 1)
    assert.equal(r.files[0].project, 'a')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('不存在的输出目录 → 不抛异常，返回空目录', async () => {
  const r = await scanAssetCatalog({ outputDir: path.join(os.tmpdir(), 'definitely-not-here-xyz'), gallery: { list: () => [] } })
  assert.equal(r.ok, true)
  assert.equal(r.files.length, 0)
})

test('没有 outputDir → 明确报错', async () => {
  const r = await scanAssetCatalog({ outputDir: '', gallery: { list: () => [] } })
  assert.equal(r.ok, false)
  assert.match(r.error, /输出目录/)
})

// ---- 审核状态 ----

test('标记合格/不合格/待定，并能读回来', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assetcat3-'))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat3-data-'))
  try {
    await mkdir(path.join(root, 'p'), { recursive: true })
    await writeFile(path.join(root, 'p', 'hero_1.png'), PNG)
    const file = path.join(root, 'p', 'hero_1.png')

    const catalog = await AssetCatalog.load(dataDir)
    assert.equal(catalog.mark({ files: [{ path: file, name: 'hero' }], state: 'approved' }).ok, true)
    // 非法状态必须被拒绝（否则脏状态会写进配置）
    const bad = catalog.mark({ files: [{ path: file, name: 'hero' }], state: 'maybe' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /approved/)
    await catalog.save()

    const reloaded = await AssetCatalog.load(dataDir)
    assert.equal(reloaded.reviewOf({ file })?.state, 'approved')
    assert.equal(reloaded.stats().approved, 1)
    // 扫描时带上状态
    const r = await scanAssetCatalog({ outputDir: root, catalog: reloaded, gallery: { list: () => [] } })
    assert.equal(r.files[0].review_state, 'approved')
    assert.equal(r.tally.approved, 1)
    assert.equal(r.tally.unreviewed, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('按素材名标记：重画同名的图会继承结论', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat4-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ names: ['hero'], state: 'rejected', note: '构图不对' })
    // 换一个全新路径，但素材名相同
    const later = catalog.reviewOf({ file: 'D:/out/new/hero_1.png' })
    assert.equal(later?.state, 'rejected')
    assert.equal(later?.note, '构图不对')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('按文件标记优先于按名字（同名不同文件可以分别判）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat5-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ names: ['hero'], state: 'rejected' })
    catalog.mark({ files: [{ path: 'D:/out/a/hero_1.png', name: 'hero' }], state: 'approved' })
    assert.equal(catalog.reviewOf({ file: 'D:/out/a/hero_1.png' })?.state, 'approved')
    assert.equal(catalog.reviewOf({ file: 'D:/out/b/hero_1.png' })?.state, 'rejected', '同名的另一张仍按名字结论')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('scope=file 时只按文件记，不污染同名结论', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat6-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: 'D:/out/a/hero_1.png', name: 'hero' }], state: 'approved', scope: 'file' })
    assert.equal(catalog.reviewOf({ file: 'D:/out/a/hero_1.png' })?.state, 'approved')
    assert.equal(catalog.reviewOf({ file: 'D:/out/b/hero_1.png' }), null, '不该继承到别的同名文件')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('批量标记多张一次完成（一件勾选的后端）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat7-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    const files = ['a/1.png', 'a/2.png', 'a/3.png'].map((f) => ({ path: f, name: 'n' }))
    const res = catalog.mark({ files, state: 'approved' })
    assert.deepEqual(res, { ok: true, changed: 3, state: 'approved', label: '合格' })
    assert.equal(catalog.stats().approved, 3)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('clear 能撤销标记', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat8-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    catalog.mark({ files: [{ path: 'a/1.png', name: 'n' }], state: 'approved' })
    catalog.mark({ names: ['m'], state: 'rejected' })
    const res = catalog.clear({ files: ['a/1.png'], names: ['m'] })
    assert.equal(res.cleared, 2)
    assert.equal(catalog.stats().approved, 0)
    assert.equal(catalog.stats().names_reviewed, 0)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('标记不可变入参：传入的 files 数组不会被改动', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat9-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    const files = Object.freeze([Object.freeze({ path: 'a/1.png', name: 'n' })])
    assert.doesNotThrow(() => catalog.mark({ files, state: 'pending' }))
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('空目录/空输入不炸', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assetcat10-'))
  try {
    const catalog = await AssetCatalog.load(dataDir)
    assert.equal(catalog.stats().files_reviewed, 0)
    assert.deepEqual(catalog.mark({ files: [], names: [], state: 'approved' }), { ok: true, changed: 0, state: 'approved', label: '合格' })
    assert.equal(catalog.reviewOf({}), null)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
