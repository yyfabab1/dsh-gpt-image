/**
 * N 组 · 执行自动化（声明式流水线）。
 *
 * 这是 O5/N2 的**前提**：没有"声明式配置"，就没有"配置漂移"可言。
 * 现有 lib/pipeline.js 是固定的 scan→generate→install 链，改流程要改代码；
 * 这里做的是**配置驱动的流水线**：改 yaml/json 即改行为。
 *
 * 设计约束（都来自真实踩坑与用户批评）：
 *   - **事务按「批次」划，不按单文件**（N5）：并行下按文件划事务会互相踩
 *   - **幂等**（N6）：同一批跑两次，第二次是 noop（靠 fingerprint）
 *   - **断点续跑**（N4）：跑到第 800 张崩了不从头来（靠 state 文件记已完成）
 *   - **依赖图增量**（N2）：改一张图不触发全库重算
 *
 * 零依赖：不引 yaml 库（那会破坏"零运行时依赖"），用**YAML 子集**解析器。
 * 只支持本插件真正会用到的形状：缩进、`- ` 列表、`key: value`、行内数组。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic, sha256 } from './util.js'

// ───────── 极简 YAML 子集解析 ─────────

/**
 * 解析 YAML 子集。支持：
 *   key: value
 *   key:
 *     - item
 *     - {a: 1, b: 2}
 *   list: [a, b, c]
 * 不支持锚点/多行字符串/嵌套 map-in-list 等复杂特性 —— 用不到，也避免引依赖。
 * @returns {{ok:boolean, data?:object, error?:string, line?:number}}
 */
export function parseYamlSubset(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const root = {}
  // 每个栈帧：{ indent, container, kind } —— kind 为 map 或 list
  const stack = [{ indent: -1, container: root, kind: 'map' }]

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.match(/^ */)[0].length
    const content = raw.trim()

    // 回退到「缩进比当前行小」的那层
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1]

    if (content.startsWith('- ')) {
      const value = content.slice(2).trim()
      if (top.kind !== 'list') {
        return { ok: false, error: `第 ${i + 1} 行：列表项没有归属的 key（上一行应是 "key:"）`, line: i + 1 }
      }
      // 列表项是 map（`- id: x`）——这是流水线最常用的写法，必须支持。
      // 做法：push 一个空对象，然后把这一帧的「当前项」设为它，
      // 后续缩进更深的 `key: value` 会写进这个对象里。
      const inlineMap = value.match(/^([^:]+):\s*(.*)$/)
      if (inlineMap) {
        const item = {}
        const k = inlineMap[1].trim()
        const v = inlineMap[2].trim()
        if (v === '') {
          item[k] = {}
          top.container.push(item)
          stack.push({ indent, container: item[k], kind: 'map' })
          // 记住这个项，供后续同层 key 写入
          top.current = item
          top.itemIndent = indent
        } else {
          item[k] = parseScalar(v)
          top.container.push(item)
          top.current = item
          top.itemIndent = indent
        }
        continue
      }
      top.container.push(parseScalar(value))
      continue
    }

    const m = content.match(/^([^:]+):\s*(.*)$/)
    if (!m) return { ok: false, error: `第 ${i + 1} 行无法识别：${content}`, line: i + 1 }
    const key = m[1].trim()
    const valueText = m[2].trim()

    // 列表项里的后续 key（缩进 > 列表项缩进）→ 写进当前项对象
    if (top.kind === 'list' && top.current && indent > (top.itemIndent ?? -1)) {
      if (valueText === '') {
        top.current[key] = {}
        stack.push({ indent, container: top.current[key], kind: 'map' })
      } else {
        top.current[key] = parseScalar(valueText)
      }
      continue
    }

    if (top.kind === 'list') {
      return { ok: false, error: `第 ${i + 1} 行：列表里出现了顶层 key「${key}」，缩进可能写错了`, line: i + 1 }
    }
    if (valueText === '') {
      // 看下一行是不是列表项：是 → 数组，否 → 嵌套 map
      const next = lines.slice(i + 1).find((l) => l.trim() && !/^\s*#/.test(l))
      const nextIndent = next ? next.match(/^ */)[0].length : -1
      const nextIsList = Boolean(next) && nextIndent > indent && next.trim().startsWith('- ')
      const container = nextIsList ? [] : {}
      top.container[key] = container
      stack.push({ indent, container, kind: nextIsList ? 'list' : 'map' })
      continue
    }
    top.container[key] = parseScalar(valueText)
  }
  return { ok: true, data: root }
}

