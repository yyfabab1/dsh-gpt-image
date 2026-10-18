#!/usr/bin/env node
/**
 * 生成 DSH 商店索引（market-index.json，format 1）。
 *
 * 为什么要这个脚本（而不是手写 JSON）：
 *   商店索引是**带严格校验**的格式 —— `versions[].source.type` 只能是 npm/git，
 *   git 要求**完整的 40 位 commit SHA**，`publishTimestamp` 必须是整数秒，
 *   `metadata.category` 必须先在 `metadata.categories` 里声明过，否则整份索引被拒。
 *   手写这些字段极易出错，而且错了在客户端只会看到"索引无效"，不知道为什么。
 *
 * 所以：脚本生成 + **用 DSH 自己的解析器校验**，校验不过就不写盘。
 *
 * 用法：
 *   node scripts/make-market-index.mjs                  # 用当前 HEAD 的提交号
 *   node scripts/make-market-index.mjs <40位commit>      # 指定提交
 *   node scripts/make-market-index.mjs --check           # 只校验已有的 market-index.json
 */
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = path.join(ROOT, 'market-index.json')

const [, , arg1] = process.argv
const checkOnly = arg1 === '--check'

/** 读当前仓库的 HEAD 提交（索引里必须写完整 40 位）。 */
async function headCommit() {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
  return stdout.trim()
}

/** 尝试加载 DSH 自带的校验器（装了才校验，没装就只做结构自检）。 */
async function loadValidator() {
  const candidates = [
    // 常见：DSH 全局安装目录
    `${process.env.APPDATA}/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js`,
    // 也试一下从当前进程的 node_modules 解析
  ]
  for (const candidate of candidates) {
    try {
      const mod = await import(`file:///${candidate.replace(/\\/g, '/')}`)
      if (typeof mod.parseMarketIndex === 'function') return mod.parseMarketIndex
    } catch { /* 试下一个 */ }
  }
  return null
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const entry = JSON.parse(await readFile(path.join(ROOT, 'market-entry.json'), 'utf8'))

const COMMIT_RE = /^[0-9a-f]{40}$/
const commit = COMMIT_RE.test(String(arg1 ?? '')) ? arg1 : await headCommit()
if (!COMMIT_RE.test(commit)) {
  console.error(`提交号不合法（要 40 位小写十六进制）：${commit}`)
  process.exit(1)
}

/* 分类 id 必须在这里声明过，插件条目才能引用 —— 这是商店格式的硬要求。 */
const CATEGORIES = {
  'image-generation': { title: { en: 'Image generation', zh: '图像生成' } },
  'video-generation': { title: { en: 'Video generation', zh: '视频生成' } },
  'audio-generation': { title: { en: 'Audio generation', zh: '音频生成' } },
  assets: { title: { en: 'Game assets', zh: '游戏素材' } },
  animation: { title: { en: 'Animation', zh: '动画' } },
  tools: { title: { en: 'Developer tools', zh: '开发工具' } },
  workflow: { title: { en: 'Workflow automation', zh: '流程自动化' } },
}

const LABELS = {
  'zero-dependency': { title: { en: 'Zero dependencies', zh: '零依赖' } },
  'local-first': { title: { en: 'Local first', zh: '本地优先' } },
  pipeline: { title: { en: 'Production pipeline', zh: '生产流水线' } },
}

const index = {
  format: 1,
  title: { en: 'yyfabab1 plugins', zh: 'yyfabab1 插件源' },
  description: {
    en: 'Plugin index for DeepSeek Harness — game asset production pipelines.',
    zh: 'DeepSeek Harness 的插件索引 —— 游戏素材生产流水线。',
  },
  metadata: { categories: CATEGORIES, labels: LABELS },
  plugins: [
    {
      name: entry.npm,
      title: { en: 'GPT Image — asset production pipeline', zh: '出图台 · 素材生产流水线' },
      description: entry.description,
      icon: 'https://raw.githubusercontent.com/yyfabab1/dsh-gpt-image/main/icon.svg',
      author: entry.owner,
      homepage: entry.url,
      repository: { url: entry.url },
      metadata: {
        category: 'assets',
        keywords: [
          'image', 'video', 'sprite', 'animation', 'spritesheet', 'game-assets',
          'pixel-art', 'audio', 'pipeline', 'zero-dependency',
        ],
        labels: ['zero-dependency', 'pipeline'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: entry.url, commit },
          engines: { dsh: '>=0.2.0' },
        },
      ],
    },
  ],
}

/* ── 校验：优先用 DSH 自己的解析器（最权威），没有就做结构自检 ── */
const parseMarketIndex = await loadValidator()
if (parseMarketIndex) {
  try {
    parseMarketIndex(index, 'https://raw.githubusercontent.com/yyfabab1/dsh-gpt-image/main/market-index.json')
    console.log('✓ 用 DSH 官方解析器校验通过')
  } catch (error) {
    console.error('✗ DSH 官方解析器拒绝这份索引：')
    console.error('  ', error?.message ?? error)
    process.exit(1)
  }
} else {
  // 结构自检（照抄官方规则里最容易踩的几条）
  const problems = []
  if (index.format !== 1) problems.push('format 必须是 1')
  for (const plugin of index.plugins) {
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(plugin.name)) problems.push(`name 不是合法 npm 包名：${plugin.name}`)
    if (plugin.metadata?.category && !CATEGORIES[plugin.metadata.category]) problems.push(`category 未声明：${plugin.metadata.category}`)
    for (const version of plugin.versions ?? []) {
      if (!/^\d+\.\d+\.\d+/.test(version.version)) problems.push(`version 不是精确 SemVer：${version.version}`)
      if (!Number.isInteger(version.publishTimestamp)) problems.push('publishTimestamp 必须是整数秒')
      if (version.source?.type === 'git' && !COMMIT_RE.test(version.source.commit)) problems.push('git 源必须给完整 40 位 commit')
    }
  }
  if (problems.length > 0) {
    console.error('✗ 结构自检失败：')
    for (const problem of problems) console.error('  -', problem)
    process.exit(1)
  }
  console.log('✓ 结构自检通过（没找到 DSH 官方解析器，按官方规则自查）')
}

if (checkOnly) {
  console.log('（--check：只校验，不写盘）')
  process.exit(0)
}

await writeFile(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`✓ 已写出 ${path.relative(ROOT, INDEX_FILE)}`)
console.log(`  插件: ${index.plugins[0].name}@${pkg.version}`)
console.log(`  提交: ${commit}`)
console.log()
console.log('在 DSH 里加这个索引：')
console.log('  设置 → 插件 → 发现（Discover）→ 添加插件源，填：')
console.log('  https://raw.githubusercontent.com/yyfabab1/dsh-gpt-image/main/market-index.json')
