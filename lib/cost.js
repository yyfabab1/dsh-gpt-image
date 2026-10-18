/**
 * 真实成本校准：把「估算单价」校准成「实际单价」。
 *
 * 两种来源：
 *  ① 上游返回里带真实花费（usage / cost 字段）→ 直接采信
 *  ② 用户手动报账（"这次 12 张扣了 0.48 元"）→ 反推单价
 * 校准后写进 spend.json 的 `pricePerImage`，之后所有预算/估算都用真实单价。
 */
import { nowIso } from './util.js'

/** 从上一次响应里挖真实花费：不同中转站字段不一样，都试一遍。 */
export function extractActualCost(payload) {
  if (!payload || typeof payload !== 'object') return null
  const candidates = [
    payload.usage?.total_cost,
    payload.usage?.cost,
    payload.cost,
    payload.total_cost,
    payload.billing?.cost,
    payload.data?.usage?.total_cost,
    payload.data?.cost,
  ]
  for (const value of candidates) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

/**
 * 用真实数据校准单价。
 * @param {import('./spend.js').SpendLedger} spend
 * @param {{images:number, actualCost?:number, note?:string}} report
 */
export function calibratePrice(spend, { images, actualCost, note = '' }) {
  const count = Number(images)
  const cost = Number(actualCost)
  if (!Number.isFinite(count) || count <= 0) return { ok: false, error: `张数无效：${images}` }
  if (!Number.isFinite(cost) || cost <= 0) return { ok: false, error: `实际花费无效：${actualCost}` }
  const unit = Number((cost / count).toFixed(6))
  const before = spend.price
  spend.data.pricePerImage = unit
  spend.data.priceCalibration = {
    at: nowIso(),
    before,
    after: unit,
    samples: Number(spend.data.priceCalibration?.samples ?? 0) + 1,
    lastImages: count,
    lastCost: cost,
    note,
  }
  return {
    ok: true,
    price_per_image: unit,
    before,
    changed: Math.abs(before - unit) > 1e-9,
    currency: spend.data.currency,
    hint: Math.abs(before - unit) > 1e-9
      ? `单价已从 ${before} 校准为 ${unit} ${spend.data.currency}/张，之后所有预算都按真实价算。`
      : `单价与实测一致（${unit}），无需调整。`,
  }
}

/**
 * 预算日历：按天聚合花费，给出趋势与预测。
 * @param {import('./spend.js').SpendLedger} spend
 * @param {{days?:number}} options
 */
export function budgetCalendar(spend, { days = 30 } = {}) {
  const byDay = new Map()
  for (const record of spend.data.records ?? []) {
    const day = String(record.at ?? '').slice(0, 10)
    if (!day) continue
    const bucket = byDay.get(day) ?? { date: day, images: 0, cost: 0, runs: 0 }
    bucket.images += Number(record.images ?? 0)
    bucket.cost = Number((bucket.cost + Number(record.cost ?? 0)).toFixed(4))
    bucket.runs += 1
    byDay.set(day, bucket)
  }
  const today = new Date().toISOString().slice(0, 10)
  byDay.set(today, byDay.get(today) ?? { date: today, images: 0, cost: 0, runs: 0 })
  const calendar = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.max(1, days))
  const activeDays = calendar.filter((day) => day.cost > 0)
  const totalCost = Number(calendar.reduce((sum, day) => sum + day.cost, 0).toFixed(4))
  const totalImages = calendar.reduce((sum, day) => sum + day.images, 0)
  const avgPerActiveDay = activeDays.length ? Number((totalCost / activeDays.length).toFixed(4)) : 0
  const budget = Number(spend.locks.dailyBudget ?? 0)
  const spentToday = Number((byDay.get(today)?.cost ?? 0).toFixed(4))
  // 按最近 7 天的日均推算还能撑几天
  const recent = calendar.slice(0, 7).filter((day) => day.cost > 0)
  const recentAvg = recent.length ? Number((recent.reduce((sum, day) => sum + day.cost, 0) / recent.length).toFixed(4)) : 0
  return {
    today,
    calendar,
    total_cost: totalCost,
    total_images: totalImages,
    currency: spend.data.currency,
    price_per_image: spend.price,
    price_source: spend.data.priceCalibration ? `实测校准（${spend.data.priceCalibration.after}）` : '手动设置',
    daily_budget: budget,
    spent_today: spentToday,
    remaining_today: Number(Math.max(0, budget - spentToday).toFixed(4)),
    avg_per_active_day: avgPerActiveDay,
    forecast_daily: recentAvg,
    trend: recentAvg > avgPerActiveDay * 1.2 ? 'up' : recentAvg < avgPerActiveDay * 0.8 ? 'down' : 'flat',
    active_days: activeDays.length,
  }
}