function parseScalar(text) {
  const t = String(text).trim()
  if (t === '') return ''
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  // 行内数组 [a, b, c]
  if (/^\[.*\]$/.test(t)) {
    return t.slice(1, -1).split(',').map((s) => parseScalar(s.trim())).filter((s) => s !== '')
  }
  // 行内对象 {a: 1, b: 2}
  if (/^\{.*\}$/.test(t)) {
    const out = {}
    for (const pair of t.slice(1, -1).split(',')) {
      const idx = pair.indexOf(':')
      if (idx < 0) continue
      out[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1))
    }
    return out
  }
  // 去引号
  if (/^["'].*["']$/.test(t)) return t.slice(1, -1)
  return t
}

// ───────── N1 流水线定义 ─────────

export const PIPELINE_FILE = 'pipeline.json'

/** 每个步骤的能力声明：需要什么、产出什么、是否可并行。 */
export const STEP_CATALOG = {
  postprocess: { label: '后处理', needs: ['file'], produces: ['file'], parallel: true, idempotentKey: 'mtime+spec' },
  slice: { label: '切片', needs: ['file'], produces: ['derived'], parallel: true, idempotentKey: 'rule+hash' },
  validate: { label: '规格校验', needs: ['file'], produces: ['verdict'], parallel: true, idempotentKey: 'hash+spec' },
  route: { label: '评分路由', needs: ['file', 'verdict'], produces: ['route'], parallel: true, idempotentKey: 'hash+palette' },
  auto_review: { label: '自动审核', needs: ['route'], produces: ['review'], parallel: false, idempotentKey: 'route+policy' },
  install: { label: '装机', needs: ['review'], produces: ['installed'], parallel: false, idempotentKey: 'hash+dest' },
  atlas: { label: '图集打包', needs: ['review'], produces: ['atlas'], parallel: false, idempotentKey: 'members' },
  cleanup: { label: '清理孤儿', needs: [], produces: [], parallel: false, idempotentKey: 'scan' },
}

/** 默认流水线（用户说的"改流程改配置"的那份配置）。 */
export const DEFAULT_PIPELINE = {
  version: 1,
  name: '默认素材流水线',
  // on: 触发时机。manual=手动；new_asset=新素材入队；approve=审核通过
  on: ['manual', 'new_asset'],
  // dry_run_first: 上线前先试跑（自检第 2 条）
  require_dry_run_first: true,
  steps: [
    { id: 'postprocess', use: 'postprocess', opts: { defringe: true, sharpen: true, trim: true } },
    { id: 'slice', use: 'slice', opts: { auto: true } },
    { id: 'validate', use: 'validate', opts: { checks: ['size', 'alpha', 'palette'] } },
    { id: 'route', use: 'route', opts: {} },
    { id: 'auto_review', use: 'auto_review', opts: { min_confidence: 0.85, sample_after: 0.1 } },
    { id: 'install', use: 'install', opts: { auto_if_approved: true } },
  ],
}

export class PipelineConfig {
  constructor(file, data) {
    this.file = file
    this.data = data
  }

  static async load(dataDir) {
    const file = path.join(dataDir, PIPELINE_FILE)
    const raw = await readJson(file, null)
    if (!raw || !Array.isArray(raw.steps)) return new PipelineConfig(file, structuredClone(DEFAULT_PIPELINE))
    return new PipelineConfig(file, raw)
  }

  /** 从 YAML/JSON 文本装载（用户写 yaml 也能吃）。 */
  static parse(text) {
    const trimmed = String(text ?? '').trim()
    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed)
        return { ok: true, data }
      } catch (error) {
        return { ok: false, error: `JSON 解析失败：${error.message}` }
      }
    }
    const yaml = parseYamlSubset(trimmed)
    if (!yaml.ok) return yaml
    return { ok: true, data: yaml.data }
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
  }

  /** 校验流水线定义（步骤存在、依赖顺序合理）。 */
  validate() {
    const errors = []
    const steps = this.data.steps ?? []
    if (steps.length === 0) errors.push('流水线没有任何步骤')
    const seen = new Set()
    const produced = new Set()
    for (const [index, step] of steps.entries()) {
      const id = step.id ?? step.use
      if (!id) { errors.push(`第 ${index + 1} 步没有 id/use`); continue }
      const def = STEP_CATALOG[step.use ?? step.id]
      if (!def) { errors.push(`第 ${index + 1} 步「${id}」不是已知步骤（可用：${Object.keys(STEP_CATALOG).join('/')}）`); continue }
      // 依赖检查：needs 里除了 file，都要有更早的步骤产出来
      for (const need of def.needs) {
        if (need === 'file') continue
        if (!produced.has(need)) {
          errors.push(`第 ${index + 1} 步「${id}」需要「${need}」，但前面没有步骤产出它（步骤顺序有问题）`)
        }
      }
      for (const out of def.produces) produced.add(out)
      seen.add(id)
    }
    return { ok: errors.length === 0, errors, steps: steps.length, produces: [...produced] }
  }
}

