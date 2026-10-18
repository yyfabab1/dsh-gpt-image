/**
 * 资产预算审批流：超过阈值的花费不直接跑，而是生成一份「待批准清单」等人点确认。
 *
 * 为什么需要：四道锁拦的是「单次张数/日预算」，但一次 5 元、10 元的大批采购在心理上是另一回事 ——
 * 那属于"要跟人商量"的量级。这里把「大额」单独拎出来：
 *   ① 超过 approvalThreshold（默认 5 元）→ 不执行，生成待批准单
 *   ② 单子写明：要花多少、画什么、用途/影响范围（哪些游戏文件会用到）
 *   ③ 人在面板上点确认（或工具带 approved_token）才真正放行
 *   ④ 单子有签名：参数没变才认（改了参数就作废，防止"批准 A 结果跑了 B"）
 */
import path from 'node:path'
import { nowIso, readJson, sha256, writeJsonAtomic } from './util.js'

export const approvalFile = (dataDir) => path.join(dataDir, 'approvals.json')
export const DEFAULT_APPROVALS = { version: 1, threshold: 5, items: [] }

/** 参数签名：同样的一批活儿才认同一张单。 */
export function approvalToken(payload) {
  return `apr_${sha256(JSON.stringify({
    project: payload.project ?? '',
    names: (payload.names ?? []).slice().sort(),
    images: payload.images ?? 0,
    cost: payload.cost ?? 0,
    action: payload.action ?? '',
  })).slice(0, 16)}`
}

export class ApprovalQueue {
  constructor(file, data) {
    this.file = file
    this.data = { ...DEFAULT_APPROVALS, ...data }
    if (!Array.isArray(this.data.items)) this.data.items = []
  }

  static async load(dataDir) {
    const file = approvalFile(dataDir)
    return new ApprovalQueue(file, (await readJson(file, null)) ?? {})
  }

  async save() {
    this.data.updatedAt = nowIso()
    this.data.items = this.data.items.slice(-200)
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  get threshold() {
    return Number(this.data.threshold ?? DEFAULT_APPROVALS.threshold)
  }

  pending() {
    return this.data.items.filter((item) => item.status === 'pending')
  }

  /**
   * 需要审批吗？超阈值且没被批准过就要。
   * @param {{cost:number, token?:string}} request
   */
  needsApproval({ cost, token = '' }) {
    if (cost <= this.threshold) return { required: false, threshold: this.threshold }
    const approved = this.data.items.find((item) => item.token === token && item.status === 'approved')
    return {
      required: !approved,
      threshold: this.threshold,
      cost,
      already_approved: Boolean(approved),
      reason: `这批要花 ${cost} 元，超过审批阈值 ${this.threshold} 元 —— 按规矩先出单，等人点确认。`,
    }
  }

  /**
   * 生成一张待批准单。
   * @param {{action:string, project:string, names:string[], images:number, cost:number,
   *          currency?:string, purpose?:string, impact_files?:string[],
   *          samples?:Array<{name:string,prompt:string}>}} payload
   */
  create(payload) {
    const token = approvalToken(payload)
    const existing = this.data.items.find((item) => item.token === token && item.status === 'pending')
    if (existing) return existing
    const item = {
      token,
      createdAt: nowIso(),
      status: 'pending',
      action: payload.action,
      project: payload.project ?? '',
      images: payload.images ?? 0,
      cost: Number((payload.cost ?? 0).toFixed(4)),
      currency: payload.currency ?? 'CNY',
      purpose: payload.purpose ?? '',
      // 影响范围：这批素材会被哪些游戏文件用到（决定"动它要连带改什么"）
      impact_files: payload.impact_files ?? [],
      names: payload.names ?? [],
      samples: (payload.samples ?? []).slice(0, 8),
      decidedAt: '',
      decidedBy: '',
    }
    this.data.items.push(item)
    return item
  }

  /** 批准 / 驳回。 */
  decide(token, decision, { by = 'user' } = {}) {
    const item = this.data.items.find((entry) => entry.token === token)
    if (!item) return { ok: false, error: `找不到待批准单 ${token}` }
    if (item.status !== 'pending') return { ok: false, error: `这张单已经处理过了（${item.status}）` }
    item.status = decision === 'approve' ? 'approved' : 'rejected'
    item.decidedAt = nowIso()
    item.decidedBy = by
    return { ok: true, item }
  }

  /** 面板列表：把过期的（超 24h 还没处理）标出来。 */
  list({ status = '' } = {}) {
    const now = Date.now()
    return this.data.items
      .filter((item) => !status || item.status === status)
      .slice()
      .reverse()
      .map((item) => ({
        ...item,
        stale: item.status === 'pending' && now - Date.parse(item.createdAt) > 24 * 3600 * 1000,
        summary: `花 ${item.cost} ${item.currency} 画 ${item.images} 张（${item.project || '未命名项目'}）`,
      }))
  }
}

/** 给人看的待批准清单文本（可直接贴进对话）。 */
export function approvalText(item) {
  const lines = [
    `【待批准】${item.action} · ${item.project || '未命名项目'}`,
    `  要花：${item.cost} ${item.currency}（${item.images} 张）`,
  ]
  if (item.purpose) lines.push(`  用途：${item.purpose}`)
  if (item.names?.length) lines.push(`  画什么：${item.names.slice(0, 8).join('、')}${item.names.length > 8 ? ` 等 ${item.names.length} 个` : ''}`)
  if (item.impact_files?.length) lines.push(`  影响范围：${item.impact_files.slice(0, 5).join('、')}`)
  lines.push(`  单号：${item.token}（点确认后带 approved_token 再跑；参数变了单子作废）`)
  return lines.join('\n')
}
