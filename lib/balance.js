/**
 * 余额与额度面板：把「还能不能花钱 / 花了多少 / 上游什么情况」汇总成一份能直接显示的报告。
 *
 * 两个来源，必须分清（不然会误导用户）：
 *   ① 本地闸门（真实生效）：spend.json 的今日花费、日预算、剩余、单价、四道锁。
 *      这是真正会拦住出图的东西。
 *   ② 上游账户（能查到多少算多少）：OpenAI 兼容的 billing 接口。
 *      Agnes 有 /v1/dashboard/billing/subscription 与 /usage，但**免费档没有真实余额**
 *      （limit 是 1e8 占位、total_usage 为 0），所以这里如实标注「免费档/无真实余额」，
 *      绝不把占位数字伪装成余额。
 */
import { briefError, candidateBases, httpRequest, joinUrl } from './util.js'

/** OpenAI 兼容的计费端点（多数中转站/服务商沿用这套）。 */
export const BILLING_PATHS = {
  subscription: 'dashboard/billing/subscription',
  usage: 'dashboard/billing/usage',
}

/** 上限值大到不合理时视为「没有真实额度限制」的占位值。 */
const PLACEHOLDER_LIMIT = 1e7

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 查上游账户计费信息。永不抛异常；查不到就用 { ok:false, error } 表达。
 * @returns {Promise<{ok:boolean, provider?:string, base_url?:string, ...}>}
 */
/* 上游余额查询缓存（60 秒）。
 * 为什么：这个查询要打上游接口，实测一次约 1.9 秒；用户在面板上连点几次
 * 或连续问两遍"还剩多少"，就白等 6 秒。余额不会秒级变化，60 秒 TTL 完全够。
 * 传 fresh=true 可穿透缓存（用户明确要刷新时用）。 */
const BALANCE_TTL_MS = 60_000
const balanceCache = new Map()

export function clearBalanceCache() {
  balanceCache.clear()
}

export async function fetchProviderBalance({ profile, provider, timeoutMs = 12000, fresh = false } = {}) {
  const key = `${profile?.id ?? ''}|${provider?.id ?? ''}`
  const cached = balanceCache.get(key)
  if (!fresh && cached && Date.now() - cached.at < BALANCE_TTL_MS) {
    return { ...cached.value, cached: true, cached_age_ms: Date.now() - cached.at }
  }
  const base = profile?.baseUrl
  if (!base) return { ok: false, error: '配置档没有 baseUrl' }
  const bases = candidateBases(base)
  const headers = profile?.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}
  const out = { ok: false, provider: provider?.id ?? profile?.provider ?? '', base_url: bases[0], model: profile?.model ?? '' }

  for (const current of bases) {
    const sub = await httpRequest(joinUrl(current, BILLING_PATHS.subscription), { headers, timeoutMs })
    if (sub.status === 401 || sub.status === 403) {
      return { ...out, ok: false, error: '服务可达，但 Key 无效或无权限', status: sub.status, detail: briefError(sub.json ?? sub.text) }
    }
    if (!sub.ok) {
      // 404 = 这家不提供计费接口（很常见），换个候选 base 再试一次，都不行就如实报告
      out.status = sub.status
      continue
    }
    const body = sub.json ?? {}
    const softLimit = num(body.soft_limit_usd)
    const hardLimit = num(body.hard_limit_usd)
    const effectiveLimit = hardLimit ?? softLimit
    // limit 大到离谱 = 服务商没设真实额度（免费档常见）
    const placeholder = effectiveLimit !== null && effectiveLimit >= PLACEHOLDER_LIMIT

    const usageRes = await httpRequest(joinUrl(current, BILLING_PATHS.usage), { headers, timeoutMs })
    const usageBody = usageRes.ok ? (usageRes.json ?? {}) : {}
    const totalUsage = num(usageBody.total_usage)

    // OpenAI 的 total_usage 单位是「美分」；这里只在能确认时才换算，否则原样给出
    const usedUsd = totalUsage !== null ? Number((totalUsage / 100).toFixed(6)) : null

    return {
      ok: true,
      provider: out.provider,
      base_url: current,
      model: out.model,
      has_payment_method: body.has_payment_method ?? null,
      access_until: num(body.access_until),
      soft_limit_usd: softLimit,
      hard_limit_usd: hardLimit,
      limit_is_placeholder: placeholder,
      total_usage_usd: usedUsd,
      // 关键：只有「有真实上限」时才算得出剩余；否则明确说没有可用余额概念
      remaining_usd: placeholder || effectiveLimit === null || usedUsd === null
        ? null
        : Number((effectiveLimit - usedUsd).toFixed(6)),
      balance_available: !(placeholder || effectiveLimit === null),
      note: placeholder
        ? '该账户没有真实额度上限（免费档/内部额度）：这里的 limit 是占位值，不能当余额看。'
        : usageRes.ok
          ? '余额 = 额度上限 − 累计用量（按上游 billing 接口计算）。'
          : '查到了额度上限，但取不到累计用量，无法算出剩余。',
      usage_checked: usageRes.ok,
    }
  }
  return { ...out, ok: false, error: `这家服务商没有计费接口（已试 /${BILLING_PATHS.subscription}）`, status: out.status ?? 404 }
}

