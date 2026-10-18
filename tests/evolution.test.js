/**
 * F–J 组测试：生成端 / 游戏倒推 / 安全网 / 可观测性 / 长期演进。
 *
 * 重点覆盖"容易做错成假数据"的地方：
 *   - 模板缺变量**不能静默留空**
 *   - 变体是乘法的，必须给成本预警
 *   - 引用检查**误报比漏报更糟**（实测被 diag 脚本的产出名骗过 36 次）
 *   - 风格迁移必须保色相（否则图全灰）
 *   - A/B 判定不编造数据，样本不足就说"别下结论"
 *   - 备份回滚本身要可回滚
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodePngRgba } from '../lib/pngcodec.js'

import {
  renderTemplate, validateTemplate, TemplateLibrary, planVariants,
  costByProject, costEffectiveness, reversePrompt,
  healthDashboard, reviewEfficiency, pipelineFunnel, trending,
} from '../lib/pipeline2.js'
import { walkProject, buildReferenceGraph, checkContract, analyzeImpact, previewChecklist } from '../lib/gamecheck.js'
import {
  acquireResourceLock, lockStatus, ProvenanceLog,
  checkPngIntegrity, scanCorruption, createBackup, listBackups, restoreBackup, needsBackup,
} from '../lib/safety.js'
import {
  buildStyleGuide, styleGuideMarkdown, SharedLibrary, transferStyle,
  designAbTest, analyzeAbTest, buildGalleryHtml,
} from '../lib/evolution.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
async function tmp(prefix = 'fj-') {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

function tile(size, rgb, alpha = 255) {
  const p = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < p.length; i += 4) {
    p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; p[i + 3] = alpha
  }
  return encodePngRgba(size, size, p)
}

// ══════ F1 Prompt 模板库 ══════

test('F1 模板渲染：变量替换；缺变量**保留占位符**而不是静默留空', () => {
  const ok = renderTemplate('{元素}，{风格}，居中', { 元素: '一把剑', 风格: '像素风' })
  assert.equal(ok.complete, true)
  assert.equal(ok.text, '一把剑，像素风，居中')

  const missing = renderTemplate('{元素}，{风格}，居中', { 元素: '盾牌' })
  assert.equal(missing.complete, false)
  assert.deepEqual(missing.missing, ['风格'])
  // 关键：占位符要留下，否则 prompt 少一截却看不出来
  assert.match(missing.text, /\{风格\}/, '缺的变量必须保留占位符')
})

test('F1 支持中英文变量名', () => {
  assert.equal(renderTemplate('{role} {元素}', { role: 'hero', 元素: '剑' }).text, 'hero 剑')
})

test('F1 模板校验：没有变量的不算模板（直接写 prompt 就行）', () => {
  assert.equal(validateTemplate({ id: 'x', text: '一段固定的话' }).ok, false)
  assert.match(validateTemplate({ id: 'x', text: '固定' }).errors.join(';'), /没有任何 \{变量\}/)
  assert.equal(validateTemplate({ id: 'y', text: '{a} 和 {b}' }).ok, true)
})

test('F1 展开：批量套模板，并汇总缺变量清单', async () => {
  const dir = await tmp()
  try {
    const lib = await TemplateLibrary.load(dir)
    const result = lib.expand({
      id: 'icon-basic',
      items: [{ name: 'a', 元素: '剑', 风格: '像素' }, { name: 'b', 元素: '盾' }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.assets.length, 2)
    assert.equal(result.assets[0].complete, true)
    assert.equal(result.assets[1].complete, false)
    assert.equal(result.missing.length, 1, '应汇总出哪条缺变量')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F1 不存在的模板 → 明确报错', async () => {
  const dir = await tmp()
  try {
    const lib = await TemplateLibrary.load(dir)
    assert.equal(lib.expand({ id: '不存在', items: [{ 元素: 'x' }] }).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F1 upsert 会记录变量、remove 能删', async () => {
  const dir = await tmp()
  try {
    const lib = await TemplateLibrary.load(dir)
    const up = lib.upsert({ id: 't1', name: 'T', text: '{a} 的 {b}' })
    assert.equal(up.ok, true)
    assert.deepEqual(up.template.variables.sort(), ['a', 'b'])
    assert.equal(lib.remove('t1'), 1)
    assert.equal(lib.get('t1'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ F2 批量调度 ══════

test('F2 变体矩阵：prompt × 尺寸 × 质量 × seed 正确展开', () => {
  const r = planVariants({
    base: { prompt: 'a' },
    prompts: ['a', 'b'], sizes: ['1K', '2K'], quality: ['low'], count: 3,
  })
  assert.equal(r.ok, true)
  assert.equal(r.matrix.prompts, 2)
  assert.equal(r.matrix.sizes, 2)
  assert.equal(r.matrix.seeds, 3)
  assert.equal(r.matrix.total, 12)
})

test('F2 每个变体都带 seed（好结果才能精确复现）', () => {
  const r = planVariants({ base: { prompt: 'x' }, count: 4, seedStart: 100 })
  assert.deepEqual(r.assets.map((a) => a.seed), [100, 101, 102, 103])
})

test('F2 大批量给成本预警（变体是乘法的）', () => {
  const big = planVariants({ base: { prompt: 'x' }, count: 100 })
  assert.match(big.warning, /注意花费|乘法/)
  const small = planVariants({ base: { prompt: 'x' }, count: 5 })
  assert.equal(small.warning, '')
})

test('F2 没有 prompt → 报错，不产出空清单', () => {
  assert.equal(planVariants({ base: {} }).ok, false)
})

// ══════ F3 成本追踪 ══════

test('F3 按项目汇总：均单价只看付费张数（免费图不稀释）', () => {
  const r = costByProject({
    records: [
      { project: 'p1', action: 'generate', images: 10, cost: 0.4 },
      { project: 'p1', action: 'generate', images: 10, cost: 0, free: true },
      { project: 'p2', action: 'generate', images: 5, cost: 0.5 },
    ],
  })
  const p1 = r.projects.find((p) => p.project === 'p1')
  assert.equal(p1.images, 20)
  assert.equal(p1.free_images, 10)
  assert.equal(p1.cost_per_paid_image, 0.04, '0.4 / 10 张付费')
  assert.equal(r.total_cost, 0.9)
})

test('F3 性价比：算出"花在没进游戏的图上"的钱', () => {
  const r = costEffectiveness({
    records: [
      { project: 'p1', images: 10, cost: 1.0, names: ['used', 'x', 'y'] },
    ],
    installedKeys: ['used'],
  })
  assert.equal(r.projects[0].utilization > 0, true)
  assert.ok(r.total_wasted > 0)
  assert.match(r.advice, /没进游戏/)
})

test('F3 空记录不炸', () => {
  assert.equal(costByProject({ records: [] }).advice, '还没有花费记录。')
})

// ══════ F4 Prompt 反向提取 ══════

test('F4 反推风格特征；语义留空不编造', () => {
  const r = reversePrompt({
    fingerprint: { dominant: '#888888', palette: [{ hex: '#888888' }], saturation: 0.1, edgeDensity: 0.4, alphaRatio: 0.3 },
    quality: { avgLuminance: 0.5 },
    imageSize: { width: 64, height: 64 },
  })
  assert.equal(r.ok, true)
  assert.ok(r.style_words.length >= 4)
  assert.match(r.prompt_fragment, /主色/)
  assert.equal(r.semantic_unknown, true, '没血缘就必须承认不知道画的是什么')
  assert.match(r.note, /不是"画的是什么"/)
})

test('F4 没有指纹 → 报错（不编）', () => {
  assert.equal(reversePrompt({}).ok, false)
})

// ══════ G3 引用完整性 ══════

test('G3 双向：被引用但缺失 → missing；存在但没引用 → orphan', async () => {
  const root = await tmp('game-')
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'assets', 'hero.png'), PNG)
    await writeFile(path.join(root, 'assets', 'unused.png'), PNG)
    await writeFile(path.join(root, 'src', 'main.js'), `const a = 'hero.png';\nconst b = 'ghost.png';\n`)
    const g = await buildReferenceGraph({ root })
    assert.ok(g.missing.some((m) => m.key === 'ghost'), `应报缺图：${JSON.stringify(g.missing)}`)
    assert.ok(!g.missing.some((m) => m.key === 'hero'), 'hero 存在，不该报缺')
    assert.ok(g.orphans.some((o) => o.key === 'unused'), 'unused 没被引用，应报冗余')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G3 不把工具脚本的产出名当成素材引用（实测被误报过 36 次）', async () => {
  const root = await tmp('game-')
  try {
    await mkdir(path.join(root, 'tools'), { recursive: true })
    await mkdir(path.join(root, 'src'), { recursive: true })
    // 诊断脚本里的 shot('cdpperf.png') 是它**产出**的截图，不是游戏素材
    await writeFile(path.join(root, 'tools', 'diag_perf.mjs'), `await b.shot('cdpperf.png');\nconst f = 'x.png';\n`)
    await writeFile(path.join(root, 'src', 'main.js'), `const a = 'i_skull.png';\n`)
    const g = await buildReferenceGraph({ root })
    assert.ok(!g.missing.some((m) => m.key === 'cdpperf'), 'cdpperf 是产出物，不该报缺图')
    assert.ok(!g.missing.some((m) => m.key === 'x'), 'x 是临时名，不该报缺图')
    assert.ok(g.missing.some((m) => m.key === 'i_skull'), 'i_skull 是真引用，应报缺图')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G3 排除代码标识符误匹配（window.__np.mjs 这类）', async () => {
  const root = await tmp('game-')
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.js'), `const m = 'window.__np.mjs';\nconst t = "some.thing.svg";\n`)
    const g = await buildReferenceGraph({ root })
    assert.ok(!g.missing.some((m) => m.key.includes('__np')), '不该把 __np.mjs 当素材')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G3 没有 root → 明确报错', async () => {
  assert.equal((await buildReferenceGraph({})).ok, false)
})

// ══════ G2 契约检查 ══════

test('G2 尺寸/透明不符 → 尺寸可自动转，透明缺失要人处理', async () => {
  const dir = await tmp()
  try {
    // 真实文件：512×512 且完全不透明
    const file = path.join(dir, 'icon_a.png')
    await writeFile(file, tile(512, [200, 100, 50], 255))
    const r = await checkContract({
      root: dir,
      expectations: { icon_a: { size: { width: 48, height: 48 }, transparent: true } },
      assets: [{ name: 'icon_a', file }],
    })
    assert.equal(r.mismatched.length, 1, JSON.stringify(r.results))
    assert.equal(r.mismatched[0].can_convert, true, '尺寸问题可自动转')
    assert.ok(r.mismatched[0].issues.some((i) => /尺寸/.test(i)))
    assert.ok(r.mismatched[0].issues.some((i) => /透明/.test(i)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('G2 符合规格 → ok；清单没定义 → no_spec（不是错）', async () => {
  const dir = await tmp()
  try {
    const good = path.join(dir, 'ok.png')
    await writeFile(good, tile(48, [200, 100, 50], 128))   // 48×48 且真的是半透明
    const r = await checkContract({
      root: dir,
      expectations: { ok: { size: { width: 48, height: 48 }, transparent: true } },
      assets: [{ name: 'ok', file: good }, { name: 'undefined_one', file: good }],
    })
    assert.equal(r.ok_count, 1, JSON.stringify(r.results))
    assert.equal(r.mismatched.length, 0)
    assert.equal(r.no_spec, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ G4 影响分析 ══════

test('G4 给出具体文件与行号，并评风险等级', async () => {
  const root = await tmp('game-')
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'ui.js'), `const a = "i_skull";\n`)
    await writeFile(path.join(root, 'src', 'hud.js'), `const b = "i_skull";\nconst c = "i_skull";\n`)
    const r = await analyzeImpact({ root, key: 'i_skull' })
    assert.equal(r.ok, true)
    assert.ok(r.details.length >= 3, `应找到多处引用：${JSON.stringify(r.details)}`)
    assert.ok(r.details.every((d) => d.file && d.line))
    assert.ok(['low', 'medium', 'high'].includes(r.risk))
    assert.match(r.advice, /影响/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G4 无引用 → 明说"改它不影响游戏"', async () => {
  const root = await tmp('game-')
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.js'), `const z = 1;\n`)
    const r = await analyzeImpact({ root, key: 'nobody' })
    assert.equal(r.referenced, false)
    assert.equal(r.risk, 'none')
    assert.match(r.advice, /没有被任何代码引用/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G1 预览清单：不重复实现截图，指向已有 screenshot 工具', () => {
  const c = previewChecklist({ root: 'D:/x', key: 'hero' })
  assert.ok(c.steps.some((s) => /screenshot/.test(s)))
  assert.match(c.note, /不重复实现/)
})

// ══════ H1 并发保护 ══════

test('H1 锁：被占时拒绝，释放后可获取', async () => {
  const dir = await tmp()
  try {
    const first = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'agent-a' })
    assert.equal(first.ok, true)
    const second = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'agent-b' })
    assert.equal(second.ok, false)
    assert.match(second.error, /agent-a/)
    await first.release()
    const third = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'agent-b' })
    assert.equal(third.ok, true)
    await third.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H1 僵死锁可被抢占（心跳超时）—— 不会永久卡住', async () => {
  const dir = await tmp()
  try {
    const stale = path.join(dir, 'lock-w.json')
    await writeFile(stale, JSON.stringify({ name: 'w', owner: 'dead-agent', at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), heartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString() }))
    const got = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'me' })
    assert.equal(got.ok, true, '僵死锁应能抢占')
    assert.match(got.record.note ?? '', /抢占/)
    await got.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H1 心跳：被抢走后原持有者不能"复活"锁', async () => {
  const dir = await tmp()
  try {
    const first = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'a' })
    await first.release()
    const second = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'b' })
    // a 再心跳应该失败（它已经不是持有者）
    assert.equal(await first.heartbeat(), false)
    assert.equal(await second.heartbeat(), true)
    await second.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H1 锁状态查询', async () => {
  const dir = await tmp()
  try {
    assert.equal((await lockStatus({ dataDir: dir, name: 'w' })).held, false)
    const l = await acquireResourceLock({ dataDir: dir, name: 'w', owner: 'me', reason: '写批次' })
    const s = await lockStatus({ dataDir: dir, name: 'w' })
    assert.equal(s.held, true)
    assert.equal(s.owner, 'me')
    assert.equal(s.stale, false)
    await l.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ H2 归属标注 ══════

test('H2 记录批次来源，可按文件查、按写入者汇总', async () => {
  const dir = await tmp()
  try {
    const log = await ProvenanceLog.load(dir)
    log.recordBatch({ batchId: 'b1', writer: 'r67-script', files: ['D:/out/a.png', 'D:/out/b.png'], note: '批量重制' })
    log.recordBatch({ batchId: 'b2', writer: 'dsh-gpt-image', files: ['D:/out/c.png'] })
    assert.equal(log.of('d:/out/a.png').writer, 'r67-script', '路径应归一化（大小写/斜杠）')
    assert.equal(log.of('D:\\out\\C.PNG').writer, 'dsh-gpt-image')
    const writers = log.byWriter()
    assert.equal(writers[0].writer, 'r67-script')
    assert.equal(writers[0].files, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H2 补登记：把未知来源按目录+日期聚批，并声明这是启发式', async () => {
  const dir = await tmp()
  try {
    const log = await ProvenanceLog.load(dir)
    const r = await log.backfill({
      files: [
        { file: 'D:/out/p/x_1.png', mtime: '2026-10-01T10:00:00Z' },
        { file: 'D:/out/p/x_2.png', mtime: '2026-10-01T11:00:00Z' },
        { file: 'D:/out/q/y_1.png', mtime: '2026-10-02T10:00:00Z' },
      ],
    })
    assert.equal(r.recorded, 3)
    assert.equal(r.groups, 2, '同目录同日应聚成一批')
    assert.match(r.note, /启发式|不是精确来源/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ H4 损坏检测 ══════

test('H4 文件头不对 → broken', () => {
  const r = checkPngIntegrity(Buffer.from('not a png at all'))
  assert.equal(r.ok, false)
  assert.equal(r.level, 'broken')
})

test('H4 截断（缺 IEND）→ truncated（外部脚本写一半的典型特征）', () => {
  // 正确文件头 + 一些数据，但没有 IEND
  const truncated = Buffer.concat([PNG, Buffer.alloc(100, 1)])
  const r = checkPngIntegrity(truncated)
  assert.equal(r.ok, false)
  assert.equal(r.level, 'truncated')
  assert.match(r.reason, /IEND|截断/)
})

test('H4 完整的 PNG → ok', () => {
  const good = tile(8, [255, 0, 0])
  const r = checkPngIntegrity(good)
  assert.equal(r.ok, true)
  assert.equal(r.width, 8)
})

test('H4 太小 / 空文件 → broken', () => {
  assert.equal(checkPngIntegrity(Buffer.alloc(3)).ok, false)
  assert.equal(checkPngIntegrity(null).ok, false)
})

test('H4 批量扫描：区分截断与损坏，并给处置建议', async () => {
  const dir = await tmp()
  try {
    await writeFile(path.join(dir, 'good.png'), tile(8, [1, 2, 3]))
    await writeFile(path.join(dir, 'cut.png'), Buffer.concat([PNG, Buffer.alloc(50)]))
    await writeFile(path.join(dir, 'bad.png'), Buffer.from('garbage'))
    const r = await scanCorruption({ files: [{ file: path.join(dir, 'good.png') }, { file: path.join(dir, 'cut.png') }, { file: path.join(dir, 'bad.png') }] })
    assert.equal(r.checked, 3)
    assert.equal(r.truncated.length, 1)
    assert.equal(r.broken.length, 1)
    assert.equal(r.total_bad, 2)
    assert.match(r.advice, /删掉重做|不要装进游戏/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ H3 备份 + 回滚 ══════

test('H3 备份关键状态；回滚前会先给当前状态留一份', async () => {
  const dir = await tmp()
  try {
    await writeFile(path.join(dir, 'assets.json'), JSON.stringify({ version: 1, reviews: { a: { state: 'approved' } } }))
    await writeFile(path.join(dir, 'spend.json'), JSON.stringify({ pricePerImage: 0.04 }))
    const backup = await createBackup({ dataDir: dir, label: 'v1' })
    assert.equal(backup.ok, true)
    assert.ok(backup.backed_up.includes('assets.json'))

    // 改坏
    await writeFile(path.join(dir, 'assets.json'), JSON.stringify({ version: 1, reviews: {} }))
    const restored = await restoreBackup({ dataDir: dir, id: backup.id })
    assert.equal(restored.ok, true)
    assert.ok(restored.safety_backup, '回滚前必须先备份当前状态（回错了还能回来）')
    const after = JSON.parse(await readFile(path.join(dir, 'assets.json'), 'utf8'))
    assert.ok(after.reviews.a, '应恢复到备份时的内容')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H3 列备份 / 没有任何状态文件时明确报错', async () => {
  const dir = await tmp()
  try {
    const none = await createBackup({ dataDir: dir })
    assert.equal(none.ok, false)
    assert.match(none.error, /没有任何状态文件/)

    await writeFile(path.join(dir, 'assets.json'), '{}')
    await createBackup({ dataDir: dir })
    const list = await listBackups({ dataDir: dir })
    assert.equal(list.count, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H3 只留最近 N 份，旧的自动清理', async () => {
  const dir = await tmp()
  try {
    await writeFile(path.join(dir, 'assets.json'), '{}')
    for (let i = 0; i < 4; i++) {
      await createBackup({ dataDir: dir, label: `b${i}`, keep: 2 })
    }
    const list = await listBackups({ dataDir: dir })
    assert.ok(list.count <= 2, `应只留 2 份，实际 ${list.count}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H3 回滚不存在的备份 → 报错', async () => {
  const dir = await tmp()
  try {
    assert.equal((await restoreBackup({ dataDir: dir, id: 'nope' })).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('H3 needsBackup：没备份过要备；变化少不急', () => {
  assert.equal(needsBackup({ lastBackupHash: null }).needed, true)
  assert.equal(needsBackup({ lastBackupHash: 'x', currentHash: 'x', changedCount: 5 }).needed, false)
  assert.equal(needsBackup({ lastBackupHash: 'x', currentHash: 'y', changedCount: 100 }).needed, true)
})

// ══════ I 组 可观测性 ══════

test('I1 仪表盘：审都还没审时优先提醒这一点', () => {
  const r = healthDashboard({
    scan: { tally: { total: 100, generated: 40, external: 60, approved: 0, rejected: 0, pending: 0, unreviewed: 100 }, by_kind: {} },
  })
  assert.equal(r.review_progress, 0)
  assert.match(r.advice.join(' '), /一张都没审过/)
})

test('I1 仪表盘：审完后给出驳回率与各项告警', () => {
  const r = healthDashboard({
    scan: { tally: { total: 100, generated: 50, external: 50, approved: 70, rejected: 20, pending: 10, unreviewed: 0 }, by_kind: { source: 70 } },
    paletteResult: { drift_count: 5, consistency: { average: 0.6 }, locked_palette: [1, 2, 3] },
    readabilityWarnings: 3,
    orphans: 2,
  })
  assert.equal(r.reviewed, 100)
  assert.equal(r.reject_rate, 0.2)
  assert.equal(r.style_drift, 5)
  assert.equal(r.readability_warnings, 3)
  assert.equal(r.orphans, 2)
})

test('I2 审核效率：平均耗时、吞吐、驳回原因集中度', () => {
  const r = reviewEfficiency({
    events: [
      { state: 'approved', kind: 'icon', ms: 2000 },
      { state: 'rejected', kind: 'icon', ms: 3000, note: '构图歪' },
      { state: 'rejected', kind: 'icon', ms: 4000, note: '构图歪' },
      { state: 'rejected', kind: 'card', ms: 1000, note: '配色不对' },
    ],
  })
  assert.equal(r.decisions, 4)
  assert.equal(r.average_ms, 2500)
  assert.equal(r.throughput_per_hour, 1440)
  assert.equal(r.reject_reasons[0].reason, '构图歪')
  assert.equal(r.reject_reasons[0].count, 2)
  // icon 被驳 2/3，card 1/1 → card 驳回率更高，应排前面
  assert.equal(r.by_kind[0].kind, 'card')
})

test('I2 没有审核记录 → 不编效率数字', () => {
  const r = reviewEfficiency({ events: [] })
  assert.equal(r.average_ms, null)
  assert.equal(r.advice, '还没有审核记录。')
})

test('I3 漏斗：算出每步转化，指出流失最大的一步', () => {
  const r = pipelineFunnel({ generated: 1000, reviewed: 600, approved: 200, installed: 150 })
  assert.equal(r.overall, 0.15)
  assert.equal(r.stages[1].conversion, 0.6)
  assert.ok(r.biggest_drop.drop > 0)
  assert.match(r.advice, /流失最多/)
})

test('I3 生成但一张没装机 → 直接点破', () => {
  const r = pipelineFunnel({ generated: 100, reviewed: 0, approved: 0, installed: 0 })
  assert.match(r.advice, /一张都没装机/)
})

test('I4 趋势：数据不足时说"看不出"，不硬给方向', () => {
  const r = trending({ points: [{ date: '2026-10-01', approved: 5, rejected: 5 }] })
  assert.equal(r.direction, 'unknown')
  assert.match(r.advice, /至少 4 个/)
})

test('I4 趋势：合格率上升判为 improving', () => {
  const r = trending({
    points: [
      { date: '2026-10-01', approved: 2, rejected: 8 },
      { date: '2026-10-02', approved: 3, rejected: 7 },
      { date: '2026-10-03', approved: 8, rejected: 2 },
      { date: '2026-10-04', approved: 9, rejected: 1 },
    ],
  })
  assert.equal(r.direction, 'improving')
  assert.equal(r.series.length, 4)
})

// ══════ J1 风格指南 ══════

test('J1 风格指南：从指纹统计出主色板与风格词，并可渲染 Markdown', () => {
  const items = [
    { name: 'a', size: { width: 48, height: 48 }, fingerprint: { palette: [{ hex: '#888888', share: 0.6 }, { hex: '#222222', share: 0.2 }], saturation: 0.15, edgeDensity: 0.35, ink: 0.5, alphaRatio: 0.2 } },
    { name: 'b', size: { width: 48, height: 48 }, fingerprint: { palette: [{ hex: '#888888', share: 0.5 }], saturation: 0.18, edgeDensity: 0.3, ink: 0.45, alphaRatio: 0.25 } },
  ]
  const guide = buildStyleGuide({ items, project: 'p' })
  assert.equal(guide.ok, true)
  assert.equal(guide.palette[0].hex, '#888888', '两张都有的色应排第一')
  assert.equal(guide.sizes[0].size, '48×48')
  assert.ok(guide.style_words.some((w) => /低饱和/.test(w)))
  const md = styleGuideMarkdown(guide)
  assert.match(md, /# 风格指南/)
  assert.match(md, /#888888/)
  assert.match(md, /prompt 段落/)
})

test('J1 没有素材 → 报错而不是给一页空指南', () => {
  assert.equal(buildStyleGuide({ items: [] }).ok, false)
  assert.match(styleGuideMarkdown({ ok: false }), /无数据/)
})

// ══════ J2 跨项目复用 ══════

test('J2 共享库：存取调色板/模板，可跨项目取用', async () => {
  const dir = await tmp()
  try {
    const lib = await SharedLibrary.load(dir)
    lib.savePalette({ id: 'scifi', project: 'star', palette: ['#0af', '#123'] })
    lib.saveTemplate({ id: 't1', project: 'star', template: { id: 't1', text: '{a}' } })
    assert.equal(lib.list().length, 2)
    assert.equal(lib.get('scifi').project, 'star')
    const reuse = lib.reuse({ id: 'scifi', targetProject: 'doom' })
    assert.equal(reuse.cross_project, true)
    assert.match(reuse.warning, /串味/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('J2 同项目复用不报警告', async () => {
  const dir = await tmp()
  try {
    const lib = await SharedLibrary.load(dir)
    lib.savePalette({ id: 'p', project: 'star', palette: ['#fff'] })
    const reuse = lib.reuse({ id: 'p', targetProject: 'star' })
    assert.equal(reuse.cross_project, false)
    assert.equal(reuse.warning, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('J2 非法输入被拒', async () => {
  const dir = await tmp()
  try {
    const lib = await SharedLibrary.load(dir)
    assert.equal(lib.savePalette({ id: 'x', palette: [] }).ok, false)
    assert.equal(lib.saveEntry({ id: 'y' }).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ══════ J3 风格迁移 ══════

test('J3 风格迁移保色相：红图迁移后仍是红的（不是变灰）', () => {
  const target = { pixels: new Uint8ClampedArray([200, 40, 40, 255, 120, 20, 20, 255]), width: 2, height: 1 }
  const reference = { pixels: new Uint8ClampedArray([60, 12, 12, 255, 30, 6, 6, 255]), width: 2, height: 1 }
  const r = transferStyle({ target, reference, strength: 1, keepHue: true })
  assert.equal(r.ok, true)
  // 红仍是主通道（R 明显大于 G/B）
  for (let i = 0; i < r.pixels.length; i += 4) {
    assert.ok(r.pixels[i] > r.pixels[i + 1] * 1.5, `应保色相：${r.pixels[i]},${r.pixels[i + 1]},${r.pixels[i + 2]}`)
  }
  assert.equal(r.width, 2)
})

test('J3 不保色相时压成灰（三个通道相等）', () => {
  const target = { pixels: new Uint8ClampedArray([200, 40, 40, 255]), width: 1, height: 1 }
  const reference = { pixels: new Uint8ClampedArray([100, 100, 100, 255]), width: 1, height: 1 }
  const r = transferStyle({ target, reference, strength: 1, keepHue: false })
  assert.equal(r.pixels[0], r.pixels[1])
  assert.equal(r.pixels[1], r.pixels[2])
})

test('J3 不透明像素为 0 时明确报错', () => {
  const target = { pixels: new Uint8ClampedArray([0, 0, 0, 0]), width: 1, height: 1 }
  const reference = { pixels: new Uint8ClampedArray([1, 1, 1, 255]), width: 1, height: 1 }
  assert.equal(transferStyle({ target, reference }).ok, false)
})

// ══════ J4 A/B 测试 ══════

test('J4 设计：算出每组需要的样本量，并提醒样本不够别下结论', () => {
  const r = designAbTest({ baselineRate: 0.1, minDetectableEffect: 0.02 })
  assert.equal(r.ok, true)
  assert.ok(r.per_variant > 1000, `检出 2 个百分点需要大样本，实际 ${r.per_variant}`)
  assert.match(r.note, /样本不够|别下结论/)
})

test('J4 判定：差异显著时给出赢家与提升幅度', () => {
  // A 10% (100/1000)，B 20% (200/1000) → 显著
  const r = analyzeAbTest({ a: { views: 1000, conversions: 100 }, b: { views: 1000, conversions: 200 } })
  assert.equal(r.significant, true)
  assert.equal(r.winner, 'B')
  assert.ok(r.lift > 0.9)
  assert.match(r.advice, /B 版更好/)
})

test('J4 判定：小样本差异**不该**判显著（不误导）', () => {
  const r = analyzeAbTest({ a: { views: 10, conversions: 1 }, b: { views: 10, conversions: 2 } })
  assert.equal(r.significant, false)
  assert.match(r.advice, /不显著|差不多/)
})

test('J4 判定不编造数据：views=0 直接报错', () => {
  assert.equal(analyzeAbTest({ a: { views: 0, conversions: 0 }, b: { views: 0, conversions: 0 } }).ok, false)
})

test('J4 明确声明只判显著性、不判"值不值得"', () => {
  const r = analyzeAbTest({ a: { views: 1000, conversions: 100 }, b: { views: 1000, conversions: 200 } })
  assert.match(r.honesty, /不回答|值不值得/)
})

// ══════ J5 素材图鉴 ══════

test('J5 生成自包含 HTML：含筛选、状态标签、项目分组', () => {
  const html = buildGalleryHtml({
    scan: {
      tally: { total: 3, approved: 1, rejected: 1, unreviewed: 1, external: 1 },
      files: [
        { name: 'a', project: 'p1', kind: 'source', review_state: 'approved', file: 'D:/out/p1/a.png', bytes: 10, generated: true },
        { name: 'b', project: 'p1', kind: 'slice', review_state: 'rejected', file: 'D:/out/p1/b.png', bytes: 10, generated: false },
        { name: 'c', project: 'p2', kind: 'preview', review_state: 'unreviewed', file: 'D:/out/p2/c.png', bytes: 10, generated: true },
      ],
    },
  })
  assert.match(html, /<!DOCTYPE html>/)
  assert.match(html, /素材图鉴/)
  assert.match(html, /只看合格/)
  assert.match(html, /data-review="approved"/)
  assert.match(html, /外部产物/)
  assert.match(html, /<h2>p1/)
  assert.match(html, /<h2>p2/)
})

test('J5 HTML 转义（名字里有尖括号不会破坏页面）', () => {
  const html = buildGalleryHtml({
    scan: { tally: {}, files: [{ name: '<img src=x onerror=alert(1)>', project: 'p', kind: 'source', review_state: 'unreviewed', file: 'D:/x.png', bytes: 1, generated: true }] },
  })
  assert.ok(!html.includes('<img src=x onerror'), '恶意名字必须被转义')
  assert.match(html, /&lt;img/)
})

test('J5 空素材也不报错', () => {
  const html = buildGalleryHtml({ scan: { tally: {}, files: [] } })
  assert.match(html, /没有素材/)
})
