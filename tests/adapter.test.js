/**
 * 引擎适配层测试。
 *
 * 这一层的价值全在「**少误报**」上 —— 一个动不动就报错的校验器会被用户直接关掉，
 * 那它就等于不存在。所以测试的重点不是"能查出多少错"，而是三件事：
 *   ① 该报的错真的报（带稳定错误码）
 *   ② **真实存在的写法不该报**（不误报清单生效）
 *   ③ 生成出来的东西自己是干净的（自己产的东西先自己体检）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeSchema, validateSchema, fieldIndex, describeSchema, emitConfig, lintConfig,
  parseIni, healthCheck, deployFiles, schemaFromCodeTable, DIAGNOSTICS, SCHEMA_VERSION,
} from '../lib/adapter.js'

/** 一份小而完整的测试字典：两个段、一个枚举、引用规则、不误报清单。 */
function testSchema() {
  return {
    id: 'demo',
    label: '演示引擎',
    format: 'ini',
    separator: ':',
    sections: [
      {
        id: 'core',
        title: '核心',
        required: true,
        groups: [{
          name: '通用',
          fields: [
            { code: 'name', title: '名字', type: 'string', required: true, example: 'tank1' },
            { code: 'maxHp', title: '生命值', type: 'float', min: 0, max: 100000, example: '200' },
            { code: 'count', title: '数量', type: 'integer', min: 0, max: 100 },
            { code: 'showInEditor', title: '显示', type: 'bool' },
            { code: 'tint', title: '染色', type: 'color' },
            { code: 'projectile', title: '抛射体', type: 'string' },
          ],
        }],
      },
      {
        id: 'attack',
        title: '攻击',
        groups: [{
          name: '',
          fields: [
            { code: 'maxAttackRange', title: '射程', type: 'float', min: 0 },
            { code: 'explosionEffect', title: '爆炸效果', type: 'enum', enum: 'explosionEffect' },
          ],
        }],
      },
      { id: 'projectile_1', title: '抛射体1', groups: [{ name: '', fields: [{ code: 'damage', title: '伤害', type: 'float' }] }] },
    ],
    enums: {
      explosionEffect: [{ v: 'none', t: '无' }, { v: 'small', t: '小' }, { v: 'large', t: '大' }],
    },
    references: [
      { from: { field: 'projectile' }, to: { prefix: 'projectile_', field: 'id' }, message: '抛射体引用' },
    ],
    tolerant: ['${', 'self.', 'max(', 'delay:'],
  }
}

/* ---------------- schema ---------------- */

test('normalizeSchema：脏输入不抛异常，缺字段补默认', () => {
  assert.equal(normalizeSchema(null).format, 'ini')
  assert.equal(normalizeSchema('x').sections.length, 0)
  const s = normalizeSchema({
    id: 'a', format: '乱七八糟', sections: [
      { id: '[core]', groups: [{ entries: [{ code: 'x', vtype: 'integer' }] }] },
      { title: '没有 id 的段' },
    ],
    enums: { e: ['a', 'b'] },
  })
  assert.equal(s.format, 'ini', '非法 format 回退 ini')
  assert.equal(s.sections[0].id, 'core', '段名的中括号要去掉')
  assert.equal(s.sections.length, 1, '没有 id 的段要丢掉')
  assert.equal(s.sections[0].groups[0].fields[0].type, 'integer')
  assert.deepEqual(s.enums.e.map((x) => x.v), ['a', 'b'], '字符串枚举要规范化成 {v,t}')
})