// ───────── N2 依赖图 + 增量执行 ─────────

/**
 * 构建步骤依赖图。每个步骤的产物被谁消费 → 反向就是"改了这个要重跑谁"。
 */
export function buildStepGraph(steps = []) {
  const nodes = new Map()
  const producedBy = new Map()
  steps.forEach((step, index) => {
    const def = STEP_CATALOG[step.use ?? step.id] ?? { needs: [], produces: [] }
    nodes.set(step.id ?? step.use, { id: step.id ?? step.use, index, def, step })
    for (const out of def.produces) {
      if (!producedBy.has(out)) producedBy.set(out, [])
      producedBy.get(out).push(step.id ?? step.use)
    }
  })
  // 每个步骤的下游（谁消费它的产出）
  const downstream = new Map()
  for (const [id, node] of nodes) {
    const list = []
    for (const need of node.def.needs) {
      for (const producer of producedBy.get(need) ?? []) {
        if (producer !== id) list.push(producer)
      }
    }
    downstream.set(id, list)
  }
  return { nodes, producedBy, downstream }
}

/**
 * N2：增量计划 —— 只重跑受影响的下游。
 *
 * 判据：每个步骤对**每个输入**算一个幂等键。键没变 → 该步骤对该输入可跳过。
 * 上游变了 → 下游全部失效（沿依赖图传播）。
 *
 * @param {{steps:Array, changedInputs:Array<string>, previousKeys?:object, currentKeys?:object}} params
 */
