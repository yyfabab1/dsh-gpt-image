/**
 * 余额 / 额度测试。
 * 最要紧的一条：**绝不能把占位额度（1e8）当成真实余额报给用户** —— 那会让用户
 * 以为自己有一个亿的余额。这里用假上游把各种情形钉死。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { buildBalanceReport, balanceSummaryText, balanceTone, fetchProviderBalance, BILLING_PATHS } from '../lib/balance.js'
import { SpendLedger } from '../lib/spend.js'
import { Gallery } from '../lib/store.js'

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** 最小 profiles 替身。 */
function fakeProfiles(profiles, activeId = profiles[0]?.id) {
  return {
    profiles,
    data: { currency: 'CNY' },
    active: profiles.find((p) => p.id === activeId),
    get: (id) => profiles.find((p) => p.id === (id || activeId)),
  }
}

const now = new Date().toISOString().slice(0, 10)

// ---- 本地：真实生效的闸门 ----

test('免费档：单价 0 → 状态 free，且不占日预算', async () => {
  const spend = new SpendLedger('', '', { locks: { dailyBudget: 1, confirmAboveImages: 1, perRunMaxImages: 12 } })
  spend.data.activePricePerImage = 0
  const report = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'free', model: 'm', pricePerImage: 0 }]),
    spend,
    checkRemote: false,
  })
  assert.equal(report.state, 'free')
  assert.equal(report.free_tier, true)
  assert.equal(report.price_per_image, 0)
  assert.equal(report.images_affordable_today, null, '免费档没有「还能出几张」的上限概念')
  assert.match(report.advice, /免费档/)
  assert.equal(balanceTone(report), 'ok')
})

test('付费档：算得出剩余金额与「还能出几张」', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 1, confirmAboveImages: 1, perRunMaxImages: 12 },
    records: [{ at: `${now}T01:00:00.000Z`, images: 5, cost: 0.2 }],
  })
  const report = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'paid', model: 'm' }]),
    spend,
    checkRemote: false,
  })
  assert.equal(report.today.cost, 0.2)
  assert.equal(report.today.remaining, 0.8)
  assert.equal(report.today.used_pct, 20)
  assert.equal(report.images_affordable_today, 20, '0.8 / 0.04 = 20 张')
  assert.equal(report.state, 'healthy')
})

test('预算用尽 → exhausted，并且明确说会被拦下', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 0.2, confirmAboveImages: 1, perRunMaxImages: 12 },
    records: [{ at: `${now}T01:00:00.000Z`, images: 5, cost: 0.2 }],
  })
  const report = await buildBalanceReport({ profiles: fakeProfiles([{ id: 'p', model: 'm' }]), spend, checkRemote: false })
  assert.equal(report.state, 'exhausted')
  assert.equal(balanceTone(report), 'bad')
  assert.match(report.advice, /用完|拦下/)
  assert.equal(report.images_affordable_today, 0)
})

test('用到 80% 以上 → tight（提醒快没了）', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 1, confirmAboveImages: 1, perRunMaxImages: 12 },
    records: [{ at: `${now}T01:00:00.000Z`, images: 21, cost: 0.84 }],
  })
  const report = await buildBalanceReport({ profiles: fakeProfiles([{ id: 'p', model: 'm' }]), spend, checkRemote: false })
  assert.equal(report.state, 'tight')
  assert.equal(balanceTone(report), 'warn')
})

test('总闸关着时状态优先级最高', async () => {
  const spend = new SpendLedger('', '', { locks: { spendDisabled: true, dailyBudget: 1 } })
  const report = await buildBalanceReport({ profiles: fakeProfiles([{ id: 'p', model: 'm' }]), spend, checkRemote: false })
  assert.equal(report.state, 'disabled')
  assert.match(report.advice, /总闸/)
  assert.equal(balanceTone(report), 'muted')
})

