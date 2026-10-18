/**
 * H 组 · 协作与安全网。
 *
 *   H1 素材锁 / 并发保护  —— 多 agent/脚本同时写同一目录时避免半成品被读走
 *   H2 归属与来源标注    —— 每张外部产物记：哪个脚本/agent 写的、什么时候、什么批次
 *   H3 自动备份 + 回滚    —— 审核结论与目录定期快照，一键回滚到某个时间点
 *   H4 损坏检测          —— 扫 PNG 完整性，发现截断/损坏（外部脚本写一半崩了）
 *
 * 设计要点：全部**零依赖**、**可重入**、**不猜**。
 * H1 的锁用文件 + 心跳（不是简单 exists），否则进程被强杀后锁会永久卡住。
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from './util.js'
import { decodePngRgba } from './pngcodec.js'

// ───────── H1 素材锁 / 并发保护 ─────────

export const LOCK_HEARTBEAT_MS = 30 * 1000
export const LOCK_EXPIRE_MS = 5 * 60 * 1000

/**
 * 带**心跳**的目录锁。
 *
 * 为什么不用 `exists()` 那种简单锁：写图的脚本被强杀时不会删锁，
 * 那个目录就永久锁死了，只能人工清理。这里让持有者定期心跳，
 * 超时未心跳即视为僵死锁，可被安全抢占。
 *
 * @param {{dataDir:string, name:string, owner?:string, reason?:string}} params
 */
export async function acquireResourceLock({ dataDir, name = 'assets-write', owner = 'unknown', reason = '' } = {}) {
  const file = path.join(dataDir, `lock-${name}.json`)
  await mkdir(dataDir, { recursive: true })

  const existing = await readJson(file, null)
  if (existing) {
    const age = Date.now() - new Date(existing.heartbeat ?? existing.at ?? 0).getTime()
    const stale = !Number.isFinite(age) || age > LOCK_EXPIRE_MS
    if (!stale) {
      return {
        ok: false,
        holder: existing.owner,
        since: existing.at,
        heartbeat_age_ms: age,
        error: `「${name}」被 ${existing.owner} 占用（${Math.round(age / 1000)}s 前心跳${existing.reason ? `，原因：${existing.reason}` : ''}）。等它释放，或确认它挂了再抢。`,
        can_steal: false,
      }
    }
    // 僵死锁：记下来，抢过来
    existing.stolen_from = existing.owner
  }

  const record = {
    name, owner, reason,
    at: nowIso(),
    heartbeat: nowIso(),
    pid: process.pid,
    ...(existing?.stolen_from ? { note: `抢占了 ${existing.stolen_from} 的僵死锁` } : {}),
  }
  await writeJsonAtomic(file, record)
  return {
    ok: true,
    file,
    record,
    heartbeat: async () => {
      const current = await readJson(file, null)
      // 只有还持有它才心跳（被别人抢走后不要复活）
      if (current?.owner !== owner) return false
      await writeJsonAtomic(file, { ...current, heartbeat: nowIso() })
      return true
    },
    release: async () => {
      const current = await readJson(file, null)
      if (current?.owner === owner) await rm(file, { force: true }).catch(() => {})
    },
  }
}

/** 查看某个锁的状态（不获取）。 */
export async function lockStatus({ dataDir, name = 'assets-write' } = {}) {
  const file = path.join(dataDir, `lock-${name}.json`)
  const record = await readJson(file, null)
  if (!record) return { held: false, name }
  const age = Date.now() - new Date(record.heartbeat ?? record.at ?? 0).getTime()
  return {
    held: true,
    name,
    owner: record.owner,
    reason: record.reason,
    since: record.at,
    heartbeat_age_ms: age,
    stale: !Number.isFinite(age) || age > LOCK_EXPIRE_MS,
    advice: (!Number.isFinite(age) || age > LOCK_EXPIRE_MS)
      ? `锁看起来已僵死（${Math.round(age / 1000)}s 无心跳），下次 acquire 会自动抢占。`
      : `锁由 ${record.owner} 持有，心跳正常。`,
  }
}

