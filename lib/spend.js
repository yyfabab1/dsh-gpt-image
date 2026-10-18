/**
 * 花钱闸门（多道锁）：再也不想"莫名其妙被花走钱"。
 *
 * 每一次要花钱的调用都会先过这里，四道锁：
 *   ① 总闸    spendDisabled=true            → 一切付费调用直接拒绝
 *   ② 单次张数 perRunMaxImages（默认 12）    → 超过就拒绝，让你拆批
 *   ③ 确认锁   一次要花 >1 张               → 必须显式 confirm=true（默认开启）
 *   ④ 日预算   dailyBudget（默认 1.0 元/天） → 当天累计 + 本次估算超了直接拒绝
 * 另外每笔都会记账（spend.json）：今天花了多少、做了几张、每次的明细。
 */
import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from './util.js'

export const DEFAULT_SPEND = {
  version: 1,
  currency: 'CNY',
  pricePerImage: 0.04,
  locks: {
    spendDisabled: false,
    perRunMaxImages: 12,
    confirmAboveImages: 1,
    dailyBudget: 1.0,
  },
  totals: { images: 0, cost: 0, runs: 0, free: { images: 0, runs: 0 }, paid: { images: 0, runs: 0, cost: 0 } },
  records: [],
}

export const spendFile = (dataDir) => path.join(dataDir, 'spend.json')
const today = () => new Date().toISOString().slice(0, 10)

export class SpendLedger {
  constructor(dataDir, file, data) {
    this.dataDir = dataDir
    this.file = file
    this.data = {
      ...DEFAULT_SPEND,
      ...data,
      locks: { ...DEFAULT_SPEND.locks, ...(data?.locks ?? {}) },
      totals: { ...DEFAULT_SPEND.totals, ...(data?.totals ?? {}) },
      records: Array.isArray(data?.records) ? data.records : [],
    }
  }

  static async load(dataDir) {
    const file = spendFile(dataDir)
    const raw = await readJson(file, null)
    return new SpendLedger(dataDir, file, raw ?? {})
  }

  async save() {
    this.data.updatedAt = nowIso()
    this.data.records = this.data.records.slice(-500)
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  get price() {
    return Number(this.data.pricePerImage ?? DEFAULT_SPEND.pricePerImage)
  }

  /** 当前生效单价：优先用当前配置档声明的单价（见 index.js loadState）。 */
  get effectivePrice() {
    const override = Number(this.data.activePricePerImage)
    return Number.isFinite(override) && override >= 0 ? override : this.price
  }

  get locks() {
    return this.data.locks
  }

  /** 今天已经花了多少钱（只算付费；免费记录 cost 恒为 0，天然不计入）。 */
  todaySpent() {
    const day = today()
    return this.data.records
      .filter((record) => String(record.at).slice(0, 10) === day)
      .reduce((sum, record) => sum + Number(record.cost ?? 0), 0)
  }

  todayImages() {
    const day = today()
    return this.data.records
      .filter((record) => String(record.at).slice(0, 10) === day)
      .reduce((sum, record) => sum + Number(record.images ?? 0), 0)
  }

  /** 记录是否算「免费档产出」：显式标记优先，否则按金额 0 推断（兼容旧记录）。 */
  static isFreeRecord(record) {
    if (record?.free !== undefined) return Boolean(record.free)
    return Number(record?.cost ?? 0) === 0
  }

  /**
   * 今天的免费档产出（单独统计，不占付费额度）。
   * 用户要求：免费的要「单独计算、无限额度」—— 所以它既不吃日预算，也单独计数。
   */
  todayFree() {
    const day = today()
    const rows = this.data.records.filter((record) => String(record.at).slice(0, 10) === day && SpendLedger.isFreeRecord(record))
    return { images: rows.reduce((sum, r) => sum + Number(r.images ?? 0), 0), runs: rows.length }
  }

  /** 今天的付费产出（花掉的钱 + 张数）。 */
  todayPaid() {
    const day = today()
    const rows = this.data.records.filter((record) => String(record.at).slice(0, 10) === day && !SpendLedger.isFreeRecord(record))
    return {
      images: rows.reduce((sum, r) => sum + Number(r.images ?? 0), 0),
      runs: rows.length,
      cost: Number(rows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0).toFixed(4)),
    }
  }

