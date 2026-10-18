/**
 * 引擎适配层（engine adapter）：把「生成的素材 + 元数据」落成**引擎真正能读的配置文件**，
 * 并且在写盘之前按「字段字典」做静态诊断。
 *
 * 为什么要有这一层（这是从开源模组编辑器学到的最重要一件事）：
 *   素材生成完只是半成品。真正让 AI 产出"能进游戏"的东西，靠的是**一份数据化的字段字典**
 *   —— 每个字段带：代码名、中文名、类型、是否必填、取值范围、枚举、示例、说明。
 *   有了它，三件事同时成立：
 *     ① 生成：AI 按字典填，不会瞎编字段名
 *     ② 校验：类型/必填/范围/枚举/引用，全部可判定，报错还能带**稳定错误码**
 *     ③ 文档：每个字段的中文名和说明就是表单标签和悬浮提示，不用另写一份
 *   反过来说：**字典不数据化，这套东西就只能是手写 if-else**，加一个字段要改代码。
 *   （铁锈战争的几个开源编辑器都有一个 `code_table.json`，500KB+，就是这个模式。）
 *
 * 我们的字典格式（`engine-schema`）是**引擎无关**的：
 *   sections → groups → fields，字段类型 string/integer/float/bool/enum/color/list
 *   另有 enums（枚举表）、references（引用关系）、tolerant（不误报清单）
 *
 * ⚠️ 一条设计红线（也是从那些工具学来的）：**校验器的价值由"误报率"决定，不由"能查多少"决定。**
 *   所以 schema 里有 `tolerant` 字段：把真实存在但看起来"不像标准写法"的东西列进去
 *   （表达式 `${...}`、`self.xx`、`price: 8000,蓝晶=2100`、`delay: 2.2s` 这类），
 *   命中就放过。宁可少报一条，也不要让人被假警报训练成"忽略所有警告"。
 */
import { readFile, writeFile, mkdir, copyFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const SCHEMA_VERSION = 1

/* ============================================================================
 * 一、Schema：规范化与校验
 * ========================================================================== */

const FIELD_TYPES = new Set(['string', 'integer', 'float', 'bool', 'enum', 'color', 'list', 'any'])

/** 把任意 schema 规范化（缺字段补默认、类型不对丢掉，不抛异常）。 */
export function normalizeSchema(raw) {
  const out = {
    version: SCHEMA_VERSION,
    id: '',
    label: '',
    format: 'ini',            // ini | json
    separator: ':',           // ini 的键值分隔符
    sections: [],
    enums: {},
    references: [],
    tolerant: [],
    notes: [],
  }
  if (!raw || typeof raw !== 'object') return out
  for (const key of ['id', 'label', 'format', 'separator']) {
    if (typeof raw[key] === 'string' && raw[key]) out[key] = raw[key]
  }
  if (out.format !== 'json') out.format = 'ini'

  if (raw.enums && typeof raw.enums === 'object') {
    for (const [name, def] of Object.entries(raw.enums)) {
      const items = Array.isArray(def) ? def : (def?.items ?? [])
      out.enums[name] = items
        .map((item) => (typeof item === 'string'
          ? { v: item, t: item }
          : { v: String(item?.v ?? item?.value ?? ''), t: String(item?.t ?? item?.title ?? item?.v ?? '') }))
        .filter((item) => item.v !== '')
    }
  }

  if (Array.isArray(raw.references)) {
    out.references = raw.references.filter((r) => r && typeof r === 'object').map((r) => ({
      from: r.from ?? {},
      to: r.to ?? {},
      message: typeof r.message === 'string' ? r.message : '',
    }))
  }
  if (Array.isArray(raw.tolerant)) out.tolerant = raw.tolerant.map(String).filter(Boolean)
  if (Array.isArray(raw.notes)) out.notes = raw.notes.map(String).filter(Boolean)
  if (Array.isArray(raw.blocks)) {
    out.blocks = raw.blocks.filter((b) => b && typeof b === 'object').map((b) => ({
      title: String(b.title ?? ''),
      items: (b.items ?? []).map((i) => ({ v: String(i?.v ?? ''), t: String(i?.t ?? '') })).filter((x) => x.v),
    }))
  }
  if (Array.isArray(raw.builtInAssets)) out.builtInAssets = raw.builtInAssets.map(String).filter(Boolean)

  if (Array.isArray(raw.sections)) {
    for (const section of raw.sections) {
      if (!section || typeof section !== 'object') continue
      const sec = {
        id: String(section.id ?? section.raw ?? '').replace(/^\[|\]$/g, '').trim(),
        title: String(section.title ?? ''),
        required: section.required === true,
        prefix: typeof section.prefix === 'string' ? section.prefix : '',
        groups: [],
      }
      if (!sec.id) continue
      for (const group of section.groups ?? []) {
        const g = { name: String(group?.name ?? ''), fields: [] }
        for (const field of group?.fields ?? group?.entries ?? []) {
          if (!field || typeof field !== 'object') continue
          const code = String(field.code ?? field.name ?? '').trim()
          if (!code) continue
          const type = FIELD_TYPES.has(field.type) ? field.type : (FIELD_TYPES.has(field.vtype) ? field.vtype : 'string')
          const f = {
            code,
            title: String(field.title ?? field.trans ?? field.tran ?? ''),
            type,
            required: field.required === true,
            desc: String(field.desc ?? field.description ?? ''),
            example: String(field.example ?? field.ex ?? ''),
          }
          if (field.enum) f.enum = String(field.enum)
          if (Number.isFinite(Number(field.min))) f.min = Number(field.min)
          if (Number.isFinite(Number(field.max))) f.max = Number(field.max)
          if (typeof field.pattern === 'string') f.pattern = field.pattern
          g.fields.push(f)
        }
        if (g.fields.length > 0) sec.groups.push(g)
      }
      // 段里没有分组但有裸字段数组时，兜一个默认分组
      if (sec.groups.length === 0 && Array.isArray(section.entries)) {
        sec.groups.push({ name: '', fields: normalizeSchema({ sections: [{ id: 'x', groups: [{ entries: section.entries }] }] }).sections[0].groups[0].fields })
      }
      out.sections.push(sec)
    }
  }
  return out
}

/** 校验 schema 本身是否可用于生成/校验。 */
export function validateSchema(schema) {
  const s = normalizeSchema(schema)
  const errors = []
  const warnings = []
  if (!s.id) errors.push('schema 缺 id')
  if (s.sections.length === 0) errors.push('schema 里一个段都没有')
  const seen = new Set()
  for (const section of s.sections) {
    if (seen.has(section.id)) errors.push(`段重名：${section.id}`)
    seen.add(section.id)
    const fieldNames = new Set()
    for (const group of section.groups) {
      for (const field of group.fields) {
        if (fieldNames.has(field.code)) {
          /* 同段同名字段只算**警告**：真实代码表里这很常见
           * （同一个键在不同分组下重复出现，比如"动作"段里给不同触发条件各列一遍）。
           * 生成/校验都取第一条，不会出错；当错误报会让人以为字典坏了。 */
          warnings.push(`段 ${section.id} 里字段重复：${field.code}（取第一条，其余忽略）`)
        }
        fieldNames.add(field.code)
        if (field.type === 'enum' && field.enum && !s.enums[field.enum]) {
          warnings.push(`字段 ${section.id}.${field.code} 引用了不存在的枚举「${field.enum}」`)
        }
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
          errors.push(`字段 ${section.id}.${field.code} 的 min > max`)
        }
      }
    }
    if (fieldNames.size === 0) warnings.push(`段 ${section.id} 没有任何字段`)
  }
  for (const ref of s.references) {
    if (!ref.from?.field || !ref.to?.field) warnings.push(`引用规则不完整：${JSON.stringify(ref).slice(0, 80)}`)
  }
  return { ok: errors.length === 0, errors, warnings, sections: s.sections.length, fields: s.sections.reduce((n, sec) => n + sec.groups.reduce((m, g) => m + g.fields.length, 0), 0) }
}

