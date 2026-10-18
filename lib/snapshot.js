/**
 * 素材变化摘要（prompt 1）。
 *
 * 要解决的痛点：目录里 900+ 张图，其中大半是外部脚本/agent 写进去的，
 * 用户**无法感知"什么时候多了什么"**，只能一张张翻。
 *
 * 做法：每次扫描时和上一次的快照 diff，产出人类可读的「自上次以来发生了什么」。
 *
 * 性能设计（这是关键取舍）：
 *   - 快照存 size + mtime 做**粗筛**（读 900 个 stat 很快）
 *   - 只有「size 变了」或「mtime 变了」的可疑项才去算 contentHash（读文件内容慢）
 *   - 这样 touch 过但内容没变的文件**不会被误报成"内容变化"**（正是要求里点名的边界）
 *
 * 首次运行：不能把已有 916 张全报成"新增"。策略是——首次只建立基线，
 * 并在结果里标 first_run:true，让调用方（UI/CLI）显示"已建立基线"而不是"新增 916"。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from './util.js'
import { classifyFile, normalizePath } from './assets.js'

export const SNAPSHOT_FILE = 'snapshot.json'
export const SNAPSHOT_VERSION = 1

/** 快照里单条记录的字段。hash 是可选的（只对可疑项算）。 */
export function snapshotEntry({ file, size, mtime, hash }) {
  return { file, size, mtime, ...(hash ? { hash } : {}) }
}

/** 算内容 hash（只读一次，用于可疑项）。 */
export async function contentHash(file) {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 24)
  } catch {
    return ''
  }
}

export class Snapshot {
  constructor(file, data) {
    this.file = file
    this.data = data
  }

  static async load(dataDir) {
    const file = path.join(dataDir, SNAPSHOT_FILE)
    const raw = await readJson(file, null)
    // 快照损坏（JSON 坏/结构不对）→ 当成"没有快照"，走首次运行，而不是崩掉
    if (!raw || typeof raw !== 'object' || !raw.files || typeof raw.files !== 'object') {
      return new Snapshot(file, { version: SNAPSHOT_VERSION, takenAt: '', files: {}, firstRun: true })
    }
    return new Snapshot(file, { version: SNAPSHOT_VERSION, takenAt: raw.takenAt ?? '', files: raw.files, firstRun: false })
  }

  get hasBaseline() {
    return !this.data.firstRun && Object.keys(this.data.files).length > 0
  }

  async save(files) {
    // 复用上一份快照里已有的 hash：hash 是"内容没变"的判据，
    // 丢了它下次遇到 touch 就只能保守处理（无法区分 touch 与真改）。
    const previousHashes = this.data?.files ?? {}
    const map = {}
    for (const item of files) {
      const key = normalizePath(item.file)
      const hash = item.contentHash ?? previousHashes[key]?.hash
      map[key] = snapshotEntry({
        file: item.file,
        size: item.bytes ?? 0,
        mtime: item.mtime ?? '',
        hash,
      })
    }
    this.data = { version: SNAPSHOT_VERSION, takenAt: nowIso(), files: map, firstRun: false }
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }
}

/**
 * 扫描结果 vs 上一次快照 → 变化摘要。
 *
 * 判定链（顺序很重要，先便宜后昂贵）：
 *   1. size 和 mtime 都没变        → 一定没变（不读内容）
 *   2. size 变了                   → 内容一定变了（不读内容）
 *   3. 只有 mtime 变了             → **必须算 hash**，否则无法区分"touch"和"真改了"
 *      —— 这是要求里点名的边界：touch 过不该报成内容变化。
 *      hash 要跟「基线里存的 hash」比；基线没存 hash 时，说明上次是快路径跳过的，
 *      这次就顺便把 hash 补进基线（下次起就能正确判定了）。
 */
