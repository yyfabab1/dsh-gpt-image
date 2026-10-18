/**
 * J 组 · 长期演进。
 *
 *   J1 风格指南自动生成 —— 从 approved 素材统计出主色板/常用尺寸/构图/风格词，生成文档
 *   J2 跨项目复用        —— 好素材/好调色板/好模板抽成共享库
 *   J3 风格迁移          —— 把 approved 的风格特征迁移到新图上（比调色板吸附更强）
 *   J4 A/B 测试          —— 同素材两版各跑一段，看数据（框架 + 统计；不伪造结论）
 *   J5 素材目录/图鉴     —— 给策划/美术看的网页版素材库
 *
 * J4 的诚实说明：**本插件不采集游戏运行数据**（那需要埋点/后端）。
 * 这里提供的是"实验设计 + 结果统计"：它告诉你该测什么、怎么判显著，
 * 数据由你/游戏埋点填进来。不编造留存/点击数字。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from './util.js'

// ───────── J1 风格指南自动生成 ─────────

/**
 * J1：从已合格素材统计出一份风格指南。
 * 数据全部来自实测指纹，不是编的。
 *
 * @param {{items:Array<{name:string, fingerprint:object, size?:{width,height}, spec?:object}>}} params
 */
export function buildStyleGuide({ items = [], project = '' } = {}) {
  const valid = items.filter((item) => item?.fingerprint)
  if (valid.length === 0) {
    return { ok: false, error: '没有可统计的素材（需要已合格且带指纹的）' }
  }
  // 主色板：跨多张出现的色才算"这套的底色"
  const colorTally = new Map()
  for (const item of valid) {
    const seen = new Set()
    for (const entry of item.fingerprint.palette ?? []) {
      if ((entry.share ?? 0) < 0.01) continue
      if (seen.has(entry.hex)) continue
      seen.add(entry.hex)
      const record = colorTally.get(entry.hex) ?? { hex: entry.hex, files: 0, weight: 0 }
      record.files += 1
      record.weight += entry.share ?? 0
      colorTally.set(entry.hex, record)
    }
  }
  const palette = [...colorTally.values()]
    .sort((a, b) => b.files - a.files || b.weight - a.weight)
    .slice(0, 16)
    .map((item) => ({ hex: item.hex, used_by: item.files, coverage: Number((item.files / valid.length).toFixed(2)) }))

  // 常用尺寸
  const sizeTally = new Map()
  for (const item of valid) {
    const size = item.size ? `${item.size.width}×${item.size.height}` : null
    if (!size) continue
    const record = sizeTally.get(size) ?? { size, count: 0 }
    record.count += 1
    sizeTally.set(size, record)
  }
  const sizes = [...sizeTally.values()].sort((a, b) => b.count - a.count)

  // 风格统计（取中位数，抗离群）
  const median = (list) => {
    const sorted = list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
    return sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)) : null
  }
  const stats = {
    saturation: median(valid.map((i) => i.fingerprint.saturation)),
    edgeDensity: median(valid.map((i) => i.fingerprint.edgeDensity)),
    ink: median(valid.map((i) => i.fingerprint.ink)),
    alphaRatio: median(valid.map((i) => i.fingerprint.alphaRatio)),
    sampled: valid.length,
  }

  // 风格词（人话）
  const words = []
  if (stats.saturation !== null) words.push(stats.saturation < 0.25 ? '低饱和（冷峻/写实）' : stats.saturation > 0.55 ? '高饱和（明快/卡通）' : '中等饱和')
  if (stats.edgeDensity !== null) words.push(stats.edgeDensity > 0.3 ? '线条明确、轮廓清晰' : stats.edgeDensity < 0.08 ? '柔和过渡、写实光影' : '细节适中')
  if (stats.alphaRatio !== null) words.push(stats.alphaRatio > 0.1 ? '以透明底素材为主' : '以满幅不透明为主')

  return {
    ok: true,
    project,
    generated_at: nowIso(),
    sampled: valid.length,
    palette,
    sizes,
    stats,
    style_words: words,
    // 可直接贴进新 prompt 的段落
    prompt_fragment: `${words.join('，')}。主色 ${palette.slice(0, 4).map((p) => p.hex).join('、')}。`.trim(),
    note: `基于 ${valid.length} 张已合格素材的实测指纹统计（不是猜的）。`,
  }
}