/** 已经是 normalizeSchema 产物的就不要再规范化一遍。 */
function asNormalized(schema) {
  if (schema && schema.version === SCHEMA_VERSION && Array.isArray(schema.sections)
      && schema.sections.every((sec) => Array.isArray(sec?.groups))) {
    return schema
  }
  return normalizeSchema(schema)
}

/**
 * 拍平成一个「段名 → 字段数组」的表，生成和校验都用它。
 *
 * ⚠️ 这里**不能无条件重新 normalize**：normalizeSchema 会造出全新的字段对象，
 * 而枚举选项是挂在字段对象上的（WeakMap），重新规范化会让缓存全部失效 ——
 * 症状是枚举校验静默不生效（非法值原样写进配置）。实测踩过。
 */
export function fieldIndex(schema) {
  const s = asNormalized(schema)
  const index = new Map()
  for (const section of s.sections) {
    const fields = []
    for (const group of section.groups) fields.push(...group.fields)
    index.set(section.id, { ...section, fields })
  }
  return index
}

/** 给 AI/人看的一页摘要（不要直接吐整个 500KB 字典给模型）。 */
export function describeSchema(schema, { section = '' } = {}) {
  const s = asNormalized(schema)
  const index = fieldIndex(s)
  if (section) {
    const sec = index.get(String(section).replace(/^\[|\]$/g, ''))
    if (!sec) return { ok: false, error: `没有段「${section}」`, sections: [...index.keys()] }
    return {
      ok: true,
      section: sec.id,
      title: sec.title,
      required: sec.required,
      fields: sec.fields.map((f) => ({
        code: f.code,
        title: f.title,
        type: f.type,
        required: f.required,
        ...(f.enum ? { enum: f.enum, options: (s.enums[f.enum] ?? []).map((i) => i.v) } : {}),
        ...(f.min !== undefined || f.max !== undefined ? { range: [f.min ?? '-', f.max ?? '-'] } : {}),
        example: f.example,
        desc: f.desc ? f.desc.slice(0, 160) : '',
      })),
    }
  }
  return {
    ok: true,
    id: s.id,
    label: s.label,
    format: s.format,
    sections: s.sections.map((sec) => ({
      id: sec.id,
      title: sec.title,
      required: sec.required,
      fields: index.get(sec.id)?.fields.length ?? 0,
    })),
    enums: Object.keys(s.enums),
    blocks: (s.blocks ?? []).map((b) => ({ title: b.title, count: b.items.length })),
    builtInAssets: (s.builtInAssets ?? []).length,
    references: s.references.length,
    tolerant: s.tolerant,
    hint: '要看某段有哪些字段：adapter(action="schema", section="core")',
  }
}

/* ============================================================================
 * 二、生成：按字典产出合法配置
 * ========================================================================== */

/**
 * 按字典生成配置文本。
 * @param {object} params
 * @param {object} params.schema
 * @param {object} params.values  { sectionId: { fieldCode: value } } 也支持 `{"core": {...}}`
 * @param {string} [params.title] 段标题注释
 * @returns {{ok:boolean, text:string, sections:string[], warnings:string[], coerced:Array, error?:string}}
 */
