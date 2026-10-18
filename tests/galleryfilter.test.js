/**
 * 分类栏过滤测试。
 *
 * 这个 bug（「点项目分类，下面还是全部图」）以前没有任何测试能发现，
 * 因为它藏在浏览器端 bundle 里。抽成纯函数后在这里钉住行为。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { filterByProject, filterByVerdict, projectKey, projectList, projectOf, projectStats, primaryFileOf, verdictCounts } from '../lib/galleryfilter.js'

const records = [
  { id: '1', project: 'agnes接入验证', name: 'a1', kind: 'generate', ts: '2026-10-03T00:10:00Z' },
  { id: '2', project: 'agnes接入验证', name: 'a2', kind: 'edit', ts: '2026-10-03T00:14:00Z' },
  { id: '3', project: 'demo', name: 'd1', kind: 'generate', ts: '2026-10-02T23:00:00Z' },
  { id: '4', name: 'legacy', kind: 'generate', ts: '2026-10-01T00:00:00Z' },
]

test('选中项目后只显示该项目的图（回归：以前会全部显示）', () => {
  const shown = filterByProject(records, 'agnes接入验证')
  assert.equal(shown.length, 2)
  assert.deepEqual(shown.map((r) => r.id), ['1', '2'])
})

test('空项目 = 不过滤，显示全部', () => {
  assert.equal(filterByProject(records, '').length, 4)
  assert.equal(filterByProject(records, undefined).length, 4)
  assert.equal(filterByProject(records, null).length, 4)
})

test('切到另一个项目会换成另一批图', () => {
  const demo = filterByProject(records, 'demo')
  assert.equal(demo.length, 1)
  assert.equal(demo[0].id, '3')
})

test('项目名忽略大小写与首尾空白（避免看起来有两个项目）', () => {
  const mixed = [{ project: 'Demo' }, { project: ' demo ' }, { project: 'DEMO' }]
  assert.equal(filterByProject(mixed, 'demo').length, 3)
  assert.equal(projectKey('  DeMo '), 'demo')
})

test('没有 project 字段的历史记录归到 images，不会凭空消失', () => {
  assert.equal(projectOf({ name: 'x' }), 'images')
  assert.equal(filterByProject(records, 'images').length, 1)
  assert.equal(filterByProject(records, 'images')[0].id, '4')
})

test('选了一个不存在的项目 → 空列表（页面会提示，而不是显示全部）', () => {
  assert.deepEqual(filterByProject(records, '不存在'), [])
})

test('入参不是数组时不炸', () => {
  assert.deepEqual(filterByProject(null, 'demo'), [])
  assert.deepEqual(filterByProject(undefined, ''), [])
})

test('projectStats：数量 / 最新时间 / 最近素材名 / 类型', () => {
  const stats = projectStats(records)
  assert.equal(stats['agnes接入验证'].count, 2)
  assert.equal(stats['agnes接入验证'].latest, '2026-10-03T00:14:00Z')
  assert.deepEqual(stats['agnes接入验证'].names, ['a1', 'a2'])
  assert.deepEqual(stats['agnes接入验证'].kinds.sort(), ['edit', 'generate'])
  assert.equal(stats.demo.count, 1)
})

test('projectStats 的 names 最多 3 个', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ project: 'p', name: `n${i}` }))
  assert.equal(projectStats(many).p.names.length, 3)
})

test('projectList：去重 + 排序，且包含没有 project 的兜底项目', () => {
  const list = projectList(records)
  assert.equal(new Set(list).size, list.length, '不能有重复')
  assert.ok(list.includes('agnes接入验证'))
  assert.ok(list.includes('demo'))
  assert.ok(list.includes('images'))
})

test('分类栏的各项目数量加起来等于总数（不会漏也不会重）', () => {
  const stats = projectStats(records)
  const sum = Object.values(stats).reduce((acc, item) => acc + item.count, 0)
  assert.equal(sum, records.length)
})

// ---- 服务端 /api/check 的契约：分类栏能不能渲染，取决于这两个字段在不在 ----

test('projectSummaries 给出每个项目的卡片数据（未选项目时也要有）', async () => {
  const { projectSummaries } = await import('../lib/server.js')
  const rows = [
    { project: 'a', name: 'a1', status: 'ok', ts: '2026-10-03T00:00:00Z', labeled: ['x'] },
    { project: 'a', name: 'a2', status: 'failed', ts: '2026-10-03T01:00:00Z' },
    { project: 'b', name: 'b1', status: 'ok', ts: '2026-10-02T00:00:00Z' },
  ]
  const sums = projectSummaries(rows)
  assert.deepEqual(Object.keys(sums).sort(), ['a', 'b'])
  assert.equal(sums.a.count, 2)
  assert.equal(sums.a.ok, 1)
  assert.equal(sums.a.failed, 1)
  assert.equal(sums.a.labeled, 1, 'labeled 应按有预览图的条数算')
  assert.equal(sums.a.latest, '2026-10-03T01:00:00Z')
  assert.equal(sums.b.count, 1)
})

test('projectSummaries 对空输入返回空对象，不炸', async () => {
  const { projectSummaries } = await import('../lib/server.js')
  assert.deepEqual(projectSummaries([]), {})
  assert.deepEqual(projectSummaries(undefined), {})
})

test('/api/check 未选项目时也必须返回 projects 与 project_summaries（否则分类栏是空的）', async () => {
  // 直接读源码做契约检查：这两个字段一旦被删掉，分类栏就会「只剩全部」。
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/server.js', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("sub === '/api/check'"))
  const noProject = branch.slice(branch.indexOf('还没选项目'))
  // 未选项目分支的返回体里必须有这两个字段
  const header = branch.slice(0, noProject.length + 600)
  assert.ok(header.includes('projects,'), '未选项目分支必须返回 projects')
  assert.ok(header.includes('project_summaries:'), '未选项目分支必须返回 project_summaries')
  assert.ok(header.includes("project: ''"), '未选项目分支应显式返回 project: \'\'，前端才能判断"无选中"')
})

// ---- 结论过滤（核对栏第二排） ----

test('按结论过滤：只看「用不上」的图', () => {
  const rows = [
    { id: '1', files: ['D:\\out\\a\\x_1.png'] },
    { id: '2', files: ['D:\\out\\a\\y_1.png'] },
  ]
  const check = {
    'D:/out/a/x_1.png': { verdict: 'broken' },
    'D:/out/a/y_1.png': { verdict: 'ok' },
  }
  const broken = filterByVerdict(rows, check, 'broken')
  assert.equal(broken.length, 1)
  assert.equal(broken[0].id, '1')
  assert.equal(filterByVerdict(rows, check, '').length, 2, '空结论 = 不过滤')
})

test('没有核对结果的图不会被任何一个结论匹配到（不会误显示）', () => {
  const rows = [{ id: '1', files: ['D:\\out\\a\\x_1.png'] }]
  assert.equal(filterByVerdict(rows, {}, 'ok').length, 0)
  assert.equal(filterByVerdict(rows, {}, 'broken').length, 0)
})

test('Windows 反斜杠与正斜杠路径都能对上', () => {
  const rows = [{ id: '1', files: ['D:\\out\\a\\x_1.png'] }]
  assert.equal(primaryFileOf(rows[0]), 'D:/out/a/x_1.png')
  assert.equal(filterByVerdict(rows, { 'D:/out/a/x_1.png': { verdict: 'ok' } }, 'ok').length, 1)
})

test('verdictCounts 统计各结论张数', () => {
  const counts = verdictCounts([
    { verdict: 'ok' }, { verdict: 'ok' }, { verdict: 'broken' }, {}, { verdict: undefined },
  ])
  assert.equal(counts.ok, 2)
  assert.equal(counts.broken, 1)
  assert.equal(Object.keys(counts).length, 2, '空的 verdict 不该被计数')
})

test('项目过滤 + 结论过滤可以叠加', () => {
  const rows = [
    { id: '1', project: 'a', files: ['x_1.png'] },
    { id: '2', project: 'a', files: ['y_1.png'] },
    { id: '3', project: 'b', files: ['z_1.png'] },
  ]
  const check = { 'x_1.png': { verdict: 'broken' }, 'y_1.png': { verdict: 'ok' }, 'z_1.png': { verdict: 'broken' } }
  const scoped = filterByProject(rows, 'a')
  assert.equal(scoped.length, 2)
  const both = filterByVerdict(scoped, check, 'broken')
  assert.equal(both.length, 1, '项目 a 里只有 1 张 broken（b 项目的那张不该混进来）')
  assert.equal(both[0].id, '1')
})