export async function diffSnapshot({ files = [], previous, hashLimit = 400 } = {}) {
  const prevFiles = previous?.data?.files ?? {}
  const firstRun = !previous?.hasBaseline

  // 首次运行：只建基线，不把历史全算成"新增"
  if (firstRun) {
    return {
      first_run: true,
      taken_at: previous?.data?.takenAt ?? '',
      added: [],
      removed: [],
      changed: [],
      stats: { added: 0, removed: 0, changed: 0, total: files.length },
      summary: `已建立基线（${files.length} 张）—— 下次扫描起会显示"自上次以来新增/消失了什么"。`,
    }
  }

  const nowKeys = new Set()
  const added = []
  const changed = []
  const deferred = []
  let hashed = 0

  for (const item of files) {
    const key = normalizePath(item.file)
    nowKeys.add(key)
    const prev = prevFiles[key]
    if (!prev) {
      added.push({ file: item.file, name: item.name, kind: item.kind, project: item.project, external: item.generated === false })
      continue
    }
    const sizeSame = Number(prev.size) === Number(item.bytes ?? 0)
    const mtimeSame = String(prev.mtime) === String(item.mtime ?? '')
    // 快路径：两个都没变 → 一定没变
    if (sizeSame && mtimeSame) {
      // 基线缺 hash 的，顺手补上（不报变化，只是让下次能准确判定）
      if (!prev.hash && item.contentHash) prev.hash = item.contentHash
      continue
    }
    // size 变了 → 内容一定变了
    if (!sizeSame) {
      changed.push({
        file: item.file, name: item.name, kind: item.kind, project: item.project,
        before: { size: prev.size, mtime: prev.mtime }, after: { size: item.bytes, mtime: item.mtime },
      })
      continue
    }
    // 只有 mtime 变了 → 用 hash 区分 touch 与真改
    let isChanged = null
    if (item.contentHash && prev.hash) {
      isChanged = prev.hash !== item.contentHash
    } else if (hashed < hashLimit && !item.contentHash) {
      hashed += 1
      const hash = await contentHash(item.file)
      // 算出来了就写回，让调用方存快照时带上
      item.contentHash = hash
      if (prev.hash) {
        isChanged = prev.hash !== hash
      } else {
        // 基线没 hash：无法判断内容是否真变。
        // 保守做法 —— 记进 deferred（不谎报"内容变化"，也不谎报"没变"），
        // 同时把 hash 补上，下次就能准确判定。
        prev.hash = hash
        deferred.push({ file: item.file, name: item.name, mtime_changed: true, hash_recorded: hash })
        continue
      }
    } else {
      // hash 预算用尽：不谎报变化
      continue
    }
    if (isChanged) {
      changed.push({
        file: item.file, name: item.name, kind: item.kind, project: item.project,
        before: { size: prev.size, mtime: prev.mtime }, after: { size: item.bytes, mtime: item.mtime },
      })
    }
  }

  // 消失：上次有、这次没有
  const removed = []
  for (const [key, prev] of Object.entries(prevFiles)) {
    if (nowKeys.has(key)) continue
    removed.push({ file: prev.file, name: path.basename(prev.file), size: prev.size })
  }

  const stats = { added: added.length, removed: removed.length, changed: changed.length, total: files.length }
  return {
    first_run: false,
    taken_at: previous?.data?.takenAt ?? '',
    added,
    removed,
    changed,
    // mtime 变了但没法确认内容的：单列，不混进"内容变化"
    deferred,
    stats: { ...stats, deferred: deferred.length },
    summary: summarizeChanges(stats, { removedMassive: removed.length > Math.max(50, files.length * 0.5) }),
  }
}

/**
 * 人话摘要。大量文件同时消失（目录被清空/被移动）时**不刷屏**，只说结论。
 */
export function summarizeChanges(stats, { removedMassive = false } = {}) {
  const parts = []
  if (stats.added > 0) parts.push(`新增 ${stats.added} 张`)
  if (stats.changed > 0) parts.push(`内容变化 ${stats.changed} 张`)
  if (stats.removed > 0) {
    parts.push(removedMassive
      ? `消失 ${stats.removed} 张（超过一半，可能是目录被清空或移动）`
      : `消失 ${stats.removed} 张`)
  }
  if (parts.length === 0) return '自上次以来没有变化。'
  return `自上次以来：${parts.join(' / ')}。`
}

/**
 * 完整一步：扫（已在外面做过）→ diff → 存快照。
 * @param {{files:Array, dataDir:string, save?:boolean}} params
 */
export async function captureChanges({ files = [], dataDir, save = true }) {
  const previous = await Snapshot.load(dataDir)
  const diff = await diffSnapshot({ files, previous })
  if (save) {
    // 首次运行 & 之后的每次都重建基线，这样"自上次以来"始终相对最近一次
    await previous.save(files)
  }
  return { ...diff, changed_files: [...diff.added, ...diff.changed].map((item) => item.file) }
}