export function emitConfig({ schema, values = {}, title = '' }) {
  /* 必须走 attachEnums：coerceValue 只拿到单个 field，枚举选项是挂在 field 上的。
   * 少了这一步，枚举校验完全失效 —— 非法值会被原样写进配置（实测踩过）。 */
  const s = attachEnums(schema)
  const index = fieldIndex(s)
  const warnings = []
  const coerced = []
  const blocks = []

  if (s.format === 'json') {
    const out = {}
    for (const [sectionId, fields] of Object.entries(values)) {
      if (!index.has(sectionId)) { warnings.push(`值里有字典没定义的段「${sectionId}」，原样输出`); out[sectionId] = fields; continue }
      const sec = index.get(sectionId)
      const obj = {}
      for (const [code, raw] of Object.entries(fields ?? {})) {
        const field = sec.fields.find((f) => f.code === code)
        const result = coerceValue(field, raw)
        if (result.warn) warnings.push(`${sectionId}.${code}: ${result.warn}`)
        if (result.coerced) coerced.push({ section: sectionId, field: code, from: raw, to: result.value })
        obj[code] = result.value
      }
      out[sectionId] = obj
    }
    return { ok: true, text: `${JSON.stringify(out, null, 2)}\n`, sections: Object.keys(out), warnings, coerced }
  }

  // INI：每段一个 [id] 块，字段按字典顺序排（比"用户给的顺序"稳定，diff 更友好）
  for (const [sectionId, fields] of Object.entries(values)) {
    const sec = index.get(sectionId)
    if (!sec) { warnings.push(`值里有字典没定义的段「${sectionId}」，原样输出`); continue }
    const lines = [`[${sec.id}]`]
    const given = fields ?? {}
    // 先按字典顺序输出已知字段
    for (const field of sec.fields) {
      if (!(field.code in given)) continue
      const result = coerceValue(field, given[field.code])
      if (result.warn) warnings.push(`${sectionId}.${field.code}: ${result.warn}`)
      if (result.coerced) coerced.push({ section: sectionId, field: field.code, from: given[field.code], to: result.value })
      lines.push(`${field.code}${s.separator} ${result.value}`)
    }
    // 再输出字典没定义但用户给了的（RW 允许自定义键，不能丢）
    for (const [code, raw] of Object.entries(given)) {
      if (sec.fields.some((f) => f.code === code)) continue
      warnings.push(`字段 ${sectionId}.${code} 不在字典里（自定义键，原样输出）`)
      lines.push(`${code}${s.separator} ${formatValue(raw)}`)
    }
    blocks.push(lines.join('\n'))
  }

  // 必填段缺失 → 直接在生成阶段就提醒（比等到 lint 再报更早）
  for (const [id, sec] of index) {
    if (sec.required && !(id in values)) warnings.push(`缺必需段 [${id}]（${sec.title || id}）`)
  }

  const header = title ? `# ${title}\n` : ''
  return { ok: true, text: `${header}${blocks.join('\n\n')}\n`, sections: Object.keys(values), warnings, coerced }
}

/** 单个值的类型强制转换。返回 {value, warn?, coerced?}。 */
function coerceValue(field, raw) {
  if (raw === undefined || raw === null) return { value: '' }
  const text = String(raw).trim()
  if (!field) return { value: text }
  switch (field.type) {
    case 'bool': {
      const lower = text.toLowerCase()
      if (['true', 'false'].includes(lower)) return { value: lower }
      if (['1', '0'].includes(lower)) return { value: lower === '1' ? 'true' : 'false', coerced: true }
      if (['是', '真', 'yes', 'y'].includes(lower)) return { value: 'true', coerced: true }
      if (['否', '假', 'no', 'n'].includes(lower)) return { value: 'false', coerced: true }
      return { value: 'false', warn: `「${text}」不是布尔值，已写成 false`, coerced: true }
    }
    case 'integer': {
      const n = Number(text)
      if (Number.isFinite(n) && Number.isInteger(n)) return clampIfNeeded(field, n)
      const rounded = Math.round(Number(text))
      if (Number.isFinite(rounded)) return clampIfNeeded(field, rounded, `「${text}」不是整数，已取整`)
      return { value: '0', warn: `「${text}」不是数字，已写成 0`, coerced: true }
    }
    case 'float': {
      const n = Number(text)
      if (Number.isFinite(n)) return clampIfNeeded(field, n)
      return { value: '0', warn: `「${text}」不是数字，已写成 0`, coerced: true }
    }
    case 'enum': {
      const options = (field.enum ? ENUM_CACHE.get(field) : null)
      if (!options || options.length === 0) return { value: text }
      if (options.includes(text)) return { value: text }
      const lower = text.toLowerCase()
      const hit = options.find((o) => o.toLowerCase() === lower)
      if (hit) return { value: hit, coerced: true }
      return { value: options[0], warn: `「${text}」不在枚举 [${options.join('/')}] 里，已写成 ${options[0]}`, coerced: true }
    }
    default:
      return { value: text }
  }
}

/** enum 选项缓存：coerceValue 只拿到 field，拿不到整个 schema，所以在 field 上挂一份。 */
const ENUM_CACHE = new WeakMap()
/** 把 schema 的枚举灌进字段对象（emitConfig / lintConfig 入口统一做一次）。 */
function attachEnums(schema) {
  const s = asNormalized(schema)
  for (const section of s.sections) {
    for (const group of section.groups) {
      for (const field of group.fields) {
        if (field.type === 'enum' && field.enum && s.enums[field.enum]) {
          ENUM_CACHE.set(field, s.enums[field.enum].map((i) => i.v))
        }
      }
    }
  }
  return s
}

function clampIfNeeded(field, n, note = '') {
  let value = n
  const warns = []
  if (field.min !== undefined && value < field.min) { value = field.min; warns.push(`小于下限 ${field.min}，已夹到 ${field.min}`) }
  if (field.max !== undefined && value > field.max) { value = field.max; warns.push(`大于上限 ${field.max}，已夹到 ${field.max}`) }
  const text = warns.length > 0 || note ? `${value}` : `${value}`
  return {
    value: text,
    ...(warns.length || note ? { warn: [note, ...warns].filter(Boolean).join('；'), coerced: true } : {}),
  }
}

function formatValue(raw) {
  if (Array.isArray(raw)) return raw.join(', ')
  return String(raw ?? '')
}

/* ============================================================================
 * 三、静态诊断：稳定错误码 + 不误报
 * ========================================================================== */

/**
 * 诊断码表。**码要稳定**（能写进文档、能被忽略列表引用、能跨版本对比），
 * 所以这里显式编号，加规则只能往后加，不能改已有含义。
 */
export const DIAGNOSTICS = {
  E001: { severity: 'error', title: '缺必需段', fix: '补上这个段' },
  E002: { severity: 'error', title: '缺必需字段', fix: '补上这个字段' },
  E003: { severity: 'warn', title: '字典里没有这个键', fix: '拼写错了？或者这确实是自定义键（可以忽略）' },
  E004: { severity: 'error', title: '类型不对', fix: '按字典的类型写' },
  E005: { severity: 'error', title: '数值越界', fix: '按字典的 min/max 改' },
  E006: { severity: 'error', title: '枚举值不存在', fix: '用字典里列出的值' },
  E007: { severity: 'error', title: '中文冒号', fix: '把「：」改成「:」' },
  E008: { severity: 'warn', title: '中文逗号', fix: '列表要用英文逗号（部分字段除外）' },
  E009: { severity: 'error', title: '同段重复键', fix: '同一个键只能出现一次，合并它们' },
  E010: { severity: 'error', title: '重复的段', fix: '同名片段的键会被后者覆盖' },
  E011: { severity: 'error', title: '悬空引用', fix: '引用的目标不存在，检查名字' },
  E012: { severity: 'error', title: '颜色格式不对', fix: '用 #RRGGBB 或 #AARRGGBB' },
  E013: { severity: 'warn', title: '键放错段', fix: '这个字段属于别的段' },
  E014: { severity: 'error', title: '语法不对', fix: '这一行不是 key: value（也不是注释）' },
}

