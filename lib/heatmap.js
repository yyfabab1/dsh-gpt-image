/**
 * 素材使用热度：哪些素材真正被游戏用到、哪些生成了却没人用。
 *
 * 价值：这是「花钱有没有花在刀刃上」的答案。生成了但代码里零引用的素材 = 白花钱，
 * 应当优先补登记或干脆别画；被大量引用的素材（比如卡框）一旦返工代价最大，要先定稿。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'tmp', 'temp', '__pycache__', '.venv', 'venv', '_fitted', '截图'])
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|lua|py|html|json)$/i

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
    } else if (entry.isFile()) files.push(full)
  }
  return files
}

/**
 * @param {{root:string, projects?:Record<string, Array<{key:string,file:string}>>, maxFiles?:number}} params
 */
export async function usageHeatmap({ root, projects = {}, maxFiles = 3000 }) {
  if (!root) return { ok: false, error: '需要 root（游戏目录）' }
  const files = await walk(root, { maxFiles })
  const blobs = []
  for (const file of files) {
    if (!CODE_EXT.test(file)) continue
    const relative = path.relative(root, file).replace(/\\/g, '/')
    // 只统计游戏运行时代码，工具/测试不算「真在用」
    if (/(^|\/)(tools?|scripts?|tests?|__tests__|docs?)(\/|$)/i.test(relative)) continue
    try {
      if ((await stat(file)).size > 2 * 1024 * 1024) continue
      blobs.push({ relative, text: await readFile(file, 'utf8') })
    } catch {
      /* 跳过读不了的 */
    }
  }

  const rows = []
  for (const [project, assets] of Object.entries(projects)) {
    const seen = new Set()
    for (const asset of assets) {
      const raw = asset.key ?? path.basename(asset.file).replace(/\.[a-z0-9]+$/i, '')
      // 预览图/按规格缩好的副本不是游戏素材本身，别算进来（否则误报"白花钱"）
      if (/_labeled$/i.test(raw) || /_fixed$/i.test(raw) || /\.bak/i.test(asset.file ?? '')) continue
      const key = raw.replace(/_\d+x\d+$/, '').replace(/_\d+$/, '')
      const dedupe = `${project}/${key}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      let references = 0
      const referencedBy = []
      for (const blob of blobs) {
        const count = blob.text.split(key).length - 1
        if (count > 0) {
          references += count
          if (referencedBy.length < 5) referencedBy.push(blob.relative)
        }
      }
      rows.push({
        project,
        key,
        file: asset.file,
        references,
        referencedBy,
        used: references > 0,
        verdict: references === 0
          ? '生成的图游戏里没人用（要么没登记，要么这个素材根本不需要）'
          : references >= 5
            ? `被引用 ${references} 次：核心素材，返工代价大，先定稿再铺量`
            : `被引用 ${references} 次`,
      })
    }
  }

  rows.sort((a, b) => b.references - a.references)
  const unused = rows.filter((row) => !row.used)
  const total = rows.length
  return {
    ok: true,
    scanned: { code_files: blobs.length, assets: total },
    // 三个视角都要给全，客户端不必自己过滤：
    //   hot   被大量引用（核心素材，返工代价大）
    //   warm  被引用但不算多（正常在用）
    //   cold  零引用（白花钱，要补登记或确认不需要）
    hot: rows.filter((row) => row.references >= 5).slice(0, 15),
    warm: rows.filter((row) => row.used && row.references < 5).slice(0, 30),
    cold: unused.slice(0, 30),
    all: rows.slice(0, 200),
    summary: {
      total,
      used: total - unused.length,
      unused: unused.length,
      waste_ratio: total ? Number((unused.length / total).toFixed(2)) : 0,
    },
    hint: unused.length > 0
      ? `有 ${unused.length}/${total} 张生成的图在游戏代码里零引用 —— 这部分钱等于白花。优先补登记（register）或确认是否真需要。`
      : '生成的图都在游戏里被用到了。',
  }
}
