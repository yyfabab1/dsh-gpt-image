/**
 * 风格参考：游戏里已经有素材库时，**拿现有素材当参考图**再生新的，
 * 避免新图和老图风格不一致（画风、线条、配色、像素密度）。
 *
 * 挑参考图的优先级：
 *   1) 游戏目录里同一分类的现有素材（卡牌配卡牌、图标配图标……）
 *   2) 该项目已经生成过的其它图（同项目同风格）
 *   3) 调用方显式给的 style_refs
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { styleSimilarity } from './stylefp.js'
import { scoreReference } from './refpick.js'

const IMAGE_EXT = /\.(png|webp|jpe?g)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'out', '_fitted', '截图'])
const CATEGORY_HINTS = {
  card: /card|牌|卡/i,
  icon: /icon|图标|item|物品/i,
  portrait: /portrait|立绘|头像|char|hero|npc/i,
  tile: /tile|地形|瓦片|ground|wall|wx_/i,
  ui: /ui|按钮|面板|frame|panel|button/i,
  enemy: /enemy|monster|怪|boss/i,
  background: /bg|background|背景|sky/i,
}

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
    } else if (entry.isFile() && IMAGE_EXT.test(entry.name)) files.push(full)
  }
  return files
}

/** 判断一张图是否够格当参考（太小/太薄的不要）。 */
async function usable(file) {
  try {
    const info = await stat(file)
    return info.size > 3000
  } catch {
    return false
  }
}

/**
 * @param {{root?:string, outputDir?:string, project?:string, kind?:string, keys?:string[], max?:number,
 *          exclude?:string[], index?:object, useFingerprint?:boolean, targetFingerprint?:object}} params
 */
export async function pickStyleRefs({ root = '', outputDir = '', project = '', kind = '', keys = [], max = 2, exclude = [], index = null, useFingerprint = false, targetFingerprint = null, targetSize = '', targetKind = '' } = {}) {
  const excluded = new Set(exclude.map((file) => path.resolve(file)))
  const hint = CATEGORY_HINTS[String(kind).toLowerCase()] ?? null
  const picks = []
  const considered = []
  let crossProjectBlocked = false

  const take = async (file, reason, score) => {
    const resolved = path.resolve(file)
    if (excluded.has(resolved)) return
    if (picks.some((item) => item.file === resolved)) return
    if (!(await usable(resolved))) return
    picks.push({ file: resolved, reason, score })
  }

  // 1) 游戏目录里的现有素材：分类匹配优先，其次名字里带同类关键词
  if (root) {
    const files = await walk(root)
    for (const file of files) {
      const base = path.basename(file)
      let score = 0
      let reason = ''
      if (hint && hint.test(base)) {
        score = 3
        reason = `游戏里同分类素材（${kind}）`
      } else if (keys.some((key) => base.includes(key))) {
        score = 2
        reason = '游戏里同一批素材的邻居'
      } else if (/(^|[\\/])(assets|images|img|art|sprites|icons|素材)([\\/]|$)/i.test(file)) {
        score = 1
        reason = '游戏素材目录里的现有图'
      }
      if (score > 0) considered.push({ file, score, reason })
    }
  }

  // 2) 本项目已经生成过的图（同风格）
  if (outputDir && project) {
    const dir = path.join(outputDir, project)
    const files = await walk(dir, { depth: 3 })
    for (const file of files) {
      if (/[\\/]_fitted[\\/]/.test(file)) continue
      considered.push({ file, score: 2, reason: '本项目已生成的图（同风格）' })
    }
  } else if (outputDir && !project) {
    // 没指定项目时**绝不跨项目挑**：宁可没有参考图，也不要串味
    crossProjectBlocked = true
  }

  // 3) 打分：宽高比 + 分类 + 风格指纹（都用 scoreReference 统一算，避免各算各的）
  for (const candidate of considered) {
    const fingerprint = index ? (index[candidate.file] ?? index[path.resolve(candidate.file)]) : null
    const scored = scoreReference(
      {
        name: path.basename(candidate.file),
        entry: fingerprint,
        kind: candidate.group ?? '',
        size: fingerprint?.size ?? '',
      },
      { targetKind: targetKind || kind, targetSize, targetFingerprint },
    )
    candidate.score += scored.score
    if (fingerprint && targetFingerprint) {
      const similarity = styleSimilarity(fingerprint, targetFingerprint)
      candidate.reason += `（风格相似度 ${similarity}）`
    }
    candidate.detail = scored.parts
  }

  considered.sort((a, b) => b.score - a.score || a.file.length - b.file.length)
  for (const candidate of considered) {
    if (picks.length >= max) break
    await take(candidate.file, candidate.reason, candidate.score)
  }

  return {
    ok: true,
    refs: picks.slice(0, max).map((item) => ({ file: item.file, reason: item.reason, score: Number((item.score ?? 0).toFixed(2)) })),
    files: picks.slice(0, max).map((item) => item.file),
    cross_project_blocked: crossProjectBlocked,
    note: picks.length === 0
      ? '没找到可用作风格参考的现有素材（游戏目录里没有符合条件的图，项目也还没生成过）——这次只能纯文字描述风格。'
      : `用 ${picks.length} 张**同项目**素材当风格参考${useFingerprint && targetFingerprint ? '（已按风格指纹排序）' : ''}，避免跨项目串味。`,
  }
}

/** 把风格一致性要求拼进提示词。 */
export function stylePrompt(prompt, refs = []) {
  const base = String(prompt ?? '').trim()
  if (!refs || refs.length === 0) return base
  return `${base} —— strictly match the art style, palette, line weight and level of detail of the provided reference image(s); same visual language, no style drift.`
}