/** 解析 ini 文本成 { sections:[{id,line,entries:[{key,value,line}]}], errors } 。 */
export function parseIni(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const sections = []
  const syntax = []
  let current = null
  lines.forEach((line, i) => {
    const no = i + 1
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('//')) return
    if (trimmed.startsWith('@')) return                        // @memory / @copyFromSection 这类指令
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed)
    if (sectionMatch) {
      current = { id: sectionMatch[1].trim(), line: no, entries: [] }
      sections.push(current)
      return
    }
    // key: value —— 允许中文冒号但会单独报 E007
    const kv = /^([^:：]+)[:：]\s*(.*)$/.exec(trimmed)
    if (!kv) { syntax.push({ line: no, text: trimmed }); return }
    if (!current) { syntax.push({ line: no, text: trimmed }); return }
    /* 分隔符是「键右边界那个字符」。注意不能拿 kv[0] 的最后一个字符判断 ——
     * kv[0] 是整行匹配（含值），slice(-1) 会取到值的最后一个字（实测漏报了中文冒号）。 */
    const sep = trimmed.charAt(kv[1].length)
    current.entries.push({
      key: kv[1].trim(),
      value: kv[2].trim(),
      line: no,
      cjkColon: sep === '：',
    })
  })
  return { sections, syntax }
}

/**
 * 诊断一段配置文本。
 * @param {object} params
 * @param {object} params.schema
 * @param {string} params.text 配置文本
 * @param {object} [params.knownSections] 额外已知段名（用来判定引用）
 * @returns {{ok:boolean, issues:Array, counts:object, parsed:object}}
 */
export function lintConfig({ schema, text, source = '' }) {
  const s = attachEnums(schema)
  const index = fieldIndex(s)
  const parsed = parseIni(text)
  const issues = []
  const push = (code, line, message, extra = {}) => {
    const def = DIAGNOSTICS[code] ?? { severity: 'warn', title: code, fix: '' }
    issues.push({ code, severity: def.severity, line, message, fix: def.fix, ...extra })
  }

  // 不误报清单：命中就直接跳过这一行的类型检查
  const tolerated = (line) => s.tolerant.some((pattern) => line.includes(pattern))

  // ---- 语法错误 ----
  for (const bad of parsed.syntax) {
    push('E014', bad.line, `这一行既不是 [段] 也不是 key: value：${bad.text.slice(0, 60)}`)
  }

  // ---- 重复段 ----
  const sectionCount = new Map()
  for (const section of parsed.sections) {
    sectionCount.set(section.id, (sectionCount.get(section.id) ?? 0) + 1)
  }
  for (const [id, count] of sectionCount) {
    if (count > 1) {
      const first = parsed.sections.find((x) => x.id === id)
      push('E010', first.line, `段 [${id}] 出现了 ${count} 次（后出现的会覆盖前面的同名键）`)
    }
  }

  // ---- 缺必需段 ----
  for (const [id, sec] of index) {
    if (!sec.required) continue
    if (!sectionCount.has(id)) push('E001', 1, `缺必需段 [${id}]（${sec.title || id}）`)
  }

  const textLines = String(text ?? '').split(/\r?\n/)

  for (const section of parsed.sections) {
    const sec = index.get(section.id)
    const seenKeys = new Map()
    for (const entry of section.entries) {
      // 中文冒号
      if (entry.cjkColon) push('E007', entry.line, `中文冒号「：」引擎可能不认，改成「:」`, { fixable: 'auto' })
      // 重复键
      if (seenKeys.has(entry.key)) {
        const prev = seenKeys.get(entry.key)
        push('E009', entry.line, `键 ${entry.key} 在本段重复（第一次在第 ${prev.line} 行），值：${prev.value} / ${entry.value}`, { key: entry.key })
      } else {
        seenKeys.set(entry.key, entry)
      }
      if (!sec) continue                                  // 未知段：整段不判字段规则
      if (tolerated(textLines[entry.line - 1] ?? '')) continue
      const field = sec.fields.find((f) => f.code === entry.key)
      if (!field) {
        // 字段属于别的段？→ E013 更精确
        const elsewhere = [...index.values()].find((other) => other.id !== section.id && other.fields.some((f) => f.code === entry.key))
        if (elsewhere) push('E013', entry.line, `字段 ${entry.key} 属于段 [${elsewhere.id}]，不是 [${section.id}]`)
        else push('E003', entry.line, `字典里没有键 ${entry.key}（自定义键可忽略）`)
        continue
      }
      // 类型 / 范围 / 枚举
      if (field.type === 'bool' && !/^(true|false|1|0)$/i.test(entry.value)) {
        push('E004', entry.line, `${field.code} 是布尔，只能 true/false，实际是「${entry.value}」`)
      }
      if ((field.type === 'integer' || field.type === 'float') && !Number.isFinite(Number(entry.value))) {
        push('E004', entry.line, `${field.code} 是数字，实际是「${entry.value}」`)
      }
      if (['integer', 'float'].includes(field.type) && Number.isFinite(Number(entry.value))) {
        const n = Number(entry.value)
        if (field.min !== undefined && n < field.min) push('E005', entry.line, `${field.code} = ${n} 小于下限 ${field.min}`)
        if (field.max !== undefined && n > field.max) push('E005', entry.line, `${field.code} = ${n} 大于上限 ${field.max}`)
      }
      if (field.type === 'enum') {
        const options = (s.enums[field.enum] ?? []).map((i) => i.v)
        if (options.length > 0 && !options.includes(entry.value)) {
          push('E006', entry.line, `${field.code} = 「${entry.value}」不在枚举里（可用：${options.slice(0, 8).join('/')}${options.length > 8 ? '…' : ''}）`)
        }
      }
      if (field.type === 'color' && !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(entry.value)) {
        push('E012', entry.line, `${field.code} 颜色格式不对：「${entry.value}」（要 #RRGGBB 或 #AARRGGBB）`)
      }
      if (field.pattern && !new RegExp(field.pattern).test(entry.value)) {
        push('E004', entry.line, `${field.code} 不符合格式 ${field.pattern}：「${entry.value}」`)
      }
      // 中文逗号（list 类字段常见，但很多字段确实允许中文，所以只警告）
      if (field.type === 'list' && /，/.test(entry.value)) {
        push('E008', entry.line, `${field.code} 列表里用了中文逗号「，」`)
      }
    }
  }

  // ---- 悬空引用 ----
  const allSections = new Set(parsed.sections.map((x) => x.id))
  for (const ref of s.references) {
    const fromSection = ref.from?.section
    const fromField = ref.from?.field
    const toPrefix = ref.to?.prefix ?? ''
    const toField = ref.to?.field ?? 'id'
    for (const section of parsed.sections) {
      if (fromSection && section.id !== fromSection) continue
      if (!fromSection && section.id !== fromSection) {
        // 没指定来源段 → 所有段都查
      }
      for (const entry of section.entries) {
        if (fromField && entry.key !== fromField) continue
        const target = entry.value.split(',')[0].trim()
        if (!target) continue
        if (tolerated(textLines[entry.line - 1] ?? '')) continue
        const wanted = `${toPrefix}${target}`
        if (!allSections.has(wanted)) {
          push('E011', entry.line, `${ref.message || `引用了 ${toPrefix}${target}`}，但本文件里没有 [${wanted}]`, { target: wanted })
        }
      }
    }
  }

  const counts = { error: 0, warn: 0 }
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1
  return {
    ok: counts.error === 0,
    source,
    issues,
    counts,
    parsed: { sections: parsed.sections.length, entries: parsed.sections.reduce((n, x) => n + x.entries.length, 0) },
    hint: issues.length === 0 ? '没发现问题。' : '按 code 查 DIAGNOSTICS 能拿到每类的说明和修法。',
  }
}

