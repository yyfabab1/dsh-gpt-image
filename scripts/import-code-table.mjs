#!/usr/bin/env node
/**
 * 把别人的「代码表」转成本插件的「引擎字段字典」（engine-schema.json）。
 *
 * 为什么需要这个脚本（而不是把代码表 vendor 进仓库）：
 *   1. 体积：真实的代码表 500KB+，进仓库不合适；
 *   2. 许可：那是别人从官方 xlsx 整理的成果，直接抄进来既不合规也不体面；
 *   3. 版本漂移：游戏一更新代码表就变，vendored 副本立刻过期，还看不出来。
 *
 * 所以正确做法是：**数据你自己从官方代码表导入，我们只提供格式与工具**。
 * 这个脚本就是那条"导入通道"——社区（如 RustedWarfareCodingTool）已经有人做好了
 * xlsx → JSON 的转换，你拿它的 code_table.json 喂给本脚本即可。
 *
 * 用法：
 *   node scripts/import-code-table.mjs <code_table.json> [选项]
 *
 * 选项：
 *   --id <名字>        字典 id（默认取文件名）
 *   --label <显示名>   中文显示名
 *   --out <路径>       输出文件（默认 <数据目录>/engine-schemas/<id>.json）
 *   --data-dir <目录>  数据目录（默认 ~/.dsh/gpt-image）
 *
 * 例子：
 *   node scripts/import-code-table.mjs D:\code_table.json --id rusted-warfare --label "铁锈战争 v1.15"
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { schemaFromCodeTable, validateSchema } from '../lib/adapter.js'

function parseArgs(argv) {
  const out = { file: '', id: '', label: '', out: '', dataDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--id') out.id = argv[++i] ?? ''
    else if (arg === '--label') out.label = argv[++i] ?? ''
    else if (arg === '--out') out.out = argv[++i] ?? ''
    else if (arg === '--data-dir') out.dataDir = argv[++i] ?? ''
    else if (!arg.startsWith('--') && !out.file) out.file = arg
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.file) {
  console.error('用法: node scripts/import-code-table.mjs <code_table.json> [--id 名字] [--label 显示名] [--out 输出路径]')
  process.exit(2)
}

const dataDir = args.dataDir || path.join(os.homedir(), '.dsh', 'gpt-image')
const id = (args.id || path.basename(args.file, path.extname(args.file))).replace(/[^\w.-]+/g, '_')
const target = args.out || path.join(dataDir, 'engine-schemas', `${id}.json`)

let raw
try {
  raw = JSON.parse(await readFile(args.file, 'utf8'))
} catch (error) {
  console.error(`读不到或不是合法 JSON：${args.file}\n${error.message}`)
  process.exit(1)
}

const converted = schemaFromCodeTable(raw, { id, label: args.label })
if (!converted.ok) {
  console.error(`转换失败：${converted.error}`)
  console.error('提示：这个脚本吃的是「段 → 分组 → 字段」结构的代码表（含 sections/groups/entries 或 fields）。')
  process.exit(1)
}

const check = validateSchema(converted.schema)
if (!check.ok) {
  console.error('转换出来的字典没通过自校验：')
  for (const error of check.errors) console.error('  X ' + error)
  process.exit(1)
}

await mkdir(path.dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(converted.schema, null, 2)}\n`, 'utf8')

const s = converted.schema
console.log('✓ 导入完成')
console.log(`  字典 id   : ${s.id}${s.label ? `（${s.label}）` : ''}`)
console.log(`  段 / 字段 : ${converted.stats.sections} / ${converted.stats.fields}`)
console.log(`  枚举      : ${converted.stats.enums}`)
console.log(`  取值词表  : ${converted.stats.blocks}`)
console.log(`  内置素材  : ${converted.stats.builtInAssets}（体检时当白名单，不报"缺失"）`)
if (check.warnings.length > 0) {
  console.log(`  警告      : ${check.warnings.length} 条（前 3 条）`)
  for (const warn of check.warnings.slice(0, 3)) console.log('    ! ' + warn)
}
console.log(`  写入      : ${target}`)
console.log('')
console.log('接下来：')
console.log(`  adapter(action="schema", schema_id="${s.id}")                        # 看结构`)
console.log(`  adapter(action="schema", schema_id="${s.id}", section="${s.sections[0]?.id ?? 'core'}") # 看某段字段`)
console.log(`  adapter(action="emit",   schema_id="${s.id}", values={...})          # 生成配置`)
console.log(`  adapter(action="lint",   schema_id="${s.id}", file="D:\\\\...\\\\x.ini") # 诊断`)
console.log(`  adapter(action="health", schema_id="${s.id}", game_root="D:\\\\...\\\\mod") # 素材体检`)
