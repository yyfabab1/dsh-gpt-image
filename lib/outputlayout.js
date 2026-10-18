/**
 * 产出目录收敛：把一堆混在一起的文件分成**四类**，让"哪个是给游戏用的"一眼可见。
 *
 * 问题的来源（真实痛点）：插件一路加了太多副产物 ——
 *   `x_1.png`（干净图）· `x_1.post.png`（后处理）· `x_1_labeled.png`（印着名字的预览）
 *   · `x_slices/`（切片）· `x.alpha.png`（抠底帧）· `x.cache.json`（缓存）
 *   · `frames/`（抽帧中间产物）· `.bak-before-install`（装机备份）· `.dataurl.txt`（内联用）
 * 它们平铺在同一个目录里，新人（和几个月后的自己）根本分不清该把哪个文件交给游戏。
 *
 * 四类：
 *   source        游戏用 —— **只有这类该被游戏引用**
 *   preview       给人看的（印名字的预览图）
 *   derived       派生件（后处理/切片/缩放/抠底帧）—— 可能需要，但不是"原始素材"
 *   intermediate  中间产物（管线跑的副产物，删了能重跑）
 *   config        描述文件（JSON 等，程序读的）
 *
 * 原则：**只移动/清理 preview / derived / intermediate，绝不动 source**，
 * 因为 source 是被游戏代码引用着的（移动它等于断引用）。
 */
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

/** 文件名 → 类别。 */
export function classifyFile(name) {
  const base = String(name)
  if (/_labeled\.(png|jpe?g|webp)$/i.test(base)) return 'preview'
  if (/\.(post|pixel)\.(png|jpe?g|webp)$/i.test(base)) return 'derived'
  if (/\.alpha\.(png|jpe?g|webp)$/i.test(base)) return 'derived'
  if (/_\d+x\d+\.(png|jpe?g|webp)$/i.test(base)) return 'derived'   // 缩放件
  if (/\.bak/i.test(base)) return 'intermediate'
  if (/\.cache\.json$/i.test(base)) return 'intermediate'
  if (/\.result\.txt$/i.test(base)) return 'intermediate'
  if (/\.(json|txt|ya?ml|ini|lua|ts|js)$/i.test(base)) return 'config'
  if (/\.(png|jpe?g|webp|gif)$/i.test(base)) return 'source'
  return 'other'
}

/** 目录名 → 类别（整目录归类，比如 `x_slices/`、`frames/`）。 */
export function classifyDir(name) {
  const base = String(name)
  if (/_slices$/i.test(base)) return 'derived'
  if (/^(frames|frames_probe|_fitted|_tmp)$/i.test(base)) return 'intermediate'
  if (/^_labeled$|^_preview$/i.test(base)) return 'preview'
  return null
}

/** 每一类落到哪个子目录（source 留在原地，不移动）。 */
const TARGET_DIR = {
  preview: '_preview',
  derived: '_derived',
  intermediate: '_tmp',
}

/**
 * 清点一个目录（递归最多 3 层），按类别汇总。
 * @param {{dir:string}} params
 */
export async function summarizeLayout({ dir }) {
  const categories = {
    source: { count: 0, bytes: 0, samples: [] },
    preview: { count: 0, bytes: 0, samples: [] },
    derived: { count: 0, bytes: 0, samples: [] },
    intermediate: { count: 0, bytes: 0, samples: [] },
    config: { count: 0, bytes: 0, samples: [] },
    other: { count: 0, bytes: 0, samples: [] },
  }
  const push = (kind, name, bytes) => {
    const bucket = categories[kind]
    bucket.count += 1
    bucket.bytes += bytes
    if (bucket.samples.length < 5) bucket.samples.push(name)
  }
  const walk = async (current, depth) => {
    if (depth > 3) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        const kind = classifyDir(entry.name)
        if (kind) {
          // 整目录归类：统计它的总大小，不再往里钻
          let bytes = 0
          let count = 0
          const deep = async (d, lvl) => {
            if (lvl > 4) return
            const inner = await readdir(d, { withFileTypes: true }).catch(() => [])
            for (const item of inner) {
              const f = path.join(d, item.name)
              if (item.isDirectory()) await deep(f, lvl + 1)
              else {
                const info = await stat(f).catch(() => null)
                if (info) { bytes += info.size; count += 1 }
              }
            }
          }
          await deep(full, 0)
          const bucket = categories[kind]
          bucket.count += count
          bucket.bytes += bytes
          if (bucket.samples.length < 5) bucket.samples.push(`${entry.name}/ (${count} 个文件)`)
          continue
        }
        await walk(full, depth + 1)
        continue
      }
      const info = await stat(full).catch(() => null)
      push(classifyFile(entry.name), entry.name, info?.size ?? 0)
    }
  }
  await walk(dir, 0)
  const totalBytes = Object.values(categories).reduce((sum, c) => sum + c.bytes, 0)
  return {
    dir,
    total_bytes: totalBytes,
    total_mb: Number((totalBytes / 1024 / 1024).toFixed(1)),
    categories: Object.fromEntries(Object.entries(categories).map(([key, value]) => [
      key,
      { ...value, mb: Number((value.bytes / 1024 / 1024).toFixed(1)), share: totalBytes > 0 ? Number(((value.bytes / totalBytes) * 100).toFixed(1)) : 0 },
    ])),
    game_ready: categories.source.count,
    can_clean_mb: Number(((categories.preview.bytes + categories.derived.bytes + categories.intermediate.bytes) / 1024 / 1024).toFixed(1)),
  }
}