/** 把日历渲染成一段可直接贴进对话的文本条形图。 */
export function calendarText(calendar, { currency = 'CNY' } = {}) {
  const days = [...calendar].sort((a, b) => a.date.localeCompare(b.date)).slice(-14)
  if (days.length === 0) return '(还没有花费记录)'
  const max = Math.max(...days.map((day) => day.cost), 0.0001)
  return days.map((day) => {
    const bars = Math.max(day.cost > 0 ? 1 : 0, Math.round((day.cost / max) * 20))
    const bar = '█'.repeat(bars).padEnd(20, '·')
    return `${day.date}  ${bar}  ${day.cost.toFixed(4)} ${currency}  ${day.images} 张`
  }).join('\n')
}

/**
 * 花费预测：「这批素材画完要多少钱、还能撑几天、什么时候会撞到预算」。
 * @param {import('./spend.js').SpendLedger} spend
 * @param {{pendingAssets:number, avgImagesPerAsset?:number, perDay?:number}} params
 */
export function forecastSpend(spend, { pendingAssets = 0, avgImagesPerAsset = 1, perDay = 0 } = {}) {
  const price = spend.price
  const budget = Number(spend.locks.dailyBudget ?? 0)
  const spentToday = spend.todaySpent()
  const plannedImages = Math.max(0, pendingAssets * Math.max(1, avgImagesPerAsset))
  const plannedCost = Number((plannedImages * price).toFixed(4))
  const remainingToday = Number(Math.max(0, budget - spentToday).toFixed(4))
  const affordableToday = price > 0 ? Math.floor(remainingToday / price) : 0
  const days = budget > 0 && plannedCost > 0 ? Math.ceil(plannedCost / budget) : 0
  const calendar = budgetCalendar(spend, { days: 14 })
  const dailyRate = perDay > 0 ? perDay : (calendar.forecast_daily || plannedCost)
  const daysUntilBudgetTight = dailyRate > 0 && budget > 0 ? Math.floor(budget / dailyRate) : null
  return {
    price_per_image: price,
    currency: spend.data.currency,
    pending_assets: pendingAssets,
    planned_images: plannedImages,
    planned_cost: plannedCost,
    daily_budget: budget,
    spent_today: Number(spentToday.toFixed(4)),
    remaining_today: remainingToday,
    affordable_today: affordableToday,
    can_finish_today: plannedImages <= affordableToday,
    days_needed: days,
    forecast_daily: dailyRate,
    budget_healthy_days: daysUntilBudgetTight,
    advice: plannedImages === 0
      ? '还没有待生成清单，用 scan 攒一批再看预测。'
      : plannedImages <= affordableToday
        ? `这批 ${plannedImages} 张约 ${plannedCost} ${spend.data.currency}，今天额度够（还剩 ${remainingToday}）。`
        : `这批 ${plannedImages} 张约 ${plannedCost} ${spend.data.currency}，今天只够 ${affordableToday} 张（还剩 ${remainingToday}）—— 建议分 ${Math.max(2, days)} 天跑。`,
  }
}