test('配置档单价覆盖会如实标注来源', async () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 10 } })
  spend.data.activePricePerImage = 0
  const report = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'free', model: 'm', pricePerImage: 0 }]),
    spend,
    checkRemote: false,
  })
  assert.equal(report.price_is_profile_override, true)
})

test('报告列出所有配置档单价，并标出当前激活档', async () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 10 } })
  const report = await buildBalanceReport({
    profiles: fakeProfiles([
      { id: 'a', model: 'ma', pricePerImage: 0 },
      { id: 'b', model: 'mb' },
    ]),
    spend,
    checkRemote: false,
  })
  assert.equal(report.profiles.length, 2)
  const a = report.profiles.find((p) => p.id === 'a')
  const b = report.profiles.find((p) => p.id === 'b')
  assert.equal(a.price_per_image, 0)
  assert.equal(a.price_declared, true)
  assert.equal(b.price_per_image, 0.04, '没声明的用全局单价')
  assert.equal(b.price_declared, false)
  assert.equal(a.is_active, true)
})

test('不带 pool/gallery 也能出报告（字段为 null，不炸）', async () => {
  const spend = new SpendLedger('', '', {})
  const report = await buildBalanceReport({ profiles: fakeProfiles([{ id: 'p', model: 'm' }]), spend, checkRemote: false })
  assert.equal(report.pool, null)
  assert.equal(report.gallery, null)
})

test('带 pool/gallery 时汇总它们', async () => {
  const spend = new SpendLedger('', '', {})
  const gallery = new Gallery('', [{ status: 'ok', images: 2 }, { status: 'failed', images: 0 }])
  const pool = { pending: () => [1, 2, 3], thresholdFor: () => 8 }
  const report = await buildBalanceReport({ profiles: fakeProfiles([{ id: 'p', model: 'm' }]), spend, gallery, pool, checkRemote: false })
  assert.equal(report.pool.pending, 3)
  assert.equal(report.pool.threshold, 8)
  assert.equal(report.gallery.total, 2)
})

// ---- 上游：占位额度绝不能被当成余额 ----

test('占位额度（1e8）：balance_available=false，remaining_usd=null', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.includes('subscription')) {
      return res.end(JSON.stringify({ object: 'billing_subscription', has_payment_method: true, soft_limit_usd: 100000000, hard_limit_usd: 100000000, access_until: 0 }))
    }
    return res.end(JSON.stringify({ object: 'list', total_usage: 0 }))
  })
  try {
    const r = await fetchProviderBalance({ profile: { baseUrl: base, apiKey: 'sk-t', model: 'm' }, provider: { id: 'agnes' } })
    assert.equal(r.ok, true)
    assert.equal(r.limit_is_placeholder, true)
    assert.equal(r.balance_available, false, '占位额度不算真实余额')
    assert.equal(r.remaining_usd, null, '不能编一个剩余金额出来')
    assert.match(r.note, /占位|没有真实额度/)
  } finally {
    await close()
  }
})

test('真实额度：能算出剩余（total_usage 以美分计）', async () => {
  const { base, close } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.includes('subscription')) {
      return res.end(JSON.stringify({ has_payment_method: true, hard_limit_usd: 50, soft_limit_usd: 40 }))
    }
    return res.end(JSON.stringify({ total_usage: 1250 })) // 12.50 USD
  })
  try {
    const r = await fetchProviderBalance({ profile: { baseUrl: base, apiKey: 'sk-t' }, provider: { id: 'x' } })
    assert.equal(r.ok, true)
    assert.equal(r.limit_is_placeholder, false)
    assert.equal(r.balance_available, true)
    assert.equal(r.total_usage_usd, 12.5)
    assert.equal(r.remaining_usd, 37.5, '50 - 12.5 = 37.5')
  } finally {
    await close()
  }
})

