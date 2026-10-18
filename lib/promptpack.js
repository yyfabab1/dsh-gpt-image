/**
 * 项目提示词包（prompt pack）：**一个项目一套固定提示词**，用来锁死画风。
 *
 * 为什么需要它（真实痛点）：
 *   同一个项目里分十次出图，每次只写「火焰塔图标」，模型就会给你十种画风 ——
 *   有的厚涂、有的描边、有的偏写实。这不是模型不行，是**你没有把"这个项目长什么样"告诉它**。
 *   项目里本来就有 `asset-specs.json` 管尺寸/透明，但没有东西管**画风**，这个模块补的就是这块。
 *
 * 设计依据（不是拍脑袋，来自 OpenAI 官方 gpt-image-2 提示词指南）：
 *   1. 「按**固定顺序**写提示词：背景/场景 → 主体 → 关键细节 → 约束」，
 *      并声明**用途**（game asset / icon / card）来设定"模式"和精细度。→ composePrompt 的顺序
 *   2. 「**Character Anchor**：建立一个可复用的角色锚点，锁住外观/比例/服装/气质，
 *      之后每张都复用它」→ pack.characters + pack.references
 *   3. 「**Constraints**：显式写排除项和不变项（no watermark / no extra text / preserve ...）」
 *      → pack.negative + pack.preserve
 *   4. 「透明底：要显式排除 scenery / backdrop / checkerboard / shadows」→ transparentClause()
 *   5. 「多图输入用**序号+描述**引用（Image 1: ... / Image 2: style reference）」→ referenceClause()
 *
 * 文件位置（跟着项目走，随项目一起备份/迁移）：
 *   <输出目录>/<项目>/prompt-pack.json      项目自己的包
 *   <数据目录>/prompt-pack.json             全局默认包（新项目继承它）
 * 两个都不存在时不影响出图 —— 只是不追加任何东西（**纯加法**，不会改变现有行为）。
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { readJson } from './util.js'

export const PACK_FILE = 'prompt-pack.json'
export const PACK_VERSION = 1

/** 一个"空包"：什么都没配，composePrompt 会原样返回用户提示词。 */
export function emptyPack() {
  return {
    version: PACK_VERSION,
    name: '',
    use: '',            // 用途：game asset / icon / card art / ui mock …
    style: '',          // 固定画风（锚点）
    composition: '',    // 构图/视角/光线
    palette: [],        // 调色板（也用于 snapToPalette 与协调性检查）
    negative: [],       // 排除项（no watermark / no text …）
    preserve: [],       // 不变项（preserve silhouette / preserve palette …）
    transparent: null,  // true = 要透明底；null = 不表态
    references: [],     // 全局风格参考图（本地路径）
    characters: {},     // { 角色名: { desc, ref } } —— 角色锚点
    kinds: {},          // { icon: { style, composition, size, quality, transparent } }
    defaults: {},       // { size, quality, ratio, palette }
    updatedAt: '',
  }
}

const ARRAY_FIELDS = ['palette', 'negative', 'preserve', 'references']

/** 把任意对象规范化成合法 pack（缺字段补默认、类型不对就丢掉，不抛异常）。 */
export function normalizePack(raw) {
  const out = emptyPack()
  if (!raw || typeof raw !== 'object') return out
  for (const key of ['name', 'use', 'style', 'composition']) {
    if (typeof raw[key] === 'string') out[key] = raw[key].trim()
  }
  for (const key of ARRAY_FIELDS) {
    if (Array.isArray(raw[key])) {
      out[key] = raw[key].map((v) => String(v ?? '').trim()).filter(Boolean)
    }
  }
  if (raw.transparent === true || raw.transparent === false) out.transparent = raw.transparent
  if (raw.characters && typeof raw.characters === 'object' && !Array.isArray(raw.characters)) {
    for (const [name, value] of Object.entries(raw.characters)) {
      if (!value || typeof value !== 'object') continue
      out.characters[String(name)] = {
        desc: typeof value.desc === 'string' ? value.desc.trim() : '',
        ref: typeof value.ref === 'string' ? value.ref.trim() : '',
      }
    }
  }
  for (const group of ['kinds', 'defaults']) {
    if (raw[group] && typeof raw[group] === 'object' && !Array.isArray(raw[group])) {
      for (const [key, value] of Object.entries(raw[group])) {
        if (!value || typeof value !== 'object') continue
        const cleaned = {}
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined || v === null) continue
          if (Array.isArray(v)) cleaned[k] = v.map(String)
          else cleaned[k] = typeof v === 'string' ? v.trim() : v
        }
        out[group][String(key)] = cleaned
      }
    }
  }
  if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt
  return out
}

