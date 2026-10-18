/**
 * 跨项目风格对比：防止 A 项目的素材风格污染 B 项目。
 *
 * 场景：`starcraft-rts` 的 `flag_*` / `portrait_*` 和 `doomsday-ember` 的 `wx_*` / `t_*`
 * 明显是两套美术语言。如果生成 B 项目素材时误把 A 项目的图当风格参考，
 * 出来的图会串味 —— 而且这种问题肉眼不一定立刻发现。
 *
 * 这里给每个项目算一份「风格档案」，两两比对，并在挑参考图时**强制只用同项目的素材**。
 */
import path from 'node:path'
import { styleFingerprint, styleLabel } from './stylefp.js'
import { ensureDir, readJson, writeJsonAtomic, nowIso } from './util.js'
import { mkdir, readdir, stat } from 'node:fs/promises'

export const projectProfileFile = (dataDir) => path.join(dataDir, 'project-styles.json')

const IMAGE_EXT = /\.(png|webp|jpe?g)$/i

async function listImages(dir, { max = 60 } = {}) {
  const out = []
  const walk = async (current, level = 0) => {
    if (level > 3 || out.length >= max) return
    let entries = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= max) break
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '_fitted' || entry.name === '截图') continue
        await walk(full, level + 1)
      } else if (entry.isFile() && IMAGE_EXT.test(entry.name) && !/_labeled/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

/** 一组图的风格档案（取中位数，抗离群）。 */
export function profileOf(fingerprints) {
  const list = fingerprints.filter(Boolean)
  if (list.length === 0) return null
  const median = (numbers) => {
    if (numbers.length === 0) return 0
    const sorted = [...numbers].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const colors = new Map()
  for (const fingerprint of list) {
    for (const item of fingerprint.palette ?? []) colors.set(item.hex, (colors.get(item.hex) ?? 0) + (item.share ?? 0))
  }
  return {
    samples: list.length,
    palette: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hex, weight]) => ({ hex, weight: Number(weight.toFixed(3)) })),
    ink: Number(median(list.map((f) => f.ink)).toFixed(3)),
    saturation: Number(median(list.map((f) => f.saturation)).toFixed(3)),
    edgeDensity: Number(median(list.map((f) => f.edgeDensity)).toFixed(3)),
    alphaRatio: Number(median(list.map((f) => f.alphaRatio)).toFixed(3)),
    labels: list.reduce((acc, f) => { const k = styleLabel(f); acc[k] = (acc[k] ?? 0) + 1; return acc }, {}),
  }
}

/**
 * 扫描 output 目录下每个项目，算档案并缓存。
 * @param {{outputDir:string, dataDir:string}} params
 */
export async function buildProjectProfiles({ outputDir, dataDir }) {
  await ensureDir(dataDir)
  let projects = []
  try {
    projects = (await readdir(outputDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { ok: false, error: `读不到输出目录：${outputDir}` }
  }
  const store = (await readJson(projectProfileFile(dataDir), null)) ?? { version: 1, projects: {} }
  const scanned = []
  for (const project of projects) {
    if (project === '截图') continue
    const dir = path.join(outputDir, project)
    const files = await listImages(dir)
    const fingerprints = []
    for (const file of files) {
      try {
        const info = await stat(file)
        if (info.size < 300) continue
        fingerprints.push(styleFingerprint(await (await import('node:fs/promises')).readFile(file)))
      } catch {
        /* 跳过读不了的 */
      }
    }
    const profile = profileOf(fingerprints)
    if (!profile) continue
    store.projects[project] = { ...profile, at: nowIso(), dir }
    scanned.push({ project, samples: profile.samples, label: Object.entries(profile.labels).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '', dominant: profile.palette[0]?.hex ?? '' })
  }
  store.updatedAt = nowIso()
  await writeJsonAtomic(projectProfileFile(dataDir), store)
  return { ok: true, projects: scanned, ...compareProjects(store.projects) }
}

/** 两两比较：相似度低 = 两套美术语言，别互相参考。 */
export function compareProjects(profiles) {
  const names = Object.keys(profiles)
  const pairs = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = profiles[names[i]]
      const b = profiles[names[j]]
      const similarity = similarityOf(a, b)
      pairs.push({
        a: names[i],
        b: names[j],
        similarity,
        verdict: similarity < 0.35
          ? '两套美术语言（差异大）—— 千万别互相引用参考图，会串味'
          : similarity < 0.6
            ? '风格有差异但不算冲突：跨项目参考要谨慎'
            : '风格接近：可以共享参考图',
      })
    }
  }
  pairs.sort((x, y) => x.similarity - y.similarity)
  return {
    pairs,
    warning: pairs.some((pair) => pair.similarity < 0.35)
      ? '检测到跨项目风格差异明显：生成时请只用「同项目」的素材当风格参考。'
      : '各项目风格接近，跨项目参考风险较低。',
  }
}

function similarityOf(a, b) {
  if (!a || !b) return 0
  const setB = new Set((b.palette ?? []).map((item) => item.hex))
  const hit = (a.palette ?? []).filter((item) => {
    if (setB.has(item.hex)) return true
    const [ar, ag, ab] = item.hex.slice(1).match(/../g).map((v) => parseInt(v, 16))
    return (b.palette ?? []).some((other) => {
      const [br, bg, bb] = other.hex.slice(1).match(/../g).map((v) => parseInt(v, 16))
      return Math.abs(ar - br) <= 24 && Math.abs(ag - bg) <= 24 && Math.abs(ab - bb) <= 24
    })
  }).length
  const paletteScore = hit / Math.max(1, (a.palette ?? []).length)
  const inkScore = 1 - Math.min(1, Math.abs((a.ink ?? 0) - (b.ink ?? 0)) / 0.5)
  const satScore = 1 - Math.min(1, Math.abs((a.saturation ?? 0) - (b.saturation ?? 0)) / 0.5)
  const edgeScore = 1 - Math.min(1, Math.abs((a.edgeDensity ?? 0) - (b.edgeDensity ?? 0)) / 0.3)
  return Number((paletteScore * 0.4 + inkScore * 0.2 + satScore * 0.2 + edgeScore * 0.2).toFixed(3))
}

/** 挑参考图时必须同项目：给出该项目的档案（没有就返回 null）。 */
export async function profileForProject(dataDir, project) {
  const store = (await readJson(projectProfileFile(dataDir), null)) ?? { projects: {} }
  return store.projects?.[project] ?? null
}