test('服务商没有计费接口 → ok:false 但不抛异常（很多中转站如此）', async () => {
  const { base, close } = await startServer((req, res) => { res.writeHead(404); res.end('{}') })
  try {
    const r = await fetchProviderBalance({ profile: { baseUrl: base, apiKey: 'sk-t' } })
    assert.equal(r.ok, false)
    assert.match(r.error, /没有计费接口/)
  } finally {
    await close()
  }
})

test('Key 无效 → 明确说是权限问题，而不是「没有接口」', async () => {
  const { base, close } = await startServer((req, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'bad key' } })) })
  try {
    const r = await fetchProviderBalance({ profile: { baseUrl: base, apiKey: 'sk-bad' } })
    assert.equal(r.ok, false)
    assert.match(r.error, /Key 无效|无权限/)
  } finally {
    await close()
  }
})

test('没有 baseUrl → 直接报错，不发请求', async () => {
  const r = await fetchProviderBalance({ profile: {} })
  assert.equal(r.ok, false)
  assert.match(r.error, /baseUrl/)
})

test('上游计费查询失败不影响本地部分（报告仍可用）', async () => {
  const { base, close } = await startServer((req, res) => { res.writeHead(500); res.end('boom') })
  try {
    const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 1 } })
    const report = await buildBalanceReport({
      profiles: fakeProfiles([{ id: 'p', model: 'm', baseUrl: base, apiKey: 'k' }]),
      spend,
      checkRemote: true,
    })
    assert.equal(report.ok, true, '本地部分必须仍然可用')
    assert.equal(report.remote.ok, false)
    assert.equal(report.today.budget, 1)
  } finally {
    await close()
  }
})

test('计费路径是 OpenAI 兼容的那两个', () => {
  assert.equal(BILLING_PATHS.subscription, 'dashboard/billing/subscription')
  assert.equal(BILLING_PATHS.usage, 'dashboard/billing/usage')
})

// ---- 徽章文案 ----

test('徽章文案：免费档 / 付费档 / 总闸关闭 各说各的', async () => {
  const free = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'f', model: 'm', pricePerImage: 0 }]),
    spend: new SpendLedger('', '', {}),
    checkRemote: false,
  })
  assert.match(balanceSummaryText(free), /免费档/)

  const paid = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'p', model: 'm' }]),
    spend: new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 1 } }),
    checkRemote: false,
  })
  assert.match(balanceSummaryText(paid), /\/ 1 CNY/)
})

test('总结函数对残缺输入不炸', () => {
  assert.equal(balanceSummaryText(null), '余额不可用')
  assert.equal(balanceSummaryText({ ok: false }), '余额不可用')
})

// ---- 免费 = 无限额度 + 单独计算（用户明确要求） ----

test('免费档不吃付费预算：付费额度已耗尽时，免费照样放行', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 0.1, confirmAboveImages: 1, perRunMaxImages: 12 },
    records: [{ at: `${now}T01:00:00.000Z`, images: 5, cost: 0.2, free: false }],
  })
  spend.data.activePricePerImage = 0
  const gate = spend.check({ images: 6, action: 'generate' })
  assert.equal(gate.allow, true, `免费档不该被付费预算拦住：${gate.refusals.join('; ')}`)
  assert.equal(gate.free, true)
  assert.equal(gate.quota, 'unlimited')
  assert.equal(gate.remaining_today, null, '免费没有「剩余额度」这个概念')
})

test('免费档跳过总闸/确认锁/日预算，并如实列出跳过了哪些', async () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { spendDisabled: true, dailyBudget: 1 } })
  spend.data.activePricePerImage = 0
  const gate = spend.check({ images: 3 })
  assert.equal(gate.allow, true, '总闸是「付费总闸」，不该挡免费')
  assert.deepEqual(gate.skipped_locks.sort(), ['confirmAboveImages', 'dailyBudget', 'spendDisabled'])
})