/** 合并两套包：后者覆盖前者（数组取后者非空时的并集，空则沿用前者）。 */
export function mergePacks(base, override) {
  const a = normalizePack(base)
  const b = normalizePack(override)
  const out = normalizePack({ ...a, ...b })
  for (const key of ['name', 'use', 'style', 'composition']) {
    out[key] = b[key] || a[key]
  }
  for (const key of ARRAY_FIELDS) {
    // 调色板/排除项这类"清单"取并集更合理：默认包的全项目通用，项目包再补自己的
    out[key] = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])]
  }
  out.transparent = b.transparent === null ? a.transparent : b.transparent
  out.characters = { ...a.characters, ...b.characters }
  out.kinds = { ...a.kinds, ...b.kinds }
  out.defaults = { ...a.defaults, ...b.defaults }
  return out
}

/** 项目包文件路径。 */
export function packPath({ outputDir, project }) {
  return path.join(outputDir, project || 'default', PACK_FILE)
}

/** 全局默认包路径。 */
export function globalPackPath({ dataDir }) {
  return path.join(dataDir ?? '.', PACK_FILE)
}

/**
 * 读某个项目最终生效的包 = 全局默认 ⊕ 项目包。
 * 两个文件都不存在 → 返回 null（表示"这个项目没配画风"，调用方应保持原行为）。
 */
export async function loadPromptPack({ outputDir, project, dataDir }) {
  const globalRaw = dataDir ? await readJson(globalPackPath({ dataDir }), null) : null
  const projectRaw = outputDir && project ? await readJson(packPath({ outputDir, project }), null) : null
  if (!globalRaw && !projectRaw) return null
  const merged = mergePacks(globalRaw ?? {}, projectRaw ?? {})
  merged.source = {
    global: Boolean(globalRaw),
    project: Boolean(projectRaw),
    file: projectRaw ? packPath({ outputDir, project }) : globalPackPath({ dataDir }),
  }
  return merged
}

/** 保存项目包（或全局包，project 传空字符串时）。 */
export async function savePromptPack({ outputDir, project, dataDir, pack }) {
  const normalized = normalizePack(pack)
  normalized.updatedAt = new Date().toISOString()
  const file = project ? packPath({ outputDir, project }) : globalPackPath({ dataDir })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return { file, pack: normalized }
}

/* ============================================================================
 * 提示词组装
 * ========================================================================== */

/** 透明底那段官方措辞（照 OpenAI 指南的要求写全，少一项就会画出棋盘格或投影）。 */
export function transparentClause() {
  return 'isolated subject on a fully transparent background, no scenery, no backdrop, no checkerboard pattern, no background shadow, no vignette'
}

/** 多图引用的序号+描述写法（官方推荐格式）。 */
export function referenceClause(count) {
  if (!count || count <= 0) return ''
  const parts = []
  for (let i = 1; i <= count; i++) {
    parts.push(i === 1 ? 'Image 1 is the character/style anchor' : `Image ${i} is an additional style reference`)
  }
  return `${parts.join('; ')}. Match the anchor's palette, line weight, shading and proportions exactly.`
}

/** 角色锚点：把 characters[name] 展开成一句可复用的描述。 */
export function characterClause(pack, name) {
  if (!pack || !name) return ''
  const entry = pack.characters?.[name]
  if (!entry) return ''
  const bits = [entry.desc].filter(Boolean)
  if (bits.length === 0) return ''
  return `Character "${name}": ${bits[0]}`
}

/**
 * 把「用户提示词 + 项目提示词包」组装成最终提示词。
 *
 * 顺序严格按官方指南：**用途 → 场景/背景 → 主体（用户写的）→ 画风 → 构图/光线 → 透明底 → 约束**。
 * 为什么顺序重要：官方明确说"按固定顺序写"能让模型稳定进入同一个"模式"，
 * 而把约束放最后也是他们的写法（先说画什么，再说什么不要）。
 *
 * @returns {{prompt:string, negative:string, parts:object, used:boolean, notes:string[]}}
 */
export function composePrompt({ pack, prompt = '', kind = '', character = '', extraReferences = 0 } = {}) {
  const empty = { prompt, negative: '', parts: {}, used: false, notes: [] }
  if (!pack) return empty
  const notes = []
  const kindCfg = (kind && pack.kinds?.[kind]) ? pack.kinds[kind] : {}
  const use = kindCfg.use || pack.use
  const style = kindCfg.style || pack.style
  const composition = kindCfg.composition || pack.composition
  const transparent = kindCfg.transparent === undefined ? pack.transparent : kindCfg.transparent

  const parts = {
    use: use ? `Intended use: ${use}.` : '',
    subject: String(prompt ?? '').trim(),
    style: style ? `Art style: ${style}` : '',
    composition: composition ? `Composition: ${composition}` : '',
    character: characterClause(pack, character),
    transparent: transparent === true ? transparentClause() : '',
    references: referenceClause(pack.references?.length ?? 0),
  }
  if (pack.palette?.length) {
    parts.style = `${parts.style}${parts.style ? '. ' : ''}Strictly limited palette: ${pack.palette.slice(0, 16).join(', ')}`
  }
  if (pack.preserve?.length) parts.preserve = `Keep unchanged: ${pack.preserve.join('; ')}`
  // 排除项：gpt-image 系列没有独立 negative 字段，官方指南的做法就是**在提示词里显式写排除**
  // （"no watermark" / "no extra text"）。所以这里拼进正文，同时把 negative 单独返回给
  // 那些真的有 negative 字段的服务商。
  if (pack.negative?.length) parts.avoid = `Exclude: ${pack.negative.join(', ')}.`

  const ordered = [parts.use, parts.subject, parts.character, parts.style, parts.composition, parts.transparent, parts.preserve, parts.avoid]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
  const composed = ordered.join(' ')
  // 负向约束单独返回：有的接口有独立 negative 字段，有的要拼进正文
  const negative = (pack.negative ?? []).join(', ')
  const used = Boolean(style || composition || use || transparent === true || negative || pack.palette?.length || parts.character)
  if (!used) notes.push('提示词包是空的（没配 style/composition/negative/palette），本次不追加任何内容。')

  return {
    prompt: used ? composed : String(prompt ?? '').trim(),
    negative,
    parts,
    used,
    notes,
  }
}

