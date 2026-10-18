/**
 * 提示词库：把「画得好的提示词」和「画废的提示词」都记下来，下次直接复用/避开。
 *
 * 为什么省事又省钱：反复调提示词是这个流程里最花时间、也最容易重复烧钱的部分。
 * 这里把每次生成结果和提示词一起记：自检通过的进 good（可复用），
 * 废图进 bad（带原因），下次生成前先查一遍，命中就直接用以前成功的措辞。
 */
import path from 'node:path'
import { nowIso, readJson, sha256, writeJsonAtomic } from './util.js'

export const promptFile = (dataDir) => path.join(dataDir, 'prompts.json')
export const DEFAULT_LIBRARY = { version: 1, entries: {} }

/**
 * 【第七十三轮 · 实战验证过的风格配方】直接用 `style` 传进 sheet/generate 即可。
 *
 * 为什么要有这一条：**只写 "pixel art" 是没用的** —— 实测模型照样给写实厚涂。
 * 必须把话说死：句首 "PIXEL ART ONLY" + 一串**否定约束**
 * （no anti-aliasing / no smooth gradients / hard pixel edges）+ 限色板。
 *
 * 【本轮补充 · 针对"伪像素"的三个关键措辞】
 * 实测发现：模型给的"像素风"图往往是**高分辨率插画**，块大小不一致（precision 只有 0.3），
 * 所以除了"风格"，还必须把**网格本身**说清楚：
 *   · 明确「严格等大的正方形像素，对齐到一套网格」—— 这是块大小一致的前提；
 *   · 明确「no anti-aliasing / no blur / no soft edges」—— 抗锯齿会让边缘出现中间色；
 *   · 给出**可数的行列数**（"exactly 32 columns and 32 rows of visible pixels"）——
 *     让模型有一个可数的目标，比只说"pixel art"稳定得多（`pixelStyleFor` 会填这个数）。
 *   · 明确「一个像素只有一种颜色，没有渐变过渡」。
 *
 * 另外两条**同一轮撞出来的**经验，配套的代码已经写进 autotrim.js：
 *   · 模板里写 "pure transparent background" 也**不可信** —— 像素风的格子常被填成平底，
 *     所以切图后有一步 keyOutFlatBackground() 抠底；
 *   · 模型会在格子之间画网格线 —— 切图后有一步 trimEdgeStripes() 把它收掉，
 *     否则那道线既成为直条纹、又会把内容包围盒撑到整格让居中和缩放失效。
 * 这两步在 sheet.js 的 computeSlices 里**默认开启**（clean:true）。
 */
export const PIXEL_ART_STYLE = [
  'PIXEL ART ONLY.',
  '16-bit SNES-era pixel art game illustration,',
  'strict uniform square pixel grid, every pixel exactly the same size, aligned to the grid,',
  'chunky clearly visible square pixels, hard pixel edges,',
  'exactly one flat colour per pixel, no anti-aliasing, no blur, no soft edges,',
  'no smooth gradients, no dithering noise, flat dithered shading only,',
  'limited 24-colour palette,',
  'retro 1990s video game sprite art,',
  'dark muted palette, no text, no watermark',
].join(' ')

/**
 * 针对「给定逻辑分辨率」的像素画风格提示词。
 *
 * 这个函数存在的理由很具体：本轮实测发现 AI 的「像素风」图**块大小不一致**
 * （1248×832 的图里最佳候选周期的 precision 只有 0.28~0.46），
 * 所以光说风格没用，得把**网格**说成可数的东西 ——
 * 「正好 32 列 32 行可见像素」比「pixel art」有效得多。
 *
 * @param {{width?:number, height?:number, colors?:number, extra?:string}} options
 * @returns {string} 可直接作为 `style` 传入的提示词
 */
export function pixelStyleFor({ width = 0, height = 0, colors = 0, extra = '' } = {}) {
  const parts = [PIXEL_ART_STYLE]
  if (width > 0 && height > 0) {
    parts.push(
      `The artwork is a ${width}×${height} pixel sprite: you can count exactly ${width} columns and ${height} rows of visible pixels,`,
      `each pixel covers exactly the same square area (the whole image is ${width}×${height} logical pixels upscaled by an integer factor with nearest-neighbour),`,
      'every pixel is a solid single colour — no pixel contains a gradient, a blend, or a partial edge',
    )
  } else if (width > 0) {
    parts.push(`The artwork is ${width} logical pixels wide with uniform square pixels on a strict grid`)
  }
  if (colors > 0) parts.push(`use at most ${colors} flat colours in total`)
  if (extra) parts.push(String(extra))
  return parts.join(' ')
}

/** 判断一段提示词是不是已经在讲像素画（避免重复追加风格）。 */
export function mentionsPixelArt(prompt) {
  return /pixel\s*art|pixelart|像素画|像素图|pixel\s*sprite|8-?bit|16-?bit/i.test(String(prompt ?? ''))
}