/**
 * 整理：把 preview / derived / intermediate 移到各自的 `_xxx` 子目录。
 * **绝不移动 source**（它被游戏代码引用着）。也绝不动 config 以外的顶层 JSON。
 *
 * @param {{dir:string, dryRun?:boolean, categories?:string[]}} params
 */
export async function organizeLayout({ dir, dryRun = true, categories = ['preview', 'intermediate'] } = {}) {
  /* 默认**不动 derived**：`*_slices/` 这类派生目录很可能就是游戏在用的切片
   * （把一个 4×4 图标集切开成 16 张，游戏读的是切好的单张）。
   * 名字叫"派生"，但它可能已经被引用 —— 移动它等于断引用。
   * 要整理 derived 必须显式在 categories 里带上它，那时会给出警告。 */
  const wanted = new Set(categories)
  const moves = []

  /* 必须**递归**：`frames/` 通常躺在 `anim/<动画名>/frames` 里，只看一层会一个都找不到
   * （第一版就只扫顶层，演练结果"计划移动 0 项"，等于没做事还报成功）。
   * 移动时保留相对路径（_tmp/anim/x/frames），否则多个同名 `frames/` 会撞在一起。 */
  const walk = async (current, depth) => {
    if (depth > 3) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full)
      // 别钻进整理目标目录，否则会自己搬自己
      if (depth === 0 && Object.values(TARGET_DIR).includes(entry.name)) continue
      if (entry.isDirectory()) {
        const kind = classifyDir(entry.name)
        if (kind && wanted.has(kind)) {
          moves.push({ kind, from: full, to: path.join(dir, TARGET_DIR[kind], rel) })
          continue
        }
        await walk(full, depth + 1)
        continue
      }
      const kind = classifyFile(entry.name)
      if (!wanted.has(kind)) continue
      moves.push({ kind, from: full, to: path.join(dir, TARGET_DIR[kind], rel) })
    }
  }
  await walk(dir, 0)

  if (dryRun) {
    return {
      ok: true, dry_run: true, dir,
      planned: moves.length,
      by_category: Object.fromEntries([...wanted].map((kind) => [kind, moves.filter((m) => m.kind === kind).length])),
      moves: moves.slice(0, 20).map((m) => ({ kind: m.kind, name: path.basename(m.from), to: path.relative(dir, m.to) })),
      hint: '这些会被移到 _preview/ _tmp/ 下，**游戏用的 source 不动**。确认后传 dry_run=false。',
    }
  }

  let moved = 0
  const failures = []
  for (const move of moves) {
    await mkdir(path.dirname(move.to), { recursive: true })
    try {
      await rename(move.from, move.to)
      moved += 1
    } catch (error) {
      failures.push({ name: path.basename(move.from), error: String(error?.message ?? error) })
    }
  }
  return {
    ok: failures.length === 0,
    dry_run: false, dir,
    moved,
    failed: failures.length,
    failures: failures.slice(0, 10),
    by_category: Object.fromEntries([...wanted].map((kind) => [kind, moves.filter((m) => m.kind === kind).length])),
    note: `移了 ${moved} 项。游戏用的 source 一个都没动。`,
    ...(wanted.has('derived')
      ? { warning: '这次连 derived 也整理了（*_slices/ 等）。如果游戏引用的是切片里的单张图，那些路径已经变了 —— 请检查代码引用。' }
      : {}),
  }
}

/** 目录约定说明（给文档和工具提示用，避免每次解释）。 */
export function explainLayout() {
  return {
    source: '游戏用 —— 只有这一类该被游戏代码引用（干净的原始素材 / 精灵表）',
    preview: '给人看的：画面里印着素材名的预览图（*_labeled.png）→ _preview/',
    derived: '派生件：后处理、切片、缩放、抠底帧（*.post.png / *_slices/ / *_{w}x{h}.png / *.alpha.png）→ _derived/',
    intermediate: '中间产物：抽帧目录、缓存、装机备份（frames/ / *.cache.json / *.bak*）→ _tmp/，删了能重跑',
    config: '描述文件：精灵表 JSON、素材清单等，程序读的',
    rule: '整理只移动 preview / derived / intermediate 三类；source 不动（它被游戏引用着，移动等于断引用）。',
  }
}