test('validateSchema：能抓出结构问题，但**同段字段重复只算警告**', () => {
  // 真实代码表里同段重复字段很常见（同一键在不同分组下各列一遍），当错误报是误报
  const dup = testSchema()
  dup.sections[0].groups.push({ name: 'again', fields: [{ code: 'name', title: '再来一次', type: 'string' }] })
  const check = validateSchema(dup)
  assert.equal(check.ok, true, '重复字段不该阻断')
  assert.ok(check.warnings.some((w) => w.includes('重复')), JSON.stringify(check.warnings))

  const broken = testSchema()
  broken.sections.push({ id: 'core', groups: [{ name: '', fields: [{ code: 'y', type: 'string' }] }] })
  assert.ok(validateSchema(broken).errors.some((e) => e.includes('段重名')))

  const badEnum = testSchema()
  badEnum.sections[1].groups[0].fields[1].enum = '不存在的枚举'
  assert.ok(validateSchema(badEnum).warnings.some((w) => w.includes('不存在的枚举')))

  const badRange = testSchema()
  badRange.sections[0].groups[0].fields[1].min = 100
  badRange.sections[0].groups[0].fields[1].max = 1
  assert.ok(validateSchema(badRange).errors.some((e) => e.includes('min > max')))
})

test('describeSchema：概览 + 单段字段（给 AI 看的东西不能是 500KB 原始字典）', () => {
  const s = testSchema()
  const overview = describeSchema(s)
  assert.equal(overview.ok, true)
  assert.equal(overview.sections.length, 3)
  assert.deepEqual(overview.enums, ['explosionEffect'])
  assert.ok(JSON.stringify(overview).length < 3000, '概览必须小到能塞进模型上下文')

  const core = describeSchema(s, { section: 'core' })
  assert.equal(core.ok, true)
  assert.equal(core.fields.length, 6)
  const maxHp = core.fields.find((f) => f.code === 'maxHp')
  assert.equal(maxHp.type, 'float')
  assert.deepEqual(maxHp.range, [0, 100000])

  const attack = describeSchema(s, { section: 'attack' })
  assert.deepEqual(attack.fields.find((f) => f.code === 'explosionEffect').options, ['none', 'small', 'large'])

  const missing = describeSchema(s, { section: '不存在' })
  assert.equal(missing.ok, false)
  assert.ok(missing.sections.includes('core'))
})

test('fieldIndex：段名 → 拍平的字段数组', () => {
  const index = fieldIndex(testSchema())
  assert.ok(index.has('core'))
  assert.equal(index.get('core').fields.length, 6)
  assert.equal(index.get('projectile_1').fields[0].code, 'damage')
})

/* ---------------- 生成 ---------------- */

test('emitConfig：按字典顺序输出 + 类型强制 + 中文布尔/数字都能吃', () => {
  const r = emitConfig({
    schema: testSchema(),
    title: '测试单位',
    values: {
      core: { showInEditor: '是', maxHp: '两百五', count: 3.7, name: 'tank1', tint: '#FF0000' },
    },
  })
  assert.equal(r.ok, true)
  assert.match(r.text, /^# 测试单位/, '标题要写成注释')
  assert.match(r.text, /showInEditor: true/, '中文「是」要转成 true')
  assert.equal(r.coerced.length, 3, '「是」→true、「两百五」→0、3.7→4 都该被记进 coerced')
  // 字段按**字典顺序**输出（比用户给值的顺序稳定，diff 更友好）
  const order = ['name', 'maxHp', 'count', 'showInEditor', 'tint'].map((k) => r.text.indexOf(`${k}:`))
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], '字段顺序应按字典')
  // 数字非法 → 0 并警告
  const bad = emitConfig({ schema: testSchema(), values: { core: { maxHp: '很多' } } })
  assert.match(bad.text, /maxHp: 0/)
  assert.ok(bad.warnings.some((w) => w.includes('不是数字')))
})

test('emitConfig：枚举非法 → 退回第一个可用值并警告（不让人拿到一个引擎不认的值）', () => {
  const r = emitConfig({ schema: testSchema(), values: { attack: { explosionEffect: '不存在' } } })
  assert.match(r.text, /explosionEffect: none/, '要退回枚举第一个值')
  assert.ok(r.warnings.some((w) => w.includes('不在枚举')))
})

test('emitConfig：数值越界被夹住并说明（默默改掉是最坏的做法）', () => {
  const r = emitConfig({ schema: testSchema(), values: { core: { count: 999 } } })
  assert.match(r.text, /count: 100/, '要夹到 max=100')
  assert.ok(r.warnings.some((w) => w.includes('上限')), JSON.stringify(r.warnings))
})

