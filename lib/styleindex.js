/**
 * 素材库风格索引：扫一次全项目素材，给每张图算风格指纹并缓存。
 *
 * 用途：
 *  ① 生成时按指纹挑最像的参考图（不是靠目录/名字猜）
 *  ② 给出一份「这个项目长什么样」的风格档案，可直接拼进提示词
 *  ③ 发现风格跑偏的素材（与项目主体差异过大的），提前预警
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fingerprintOfFile, styleLabel } from './stylefp.js'
import { nowIso, readJson, writeJsonAtomic } from './util.js'

const IMAGE_EXT = /\.(png|webp|jpe?g)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'out', '_fitted', '截图'])

export const styleIndexFile = (dataDir) => path.join(dataDir, 'style-index.json')

export const DEFAULT_INDEX = { version: 1, roots: {}, entries: {} }

export class StyleIndex {
  constructor(file, data) {
    this.file = file
    this.data = { ...DEFAULT_INDEX, ...data }
    if (!this.data.entries || typeof this.data.entries !== 'object') this.data.entries = {}
  }

  static async load(dataDir) {
    const file = styleIndexFile(dataDir)
    return new StyleIndex(file, (await readJson(file, null)) ?? {})
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  /** 该目录上次扫描的时间，用来判断要不要重扫。 */
  scannedAt(root) {
    return this.data.roots?.[root]?.at ?? ''
  }

  stats() {
    const entries = Object.values(this.data.entries)
    const byLabel = {}
    for (const entry of entries) byLabel[entry.label] = (byLabel[entry.label] ?? 0) + 1
    return { files: entries.length, by_label: byLabel, roots: Object.keys(this.data.roots ?? {}).length }
  }

  /** 项目风格档案：主色、明暗、线条密度取所有素材的中位数，代表"整体长什么样"。 */
  profile({ sampleLimit = 60 } = {}) {
    const entries = Object.values(this.data.entries)
    if (entries.length === 0) return null
    const median = (numbers) => {
      if (numbers.length === 0) return 0
      const sorted = [...numbers].sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
    const sampled = entries.slice(0, sampleLimit)
    const colorCount = new Map()
    for (const entry of sampled) {
      for (const item of entry.palette ?? []) {
        colorCount.set(item.hex, (colorCount.get(item.hex) ?? 0) + (item.share ?? 0))
      }
    }
    return {
      files: entries.length,
      palette: [...colorCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hex, weight]) => ({ hex, weight: Number(weight.toFixed(3)) })),
      ink: Number(median(sampled.map((entry) => entry.ink)).toFixed(3)),
      saturation: Number(median(sampled.map((entry) => entry.saturation)).toFixed(3)),
      edgeDensity: Number(median(sampled.map((entry) => entry.edgeDensity)).toFixed(3)),
      alphaRatio: Number(median(sampled.map((entry) => entry.alphaRatio)).toFixed(3)),
      labels: sampled.reduce((acc, entry) => { acc[entry.label] = (acc[entry.label] ?? 0) + 1; return acc }, {}),
    }
  }

  /** 和项目主体风格偏差最大的素材（风格跑偏预警）。 */
  outliers({ threshold = 0.45, limit = 10 } = {}) {
    const profile = this.profile()
    if (!profile) return []
    const reference = { palette: profile.palette.map((item) => ({ hex: item.hex })), ink: profile.ink, saturation: profile.saturation, edgeDensity: profile.edgeDensity }
    const scored = Object.entries(this.data.entries).map(([file, entry]) => ({
      file,
      similarity: styleSimilaritySafe(entry, reference),
      label: entry.label,
    }))
    scored.sort((a, b) => a.similarity - b.similarity)
    return scored.filter((item) => item.similarity < threshold).slice(0, limit)
  }
}

function styleSimilaritySafe(a, b) {
  try {
    // 延迟引入，避免循环依赖
    const { styleSimilarity } = require0()
    return styleSimilarity(a, b)
  } catch {
    return 0
  }
}

function require0() {
  return { styleSimilarity: (a, b) => {
    if (!a || !b) return 0
    const setB = new Set((b.palette ?? []).map((item) => item.hex))
    const hit = (a.palette ?? []).filter((item) => setB.has(item.hex)).length
    const paletteScore = hit / Math.max(1, (a.palette ?? []).length)
    const inkScore = 1 - Math.min(1, Math.abs((a.ink ?? 0) - (b.ink ?? 0)) / 0.5)
    const edgeScore = 1 - Math.min(1, Math.abs((a.edgeDensity ?? 0) - (b.edgeDensity ?? 0)) / 0.3)
    return Number((paletteScore * 0.5 + inkScore * 0.25 + edgeScore * 0.25).toFixed(3))
  } }
}

async function walk(root, { maxFiles = 400, depth = 5, files = [], level = 0 } = {}) {
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
    } else if (entry.isFile() && IMAGE_EXT.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

/**
 * 扫描并建立/更新索引。
 * @param {{root:string, dataDir:string, maxFiles?:number, force?:boolean, index?:StyleIndex}} params
 */
export async function buildStyleIndex({ root, dataDir, maxFiles = 400, force = false, index = null }) {
  if (!root) return { ok: false, error: '需要 root（游戏目录）' }
  const store = index ?? await StyleIndex.load(dataDir)
  const files = await walk(root, { maxFiles })
  let scanned = 0
  let skipped = 0
  let failed = 0
  for (const file of files) {
    const resolved = path.resolve(file)
    if (!force && store.data.entries[resolved]) {
      // 已索引且没变过就跳过（用大小+时间粗判）
      try {
        const info = await stat(resolved)
        const cached = store.data.entries[resolved]
        if (cached.bytes === info.size && cached.mtime === info.mtimeMs) { skipped += 1; continue }
      } catch {
        /* 读不到就重算 */
      }
    }
    const fingerprint = await fingerprintOfFile(resolved)
    if (!fingerprint) { failed += 1; continue }
    let info = {}
    try {
      info = await stat(resolved)
    } catch {
      /* noop */
    }
    store.data.entries[resolved] = {
      ...fingerprint,
      label: styleLabel(fingerprint),
      bytes: info.size ?? 0,
      mtime: info.mtimeMs ?? 0,
      indexedAt: nowIso(),
    }
    scanned += 1
  }
  store.data.roots[root] = { at: nowIso(), files: files.length, scanned, skipped, failed }
  await store.save()
  return {
    ok: true,
    root,
    found: files.length,
    scanned,
    skipped,
    failed,
    profile: store.profile(),
    outliers: store.outliers({ limit: 8 }),
    hint: '索引已缓存；下次生成时用 use_style_refs=true 会自动按风格指纹挑参考图。',
  }
}