/** J1：把风格指南渲染成 Markdown（给新人/新 agent 看）。 */
export function styleGuideMarkdown(guide) {
  if (!guide?.ok) return '# 风格指南\n\n（无数据）\n'
  const lines = [
    `# 风格指南${guide.project ? ` · ${guide.project}` : ''}`,
    '',
    `> 由 ${guide.sampled} 张已合格素材自动统计，生成于 ${guide.generated_at}`,
    '',
    '## 一句话风格',
    '',
    guide.style_words.join('；') || '（数据不足）',
    '',
    '## 主色板（按使用广度排序）',
    '',
    '| 色值 | 用于 | 覆盖率 |',
    '| --- | --- | --- |',
    ...guide.palette.map((p) => `| \`${p.hex}\` | ${p.used_by} 张 | ${Math.round(p.coverage * 100)}% |`),
    '',
    '## 常用尺寸',
    '',
    ...(guide.sizes.length ? guide.sizes.map((s) => `- ${s.size} —— ${s.count} 张`) : ['（未记录尺寸）']),
    '',
    '## 量化特征',
    '',
    `- 饱和度：${guide.stats.saturation ?? '-'}`,
    `- 线条密度：${guide.stats.edgeDensity ?? '-'}`,
    `- 墨色占比：${guide.stats.ink ?? '-'}`,
    `- 透明占比：${guide.stats.alphaRatio ?? '-'}`,
    '',
    '## 可直接复用的 prompt 段落',
    '',
    '```text',
    guide.prompt_fragment || '',
    '```',
    '',
    '> 把上面这段拼到新 prompt 末尾，新素材会自动往这套风格靠。',
    '',
  ]
  return lines.join('\n')
}

// ───────── J2 跨项目复用 ─────────

export const SHARED_LIB_FILE = 'shared-library.json'

/**
 * J2：共享库 —— 把"好调色板 / 好模板 / 好素材"抽出来给别的项目用。
 *
 * 安全性：跨项目复用**最容易串味**（科幻的配色用在废土上就毁了）。
 * 所以这里只存**与项目绑定**的条目，并记录来源项目；
 * 使用时由调用方显式指定，不做"自动套用"。
 */
export class SharedLibrary {
  constructor(file, data) {
    this.file = file
    this.data = data
  }

  static async load(dataDir) {
    const file = path.join(dataDir, SHARED_LIB_FILE)
    const raw = await readJson(file, null)
    return new SharedLibrary(file, {
      version: 1,
      palettes: raw?.palettes ?? {},
      templates: raw?.templates ?? {},
      entries: raw?.entries ?? {},
    })
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
  }

  /** 存一份调色板（来自某个项目的已合格素材）。 */
  savePalette({ id, project, palette, note = '' }) {
    if (!id || !Array.isArray(palette) || palette.length === 0) {
      return { ok: false, error: '需要 id 和非空调色板' }
    }
    this.data.palettes[id] = { id, project, palette, note, savedAt: nowIso() }
    return { ok: true, id, colors: palette.length }
  }

  saveTemplate({ id, project, template, note = '' }) {
    if (!id || !template) return { ok: false, error: '需要 id 和 template' }
    this.data.templates[id] = { id, project, template, note, savedAt: nowIso() }
    return { ok: true, id }
  }

  /** 存一个素材引用（不复制文件，只记路径 + 特征）。 */
  saveEntry({ id, project, file, tags = [], fingerprint = null, note = '' }) {
    if (!id || !file) return { ok: false, error: '需要 id 和 file' }
    this.data.entries[id] = { id, project, file, tags, fingerprint, note, savedAt: nowIso() }
    return { ok: true, id }
  }

  list(kind = '') {
    const out = []
    if (!kind || kind === 'palette') out.push(...Object.values(this.data.palettes).map((p) => ({ ...p, kind: 'palette' })))
    if (!kind || kind === 'template') out.push(...Object.values(this.data.templates).map((t) => ({ ...t, kind: 'template' })))
    if (!kind || kind === 'entry') out.push(...Object.values(this.data.entries).map((e) => ({ ...e, kind: 'entry' })))
    return out
  }