/* ============================================================================
 * 四、双向编辑：文本 ↔ 结构，**逐字节保留原文件**
 * --------------------------------------------------------------------------
 * 那些模组编辑器共同的硬要求：改一个数值，不能把用户的注释、缩进、空行、
 * @指令、语句顺序全部重排 —— 那等于把人家的文件格式化了一遍，diff 里全是噪音，
 * 而且很容易在重排中丢东西。
 *
 * 所以这里的做法是「**行级无损解析 + 只改目标行**」：
 *   ① parseConfigLossless(text) 拆成行对象，**记住每一行的原文**
 *   ② editConfig 只替换目标行的值部分（保留键名前缩进、冒号后空格风格）
 *   ③ 序列化时把没动过的行原样吐回去
 * 有测试钉住「parse → serialize 必须逐字节等于原文」这条往返恒等式。
 * ========================================================================== */

/**
 * 无损解析：每一行都保留 raw，并标注类型与所属段。
 * @returns {{lines:Array, sections:Array<{id,line,index}>}}
 */
export function parseConfigLossless(text) {
  const raw = String(text ?? '')
  const lines = raw.split('\n')
  const out = []
  const sections = []
  let current = null
  lines.forEach((line, i) => {
    const hasCR = line.endsWith('\r')
    const body = hasCR ? line.slice(0, -1) : line
    const trimmed = body.trim()
    let kind = 'blank'
    let entry = null
    let sectionId = current
    if (trimmed === '') kind = 'blank'
    else if (trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('//')) kind = 'comment'
    else if (trimmed.startsWith('@')) kind = 'directive'
    else {
      const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed)
      if (sectionMatch) {
        kind = 'section'
        current = sectionMatch[1].trim()
        sectionId = current
        sections.push({ id: current, line: i + 1, index: sections.length })
      } else {
        const kv = /^(\s*)([^:：]+)([:：])([ \t]*)(.*)$/.exec(body)
        if (kv) {
          kind = 'entry'
          /* 值的行尾注释要单独留下来 —— 改值时只换值、注释原样保留。
           * 第一版没拆，一改值就把 "# 行尾注释" 吃掉了：一个声称"保留原文件"的功能丢数据，
           * 比不提供这个功能更糟。正则要求 # 前面有空白，所以 #AABBCC 这种颜色值不会被误切。 */
          const valueComment = /^([\s\S]*?)(\s+[#;][\s\S]*)?$/.exec(kv[5])
          entry = {
            indent: kv[1],
            key: kv[2].trim(),
            separator: kv[3],
            gap: kv[4],                                  // 冒号后原有的空格风格
            value: (valueComment?.[1] ?? kv[5]),
            trail: valueComment?.[2] ?? '',              // 行尾注释（含前面的空白）
            valueStart: kv[1].length + kv[2].length + 1 + kv[4].length,
          }
        } else kind = 'raw'
      }
    }
    out.push({ index: i, raw: line, body, hasCR, kind, section: sectionId, entry, removed: false })
  })
  return { lines: out, sections }
}

/** 把无损解析结果序列化回去（不做任何规范化）。 */
export function serializeConfig(parsed) {
  return (parsed?.lines ?? []).filter((l) => !l.removed).map((line) => line.raw).join('\n')
}

/** 往返恒等式：解析后原样序列化必须等于原文。 */
export function verifyRoundTrip(text) {
  const parsed = parseConfigLossless(text)
  return { ok: serializeConfig(parsed) === String(text ?? ''), lines: parsed.lines.length, sections: parsed.sections.length }
}

/**
 * 改配置里的值 —— **只动目标那一行**，其它行逐字节不变。
 *
 * @param {object} params
 * @param {string} params.text 原文
 * @param {Array<{section?:string, key:string, value?:any, remove?:boolean, normalizeSeparator?:boolean}>} params.edits
 * @param {boolean} [params.addMissing] 键不存在时是否追加到段尾（默认 true）
 */
export function editConfig({ text, edits = [], addMissing = true } = {}) {
  const parsed = parseConfigLossless(text)
  const applied = []
  const skipped = []
  const added = []
  const lines = parsed.lines

  for (const edit of edits) {
    const key = String(edit?.key ?? '').trim()
    if (!key) { skipped.push({ edit, reason: '没有 key' }); continue }
    const wantedSection = edit.section ? String(edit.section).replace(/^\[|\]$/g, '') : null
    const target = lines.find((line) => line.kind === 'entry' && !line.removed
      && (!wantedSection || line.section === wantedSection)
      && line.entry.key.toLowerCase() === key.toLowerCase())

    if (target) {
      if (edit.remove) {
        target.removed = true
        applied.push({ key, section: target.section, action: 'removed', line: target.index + 1 })
        continue
      }
      const entry = target.entry
      const value = formatValue(edit.value)
      const sep = edit.normalizeSeparator ? ':' : entry.separator
      // 只重建这一行：保留缩进 + 键名 + 冒号后的空格风格 + **行尾注释**
      target.raw = `${entry.indent}${entry.key}${sep}${entry.gap}${value}${entry.trail ?? ''}${target.hasCR ? '\r' : ''}`
      target.body = target.hasCR ? target.raw.slice(0, -1) : target.raw
      target.entry = { ...entry, separator: sep, value }
      applied.push({ key, section: target.section, action: 'updated', line: target.index + 1, value })
      continue
    }

    if (edit.remove) { skipped.push({ edit, reason: '没找到这个键（无需删除）' }); continue }
    if (!addMissing) { skipped.push({ edit, reason: '没找到这个键，且不允许追加' }); continue }

    const sectionId = wantedSection ?? (lines.filter((l) => l.kind === 'section').pop()?.section ?? '')
    if (!sectionId) { skipped.push({ edit, reason: '文件里没有段，无法追加' }); continue }
    const sectionEntries = lines.filter((l) => l.section === sectionId && l.kind === 'entry' && !l.removed)
    const sectionLine = lines.find((l) => l.kind === 'section' && l.section === sectionId)
    const insertAfter = sectionEntries.length > 0
      ? sectionEntries[sectionEntries.length - 1].index
      : (sectionLine?.index ?? lines.length - 1)
    // 换行风格跟随文件：原文件是 CRLF 时，新插入的行也要带 \r
    const eol = lines.some((l) => l.hasCR) ? '\r' : ''
    const newRaw = `${key}: ${formatValue(edit.value)}`
    lines.splice(insertAfter + 1, 0, {
      index: 0, raw: `${newRaw}${eol}`, body: newRaw,
      hasCR: eol === '\r', kind: 'entry', section: sectionId, removed: false,
      entry: { indent: '', key, separator: ':', gap: ' ', value: formatValue(edit.value), trail: '', valueStart: key.length + 1 },
    })
    lines.forEach((l, i) => { l.index = i })
    added.push({ key, section: sectionId, value: formatValue(edit.value), line: insertAfter + 2 })
  }

  return {
    ok: skipped.length === 0,
    text: lines.filter((l) => !l.removed).map((l) => l.raw).join('\n'),
    applied, added, skipped,
    counts: {
      updated: applied.filter((a) => a.action === 'updated').length,
      removed: applied.filter((a) => a.action === 'removed').length,
      added: added.length, skipped: skipped.length,
    },
  }
}

/* ============================================================================
 * 五、背包 / 片段库：可复用的配置片段
 * --------------------------------------------------------------------------
 * 对应那些编辑器的「背包」：把常用配置块（一段 [attack]、一组 [graphics]）存起来，
 * 换单位时一键追加，不用复制粘贴。存在 <数据目录>/snippets/<schema-id>.json。
 * ========================================================================== */

function snippetPath(dataDir, schemaId) {
  return path.join(dataDir ?? '.', 'snippets', `${String(schemaId || 'default').replace(/[^\w.-]+/g, '_')}.json`)
}

/** 读某套字典的片段库。 */
export async function loadSnippets(dataDir, schemaId) {
  const data = await readFile(snippetPath(dataDir, schemaId), 'utf8').catch(() => null)
  if (!data) return { version: 1, schema: schemaId, snippets: {} }
  try {
    const parsed = JSON.parse(data)
    return { version: 1, schema: schemaId, snippets: parsed.snippets ?? {} }
  } catch {
    return { version: 1, schema: schemaId, snippets: {}, corrupt: true }
  }
}

/** 存/改一个片段。 */
export async function saveSnippet({ dataDir, schemaId, name, section, fields, tags = [], note = '' }) {
  const snippetName = String(name ?? '').trim()
  if (!snippetName) return { ok: false, error: '片段需要名字' }
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return { ok: false, error: '片段需要 fields（{ 字段: 值 }）' }
  }
  const library = await loadSnippets(dataDir, schemaId)
  library.snippets[snippetName] = {
    section: section ? String(section).replace(/^\[|\]$/g, '') : '',
    fields: { ...fields },
    tags: tags.map(String).filter(Boolean),
    note: String(note ?? ''),
    updatedAt: new Date().toISOString(),
  }
  const target = snippetPath(dataDir, schemaId)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify({ version: 1, snippets: library.snippets }, null, 2)}\n`, 'utf8')
  return { ok: true, name: snippetName, file: target, total: Object.keys(library.snippets).length }
}

/** 删一个片段。 */
export async function removeSnippet({ dataDir, schemaId, name }) {
  const library = await loadSnippets(dataDir, schemaId)
  const target = String(name ?? '').trim()
  if (!library.snippets[target]) {
    return { ok: false, error: `没有叫「${target}」的片段`, available: Object.keys(library.snippets) }
  }
  delete library.snippets[target]
  const file = snippetPath(dataDir, schemaId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ version: 1, snippets: library.snippets }, null, 2)}\n`, 'utf8')
  return { ok: true, removed: target, remaining: Object.keys(library.snippets), file }
}

