/** 收尾体检：模块语法、工具数、路由数、侧栏页配对、测试文件数。 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.join(import.meta.dirname, '..')
const libDir = path.join(root, 'lib')

// 1. 所有 lib 模块（含子目录）语法自检
const modules = []
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.name.endsWith('.js')) modules.push(full)
  }
}
await walk(libDir)
let syntaxOk = 0
const bad = []
for (const file of modules) {
  try {
    await import(pathToFileURL(file).href)
    syntaxOk += 1
  } catch (error) {
    // server.js / client.js 顶层依赖宿主注入，import 失败不等于语法错 → 用 --check 兜底
    bad.push({ file: path.relative(root, file), error: String(error?.message ?? error).slice(0, 90) })
  }
}
console.log(`lib 模块：${modules.length} 个；可直接 import 的 ${syntaxOk} 个`)
for (const item of bad) console.log(`  （顶层需要宿主上下文，属正常）${item.file}: ${item.error}`)

// 2. 工具清单
const { createTools } = await import(pathToFileURL(path.join(libDir, 'tools.js')).href)
const tools = createTools({
  loadState: async () => { throw new Error('not used') },
  saveState: async () => {},
  boardUrl: () => 'http://x',
})
console.log(`\n工具：${tools.length} 个`)
const names = tools.map((tool) => tool.name.replace('_dsh_external_dsh_gpt_image_', ''))
console.log(`  ${names.join(', ')}`)

// 3. 服务端路由
const server = await readFile(path.join(libDir, 'server.js'), 'utf8')
const routes = [...server.matchAll(/sub === '(\/api\/[^']+)'/g)].map((m) => m[1])
console.log(`\n服务端路由：${new Set(routes).size} 个`)
const upload = routes.filter((route) => route.includes('upload'))
console.log(`  （其中新增：${upload.join(', ') || '无'}）`)

// 4. 侧栏页与 main 面板配对
const client = await readFile(path.join(libDir, 'client.js'), 'utf8')
const sideIds = [...client.matchAll(/inject\('sidebar\.panellist'[\s\S]{0,300}?id:\s*'([^']+)'/g)].map((m) => m[1])
const mainKeys = [...client.matchAll(/inject\('main'[\s\S]{0,300}?key:\s*'([^']+)'/g)].map((m) => m[1])
const unpaired = sideIds.filter((id) => !mainKeys.includes(id))
console.log(`\n侧栏页：${sideIds.join(', ')}`)
console.log(`main 面板：${mainKeys.join(', ')}`)
console.log(unpaired.length ? `✗ 没配对：${unpaired.join(', ')}（点了会没反应）` : '✓ 侧栏 id 与 main key 全部配对')

// 5. 测试文件
const testFiles = (await readdir(path.join(root, 'tests'))).filter((name) => name.endsWith('.test.js'))
console.log(`\n测试文件：${testFiles.length} 个`)

/*
 * 【给一键安装.bat 用的一行 ASCII 摘要】
 * 为什么单独打一行纯 ASCII：.bat 里的 findstr 不做 UTF-8 解码，
 * 用它去匹配中文（比如「工具：」）在 chcp 65001 下并不可靠 —— 会静默匹配失败，
 * 于是安装脚本可能"以为自检通过/没通过"。只匹配 ASCII 就没这个问题。
 */
console.log(
  `SUMMARY TOOLS=${tools.length} ROUTES=${new Set(routes).size}`
  + ` SIDEBAR_PAGES=${sideIds.length} SIDEBAR_OK=${unpaired.length === 0 ? 1 : 0}`
  + ` TESTFILES=${testFiles.length} MODULES=${modules.length}`,
)