  get(id) {
    return this.data.palettes[id] ?? this.data.templates[id] ?? this.data.entries[id] ?? null
  }

  /**
   * 复用提示：从共享库取一条，但**明确告诉调用方它的来源项目**。
   * 跨项目用有串味风险，所以调用方要显式确认。
   */
  reuse({ id, targetProject = '' } = {}) {
    const item = this.get(id)
    if (!item) return { ok: false, error: `共享库里没有 ${id}` }
    const crossProject = item.project && targetProject && item.project !== targetProject
    return {
      ok: true,
      item,
      cross_project: Boolean(crossProject),
      warning: crossProject
        ? `⚠ 这条来自「${item.project}」，而你现在做的是「${targetProject}」—— 跨项目复用容易串味，确认两边的美术方向一致再用。`
        : '',
      note: '共享库只做引用，不复制文件 —— 素材本体仍在原项目里。',
    }
  }
}

// ───────── J3 风格迁移 ─────────

/**
 * J3：把参考风格迁移到目标图上。
 *
 * 比"调色板吸附"更强的地方：不只用色板，还对齐**明暗分布**与**对比度**，
 * 所以能处理"同样的颜色但整体偏灰/偏亮"这类差异。
 *
 * 做法（确定性，无模型）：
 *   1. 统计参考图的亮度分布（p10/p50/p90）与饱和度中位
 *   2. 把目标图的亮度**直方图匹配**到参考的分布（保持色相与结构）
 *   3. 饱和度向参考靠拢
 * 不是 AI 风格迁移，但对"同一套素材内部统一"这类需求足够且可控。
 *
 * @param {{target:{pixels,width,height}, reference:{pixels,width,height}, strength?:number, keepHue?:boolean}} params
 */
export function transferStyle({ target, reference, strength = 1, keepHue = true }) {
  if (!target?.pixels || !reference?.pixels) return { ok: false, error: '需要 target 与 reference 的像素' }
  const k = Math.max(0, Math.min(1, strength))

  const luminanceStats = (image) => {
    const lums = []
    for (let i = 0; i < image.pixels.length; i += 4) {
      if (image.pixels[i + 3] < 24) continue
      lums.push(0.299 * image.pixels[i] + 0.587 * image.pixels[i + 1] + 0.114 * image.pixels[i + 2])
    }
    if (lums.length === 0) return null
    lums.sort((a, b) => a - b)
    const at = (p) => lums[Math.min(lums.length - 1, Math.floor(lums.length * p))]
    return { p10: at(0.1), p50: at(0.5), p90: at(0.9) }
  }
  const saturationMedian = (image) => {
    const sats = []
    for (let i = 0; i < image.pixels.length; i += 4) {
      if (image.pixels[i + 3] < 24) continue
      const max = Math.max(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2])
      const min = Math.min(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2])
      sats.push(max > 0 ? (max - min) / max : 0)
    }
    if (sats.length === 0) return null
    sats.sort((a, b) => a - b)
    return sats[Math.floor(sats.length / 2)]
  }

  const refLum = luminanceStats(reference)
  const tgtLum = luminanceStats(target)
  const refSat = saturationMedian(reference)
  const tgtSat = saturationMedian(target)
  if (!refLum || !tgtLum) return { ok: false, error: '有一边没有不透明像素' }

  const out = new Uint8ClampedArray(target.pixels)
  const satScale = (refSat !== null && tgtSat !== null && tgtSat > 0.01) ? refSat / tgtSat : 1

  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 24) continue
    const r = out[i]
    const g = out[i + 1]
    const b = out[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b

    // 亮度映射：把目标的 [p10,p50,p90] 线性映射到参考的 [p10,p50,p90]（分段，保住中间调）
    let mapped
    if (lum <= tgtLum.p50) {
      const span = Math.max(1, tgtLum.p50 - tgtLum.p10)
      mapped = refLum.p10 + ((lum - tgtLum.p10) / span) * (refLum.p50 - refLum.p10)
    } else {
      const span = Math.max(1, tgtLum.p90 - tgtLum.p50)
      mapped = refLum.p50 + ((lum - tgtLum.p50) / span) * (refLum.p90 - refLum.p50)
    }
    mapped = Math.max(0, Math.min(255, mapped))
    const newLum = lum + (mapped - lum) * k

    if (keepHue) {
      // 保色相：按亮度比例缩放 RGB（等比 → 色相不变）
      const scale = lum > 1 ? newLum / lum : 1
      out[i] = Math.max(0, Math.min(255, r * scale))
      out[i + 1] = Math.max(0, Math.min(255, g * scale))
      out[i + 2] = Math.max(0, Math.min(255, b * scale))
      // 饱和度靠拢
      if (Math.abs(satScale - 1) > 0.05) {
        const grey = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]
        const satK = 1 + (satScale - 1) * k
        out[i] = Math.max(0, Math.min(255, grey + (out[i] - grey) * satK))
        out[i + 1] = Math.max(0, Math.min(255, grey + (out[i + 1] - grey) * satK))
        out[i + 2] = Math.max(0, Math.min(255, grey + (out[i + 2] - grey) * satK))
      }
    } else {
      // 不保色相：直接压成参考的亮度（等于去色 + 重新上亮度）
      out[i] = out[i + 1] = out[i + 2] = newLum
    }
  }

  return {
    ok: true,
    pixels: out,
    width: target.width,
    height: target.height,
    measured: {
      reference: { ...refLum, saturation: refSat },
      target: { ...tgtLum, saturation: tgtSat },
      saturation_scale: Number(satScale.toFixed(3)),
    },
    note: '这是**确定性**的亮度/饱和度对齐（不是 AI 风格迁移）—— 对"同一套素材内部统一"足够可控，且可复现。',
  }
}