/**
 * 汇总一份「余额 / 花费 / 上游状态」报告。
 * @param {{profiles:object, spend:object, pool?:object, gallery?:object, profileId?:string, checkRemote?:boolean, timeoutMs?:number}} params
 */
export async function buildBalanceReport({ profiles, spend, pool, gallery, profileId = '', checkRemote = true, timeoutMs = 12000, fresh = false } = {}) {
  const profile = profiles.get(profileId) || profiles.active
  const currency = spend.data.currency ?? 'CNY'
  const priceOverride = Number(profile?.pricePerImage)
  // 当前配置档的有效单价（免费档为 0）。
  // 优先用闸门里的 activePricePerImage（index.js loadState 注入的，与真正拦人的那个值同源）；
  // 没注入时退回配置档自己的 pricePerImage，避免「配置档写了免费、报告却按付费算」这种不一致。
  const injected = Number(spend.effectivePrice)
  const unit = Number.isFinite(priceOverride) && priceOverride >= 0 && !Number.isFinite(Number(spend.data.activePricePerImage))
    ? priceOverride
    : injected
  const isFreeTier = unit === 0

  const status = spend.check({ images: 0, action: 'status' })
  const locks = status.locks ?? {}
  const budget = Number(locks.dailyBudget ?? 0)
  // 免费与付费分开算：免费档是「无限额度」，不进预算口径
  const freeToday = spend.todayFree ? spend.todayFree() : { images: 0, runs: 0 }
  const paidToday = spend.todayPaid ? spend.todayPaid() : { images: 0, runs: 0, cost: 0 }
  const spentToday = Number((paidToday.cost ?? 0).toFixed(4))
  const remaining = Number(Math.max(0, budget - spentToday).toFixed(4))
  const usedPct = budget > 0 ? Math.min(100, Number(((spentToday / budget) * 100).toFixed(1))) : null

  // 还能再出几张（按当前单价）——比「剩多少钱」更直观
  const imagesAffordable = unit > 0 ? Math.floor(remaining / unit) : null

  // 文字版状态，给用户一眼看懂「什么情况」
  let state = 'healthy'
  let advice = '额度充足。'
  if (isFreeTier) {
    // 免费 = 无限额度：不受总闸/日预算/确认锁影响，只单独计数
    state = 'free'
    advice = `当前配置档是免费档（单价 0）：无限额度、单独计数，不占日预算也不触发确认锁。`
      + `今日已免费出 ${freeToday.images} 张（付费花费另计：${spentToday} / ${budget || '不限'} ${currency}）。`
  } else if (locks.spendDisabled) {
    state = 'disabled'
    advice = '总闸关着：付费调用会被拒绝。要跑先在 config 里 set_locks {"spendDisabled": false}。（免费档不受影响）'
  } else if (budget > 0 && spentToday >= budget) {
    state = 'exhausted'
    advice = `今天的付费预算已经用完（${spentToday} / ${budget} ${currency}），再走付费档会被闸门拦下。`
      + `明天恢复，或调高 locks.dailyBudget；也可以切到免费档继续出图。`
  } else if (budget > 0 && usedPct !== null && usedPct >= 80) {
    state = 'tight'
    advice = `付费预算快用完了（已用 ${usedPct}%），今天大约还能出 ${imagesAffordable} 张。`
  } else if (budget > 0 && imagesAffordable !== null) {
    advice = `今天还能出约 ${imagesAffordable} 张（付费剩余 ${remaining} ${currency}）。`
  }

  const report = {
    ok: true,
    generated_at: new Date().toISOString(),
    currency,
    state,
    advice,
    active_profile: profile?.id ?? '',
    active_provider: profile?.provider ?? '',
    active_model: profile?.model ?? '',
    price_per_image: unit,
    price_is_profile_override: Number.isFinite(priceOverride) && priceOverride >= 0,
    free_tier: isFreeTier,
    // 免费=无限额度：UI 里据此显示「∞」而不是「剩余」
    quota: isFreeTier ? 'unlimited' : 'budget',
    today: {
      date: status.today?.date ?? '',
      images: status.today?.images ?? 0,
      cost: spentToday,
      budget,
      remaining,
      used_pct: usedPct,
      // 分账：免费张数不参与付费额度
      free_images: freeToday.images,
      free_runs: freeToday.runs,
      paid_images: paidToday.images,
      paid_runs: paidToday.runs,
      paid_cost: spentToday,
    },
    free_today: freeToday,
    paid_today: paidToday,
    images_affordable_today: imagesAffordable,
    // 与花钱闸门的字段名保持一致（免费档为 null = 无限额度）
    remaining_today: isFreeTier ? null : remaining,
    totals: status.totals ?? { images: 0, cost: 0, runs: 0 },
    locks: {
      spend_disabled: Boolean(locks.spendDisabled),
      per_run_max_images: locks.perRunMaxImages ?? null,
      confirm_above_images: locks.confirmAboveImages ?? null,
      daily_budget: budget,
    },
    pool: pool
      ? { pending: pool.pending().length, threshold: pool.thresholdFor('') }
      : null,
    gallery: gallery ? gallery.stats() : null,
    remote: null,
  }

  // 所有配置档的单价一览：一眼看出哪个免费、哪个花钱
  report.profiles = profiles.profiles.map((item) => ({
    id: item.id,
    name: item.name ?? item.id,
    provider: item.provider ?? '',
    model: item.model ?? '',
    price_per_image: Number.isFinite(Number(item.pricePerImage)) ? Number(item.pricePerImage) : Number(spend.data.pricePerImage ?? 0),
    price_declared: item.pricePerImage !== undefined,
    is_active: item.id === report.active_profile,
  }))

  if (checkRemote) {
    // 远端查询把「上游什么情况」也带回来；失败不影响本地部分可用
    // （视频队列满/免费档限流这类信息，用户最需要看见）
    const remoteResult = await fetchProviderBalance({ profile, provider: { id: profile?.provider }, timeoutMs, fresh })
    if (remoteResult && remoteResult.ok && !remoteResult.cached) {
      balanceCache.set(`${profile?.id ?? ''}|${profile?.provider ?? ''}`, { at: Date.now(), value: remoteResult })
    }
    report.remote = remoteResult
  }
  return report
}

/** 把报告压成一行短文本（徽章/日志用）。 */
export function balanceSummaryText(report) {
  if (!report?.ok) return '余额不可用'
  const cur = report.currency ?? 'CNY'
  const freeImages = report.today?.free_images ?? 0
  const paidCost = report.today?.paid_cost ?? 0
  // 免费=无限额度：只说「免费档 + 已出多少张」，不提预算
  if (report.free_tier) return `免费档 ∞ · 今日 ${freeImages} 张`
  if (report.locks?.spend_disabled) return '付费总闸已关'
  const budget = report.today?.budget ?? 0
  if (!budget) return `今日 ${paidCost} ${cur} · 不限额度`
  return `${paidCost} / ${budget} ${cur}${freeImages ? ` （+免费 ${freeImages}）` : ''}`
}

/** 余额徽章的状态色（供 UI 用）。 */
export function balanceTone(report) {
  switch (report?.state) {
    case 'exhausted': return 'bad'
    case 'tight': return 'warn'
    case 'disabled': return 'muted'
    case 'free': return 'ok'
    default: return 'ok'
  }
}
