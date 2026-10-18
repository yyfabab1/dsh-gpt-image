/**
 * 素材依赖图：从代码里解析出「哪些素材被谁用、谁先谁后」，据此排生成顺序。
 *
 * 为什么有用：一上来就画 169 张卡面插画，大概率因为通用的「卡框」还没定稿而全部返工。
 * 正确顺序是先画通用件（卡框/UI 面板/图标底板），再画具体件（每张卡的插画）。
 * 这里从真实引用里推断依赖，产出一个「先画什么后画什么」的批次计划。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '_fitted', '截图', '__pycache__', '.venv', 'venv', 'out'])
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|lua|py|html|json|css|scss)$/i
/** 工具/测试目录里的引用不算游戏运行时依赖 */
const TOOLING = /(^|[\\/])(tools?|scripts?|tests?|__tests__|docs?|tmp|temp|\.cache)([\\/]|$)/i

/** 素材分类：用来判断"通用件 vs 具体件"。 */
export function classifyAsset(name) {
  const value = String(name ?? '').toLowerCase()
  // 先判「具体件」：card_art / 立绘 / 怪物 —— 否则 card_* 会被误归到通用件
  if (/card_art|cardart|插画|立绘|portrait|头像|monster|enemy|boss|怪/.test(value)) {
    if (/monster|enemy|boss|怪/.test(value)) return { group: 'enemy', generic: false }
    if (/card_art|cardart|插画/.test(value)) return { group: 'card-art', generic: false }
    return { group: 'character', generic: false }
  }
  if (/frame|面板|panel|ui_|button|按钮|dialog|对话框|border|边框/.test(value)) return { group: 'ui', generic: true }
  if (/icon|图标/.test(value)) return { group: 'icon', generic: true }
  if (/tile|地形|瓦片|ground|wall|terrain|bg_|background|sky|^wx_/.test(value)) return { group: 'terrain', generic: true }
  if (/card_back|牌背|_back$/.test(value)) return { group: 'card-core', generic: true }
  if (/effect|fx_|特效|explosion/.test(value)) return { group: 'effect', generic: false }
  if (/char|hero|npc/.test(value)) return { group: 'character', generic: false }
  return { group: 'misc', generic: false }
}

/** 通用件的绘制顺序（数字越小越先画）。 */
const GROUP_ORDER = { ui: 1, icon: 2, 'card-core': 3, terrain: 4, effect: 5, character: 6, enemy: 7, 'card-art': 8, misc: 9 }

async function walk(root, { maxFiles = 4000, depth = 6, files = [], level = 0 } = {}) {
  if (level > depth || files.length >= maxFiles) return files
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(full, { maxFiles, depth, files, level: level + 1 })
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

/** 从项目里提取「素材 key → 被哪些文件引用（及次数）」。 */
export async function buildUsageGraph(root, { maxFiles = 4000 } = {}) {
  const files = await walk(root, { maxFiles })
  const usage = new Map()
  const allKeys = new Set()
  const codeFiles = []
  // 关键：只按「相对项目根」的路径判断是不是工具/测试代码 ——
  // 用绝对路径会把 C:\Users\...\Temp\... 这种正常项目误判成临时目录。
  const isTooling = (file) => TOOLING.test(path.relative(root, file).replace(/\\/g, '/'))
  const readable = []
  for (const file of files) {
    if (!CODE_EXT.test(file) || isTooling(file)) continue
    let text
    try {
      if ((await stat(file)).size > 2 * 1024 * 1024) continue
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    codeFiles.push(path.relative(root, file).replace(/\\/g, '/'))
    readable.push({ file, text })
    // 素材 key：形如 wx_clear_tile / i_skull / card_fire 这类带下划线的标识
    for (const match of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/gi)) {
      const key = match[1]
      if (key.length < 4 || key.length > 40) continue
      allKeys.add(key)
    }
  }
  // 只保留「至少被两个不同文件引用」或「名字像素材」的 key，避免把普通变量当素材
  const ASSET_LIKE = /^(wx_|i_|u_|t_|bg_|scen_|fx_|card_|ui_|icon_|portrait_|npc_|monster_|unit_|prop_|deco_)/i
  for (const { file, text } of readable) {
    const relative = path.relative(root, file).replace(/\\/g, '/')
    for (const key of allKeys) {
      if (!ASSET_LIKE.test(key)) continue
      const count = text.split(key).length - 1
      if (count === 0) continue
      const bucket = usage.get(key) ?? { key, files: [], total: 0, groups: new Set() }
      bucket.files.push({ file: relative, count })
      bucket.total += count
      bucket.groups.add(classifyAsset(key).group)
      usage.set(key, bucket)
    }
  }
  return {
    keys: [...usage.values()].map((bucket) => ({
      key: bucket.key,
      total: bucket.total,
      files: bucket.files.slice(0, 5),
      ...classifyAsset(bucket.key),
    })).sort((a, b) => b.total - a.total),
    codeFiles: codeFiles.length,
    scannedFiles: files.length,
  }
}

/**
 * 生成顺序计划：先通用件（一改全改的），后具体件（各自独立的）。
 * @param {{root:string, wanted?:string[]}} params
 */
export async function planGenerationOrder({ root, wanted = [] }) {
  const graph = await buildUsageGraph(root)
  const source = wanted.length > 0
    ? wanted.map((key) => {
        const found = graph.keys.find((item) => item.key === key)
        return found ?? { key, total: 0, files: [], ...classifyAsset(key) }
      })
    : graph.keys
  const batches = new Map()
  for (const item of source) {
    const order = GROUP_ORDER[item.group] ?? GROUP_ORDER.misc
    const bucket = batches.get(order) ?? { order, group: item.group, generic: Boolean(item.generic), items: [] }
    bucket.items.push({ key: item.key, usedBy: item.total, files: item.files.slice(0, 3).map((entry) => entry.file) })
    batches.set(order, bucket)
  }
  const ordered = [...batches.values()].sort((a, b) => a.order - b.order)
  let step = 0
  for (const batch of ordered) {
    step += 1
    batch.step = step
    batch.why = batch.generic
      ? `通用件（${batch.group}）：先定稿，后面所有具体素材都要跟它对齐，改它等于全改。`
      : `具体件（${batch.group}）：各自独立，可以在通用件定稿后并行铺开。`
  }
  return {
    ok: true,
    root,
    scanned: { files: graph.scannedFiles, code_files: graph.codeFiles, assets: graph.keys.length },
    batches: ordered,
    hint: ordered.length > 0
      ? `按批次画：第 ${ordered[0].step} 批先画 ${ordered[0].items.slice(0, 3).map((item) => item.key).join('、')}${ordered.length > 1 ? `，最后一批再画 ${ordered[ordered.length - 1].items.slice(0, 3).map((item) => item.key).join('、')}` : ''}。先通用后具体，能显著减少返工。`
      : '没从代码里认出素材引用；可以直接给一批素材名让我排顺序。',
  }
}