/**
 * 把片段套进 values（后给的片段覆盖先给的）。
 * @returns {{ok:boolean, values:object, applied:Array, missing:string[], warnings:string[]}}
 */
export async function applySnippets({ dataDir, schemaId, names = [], values = {} }) {
  const library = await loadSnippets(dataDir, schemaId)
  /* 顺序很重要：**片段先铺底，用户显式给的 values 覆盖它**。
   * 因为最常见的用法是"用这套模板，但把血量改成 600" ——
   * 如果片段反过来盖掉 values，用户每次都得再改一遍，这个功能就没意义了。 */
  const base = {}
  const applied = []
  const missing = []
  const warnings = []
  for (const rawName of names) {
    const name = String(rawName ?? '').trim()
    const snippet = library.snippets[name]
    if (!snippet) { missing.push(name); continue }
    const section = snippet.section || ''
    if (!section) { warnings.push(`片段「${name}」没记段名，已跳过（存的时候要带 section）`); continue }
    base[section] = { ...(base[section] ?? {}), ...snippet.fields }
    applied.push({ name, section, fields: Object.keys(snippet.fields).length })
  }
  const merged = JSON.parse(JSON.stringify(values ?? {}))
  for (const [section, fields] of Object.entries(base)) {
    merged[section] = { ...fields, ...(merged[section] ?? {}) }   // 值在右 → 用户值胜出
  }
  return {
    ok: missing.length === 0,
    values: merged, applied, missing, warnings,
    ...(missing.length ? { error: `这些片段不存在：${missing.join('、')}`, available: Object.keys(library.snippets) } : {}),
  }
}