test('付费档在同样的总闸/预算下仍然被拦（不能因为加了免费逻辑就放松）', async () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { spendDisabled: true, dailyBudget: 1 } })
  spend.data.activePricePerImage = 0.04
  const gate = spend.check({ images: 3, confirm: true })
  assert.equal(gate.allow, false)
  assert.equal(gate.free, false)
  assert.equal(gate.quota, 'budget')
  assert.ok(gate.refusals.some((t) => t.includes('总闸')))
})

test('免费档仍受「单次张数」保护（那是请求体量，不是钱）', async () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { perRunMaxImages: 12, dailyBudget: 10 } })
  spend.data.activePricePerImage = 0
  const gate = spend.check({ images: 50 })
  assert.equal(gate.allow, false)
  assert.ok(gate.refusals.some((t) => t.includes('单次最多')))
})

test('分账：免费只加张数不加钱，付费加钱；免费绝不挤占付费额度', async () => {
  const spend = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 100 } })
  spend.data.activePricePerImage = 0
  spend.record({ action: 'generate', images: 5, project: 'p' })
  spend.data.activePricePerImage = 0.04
  spend.record({ action: 'generate', images: 3, project: 'p' })

  assert.deepEqual(spend.todayFree(), { images: 5, runs: 1 })
  assert.deepEqual(spend.todayPaid(), { images: 3, runs: 1, cost: 0.12 })
  assert.equal(spend.todaySpent(), 0.12, '免费的钱数必须是 0')
  assert.deepEqual(spend.data.totals.free, { images: 5, runs: 1 })
  assert.deepEqual(spend.data.totals.paid, { images: 3, runs: 1, cost: 0.12 })
  // 记录上要有明确标记，不能靠猜
  assert.equal(spend.data.records[0].free, true)
  assert.equal(spend.data.records[1].free, false)
})

test('旧记录（没有 free 字段）按金额推断，不会把 0 元算进付费花费', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 10 },
    records: [
      { at: `${now}T01:00:00.000Z`, images: 4, cost: 0 },      // 旧免费记录
      { at: `${now}T02:00:00.000Z`, images: 2, cost: 0.08 },   // 旧付费记录
    ],
  })
  assert.equal(spend.todayFree().images, 4)
  assert.equal(spend.todayPaid().images, 2)
  assert.equal(spend.todayPaid().cost, 0.08)
})

test('报告里免费/付费分列，且免费档的 quota 是 unlimited', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 1 },
    records: [
      { at: `${now}T01:00:00.000Z`, images: 5, cost: 0, free: true },
      { at: `${now}T02:00:00.000Z`, images: 2, cost: 0.08, free: false },
    ],
  })
  const report = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'free', model: 'm', pricePerImage: 0 }]),
    spend,
    checkRemote: false,
  })
  assert.equal(report.quota, 'unlimited')
  assert.equal(report.state, 'free')
  assert.equal(report.today.free_images, 5)
  assert.equal(report.today.paid_images, 2)
  assert.equal(report.today.paid_cost, 0.08)
  assert.equal(report.today.cost, 0.08, 'cost 只反映付费')
  assert.equal(report.today.remaining, 0.92, '免费不占预算：1 - 0.08')
  assert.match(report.advice, /无限额度|单独计数/)
  assert.match(balanceSummaryText(report), /∞/)
})

test('付费档的总结文案会带上免费张数（两个口径都看得到）', async () => {
  const spend = new SpendLedger('', '', {
    pricePerImage: 0.04,
    locks: { dailyBudget: 1 },
    records: [
      { at: `${now}T01:00:00.000Z`, images: 3, cost: 0, free: true },
      { at: `${now}T02:00:00.000Z`, images: 2, cost: 0.08, free: false },
    ],
  })
  const report = await buildBalanceReport({
    profiles: fakeProfiles([{ id: 'paid', model: 'm' }]),
    spend,
    checkRemote: false,
  })
  const text = balanceSummaryText(report)
  assert.match(text, /0\.08 \/ 1 CNY/)
  assert.match(text, /免费 3/)
})