/* ============================================================================
 * 校验与工具
 * ========================================================================== */

/** 校验包，返回 {ok, errors, warnings}。给"保存后立刻知道哪里不对"用。 */
export function validatePack(pack) {
  const errors = []
  const warnings = []
  const p = normalizePack(pack)
  if (!p.style && !p.use) {
    warnings.push('既没有 style 也没有 use：这个包对画风几乎没影响。至少写一句 style。')
  }
  if (p.style && p.style.length > 600) warnings.push(`style 有点长（${p.style.length} 字），模型可能抓不住重点，建议压到 200 字内`)
  if (p.negative?.length > 12) warnings.push(`negative 有 ${p.negative.length} 项，太多会稀释重点，建议 ≤12`)
  if (p.palette?.length > 24) warnings.push(`调色板 ${p.palette.length} 色，像素画建议 ≤16`)
  for (const color of p.palette ?? []) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) errors.push(`调色板里有非法颜色「${color}」（要 #rrggbb）`)
  }
  for (const ref of p.references ?? []) {
    if (/^https?:\/\//i.test(ref) || /^data:/i.test(ref)) continue
    if (!path.isAbsolute(ref)) errors.push(`参考图要用绝对路径（收到相对路径「${ref}」）`)
  }
  if (p.transparent === true && p.use && !/icon|asset|sprite|item|ui|logo|sticker/i.test(p.use)) {
    warnings.push(`要了透明底但 use="${p.use}"，模型可能画成场景图。建议 use 写 game asset / icon / sprite / logo 这类。`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 给 AI/人看的一页摘要。 */
export function describePack(pack) {
  if (!pack) return { configured: false, hint: '这个项目还没配提示词包 —— 同一个项目多次出图会画风飘。用 prompts(action="pack-save") 建一个。' }
  return {
    configured: true,
    file: pack.source?.file,
    name: pack.name,
    use: pack.use,
    style: pack.style,
    composition: pack.composition,
    palette: pack.palette,
    negative: pack.negative,
    preserve: pack.preserve,
    transparent: pack.transparent,
    characters: Object.keys(pack.characters ?? {}),
    references: pack.references,
    kinds: Object.keys(pack.kinds ?? {}),
    defaults: pack.defaults,
  }
}

/**
 * 列出所有已配置的提示词包（全局 + 每个项目）。
 * 用来回答"我到底给哪些项目定过画风"。
 */
export async function listPacks({ outputDir, dataDir } = {}) {
  const out = []
  const check = async (file, scope, project = '') => {
    const raw = await readJson(file, null)
    if (!raw) return
    const pack = normalizePack(raw)
    out.push({
      scope,
      project,
      file,
      name: pack.name || project,
      use: pack.use,
      style_short: pack.style ? `${pack.style.slice(0, 80)}${pack.style.length > 80 ? '…' : ''}` : '',
      palette: pack.palette?.length ?? 0,
      negative: pack.negative?.length ?? 0,
      characters: Object.keys(pack.characters ?? {}),
      updatedAt: pack.updatedAt,
    })
  }
  if (dataDir) await check(globalPackPath({ dataDir }), 'global')
  if (outputDir) {
    const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await check(path.join(outputDir, entry.name, PACK_FILE), 'project', entry.name)
    }
  }
  return out
}

/**
 * 一个"能直接用"的起步模板。
 * 不指望用户从零写 JSON —— 给一份填好一半的，他改改就能用。
 */
export function starterPack({ name = '', use = 'game asset' } = {}) {
  const pack = emptyPack()
  pack.name = name
  pack.use = use
  pack.style = [
    'consistent 2D game art style, painted in a single unified palette,',
    'clean readable silhouette, clear value separation between light and shadow,',
    'soft ambient occlusion, no harsh outline except deliberate rim light',
  ].join(' ')
  pack.composition = 'centered subject, slightly top-down three-quarter view, soft key light from upper left, subtle rim light'
  pack.negative = ['no watermark', 'no text', 'no signature', 'no extra limbs', 'no duplicated subject', 'no cluttered background']
  pack.preserve = ['silhouette readability at 48px', 'palette consistency with the rest of the project']
  pack.transparent = true
  pack.defaults = { size: '1024x1024', quality: 'high' }
  return pack
}