/** 为「要求像素化」的出图自动补一段网格约束（已有像素画措辞时不重复塞）。 */
export function pixelPromptSuffix(pixel, { existingPrompt = '' } = {}) {
  if (!pixel || pixel === false) return ''
  const width = Number(pixel?.width) || 0
  const height = Number(pixel?.height) || 0
  const colors = Number(pixel?.palette) || 0
  const style = pixelStyleFor({ width, height, colors })
  if (mentionsPixelArt(existingPrompt)) {
    // 已经说了是像素画 —— 只补最关键的"等大 + 硬边 + 可数行列"，不重复整段风格
    const parts = ['strictly uniform square pixels on one grid, every pixel exactly the same size']
    if (width > 0) parts.push(`exactly ${width}${height > 0 ? `×${height}` : ''} logical pixels, countable rows and columns`)
    if (colors > 0) parts.push(`at most ${colors} flat colours`)
    parts.push('no anti-aliasing, no blur, no gradients, one flat colour per pixel')
    return parts.join(', ')
  }
  return style
}

/**
 * 合集图（sprite sheet）的**格子卫生**经验，供提示词里强调。
 * 即便提示词写了，也必须靠 computeSlices 的 clean 兜底 —— 见上面注释。
 */
export const SHEET_HYGIENE_NOTE = [
  'strict even grid, each item centered in its own cell with clear padding between cells',
  'no grid lines, no borders, no cell frames, no background panel behind items',
  'pure transparent background (no flat colour fill, no rectangle)',
  'no text, no labels, no watermark',
].join(', ')


/** 提示词归一化：去掉多余空白与大小写差异，便于命中。 */
export function normalizePrompt(prompt) {
  return String(prompt ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function promptKey(prompt) {
  return sha256(normalizePrompt(prompt)).slice(0, 16)
}

export class PromptLibrary {
  constructor(file, data) {
    this.file = file
    this.data = { ...DEFAULT_LIBRARY, ...data }
    if (!this.data.entries || typeof this.data.entries !== 'object') this.data.entries = {}
  }

  static async load(dataDir) {
    const file = promptFile(dataDir)
    return new PromptLibrary(file, (await readJson(file, null)) ?? {})
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  /**
   * 记一次结果。
   * @param {{prompt:string, verdict:'good'|'bad'|'needs-fit', project?:string, name?:string,
   *          kind?:string, size?:string, problems?:string[], files?:string[]}} record
   */
  record({ prompt, verdict, project = '', name = '', kind = '', size = '', problems = [], files = [] }) {
    const key = promptKey(prompt)
    const existing = this.data.entries[key] ?? {
      key,
      prompt: String(prompt).slice(0, 2000),
      project,
      name,
      kind,
      size,
      good: 0,
      bad: 0,
      problems: [],
      sample_files: [],
      firstAt: nowIso(),
    }
    if (verdict === 'good' || verdict === 'needs-fit') existing.good += 1
    else existing.bad += 1
    for (const problem of problems.slice(0, 3)) {
      if (!existing.problems.includes(problem)) existing.problems.push(problem)
    }
    if (existing.problems.length > 6) existing.problems = existing.problems.slice(0, 6)
    if (files.length) existing.sample_files = files.slice(0, 3)
    existing.verdict = existing.good > existing.bad ? 'good' : existing.bad > 0 ? 'bad' : 'unknown'
    existing.lastAt = nowIso()
    this.data.entries[key] = existing
    return existing
  }

  /** 查这条提示词以前的表现（命中就少走弯路）。 */
  lookup(prompt) {
    const entry = this.data.entries[promptKey(prompt)]
    if (!entry) return null
    return {
      ...entry,
      advice: entry.verdict === 'good'
        ? `这条提示词以前成功过 ${entry.good} 次，可以直接复用。`
        : entry.verdict === 'bad'
          ? `这条提示词以前画废过 ${entry.bad} 次（${entry.problems.slice(0, 2).join('；')}）—— 换措辞再试。`
          : '这条提示词成败各半，谨慎复用。',
    }
  }

  /** 成功模板：可直接拿来当骨架。 */
  goodTemplates({ kind = '', limit = 10 } = {}) {
    return Object.values(this.data.entries)
      .filter((entry) => entry.verdict === 'good' && entry.good > 0)
      .filter((entry) => !kind || entry.kind === kind)
      .sort((a, b) => b.good - a.good)
      .slice(0, limit)
      .map((entry) => ({ prompt: entry.prompt, good: entry.good, kind: entry.kind, size: entry.size, sample: entry.sample_files?.[0] }))
  }

  /** 避坑清单：画废过的措辞及其原因。 */
  pitfalls({ limit = 10 } = {}) {
    return Object.values(this.data.entries)
      .filter((entry) => entry.bad > 0)
      .sort((a, b) => b.bad - a.bad)
      .slice(0, limit)
      .map((entry) => ({ prompt: entry.prompt.slice(0, 160), bad: entry.bad, problems: entry.problems }))
  }

  stats() {
    const entries = Object.values(this.data.entries)
    return {
      total: entries.length,
      good: entries.filter((entry) => entry.verdict === 'good').length,
      bad: entries.filter((entry) => entry.verdict === 'bad').length,
      reuses: entries.reduce((sum, entry) => sum + Math.max(0, entry.good - 1), 0),
    }
  }
}