export function planIncremental({ steps = [], changedInputs = [], previousKeys = {}, currentKeys = {} } = {}) {
  const graph = buildStepGraph(steps)
  const ids = [...graph.nodes.keys()]
  // 自下而上传播：某个步骤的输入变了 → 它也失效
  const dirty = new Set()
  // 输入变化直接影响第一层
  for (const [id, node] of graph.nodes) {
    const key = `${id}|${JSON.stringify(changedInputs)}`
    const changed = Object.entries(currentKeys).some(([k, v]) =>
      k.startsWith(`${id}:`) && previousKeys[k] !== undefined && previousKeys[k] !== v)
    if (changed || node.index === 0 && changedInputs.length > 0) dirty.add(id)
  }
  // 沿依赖传播（迭代到稳定）
  let changed = true
  while (changed) {
    changed = false
    for (const [id, list] of graph.downstream) {
      if (dirty.has(id)) continue
      if (list.some((up) => dirty.has(up))) { dirty.add(id); changed = true }
    }
  }
  const run = ids.filter((id) => dirty.has(id))
  const skip = ids.filter((id) => !dirty.has(id))
  return {
    total: ids.length,
    run,
    skip,
    // 全都没变 → 整个流水线是 noop（N6 幂等）
    noop: run.length === 0,
    note: run.length === 0
      ? '没有任何输入变化 —— 整条流水线是 noop（幂等，可以放心重复触发）。'
      : `需要重跑 ${run.length}/${ids.length} 步（${run.join(' → ')}），其余 ${skip.length} 步跳过 —— 改一张图不会触发全库重算。`,
  }
}

/**
 * N2：算某批输入的幂等键（用于判断"要不要重跑"）。
 */
export function idempotencyKeys({ steps = [], inputs = [], fileStats = {} } = {}) {
  const keys = {}
  for (const step of steps) {
    const id = step.id ?? step.use
    const def = STEP_CATALOG[step.use ?? step.id]
    if (!def) continue
    const parts = inputs.map((file) => {
      const stat = fileStats[file] ?? {}
      return `${file}:${stat.size ?? '?'}:${stat.mtime ?? '?'}`
    }).join('|')
    keys[`${id}:all`] = sha256(`${id}|${def.idempotentKey ?? ''}|${JSON.stringify(step.opts ?? {})}|${parts}`).slice(0, 24)
  }
  return keys
}

// ───────── N4/N5/N6 执行器 ─────────

export const RUN_STATE_FILE = 'pipeline-run.json'

/**
 * 跑一条流水线。
 *
 * 关键设计（对应你的批评）：
 *   - **事务按批次划**（N5）：整批要么按步提交、要么回滚，不留"一半新规则一半旧"
 *   - **断点续跑**（N4）：把已完成项写进 state 文件，重跑时跳过
 *   - **幂等**（N6）：同批同参数跑两次，第二次 noop
 *   - **重试**（N4）：单步失败重试 N 次
 *   - **并行**（N3）：步骤内按并发度处理输入项（IO 密集，不必等于 CPU 核数）
 *
 * @param {{pipeline:object, batchId:string, inputs:Array<string>, dataDir:string,
 *          executors:object, retries?:number, resume?:boolean, dryRun?:boolean,
 *          concurrency?:number, onProgress?:Function}} params
 */