// ───────── H2 归属与来源标注 ─────────

export const PROVENANCE_FILE = 'provenance.json'

/**
 * 来源登记：每个文件由谁、何时、哪个批次写入。
 *
 * 为什么需要：681 张外部产物"哪来的"以前无据可查。
 * 有了它，"这堆图谁写的、能不能删"就有答案。
 */
export class ProvenanceLog {
  constructor(file, data) {
    this.file = file
    this.data = data
  }

  static async load(dataDir) {
    const file = path.join(dataDir, PROVENANCE_FILE)
    const raw = await readJson(file, null)
    if (!raw || typeof raw.entries !== 'object') {
      return new ProvenanceLog(file, { version: 1, entries: {}, batches: {} })
    }
    return new ProvenanceLog(file, { version: 1, entries: raw.entries ?? {}, batches: raw.batches ?? {} })
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
  }

  /** 记一批文件的来源。 */
  recordBatch({ batchId, writer = 'unknown', when = null, files = [], note = '' }) {
    const id = batchId || `b_${Date.now().toString(36)}`
    const at = when ?? nowIso()
    const entry = { writer, at, count: files.length, note, files: files.slice(0, 500) }
    this.data.batches[id] = entry
    for (const file of files) {
      // 路径归一化用小写正斜杠，避免 Windows 大小写差异造成同文件两条记录
      const key = String(file).replace(/\\/g, '/').toLowerCase()
      this.data.entries[key] = { batch: id, writer, at }
    }
    return { ok: true, batch_id: id, recorded: files.length }
  }

  /** 查某个文件的来源。 */
  of(file) {
    const key = String(file ?? '').replace(/\\/g, '/').toLowerCase()
    const entry = this.data.entries[key]
    if (!entry) return null
    return { ...entry, batch_info: this.data.batches[entry.batch] ?? null }
  }

  /** 按写入者汇总 —— 回答"这堆图哪来的"。 */
  byWriter() {
    const map = new Map()
    for (const batch of Object.values(this.data.batches)) {
      const bucket = map.get(batch.writer) ?? { writer: batch.writer, batches: 0, files: 0, last_at: '' }
      bucket.batches += 1
      bucket.files += batch.count
      if (String(batch.at) > bucket.last_at) bucket.last_at = batch.at
      map.set(batch.writer, bucket)
    }
    return [...map.values()].sort((a, b) => b.files - a.files)
  }