test('emitConfig：字典外的键**保留**（引擎允许自定义键，丢了就是数据损坏）', () => {
  const r = emitConfig({ schema: testSchema(), values: { core: { name: 'a', 自定义键: '值' } } })
  assert.match(r.text, /自定义键: 值/)
  assert.ok(r.warnings.some((w) => w.includes('自定义键')))
})

test('emitConfig：缺必需段/必填字段要在生成阶段就提醒', () => {
  const r = emitConfig({ schema: testSchema(), values: { attack: {} } })
  assert.ok(r.warnings.some((w) => w.includes('必需段')), JSON.stringify(r.warnings))
})

test('emitConfig：json 格式走 JSON 输出', () => {
  const schema = { ...testSchema(), format: 'json' }
  const r = emitConfig({ schema, values: { core: { name: 'a', maxHp: 5 } } })
  const parsed = JSON.parse(r.text)
  assert.equal(parsed.core.name, 'a')
  assert.equal(parsed.core.maxHp, '5')
})

test('emitConfig：**自己生成的东西自己是干净的**（自产自检）', () => {
  const schema = testSchema()
  const r = emitConfig({
    schema,
    values: {
      core: { name: 'tank1', maxHp: 200, count: 1, showInEditor: true, tint: '#AABBCC', projectile: '1' },
      attack: { maxAttackRange: 160, explosionEffect: 'small' },
      projectile_1: { damage: 30 },
    },
  })
  const lint = lintConfig({ schema, text: r.text })
  assert.equal(lint.counts.error, 0, `生成器自己产出了错误：${JSON.stringify(lint.issues)}`)
})

/* ---------------- 诊断 ---------------- */

test('parseIni：解析段/键值/中文冒号，指令行和注释跳过', () => {
  const p = parseIni([
    '# 注释',
    '// 也是注释',
    '@memory something',
    '[core]',
    'name: tank',
    'name：中文冒号',
    '  空行上面有空行  ',
    '[attack]',
    'maxAttackRange: 100',
  ].join('\n'))
  assert.equal(p.sections.length, 2)
  assert.equal(p.sections[0].entries.length, 2)
  assert.equal(p.sections[0].entries[0].cjkColon, false)
  assert.equal(p.sections[0].entries[1].cjkColon, true, '中文冒号要识别出来（第一版这里漏报过）')
  assert.equal(p.syntax.length, 1)
})

test('lintConfig：该报的错都报，且每个都带**稳定错误码**', () => {
  const text = [
    '[core]',              // 1
    'name：坏坦克',         // 2 E007 中文冒号
    'maxHp: 很多',          // 3 E004 类型不对
    'showInEditor: 是的',   // 4 E004 布尔不对
    'maxHp: 300',          // 5 E009 重复键
    '[core]',              // 6 E010 重复段
    '[attack]',
    'explosionEffect: 不存在', // 8 E006 枚举
    'projectile: 9',       // 9 E011 悬空引用
    '[core]',
    'count: 999',          // 11 E005 越界
    'tint: red',           // 12 E012 颜色
    '[core]',
    'maxAttackRange: 100', // 14 E013 放错段
    '这一行没有冒号',        // 15 E014 语法
  ].join('\n')
  const r = lintConfig({ schema: testSchema(), text })
  const codes = new Set(r.issues.map((i) => i.code))
  for (const expected of ['E007', 'E004', 'E009', 'E010', 'E006', 'E011', 'E005', 'E012', 'E013', 'E014']) {
    assert.ok(codes.has(expected), `应报 ${expected}（${DIAGNOSTICS[expected]?.title}），实际只有 ${[...codes].join(',')}`)
  }
  assert.equal(r.ok, false)
  // 每条都要能查回码表（有说明和修法）
  for (const issue of r.issues) {
    assert.ok(DIAGNOSTICS[issue.code], `${issue.code} 不在码表里`)
    assert.ok(issue.message.length > 0)
  }
})