  /**
   * 过闸门。返回 { allow, needConfirm, refusals[], estimate, today, remaining, free }。
   *
   * 免费档（单价 0）的语义是**无限额度**：
   *   - 不吃日预算（哪怕付费额度已经用尽，免费照样能跑）
   *   - 不触发确认锁（0 元没有可防的）
   *   - 不受 spendDisabled（那是个"付费总闸"）影响
   *   - 仍然受「单次张数」约束：那是请求体量的保护，不是钱的问题
   * 跳过了哪些锁会在 `skipped_locks` 里明说，避免用户疑惑"为什么没拦我"。
   * @param {{images:number, action:string, confirm?:boolean, force?:boolean, note?:string, pricePerImage?:number}} request
   */
  check({ images = 1, action = 'generate', confirm = false, note = '', pricePerImage }) {
    const locks = this.locks
    const count = Math.max(1, Number(images) || 1)
    // 允许按配置档覆盖单价：免费档（如 Agnes 免费期）传 0。
    const override = pricePerImage !== undefined ? Number(pricePerImage) : this.effectivePrice
    const unit = Number.isFinite(override) && override >= 0 ? override : this.price
    const free = unit === 0
    const estimate = Number((count * unit).toFixed(4))
    const spentToday = this.todaySpent()
    const refusals = []
    const skippedLocks = []
    let needConfirm = false

    // 总闸 / 确认锁 / 日预算都只针对「要花钱」的调用；免费档一律跳过并记录在案
    if (free) {
      if (locks.spendDisabled) skippedLocks.push('spendDisabled')
      skippedLocks.push('confirmAboveImages', 'dailyBudget')
    } else {
      if (locks.spendDisabled) {
        refusals.push('总闸关着（locks.spendDisabled = true）：付费调用被拒绝。要跑先在 config 里 set_locks {"spendDisabled": false}。')
      }
      if (count > Number(locks.confirmAboveImages ?? DEFAULT_SPEND.locks.confirmAboveImages) && !confirm) {
        needConfirm = true
      }
      const budget = Number(locks.dailyBudget ?? DEFAULT_SPEND.locks.dailyBudget)
      if (budget > 0 && spentToday + estimate > budget + 1e-9) {
        refusals.push(`日预算 ${budget} ${this.data.currency}：付费已花 ${spentToday.toFixed(4)}，本次还要 ${estimate}，超了。要么明天再来，要么调高 locks.dailyBudget。`)
      }
    }
    // 单次张数对免费档同样生效：这是请求体量保护，跟花不花钱无关
    if (count > Number(locks.perRunMaxImages ?? DEFAULT_SPEND.locks.perRunMaxImages)) {
      refusals.push(`单次最多 ${locks.perRunMaxImages} 张（本次 ${count} 张）：拆成几批跑，或调高 locks.perRunMaxImages。`)
    }

    const budget = Number(locks.dailyBudget ?? DEFAULT_SPEND.locks.dailyBudget)
    const freeToday = this.todayFree()
    const paidToday = this.todayPaid()

    return {
      allow: refusals.length === 0 && !needConfirm,
      needConfirm: refusals.length === 0 && needConfirm,
      refusals,
      action,
      note,
      images: count,
      estimate,
      estimate_total: Number((spentToday + estimate).toFixed(4)),
      price_per_image: unit,
      free,
      price_source: free ? '免费档（该配置档单价为 0）：单独计数、无限额度' : undefined,
      // 免费档跳过了哪些锁，明说，避免"为什么没拦我"
      skipped_locks: free ? skippedLocks : [],
      quota: free ? 'unlimited' : 'budget',
      currency: this.data.currency,
      today: {
        date: today(),
        images: this.todayImages(),
        cost: Number(spentToday.toFixed(4)),
        budget,
        // 免费与付费分开报：免费张数不参与付费额度
        free_images: freeToday.images,
        paid_images: paidToday.images,
        paid_cost: paidToday.cost,
      },
      remaining_today: free
        ? null // 免费=无限，没有"剩余"这个概念
        : Number(Math.max(0, budget - spentToday - estimate).toFixed(4)),
      locks,
      totals: this.data.totals,
      hint: refusals.length > 0
        ? '被闸门拦下了，没有花任何钱。'
        : needConfirm
          ? `这次要花约 ${estimate} ${this.data.currency}（${count} 张）：确认就再调一次并带 confirm=true。`
          : free
            ? `通过：免费档，本次 0 ${this.data.currency}（${count} 张）。无限额度，单独计数；今日已免费出 ${freeToday.images + count} 张。`
            : `通过：本次约 ${estimate} ${this.data.currency}。`,
    }
  }

  /**
   * 记账（只在真的发过请求之后调用）。
   * 免费与付费分开累计：免费只加张数/次数，永不加金额，因此绝不会挤占付费额度。
   */
  record({ action = 'generate', images = 1, cost, note = '', project = '', names = [], free }) {
    const isFree = free !== undefined ? Boolean(free) : this.effectivePrice === 0
    const unit = isFree ? 0 : this.price
    const amount = Number(cost ?? images * unit)
    const entry = {
      at: nowIso(), action, images,
      cost: Number(amount.toFixed(4)),
      free: isFree,
      project, names: names.slice(0, 20), note,
    }
    this.data.records.push(entry)
    // 总账（历史兼容）
    this.data.totals.images += images
    this.data.totals.cost = Number((this.data.totals.cost + amount).toFixed(4))
    this.data.totals.runs += 1
    // 分账：免费 / 付费各记一份，免费永远不产生金额
    if (!this.data.totals.free) this.data.totals.free = { images: 0, runs: 0 }
    if (!this.data.totals.paid) this.data.totals.paid = { images: 0, runs: 0, cost: 0 }
    if (isFree) {
      this.data.totals.free.images += images
      this.data.totals.free.runs += 1
    } else {
      this.data.totals.paid.images += images
      this.data.totals.paid.runs += 1
      this.data.totals.paid.cost = Number((this.data.totals.paid.cost + amount).toFixed(4))
    }
    return entry
  }
}