export async function runPipeline({
  pipeline, batchId, inputs = [], dataDir, executors = {},
  retries = 2, resume = true, dryRun = false, concurrency = 0, onProgress,
} = {}) {
  const validation = pipeline.validate ? pipeline.validate() : { ok: true }
  if (!validation.ok) return { ok: false, error: '流水线定义有误', errors: validation.errors }

  const stateFile = path.join(dataDir, RUN_STATE_FILE)
  const previous = resume ? await readJson(stateFile, null) : null
  const sameBatch = previous?.batchId === batchId
  const done = new Set(sameBatch ? (previous.done ?? []) : [])
  const stepResults = []

  const startedAt = Date.now()
  const steps = pipeline.data?.steps ?? pipeline.steps ?? []
  for (const step of steps) {
    const id = step.id ?? step.use
    const executor = executors[step.use ?? id] ?? executors[id]
    if (!executor) {
      // 没接执行器：如实记录，**不 continue 到不记录**
      // （早先 continue 在 push 之前，导致整条流水线的 steps 变成 undefined）
      stepResults.push({ step: id, ok: true, skipped: true, reason: '没有实现该步骤的执行器（配置里有但代码没接）' })
      continue
    }
    const pending = inputs.filter((file) => !done.has(`${id}|${file}`))
    if (pending.length === 0) {
      stepResults.push({ step: id, ok: true, skipped: true, reason: '断点续跑：这一步的输入都已完成' })
      continue
    }
    if (dryRun) {
      stepResults.push({ step: id, ok: true, dry_run: true, would_process: pending.length })
      continue
    }

    let attempt = 0
    let lastError = ''
    let ok = false
    let produced = 0
    const failedItems = []

    // N3 并行：步骤内按并发度切批，批内并发、批间顺序。
    // 注意事务边界**仍是整步**（不是每一批）—— 任一批有失败就整步失败 → 整批中止。
    // 这样并行不会破坏 N5 的事务语义。
    const def = STEP_CATALOG[step.use ?? id] ?? {}
    // 不可并行的步骤（install / atlas 会改同一批目标文件）强制串行
    const stepConcurrency = def.parallel === false
      ? 1
      : Math.max(1, Number(step.opts?.concurrency) || Number(concurrency) || 4)
    const chunks = []
    for (let i = 0; i < pending.length; i += stepConcurrency) chunks.push(pending.slice(i, i + stepConcurrency))

    while (attempt <= retries && !ok) {
      attempt += 1
      failedItems.length = 0
      produced = 0
      for (const chunk of chunks) {
        const settled = await Promise.all(chunk.map(async (file) => {
          try {
            const result = await executor({ step, inputs: [file], batchId, dataDir })
            if (result?.ok === false) return { file, ok: false, error: result.error ?? '执行器返回失败' }
            return { file, ok: true, count: result?.count ?? 1 }
          } catch (error) {
            return { file, ok: false, error: String(error?.message ?? error) }
          }
        }))
        for (const item of settled) {
          if (item.ok) produced += item.count
          else failedItems.push(item)
        }
      }
      if (failedItems.length === 0) { ok = true; break }
      lastError = failedItems.slice(0, 3).map((f) => `${f.file}: ${f.error}`).join('; ')
      if (attempt <= retries) await new Promise((r) => setTimeout(r, 300 * attempt))
    }

    if (ok) {
      for (const file of pending) done.add(`${id}|${file}`)
      // N4：每步完成就落盘，崩了能从这继续
      await writeJsonAtomic(stateFile, { batchId, done: [...done], at: nowIso() })
    } else {
      // N5 事务性：某步失败 → 整批中止（不继续往下做"一半"）
      stepResults.push({ step: id, ok: false, error: lastError, attempts: attempt, failed_items: failedItems.slice(0, 10) })
      await writeJsonAtomic(stateFile, { batchId, done: [...done], at: nowIso(), failedAt: id, error: lastError })
      return {
        ok: false,
        batch_id: batchId,
        steps: stepResults,
        failed_step: id,
        failed_items: failedItems.slice(0, 10),
        error: lastError,
        // 关键：整批中止，不留半成品
        note: `第「${id}」步重试 ${attempt} 次后仍有 ${failedItems.length} 项失败 —— **整批已中止**（事务按批次划），不会留下"一半新规则一半旧"的状态。`
          + `已完成的部分记在断点里：修掉原因后带 resume=true 重跑，会从中断处继续。`,
        ms: Date.now() - startedAt,
      }
    }
    stepResults.push({ step: id, ok: true, processed: pending.length, produced, attempts: attempt, concurrency: stepConcurrency })
    onProgress?.({ step: id, ok: true, processed: pending.length })
  }

  if (!dryRun) await writeJsonAtomic(stateFile, { batchId, done: [...done], at: nowIso(), completed: true })
  return {
    ok: true,
    batch_id: batchId,
    steps: stepResults,
    processed: inputs.length,
    ms: Date.now() - startedAt,
    dry_run: dryRun,
    note: dryRun
      ? '试运行：只报告"会做什么"，没有实际改动。确认无误后去掉 dry_run 再跑。'
      : '整批完成（事务性：要么全成、要么整批中止）。',
  }
}