/* ============================================================================
 * 六、素材引用体检（对应那些工具的「模组体检」）
 * ========================================================================== */

/**
 * 扫游戏/模组目录，找出：
 *   ① 从没被任何配置文本引用过的素材（白占体积）
 *   ② 配置里引用了但**文件不存在**的素材（进游戏才发现，最坑）
 *
 * 为什么用"文件名全文搜索"而不是解析引用关系：配置里的素材引用写法千奇百怪
 * （`image: a.png`、`sound: x.ogg`、路径前缀、team color 变体），全文搜索
 * 的漏报比"严格解析"的误报好得多。这条是那些工具踩出来的经验。
 */
export async function healthCheck({
  gameRoot,
  schema = null,
  textExtensions = ['.ini', '.template', '.md', '.json', '.properties'],
  assetExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.ogg', '.wav', '.mp3', '.atlas'],
  maxFiles = 4000,
} = {}) {
  if (!gameRoot) return { ok: false, error: 'health 需要 gameRoot（游戏/模组目录的绝对路径）' }
  const info = await stat(gameRoot).catch(() => null)
  if (!info?.isDirectory()) return { ok: false, error: `gameRoot 不是目录：${gameRoot}` }

  /* 引擎内置素材白名单：schema 里带了「代码可用内置图像」这类词表时，
   * 配置里写 beam1.png 是**合法**的（引擎自带），不能报「文件缺失」。
   * 不加这个白名单，体检会产出一屏假警报 —— 假警报比不报更糟（人会被训练成忽略警告）。 */
  const builtIn = new Set((normalizeSchema(schema).builtInAssets ?? []).map((n) => n.toLowerCase()))

  const texts = []
  const assets = []
  const walk = async (dir, depth) => {
    if (depth > 8 || texts.length + assets.length >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (texts.length + assets.length >= maxFiles) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '__pycache__', '_回收站_'].some((skip) => entry.name.startsWith(skip))) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (textExtensions.includes(ext)) texts.push(full)
      else if (assetExtensions.includes(ext)) {
        const size = await stat(full).then((x) => x.size).catch(() => 0)
        assets.push({ file: full, name: entry.name, size, rel: path.relative(gameRoot, full) })
      }
    }
  }
  await walk(gameRoot, 0)

  // 把所有配置文本读成一个池子（分块搜，避免把几百 MB 全拼成一个大字符串）
  const blobs = []
  for (const file of texts) {
    const content = await readFile(file, 'latin1').catch(() => null)
    if (content) blobs.push({ file, content })
  }
  const referenced = new Set()
  for (const asset of assets) {
    // 只看文件名：配置里一般写 image: xx.png，不写绝对路径
    const lower = asset.name.toLowerCase()
    let hit = false
    for (const blob of blobs) {
      if (blob.content.toLowerCase().includes(lower)) { hit = true; break }
    }
    if (hit) referenced.add(asset.file)
  }
  const unreferenced = assets.filter((a) => !referenced.has(a.file)).sort((a, b) => b.size - a.size)

  // 反向：配置里写了 xxx.png 但没有这个文件
  const assetNames = new Set(assets.map((a) => a.name.toLowerCase()))
  const missing = []
  const assetPattern = /([\w\u4e00-\u9fff .\-/]+\.(?:png|jpg|jpeg|webp|ogg|wav|mp3))/gi
  for (const blob of blobs) {
    const lines = blob.content.split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const match of line.matchAll(assetPattern)) {
        const name = path.basename(match[1].trim().replace(/\\/g, '/')).toLowerCase()
        if (!name || assetNames.has(name)) continue
        if (builtIn.has(name)) continue                                // 引擎自带 → 不算缺失
        if (/[*{}<>]/.test(name)) continue                            // 通配/变量：不判
        missing.push({ file: blob.file, line: i + 1, referenced: match[1].trim(), name })
      }
    })
  }

  const wasted = unreferenced.reduce((n, a) => n + a.size, 0)
  return {
    ok: true,
    gameRoot,
    scanned: { text_files: texts.length, assets: assets.length },
    unreferenced: unreferenced.slice(0, 200).map((a) => ({ name: a.name, rel: a.rel, size: a.size })),
    unreferenced_count: unreferenced.length,
    wasted_bytes: wasted,
    wasted_human: `${(wasted / 1024 / 1024).toFixed(2)} MB`,
    missing: missing.slice(0, 200),
    missing_count: missing.length,
    note: '判定方式是"文件名全文搜索"。这会有漏报（配置里写的是变量/通配时），但比严格解析的误报好得多。',
    hint: unreferenced.length === 0 && missing.length === 0 ? '素材引用看起来是干净的。' : '按体积排序看 unreferenced（白占体积）；missing 是最坑的（进游戏才炸）。',
  }
}

/* ============================================================================
 * 五、部署（带备份，默认 dry-run）
 * ========================================================================== */

/**
 * 把生成的文件写进游戏目录。
 * @param {object} params
 * @param {Array<{name:string, content:string|Buffer, subdir?:string}>} params.files
 * @param {string} params.gameRoot
 * @param {boolean} [params.dryRun] 默认 true —— 不先看一眼就写进游戏目录是很粗鲁的
 * @param {boolean} [params.backup] 覆盖已有文件时留 .bak-before-deploy，默认 true
 */