test('lintConfig：**不误报清单生效** —— 表达式、变量、脚本调用不该被当类型错误', () => {
  const text = [
    '[core]',
    'maxHp: ${self.maxHp * 1.5}',      // 表达式
    'count: max(0, sin(3))',           // 函数调用
    'tint: self.tint',                 // 变量引用
  ].join('\n')
  const r = lintConfig({ schema: testSchema(), text })
  assert.equal(r.counts.error, 0, `不误报清单没生效：${JSON.stringify(r.issues)}`)
})

test('lintConfig：干净的配置一条都不报（误报率是这个功能的命门）', () => {
  const text = [
    '[core]',
    'name: tank1',
    'maxHp: 200',
    'count: 2',
    'showInEditor: true',
    'tint: #AABBCC',
    'projectile: 1',
    '[attack]',
    'maxAttackRange: 160',
    'explosionEffect: small',
    '[projectile_1]',
    'damage: 30',
  ].join('\n')
  const r = lintConfig({ schema: testSchema(), text })
  assert.equal(r.issues.length, 0, `干净的配置被误报：${JSON.stringify(r.issues)}`)
  assert.equal(r.ok, true)
  assert.equal(r.parsed.sections, 3)
})

test('lintConfig：未知键只警告不阻断（引擎允许自定义段和键）', () => {
  const r = lintConfig({ schema: testSchema(), text: '[core]\nname: a\n随便一个键: 1\n' })
  assert.equal(r.ok, true, '未知键不该阻断')
  assert.ok(r.issues.some((i) => i.code === 'E003' && i.severity === 'warn'))
})

test('lintConfig：字典为空时只做语法检查（不能因为没字典就崩）', () => {
  const r = lintConfig({ schema: null, text: '[core]\nname: a\n' })
  assert.equal(r.ok, true)
  const bad = lintConfig({ schema: null, text: '这行没有冒号\n' })
  assert.ok(bad.issues.some((i) => i.code === 'E014'))
})

/* ---------------- 体检 ---------------- */

test('healthCheck：找出"从没被引用的素材"和"引用了但文件不存在"', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-health-'))
  try {
    await mkdir(path.join(dir, 'units'), { recursive: true })
    await writeFile(path.join(dir, 'units', 'used.png'), Buffer.alloc(100))
    await writeFile(path.join(dir, 'units', 'unused.png'), Buffer.alloc(5000))
    await writeFile(path.join(dir, 'units', 'tank.ini'), [
      '[core]',
      'name: tank',
      'image: used.png',
      'sound: ghost.ogg',      // 这个文件不存在
      'image2: beam1.png',      // 引擎内置 → 不该报缺失
    ].join('\n'))
    const r = await healthCheck({ gameRoot: dir, schema: { builtInAssets: ['beam1.png'] } })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.scanned.assets, 2)
    const unused = r.unreferenced.map((x) => x.name)
    assert.deepEqual(unused, ['unused.png'], `未引用素材应是 unused.png，实际 ${unused}`)
    assert.equal(r.wasted_bytes, 5000)
    const missing = r.missing.map((x) => x.name)
    assert.ok(missing.includes('ghost.ogg'), `应报 ghost.ogg 缺失，实际 ${missing}`)
    assert.ok(!missing.includes('beam1.png'), '引擎内置素材不该报缺失（否则满屏假警报）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('healthCheck：目录不存在时给明确错误', async () => {
  const r = await healthCheck({ gameRoot: path.join(os.tmpdir(), '绝对不存在_' + Date.now()) })
  assert.equal(r.ok, false)
  assert.match(r.error, /不是目录/)
})

/* ---------------- 部署 ---------------- */