  /**
   * 给"未知来源"的文件补归属。
   * 判据（确定性）：插件自己生成的看 history；其余按目录+时间聚成批次。
   */
  async backfill({ files = [], gallery = null } = {}) {
    const known = new Set()
    for (const record of gallery?.list?.({ limit: 1000 }) ?? []) {
      for (const file of record.files ?? []) known.add(String(file).replace(/\\/g, '/').toLowerCase())
      for (const file of record.labeled ?? []) known.add(String(file).replace(/\\/g, '/').toLowerCase())
    }
    const unknown = files.filter((f) => !this.of(f.file))
    // 按「目录 + 修改日期」聚批：同一目录同一天产生的，大概率是同一批脚本产出
    const groups = new Map()
    for (const item of unknown) {
      const dir = path.dirname(item.file)
      const day = String(item.mtime ?? '').slice(0, 10) || 'unknown'
      const key = `${dir}|${day}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item.file)
    }
    let recorded = 0
    for (const [key, list] of groups) {
      const [dir, day] = key.split('|')
      const plugin = list.filter((f) => known.has(String(f).replace(/\\/g, '/').toLowerCase()))
      this.recordBatch({
        batchId: `bf_${createHash('sha256').update(key).digest('hex').slice(0, 10)}`,
        writer: plugin.length > 0 ? 'dsh-gpt-image' : `外部（${path.basename(dir)}）`,
        when: day === 'unknown' ? nowIso() : `${day}T00:00:00.000Z`,
        files: list,
        note: `自动补登记：${path.basename(dir)} 目录 ${day} 的文件（按目录+日期聚类，非精确来源）`,
      })
      recorded += list.length
    }
    return {
      ok: true,
      unknown_before: unknown.length,
      recorded,
      groups: groups.size,
      note: '自动补登记是**启发式**（按目录+日期聚类），不是精确来源。'
        + '要精确归属，写入方应在写完后自己调 record_batch。',
    }
  }
}

// ───────── H4 损坏检测 ─────────

/**
 * H4：PNG 完整性检测。
 *
 * 外部脚本写一半崩掉 → 文件截断，但扩展名还是 .png。
 * 判据（三级，从便宜到贵）：
 *   1. 文件头签名（8 字节）不对 → 一定坏
 *   2. 必须有 IEND 块结尾 → 否则就是截断（这是最常见的"写一半"）
 *   3. 解码能通过 → 最终确认
 */
export function checkPngIntegrity(buffer) {
  if (!buffer || buffer.length < 8) {
    return { ok: false, reason: '文件太小（<8 字节）', level: 'broken' }
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== signature[i]) {
      return { ok: false, reason: 'PNG 文件头不对（可能不是 PNG，或已损坏）', level: 'broken' }
    }
  }
  // IEND 是 PNG 的最后一个块：签名 "IEND" + 4 字节 CRC，所以最后 8 字节应含 IEND
  const tail = buffer.subarray(Math.max(0, buffer.length - 12))
  const hasIend = tail.includes(Buffer.from('IEND', 'ascii'))
  if (!hasIend) {
    return {
      ok: false,
      reason: '缺少 IEND 结尾块 —— 文件被截断（写入过程被中断的典型特征）',
      level: 'truncated',
      bytes: buffer.length,
    }
  }
  const decoded = decodePngRgba(buffer)
  if (!decoded) {
    return { ok: false, reason: 'IEND 在，但解码失败（数据损坏，或不是 8bit 非隔行 PNG）', level: 'broken' }
  }
  return { ok: true, level: 'ok', width: decoded.width, height: decoded.height, bytes: buffer.length }
}

/**
 * H4：批量扫目录。
 * @param {{files:Array<{file:string, bytes?:number}>}} params
 */
export async function scanCorruption({ files = [], limit = 2000 } = {}) {
  const broken = []
  const truncated = []
  let checked = 0
  for (const item of files.slice(0, limit)) {
    if (!/\.png$/i.test(item.file)) continue
    checked += 1
    let buffer
    try {
      buffer = await readFile(item.file)
    } catch (error) {
      broken.push({ file: item.file, reason: `读不到：${error?.message ?? error}`, level: 'broken' })
      continue
    }
    const result = checkPngIntegrity(buffer)
    if (!result.ok) {
      const record = { file: item.file, reason: result.reason, level: result.level, bytes: result.bytes ?? buffer.length }
      if (result.level === 'truncated') truncated.push(record)
      else broken.push(record)
    }
  }
  const total = broken.length + truncated.length
  return {
    checked,
    broken,
    truncated,
    total_bad: total,
    advice: total === 0
      ? `检查了 ${checked} 个 PNG，全部完整。`
      : `发现 ${total} 个坏文件（截断 ${truncated.length}，损坏 ${broken.length}）。`
        + `截断通常是外部脚本写一半被中断 —— 这些文件要删掉重做，不要装进游戏（会黑屏/报错）。`,
  }
}

// ───────── H3 备份 + 回滚 ─────────

export const BACKUP_DIR = 'backups'
export const DEFAULT_KEEP = 20

/**
 * H3：快照关键状态（审核结论 + 素材目录索引 + 花费账本）。
 *
 * 只备份**状态文件**（小、关键），不备份素材本身 ——
 * 素材是几万张图，全备份代价太大也不现实。
 * 但如果素材文件真的被脚本跑飞改坏了，H4 能查出来、重跑能恢复。
 */
export async function createBackup({ dataDir, label = '', keep = DEFAULT_KEEP, files = null } = {}) {
  const dir = path.join(dataDir, BACKUP_DIR)
  await mkdir(dir, { recursive: true })
  const targets = files ?? ['assets.json', 'snapshot.json', 'spend.json', 'profiles.json', 'pool.json', 'provenance.json']
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${stamp}${label ? `-${label}` : ''}`
  const bundle = { id, at: nowIso(), label, files: {} }
  for (const name of targets) {
    const src = path.join(dataDir, name)
    try {
      const text = await readFile(src, 'utf8')
      bundle.files[name] = text
    } catch { /* 没有这个文件就跳过 */ }
  }
  bundle.count = Object.keys(bundle.files).length
  if (bundle.count === 0) {
    return { ok: false, error: '没有任何状态文件可备份（还没用过？）' }
  }
  await writeJsonAtomic(path.join(dir, `${id}.json`), bundle)

  // 清理旧备份，只留 keep 个
  const all = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort()
  const removed = []
  while (all.length > keep) {
    const oldest = all.shift()
    await rm(path.join(dir, oldest), { force: true }).catch(() => {})
    removed.push(oldest)
  }
  return {
    ok: true,
    id,
    at: bundle.at,
    backed_up: Object.keys(bundle.files),
    pruned: removed,
    dir,
    note: `备份了 ${bundle.count} 个状态文件（审核结论/快照/账本）。**不含素材图本身** —— 那体量太大。`,
  }
}

/** 列出可用备份。 */
export async function listBackups({ dataDir } = {}) {
  const dir = path.join(dataDir, BACKUP_DIR)
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort().reverse()
  const items = []
  for (const name of names) {
    const raw = await readJson(path.join(dir, name), null)
    if (!raw) continue
    items.push({ id: raw.id, at: raw.at, label: raw.label ?? '', files: Object.keys(raw.files ?? {}) })
  }
  return { count: items.length, dir, items }
}

/**
 * H3：回滚到某个备份。
 * 安全设计：**回滚前先给当前状态做一份备份** —— 回滚本身也是破坏性操作，
 * 不能让人回滚完发现"回错了"却回不去。
 */
export async function restoreBackup({ dataDir, id = '', files: only = [] } = {}) {
  const dir = path.join(dataDir, BACKUP_DIR)
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort().reverse()
  if (names.length === 0) return { ok: false, error: '没有任何备份可回滚' }
  const target = id ? names.find((n) => n.startsWith(id)) : names[0]
  if (!target) return { ok: false, error: `找不到备份 ${id}` }
  const bundle = await readJson(path.join(dir, target), null)
  if (!bundle?.files) return { ok: false, error: `备份 ${target} 内容不可读` }

  // 回滚前先备份当前状态（否则回错了就回不去）
  const safety = await createBackup({ dataDir, label: 'before-restore' })

  const restored = []
  for (const [name, text] of Object.entries(bundle.files)) {
    if (only.length > 0 && !only.includes(name)) continue
    await writeFile(path.join(dataDir, name), text, 'utf8')
    restored.push(name)
  }
  return {
    ok: true,
    restored,
    from: bundle.id,
    from_at: bundle.at,
    safety_backup: safety.ok ? safety.id : null,
    note: `已回滚 ${restored.length} 个文件到 ${bundle.at}。回滚前的状态已另存为备份 ${safety.id}，回错了还能再回来。`,
  }
}

/** H3：判断是否需要自动备份（状态变了就备一份）。 */
export function needsBackup({ lastBackupHash, currentHash, changedCount = 0, threshold = 20 }) {
  if (!lastBackupHash) return { needed: true, why: '还没有任何备份' }
  if (lastBackupHash !== currentHash && changedCount >= threshold) {
    return { needed: true, why: `自上次备份以来有 ${changedCount} 项变化（阈值 ${threshold}）` }
  }
  return { needed: false, why: `变化 ${changedCount} 项，未到阈值 ${threshold}` }
}

export { copyFile, stat }