export async function deployFiles({ files = [], gameRoot, dryRun = true, backup = true } = {}) {
  if (!gameRoot) return { ok: false, error: 'deploy 需要 gameRoot' }
  const info = await stat(gameRoot).catch(() => null)
  if (!info?.isDirectory()) return { ok: false, error: `gameRoot 不是目录：${gameRoot}` }
  const plan = []
  for (const file of files) {
    if (!file?.name) continue
    const target = path.join(gameRoot, file.subdir ?? '', file.name)
    const existing = await stat(target).then((x) => x.size).catch(() => null)
    plan.push({
      target,
      bytes: Buffer.isBuffer(file.content) ? file.content.length : Buffer.byteLength(String(file.content ?? '')),
      exists: existing !== null,
      existing_bytes: existing,
    })
  }
  if (dryRun) {
    return { ok: true, dry_run: true, gameRoot, plan, note: '只是计划。确认后传 dry_run=false 才真写。' }
  }
  const written = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file?.name) continue
    const entry = plan[i]
    await mkdir(path.dirname(entry.target), { recursive: true })
    if (entry.exists && backup) {
      await copyFile(entry.target, `${entry.target}.bak-before-deploy`).catch(() => {})
    }
    await writeFile(entry.target, file.content)
    written.push({ target: entry.target, bytes: entry.bytes, backed_up: entry.exists && backup })
  }
  return { ok: true, dry_run: false, gameRoot, written, count: written.length }
}

/* ============================================================================
 * 六、从「代码表」导入（别人的 xlsx/code_table.json → 我们的 schema）
 * --------------------------------------------------------------------------
 * 那些开源编辑器都带一份 code_table.json（段→分组→字段）。我们不 vendor 别人的数据
 * （体积 + 许可 + 版本漂移都不合适），只提供**转换器**：你拿自己的代码表跑一遍就有 schema。
 * ========================================================================== */

/** 把「段→分组→字段」形状的代码表转成我们的 engine-schema。 */
export function schemaFromCodeTable(codeTable, { id = 'imported', label = '', format = 'ini', separator = ':' } = {}) {
  if (!codeTable || typeof codeTable !== 'object') return { ok: false, error: '代码表不是对象' }
  const sections = []
  const enums = {}
  for (const [enumName, def] of Object.entries(codeTable.enums ?? {})) {
    const items = Array.isArray(def) ? def : (def?.items ?? [])
    enums[enumName] = items.map((item) => ({ v: String(item?.v ?? ''), t: String(item?.t ?? '') })).filter((x) => x.v)
  }
  // RW 的 vtype → 我们的 type
  const TYPE_MAP = {
    string: 'string', LocaleString: 'string', integer: 'integer', float: 'float',
    bool: 'bool', color: 'color', list: 'list', enum: 'enum',
  }
  for (const raw of (codeTable.sections ?? [])) {
    const sec = { id: String(raw.id ?? raw.raw ?? '').replace(/^\[|\]$/g, '').trim(), title: raw.title ?? '', groups: [] }
    if (!sec.id) continue
    for (const group of (raw.groups ?? [])) {
      const g = { name: group.name ?? '', fields: [] }
      for (const entry of (group.entries ?? group.fields ?? [])) {
        const code = String(entry.code ?? '').trim()
        if (!code) continue
        const vtype = String(entry.vtype ?? entry.type ?? 'string')
        const field = {
          code,
          title: String(entry.trans ?? entry.tran ?? entry.title ?? ''),
          type: TYPE_MAP[vtype] ?? (enums[vtype] ? 'enum' : 'string'),
          desc: String(entry.desc ?? '').slice(0, 2000),
          example: String(entry.ex ?? entry.example ?? ''),
        }
        if (enums[vtype]) { field.type = 'enum'; field.enum = vtype }
        else if (field.type === 'enum') {
          // vtype 写的是 "enum" 但没给枚举名 → 退回 string。
          // 硬留一个叫 "enum" 的枚举引用只会产出一堆「引用了不存在的枚举」假警告。
          field.type = 'string'
          delete field.enum
        }
        g.fields.push(field)
      }
      if (g.fields.length > 0) sec.groups.push(g)
    }
    if (sec.groups.length > 0) sections.push(sec)
  }
  if (sections.length === 0) return { ok: false, error: '代码表里没解析出任何段（结构对不上？）' }

  /* 代码表里的「引用块」不是依赖关系，而是**取值词表**（内置爆炸效果、AI 难度、
   * 可选事件、代码可用内置图像……）。这些很有用：
   *   ① 当枚举用（生成时不会瞎填）
   *   ② 「代码可用内置图像」那一块必须拎出来当白名单 ——
   *      否则体检会把引擎自带图（beam1.png 之类）当成"文件缺失"报一堆假警报。 */
  const blocks = []
  const builtInAssets = []
  for (const block of (codeTable.reference_blocks ?? [])) {
    const title = String(block?.title ?? '')
    const items = (block?.items ?? []).map((i) => ({ v: String(i?.v ?? ''), t: String(i?.t ?? '') })).filter((x) => x.v)
    if (items.length === 0) continue
    blocks.push({ title, items })
    if (/图像|贴图|素材|image|sprite/i.test(title)) {
      for (const item of items) {
        if (/\.(png|jpg|jpeg|webp|ogg|wav|mp3)$/i.test(item.v)) builtInAssets.push(item.v)
      }
    }
  }
  // 名字干净的块（纯 ASCII 标识符标题）顺手转成枚举，供字段引用
  for (const block of blocks) {
    const key = titleToEnumKey(block.title)
    if (key && !enums[key] && block.items.length > 1) enums[key] = block.items
  }

  return {
    ok: true,
    schema: normalizeSchema({
      id, label: label || `${id}（导入自代码表）`, format, separator,
      sections, enums, blocks, builtInAssets,
    }),
    stats: {
      sections: sections.length,
      fields: sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.fields.length, 0), 0),
      enums: Object.keys(enums).length,
      blocks: blocks.length,
      builtInAssets: builtInAssets.length,
    },
  }
}

/** 从中文标题里捞一个能当枚举名的 ASCII 标识（捞不到就不转）。 */
function titleToEnumKey(title) {
  const ascii = String(title).replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '')
  if (ascii.length >= 3 && /^[A-Za-z_]/.test(ascii)) return ascii
  // 中文标题但括号里有英文标识（如 "“自动触发事件”(autoTriggerOnEvent)的可填事件"）
  const paren = /\(([A-Za-z_][\w]{2,})\)/.exec(String(title))
  return paren ? paren[1] : ''
}