test('deployFiles：默认 dry-run 不写盘；真写时覆盖会留备份', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-deploy-'))
  try {
    const target = path.join(dir, 'units', 'tank.ini')
    const files = [{ name: 'tank.ini', subdir: 'units', content: '[core]\nname: new\n' }]

    const plan = await deployFiles({ files, gameRoot: dir })
    assert.equal(plan.dry_run, true)
    assert.equal(plan.plan[0].exists, false)
    await assert.rejects(readFile(target), 'dry-run 不能真写')

    await deployFiles({ files, gameRoot: dir, dryRun: false })
    assert.equal((await readFile(target, 'utf8')), '[core]\nname: new\n')

    const again = await deployFiles({ files: [{ name: 'tank.ini', subdir: 'units', content: '[core]\nname: v2\n' }], gameRoot: dir, dryRun: false })
    assert.equal(again.written[0].backed_up, true)
    const names = await readdir(path.join(dir, 'units'))
    assert.ok(names.includes('tank.ini.bak-before-deploy'), `要留备份，实际 ${names}`)
    assert.equal(await readFile(target, 'utf8'), '[core]\nname: v2\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------- 代码表导入 ---------------- */

test('schemaFromCodeTable：能吃「段→分组→字段」的代码表，并把内置素材拎成白名单', () => {
  const codeTable = {
    version: [1],
    sections: [
      {
        id: 'core', title: '核心',
        groups: [{ name: '通用', entries: [
          { code: 'name', trans: '名字', vtype: 'string', ex: 'tank1' },
          { code: 'maxHp', trans: '生命值', vtype: 'float' },
          { code: 'explosionEffect', trans: '爆炸', vtype: 'explosionEffect' },
          { code: 'autoTriggerCheckRate', trans: '检查频率', vtype: 'enum' },  // 没给枚举名 → 退回 string
        ] }],
      },
    ],
    enums: { explosionEffect: { title: '爆炸', items: [{ v: 'none', t: '无' }] } },
    reference_blocks: [
      { title: '代码可用内置图像', items: [{ v: 'beam1.png', t: '光束' }, { v: 'blank.png', t: '空白' }] },
      { title: '内置爆炸效果', items: [{ v: 'none', t: '无' }] },
    ],
  }
  const conv = schemaFromCodeTable(codeTable, { id: 't', label: '测试' })
  assert.equal(conv.ok, true, conv.error)
  const s = conv.schema
  assert.equal(s.sections.length, 1)
  const fields = s.sections[0].groups[0].fields
  assert.equal(fields.find((f) => f.code === 'explosionEffect').type, 'enum')
  assert.equal(fields.find((f) => f.code === 'explosionEffect').enum, 'explosionEffect')
  assert.equal(fields.find((f) => f.code === 'autoTriggerCheckRate').type, 'string', 'vtype=enum 但没枚举名 → 退回 string（否则产生假警告）')
  assert.deepEqual(s.builtInAssets, ['beam1.png', 'blank.png'])
  assert.ok((s.blocks ?? []).length >= 2, '取值词表要保留（当枚举用）')
  assert.ok(conv.stats.sections >= 1)
})

test('schemaFromCodeTable：结构对不上时明确报错，不像素级解析就崩', () => {
  assert.equal(schemaFromCodeTable(null).ok, false)
  assert.equal(schemaFromCodeTable({}).ok, false)
  assert.equal(schemaFromCodeTable({ sections: [] }).ok, false)
  const ok = schemaFromCodeTable({ sections: [{ id: 's', groups: [{ entries: [{ code: 'x' }] }] }] })
  assert.equal(ok.ok, true)
})

test('DIAGNOSTICS：码表稳定 —— 编号不跳、每项都有说明和修法', () => {
  const codes = Object.keys(DIAGNOSTICS)
  assert.ok(codes.length >= 14)
  for (const code of codes) {
    assert.match(code, /^E\d{3}$/, `错误码格式应是 E001：${code}`)
    const def = DIAGNOSTICS[code]
    assert.ok(def.title, `${code} 缺 title`)
    assert.ok(['error', 'warn'].includes(def.severity), `${code} 的 severity 不合法`)
    assert.ok(def.fix !== undefined, `${code} 缺修法`)
  }
  assert.equal(SCHEMA_VERSION, 1)
})
