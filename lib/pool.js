/**
 * 素材需求池（省钱的核心）：
 * 发现缺什么素材 → 先登记进池子，**攒够一批再生成**，而不是发现一张就生一张。
 *
 *  - 阈值：默认 8 张；卡牌类游戏（杀戮尖塔那种）默认 12 张（可改）
 *  - 单价：默认 0.04（元/张，可改），随时算出「这一批要花多少」
 *  - 去重：已经在出图历史里成功生成过的，不会重复入池，也不会重复花钱
 *
 * 为什么省钱：零散生成时，需求边发现边变，容易生完就改、改完就废；
 * 攒成一批再跑，只跑一次、只花一批的钱，且失败的整批复盘成本更低。
 */
import path from 'node:path'
import { nowIso, readJson, sha256, writeJsonAtomic } from './util.js'

export const DEFAULT_POOL = {
  version: 1,
  threshold: 8,
  thresholds: { default: 8, card: 12, rpg: 8, 'tower-defense': 8, platformer: 8, shooter: 8, rts: 8, sandbox: 8, 'visual-novel': 8, casual: 8, sim: 8 },
  pricePerImage: 0.04,
  currency: 'CNY',
  /** 单次自动花费上限（元）：超过就必须显式 confirm=true，避免手滑一次跑掉一大批。 */
  autoSpendLimit: 0.5,
  items: [],
}

export function poolFile(dataDir) {
  return path.join(dataDir, 'pool.json')
}

export class DemandPool {
  constructor(dataDir, file, data) {
    this.dataDir = dataDir
    this.file = file
    this.data = { ...DEFAULT_POOL, ...data }
    if (!Array.isArray(this.data.items)) this.data.items = []
  }

  static async load(dataDir) {
    const file = poolFile(dataDir)
    const raw = await readJson(file, null)
    const data = raw && typeof raw === 'object' ? { ...DEFAULT_POOL, ...raw } : { ...DEFAULT_POOL }
    data.thresholds = { ...DEFAULT_POOL.thresholds, ...(raw?.thresholds ?? {}) }
    return new DemandPool(dataDir, file, data)
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  /** 当前生效阈值：按题材取，没有就用默认。 */
  thresholdFor(genre = '') {
    const key = String(genre || '').toLowerCase()
    return Number(this.data.thresholds?.[key] ?? this.data.threshold ?? DEFAULT_POOL.threshold)
  }

  get price() {
    return Number(this.data.pricePerImage ?? DEFAULT_POOL.pricePerImage)
  }

  pending() {
    return this.data.items.filter((item) => item.status === 'pending')
  }

  /** 池子里同一素材只留一条（按 key+project+prompt 指纹）。 */
  entryKey(item, project) {
    return sha256([project, item.name ?? '', item.prompt ?? ''].join('|')).slice(0, 16)
  }

  /** 入池去重用的指纹（与出图历史里的 fingerprint 同算法，便于跨模块比对）。 */
  fingerprintOf(project, item) {
    return sha256([project, item.name ?? '', item.prompt ?? item.prompt_hint ?? ''].join('|')).slice(0, 20)
  }

  /**
   * 登记一批需求。
   * @param {{project:string, genre?:string, suggestions:Array<{name?:string,prompt?:string,prompt_hint?:string,size?:string,ratio?:string,quality?:string,kind?:string,reason?:string,priority?:number}>,
   *          existingKeys?:Set<string>, existingFingerprints?:Set<string>, source?:string}} params
   */
  enqueue({ project = 'assets', genre = '', suggestions = [], existingKeys = new Set(), existingFingerprints = new Set(), source = 'scan' }) {
    const added = []
    const skipped = []
    for (const suggestion of suggestions) {
      const name = String(suggestion.name ?? '').trim()
      if (!name) continue
      const id = this.entryKey(suggestion, project)
      const fingerprint = suggestion.fingerprint ?? this.fingerprintOf(project, suggestion)
      if (existingFingerprints.has(fingerprint)) {
        skipped.push({ name, why: '已经生成过（指纹相同）' })
        continue
      }
      if (existingKeys.has(`${project}/${name}`)) {
        skipped.push({ name, why: '已在池子里' })
        continue
      }
      const item = {
        id,
        project,
        name,
        prompt: String(suggestion.prompt ?? suggestion.prompt_hint ?? name),
        size: suggestion.size ?? '',
        // ratio 要一路带到 flush，否则档位式 size（1K/2K）没法定构图方向
        ratio: suggestion.ratio ?? '',
        quality: suggestion.quality ?? 'low',
        kind: suggestion.kind ?? suggestion.category ?? 'image',
        reason: suggestion.reason ?? '',
        priority: suggestion.priority ?? 2,
        fingerprint,
        source,
        status: 'pending',
        addedAt: nowIso(),
      }
      this.data.items.push(item)
      existingKeys.add(`${project}/${name}`)
      added.push(item)
    }
    return { added, skipped }
  }

  markGenerated(names, project = '') {
    let changed = 0
    for (const item of this.data.items) {
      if (item.status !== 'pending') continue
      if (project && item.project !== project) continue
      if (names && !names.includes(item.name)) continue
      item.status = 'generated'
      item.doneAt = nowIso()
      changed += 1
    }
    return changed
  }

  remove(ids = []) {
    const before = this.data.items.length
    this.data.items = this.data.items.filter((item) => !ids.includes(item.id) && !ids.includes(item.name))
    return before - this.data.items.length
  }

  clear(status = 'generated') {
    const before = this.data.items.length
    this.data.items = this.data.items.filter((item) => item.status !== status)
    return before - this.data.items.length
  }

  /** 攒批状态 + 花费预估（给模型和面板看的关键数字）。 */
  report({ genre = '', project = '' } = {}) {
    const pending = this.pending().filter((item) => !project || item.project === project)
    const threshold = this.thresholdFor(genre)
    const cost = Number((pending.length * this.price).toFixed(4))
    const batchCost = Number((threshold * this.price).toFixed(4))
    const limit = Number(this.data.autoSpendLimit ?? DEFAULT_POOL.autoSpendLimit)
    return {
      pending: pending.length,
      threshold,
      genre: genre || '(默认)',
      ready: pending.length >= threshold,
      need_more: Math.max(0, threshold - pending.length),
      price_per_image: this.price,
      currency: this.data.currency,
      cost_if_now: cost,
      cost_at_threshold: batchCost,
      auto_spend_limit: limit,
      needs_confirm: cost > limit,
      advice: pending.length >= threshold
        ? (cost > limit
            ? `池子里已有 ${pending.length} 张（≥ 阈值 ${threshold}）：这批要花约 ${cost} ${this.data.currency}，超过自动上限 ${limit} —— 请带上 confirm=true 再跑。`
            : `池子里已有 ${pending.length} 张 ≥ 阈值 ${threshold}：可以开跑了（约 ${batchCost} ${this.data.currency}），用 pool 工具 action=flush 一次生成。`)
        : `还差 ${threshold - pending.length} 张到阈值 ${threshold}；现在只攒了 ${pending.length} 张。零散生成更容易返工白花钱，建议继续攒。`,
      items: pending.map((item) => ({ id: item.id, name: item.name, kind: item.kind, size: item.size, ratio: item.ratio ?? '', project: item.project, reason: item.reason })),
    }
  }
}