// ───────── J4 A/B 测试 ─────────

/**
 * J4：A/B 实验设计 + 结果判定。
 *
 * **本插件不采集游戏运行数据**（那要埋点/后端）。它做的是：
 *   1. 帮你把"该测什么、测多少"定下来（样本量估算）
 *   2. 数据回来后判定差异是否显著（不靠肉眼）
 * 绝不编造留存/点击数字。
 */
export function designAbTest({ metric = 'retention', baselineRate = 0.1, minDetectableEffect = 0.02, power = 0.8, alpha = 0.05 } = {}) {
  if (!(baselineRate > 0 && baselineRate < 1)) return { ok: false, error: 'baselineRate 要在 0..1 之间' }
  if (!(minDetectableEffect > 0)) return { ok: false, error: 'minDetectableEffect 要 > 0' }
  // 两比例检验的样本量估算（常用近似公式）
  const zAlpha = alpha <= 0.01 ? 2.576 : alpha <= 0.05 ? 1.96 : 1.645
  const zBeta = power >= 0.9 ? 1.282 : power >= 0.8 ? 0.842 : 0.524
  const p1 = baselineRate
  const p2 = Math.min(0.999, baselineRate + minDetectableEffect)
  const pBar = (p1 + p2) / 2
  const n = Math.ceil(((zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) / ((p2 - p1) ** 2))
  return {
    ok: true,
    metric,
    baseline_rate: baselineRate,
    detectable_effect: minDetectableEffect,
    per_variant: n,
    total_needed: n * 2,
    assumption: `要在 ${alpha} 显著性下以 ${Math.round(power * 100)}% 把握检出 ${(minDetectableEffect * 100).toFixed(1)} 个百分点的差异`,
    note: `每个版本需要约 ${n} 次观测（两版合计 ${n * 2}）。样本不够就先别下结论 —— 小样本的差异多半是噪声。`,
    design_steps: [
      '1. 两个版本用同一条素材但不同处理（如 A=原版，B=高亮版）',
      '2. 随机分流，两版同时上线（不要先跑 A 再跑 B，会有时间偏差）',
      '3. 跑够上面算出的样本量',
      '4. 把结果填进 analyzeAbTest，它来判显著性',
    ],
  }
}

/** J4：结果判定（两比例 z 检验）。 */
export function analyzeAbTest({ a = { views: 0, conversions: 0 }, b = { views: 0, conversions: 0 }, alpha = 0.05 } = {}) {
  const va = Number(a.views)
  const vb = Number(b.views)
  if (!(va > 0) || !(vb > 0)) return { ok: false, error: '两个版本都需要 views > 0' }
  const pa = Number(a.conversions) / va
  const pb = Number(b.conversions) / vb
  const pBar = (Number(a.conversions) + Number(b.conversions)) / (va + vb)
  const se = Math.sqrt(pBar * (1 - pBar) * (1 / va + 1 / vb))
  if (se === 0) {
    return { ok: true, rate_a: pa, rate_b: pb, lift: 0, z: 0, significant: false, verdict: 'no_difference', note: '两版结果完全一样。' }
  }
  const z = (pb - pa) / se
  const zCrit = alpha <= 0.01 ? 2.576 : alpha <= 0.05 ? 1.96 : 1.645
  const significant = Math.abs(z) > zCrit
  const lift = pa > 0 ? Number(((pb - pa) / pa).toFixed(4)) : null
  return {
    ok: true,
    rate_a: Number(pa.toFixed(4)),
    rate_b: Number(pb.toFixed(4)),
    lift,
    z: Number(z.toFixed(3)),
    z_critical: zCrit,
    significant,
    winner: !significant ? null : (pb > pa ? 'B' : 'A'),
    verdict: !significant ? 'no_difference' : (pb > pa ? 'b_better' : 'a_better'),
    advice: !significant
      ? `差异不显著（z=${z.toFixed(2)}，阈值 ±${zCrit}）—— 现在还看不出哪个更好，继续跑或接受"两者差不多"。`
      : `${pb > pa ? 'B' : 'A'} 版更好（${(pa * 100).toFixed(1)}% → ${(pb * 100).toFixed(1)}%，提升 ${lift === null ? '-' : Math.round(lift * 100) + '%'}，z=${z.toFixed(2)}）。`,
    honesty: '这个判定只回答"差异是否显著"，不回答"差异是否值得"—— 那是产品和美术的判断。',
  }
}

// ───────── J5 素材图鉴（网页版） ─────────

/**
 * J5：生成一个**自包含**的 HTML 素材图鉴（给策划/美术看）。
 *
 * "自包含"很关键：图片以内联 data URL 嵌入，双击就能看，不依赖服务器、
 * 不依赖相对路径 —— 发给别人也不会因为路径不对而全是裂图。
 *
 * @param {{scan:object, reviewStats?:object, title?:string, maxInline?:number, inlineBytes?:number}} params
 */
export function buildGalleryHtml({ scan, reviewStats = null, title = '素材图鉴', maxInline = 300, inlineBytes = 6 * 1024 * 1024 } = {}) {
  const files = (scan?.files ?? []).slice(0, maxInline)
  const tally = scan?.tally ?? {}
  const rows = files.map((item) => ({
    name: item.name,
    project: item.project,
    kind: item.kind,
    review: item.review_state ?? 'unreviewed',
    file: item.file,
    size: item.bytes,
    generated: item.generated,
  }))
  const byProject = new Map()
  for (const row of rows) {
    if (!byProject.has(row.project)) byProject.set(row.project, [])
    byProject.get(row.project).push(row)
  }

  const tag = (text, cls) => `<span class="tag ${cls}">${escapeHtml(text)}</span>`
  const sections = [...byProject.entries()].map(([project, list]) => `
  <section>
    <h2>${escapeHtml(project)} <small>${list.length} 张</small></h2>
    <div class="grid">
      ${list.map((row) => `
      <div class="card" data-kind="${row.kind}" data-review="${row.review}" data-name="${escapeHtml(row.name)}">
        <div class="thumb" data-src="${escapeHtml(row.file)}"></div>
        <div class="meta">
          <div class="name">${escapeHtml(row.name)}</div>
          <div class="tags">
            ${tag(row.kind, 'kind')}
            ${tag({ approved: '合格', rejected: '不合格', pending: '待定', unreviewed: '未审核' }[row.review], row.review)}
            ${row.generated ? '' : tag('外部产物', 'external')}
          </div>
        </div>
      </div>`).join('')}
    </div>
  </section>`).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
 body{margin:0;font:14px/1.5 system-ui,"Segoe UI",sans-serif;background:#0f1117;color:#e6e8ee}
 header{padding:18px 22px;border-bottom:1px solid #262b36;position:sticky;top:0;background:#0f1117;z-index:2}
 h1{margin:0 0 6px;font-size:18px} h2{font-size:15px;margin:22px 0 10px}
 h2 small{opacity:.6;font-weight:400}
 .stats{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;opacity:.85}
 .filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
 button{font:inherit;font-size:12px;cursor:pointer;background:#171a22;color:#c2c9d6;border:1px solid #262b36;border-radius:8px;padding:4px 10px}
 button.on{background:#8b5cf6;color:#fff;border-color:#8b5cf6}
 main{padding:0 22px 60px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
 .card{border:1px solid #262b36;border-radius:10px;overflow:hidden;background:#141822}
 .thumb{height:130px;background:repeating-conic-gradient(#2a2f3a 0% 25%,#20242c 0% 50%) 50%/16px 16px;display:flex;align-items:center;justify-content:center}
 .thumb img{max-width:100%;max-height:100%;display:block}
 .meta{padding:7px 9px}
 .name{font-weight:600;font-size:12px;word-break:break-all}
 .tags{margin-top:4px;display:flex;gap:4px;flex-wrap:wrap}
 .tag{font-size:10.5px;border:1px solid #2c3340;border-radius:999px;padding:0 6px;opacity:.9}
 .tag.approved{border-color:#4ade80;color:#4ade80}
 .tag.rejected{border-color:#f87171;color:#f87171}
 .tag.pending{border-color:#fbbf24;color:#fbbf24}
 .tag.external{border-color:#a78bfa;color:#a78bfa}
</style></head><body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="stats">
    <span>共 ${tally.total ?? rows.length} 张</span>
    <span>合格 ${tally.approved ?? 0}</span>
    <span>不合格 ${tally.rejected ?? 0}</span>
    <span>未审核 ${tally.unreviewed ?? 0}</span>
    <span>外部产物 ${tally.external ?? 0}</span>
    <span>生成于 ${escapeHtml(nowIso())}</span>
  </div>
  <div class="filters">
    <button class="on" data-f="all">全部</button>
    <button data-f="review:approved">只看合格</button>
    <button data-f="review:unreviewed">只看未审核</button>
    <button data-f="kind:slice">切片</button>
    <button data-f="kind:resized">缩放件</button>
    <button data-f="kind:screenshot">截图</button>
  </div>
</header>
<main>${sections || '<p>没有素材。</p>'}</main>
<script>
 // 图片是**本地路径**：这个页面和素材在同一台机器上，用 file:// 直接显示。
 // 之所以不内联 data URL：几百张图内联会让 HTML 涨到几十 MB，反而打不开。
 // 发给别人时记得连同素材目录一起给，或改用"导出内联版"。
 var cards=[].slice.call(document.querySelectorAll('.card'));
 cards.forEach(function(c){
   var box=c.querySelector('.thumb'); var src=box.getAttribute('data-src');
   var img=document.createElement('img'); img.loading='lazy'; img.src='file:///'+src.replace(/\\\\/g,'/');
   img.onerror=function(){ box.textContent='（图打不开：需和素材目录放一起）'; box.style.fontSize='11px'; box.style.opacity='.6' };
   box.appendChild(img);
 });
 var btns=[].slice.call(document.querySelectorAll('.filters button'));
 btns.forEach(function(b){ b.onclick=function(){
   btns.forEach(function(x){x.classList.remove('on')}); b.classList.add('on');
   var f=b.getAttribute('data-f');
   cards.forEach(function(c){
     var show = f==='all' || (f.indexOf('review:')===0 && c.getAttribute('data-review')===f.split(':')[1])
             || (f.indexOf('kind:')===0 && c.getAttribute('data-kind')===f.split(':')[1]);
     c.style.display = show ? '' : 'none';
   });
 }});
</script>
</body></html>`
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
