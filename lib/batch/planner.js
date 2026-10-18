/**
 * 容量规划器（纯函数，可单测）——回答用户的核心诉求：
 *   「自己判断一次能生成多少素材，避免浪费；也不能太多一下生成不出来」
 *
 * 判断依据（全部可解释，落在 why[] 里）：
 *  1. 去重           —— 指纹已成功的素材直接复用，不重复花钱（避免浪费）
 *  2. 冷启动探针     —— 该组合样本 < 2 时，只放 1 张；成功后再加量
 *  3. 失败率调速     —— failRate 高 → 降并发/降单请求张数；429/超时 → 冷却，直接拒绝开工
 *  4. 队列护栏       —— ComfyUI 队列堆积超过上限就拒绝再排队（防止「一下生成不出来」/OOM）
 *  5. 预算护栏       —— 按单价估算，超预算就不生成（避免浪费）
 *  6. 截止时间       —— 有时间预算时按实测延迟反推并发，不排注定跑不完的量
 *  7. AIMD 记忆      —— 用 stats 里学到的并发/张数作为起点，对 429 乘性减、对成功加性增
 */

export const BACKEND_LIMITS = {
  // 一次请求能出几张（OpenAI Images API 的 n），以及同时几路请求
  openai: { maxBatch: 10, maxConcurrency: 4, baseLatencyMs: 20000, canBatchPerRequest: true },
  mock: { maxBatch: 8, maxConcurrency: 4, baseLatencyMs: 300, canBatchPerRequest: true },
  // ComfyUI 一次 workflow = 一张图，所以 maxBatch=1；并发即同时排队的 prompt 数
  comfyui: { maxBatch: 1, maxConcurrency: 4, maxQueueDepth: 8, baseLatencyMs: 60000, canBatchPerRequest: false },
}

export const DEFAULT_CAPS = {
  maxImagesPerRun: 24,
  maxCostPerRun: 5,
  maxConcurrency: 4,
  maxBatch: 10,
}

/** 常见模型单价（美元/张，粗略值，可在设置里覆盖）。未知模型 → 成本护栏自动失效并提示。 */
export const COST_TABLE = {
  'gpt-image-1': {
    low: { '1024x1024': 0.011, '1536x1024': 0.016, '1024x1536': 0.016, auto: 0.013 },
    medium: { '1024x1024': 0.042, '1536x1024': 0.063, '1024x1536': 0.063, auto: 0.05 },
    high: { '1024x1024': 0.167, '1536x1024': 0.25, '1024x1536': 0.25, auto: 0.19 },
  },
  'gpt-image-2': {
    low: { '1024x1024': 0.011, '1536x1024': 0.016, '1024x1536': 0.016, auto: 0.013 },
    medium: { '1024x1024': 0.042, '1536x1024': 0.063, '1024x1536': 0.063, auto: 0.05 },
    high: { '1024x1024': 0.167, '1536x1024': 0.25, '1024x1536': 0.25, auto: 0.19 },
  },
}

/**
 * 匹配单价：先精确匹配模型名，再逐级退到同族（gpt-image-2.5-sunburst → gpt-image-2.5 → gpt-image-2）。
 * 中转站的模型名经常带后缀，这样至少能给成本护栏一个同族的估算值。
 */
export function resolveCostFamily(model, table = COST_TABLE) {
  const key = String(model ?? '')
  if (!key) return ''
  if (table[key]) return key
  const parts = key.split('-')
  while (parts.length > 1) {
    parts.pop()
    const candidate = parts.join('-')
    if (table[candidate]) return candidate
  }
  return ''
}

export function unitCostOf(model, quality = 'medium', size = '1024x1024', table = COST_TABLE) {
  const family = resolveCostFamily(model, table)
  if (!family) return 0
  const byModel = table[family]
  const byQuality = byModel[quality] ?? byModel.medium ?? byModel[Object.keys(byModel)[0]]
  if (!byQuality) return 0
  return Number(byQuality[size] ?? byQuality.auto ?? Object.values(byQuality)[0] ?? 0)
}

/**
 * 单请求耗时估算：取「实测常见值」和「实测最慢值」里更保守的那个。
 * 只用平均值会让时间预算偏乐观 —— 这家中转站实测 141s（最慢 214s），
 * 按 141s 排 8 张、deadline 给 10 分钟，最后两张就注定超时白花钱。
 */
export function estimateLatencyMs(stats = {}, limits = {}) {
  const base = Number(limits.baseLatencyMs ?? 20000)
  const ewma = Number(stats.ewmaLatencyMs ?? 0)
  const max = Number(stats.maxLatencyMs ?? 0)
  const observed = Math.max(ewma, max)
  return observed > 0 ? observed : base
}

/** 本轮张数偏小的判断基准（保留给需要的地方用）。 */
export function planAssetsFloor(caps = {}) {
  return Math.max(2, Math.floor(Number(caps.maxImagesPerRun ?? 12) / 2))
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function normalizeVariants(asset) {
  const raw = Number(asset?.variants ?? 1)
  return Number.isFinite(raw) ? clamp(Math.floor(raw), 1, 10) : 1
}

/**
 * @param {object} input
 * @param {Array<object>} input.assets    素材请求 [{name, prompt, variants?, size?, quality?, tags?, fp?}]
 * @param {string} input.backend          'openai' | 'comfyui' | 'mock'
 * @param {Set<string>|Array<string>} [input.existing] 已成功产出的指纹
 * @param {object} [input.stats]          学习状态 {concurrency,batch,failRate,throttleRate,ewmaLatencyMs,n}
 * @param {number} [input.cooldownRemainingMs]
 * @param {object} [input.queue]          ComfyUI {running,pending}
 * @param {object} [input.caps]
 * @param {object} [input.limits]
 * @param {number} [input.unitCost]       美元/张；0 表示未知
 * @param {number} [input.deadlineSeconds]
 * @returns {object} plan
 */
export function planBatch(input = {}) {
  const assets = Array.isArray(input.assets) ? input.assets : []
  const backend = input.backend || 'openai'
  const limits = { ...(BACKEND_LIMITS[backend] ?? BACKEND_LIMITS.openai), ...(input.limits ?? {}) }
  const caps = { ...DEFAULT_CAPS, ...(input.caps ?? {}) }
  const stats = input.stats ?? {}
  const existing = input.existing instanceof Set ? input.existing : new Set(input.existing ?? [])
  const queue = input.queue ?? {}
  const cooldownRemainingMs = Number(input.cooldownRemainingMs ?? 0)
  const unitCost = Number(input.unitCost ?? 0)
  const deadlineSeconds = Number(input.deadlineSeconds ?? 0)

  const why = []
  const refuse = []
  const stopRules = [
    '每一波先小后大：第 1 个请求固定为最小规模（探针），成功后才按规划放量',
    '连续 3 次限流(429)或超时 → 立刻停批，把剩余素材留给下一次',
    '实际花费 / 张数 / 截止时间任一触顶 → 立即停批，不超支',
    '单张失败最多重试 1 次，重试同样计入花费与浪费账本',
  ]

  const reusedList = assets.filter((asset) => asset?.fp && existing.has(asset.fp))
  const todoList = assets.filter((asset) => !(asset?.fp && existing.has(asset.fp)))

  if (assets.length === 0) {
    return {
      ok: false,
      backend,
      refuse: ['assets 为空：没有要生成的素材。'],
      why,
    }
  }

  if (todoList.length === 0) {
    return {
      ok: true,
      nothing_to_do: true,
      backend,
      assets_total: assets.length,
      assets_todo: 0,
      assets_reused: reusedList.length,
      images_todo: 0,
      images_per_wave: 0,
      n_per_request: 0,
      concurrency: 0,
      max_images_this_run: 0,
      requests: 0,
      waves: [],
      plan_assets: [],
      estimate: { seconds: 0, cost_usd: 0, currency: 'USD' },
      risk: 'low',
      confidence: 1,
      why: [`全部 ${assets.length} 个素材指纹都已在清单里且状态有效 → 直接复用，0 次生成、0 花费。`],
      refuse: [],
      stop_rules: stopRules,
    }
  }

  // ── 护栏 1：后端队列堆积（ComfyUI）────────────────────────────────
  if (limits.maxQueueDepth && (queue.running ?? 0) + (queue.pending ?? 0) >= limits.maxQueueDepth) {
    refuse.push(
      `ComfyUI 队列已堆积 ${(queue.running ?? 0) + (queue.pending ?? 0)} 个任务（上限 ${limits.maxQueueDepth}）：`
      + '现在再提交只会卡在队列里甚至显存爆掉。等队列降到一半以下，或减少单次素材数再来。',
    )
  }

  // ── 护栏 2：限流冷却 ────────────────────────────────────────────
  if (cooldownRemainingMs > 2000) {
    refuse.push(
      `后端刚发生过限流/超时，冷却还剩 ${Math.ceil(cooldownRemainingMs / 1000)} 秒。`
      + `现在提交大概率继续 429，纯属浪费配额——建议 retry_after_ms=${Math.ceil(cooldownRemainingMs)} 后再跑。`,
    )
  }

  const observations = Number(stats.n ?? 0)
  const failRate = Number(stats.failRate ?? 0)
  const throttleRate = Number(stats.throttleRate ?? 0)

  // ── 单请求张数 n ────────────────────────────────────────────────
  let nCap = limits.canBatchPerRequest ? clamp(Number(stats.batch ?? 1) || 1, 1, Math.min(limits.maxBatch, caps.maxBatch)) : 1
  // ── 并发 ───────────────────────────────────────────────────────
  let concurrency = clamp(Number(stats.concurrency ?? 1) || 1, 1, Math.min(limits.maxConcurrency, caps.maxConcurrency))
  let risk = observations >= 6 && failRate < 0.05 ? 'low' : 'medium'

  if (observations < 2) {
    nCap = limits.canBatchPerRequest ? 1 : 1
    concurrency = 1
    why.push('冷启动：该 模型/尺寸/质量 组合的实测样本不足 2 次，先只放 1 路、每请求 1 张做探针，成功后再加量——宁可多跑两轮，也不要一次性排队太多导致整批失败。')
  } else if (failRate >= 0.5) {
    nCap = 1
    concurrency = 1
    risk = 'high'
    why.push(`历史失败率 ${(failRate * 100).toFixed(0)}%（≥50%）：降到最低档 1×1，先确认后端到底哪里不健康。`)
  } else if (failRate >= 0.2) {
    nCap = Math.min(nCap, 2)
    concurrency = 1
    risk = 'high'
    why.push(`历史失败率 ${(failRate * 100).toFixed(0)}%（≥20%）：单请求张数压到 ${nCap}、并发压到 1，避免一次拖垮整批。`)
  } else if (throttleRate >= 0.15) {
    nCap = Math.max(1, Math.floor(nCap / 2))
    concurrency = 1
    risk = 'medium'
    why.push(`限流率 ${(throttleRate * 100).toFixed(0)}%（≥15%）：并发降到 1、单请求张数减半到 ${nCap}，用时间换成功率。`)
  } else if (observations >= 6) {
    why.push(`已有 ${observations} 次实测、失败率 ${(failRate * 100).toFixed(1)}%：允许把并发放到 ${concurrency}、单请求 ${nCap} 张。`)
  } else {
    why.push(`已有 ${observations} 次实测（偏少）：保守取并发 ${concurrency}、单请求 ${nCap} 张。`)
  }

  // ── 队列余量决定并发上限（ComfyUI：别把队列灌满）────────────────
  if (limits.maxQueueDepth) {
    const room = Math.max(1, limits.maxQueueDepth - ((queue.running ?? 0) + (queue.pending ?? 0)))
    if (room < concurrency) {
      why.push(`ComfyUI 队列空位只剩 ${room} 个：并发从 ${concurrency} 收到 ${room}。`)
      concurrency = room
    }
  }

  // ── 截止时间反推：不排注定跑不完的量 ───────────────────────────
  // 宁可高估（用实测最慢的一次），也不要低估 —— 低估等于"排了跑不完，钱花了拿不到"。
  const latencyMs = estimateLatencyMs(stats, limits)
  let deadlineCapacityImages = Number.POSITIVE_INFINITY
  if (deadlineSeconds > 0) {
    const requestCapacity = Math.max(1, Math.floor((deadlineSeconds * 1000 * concurrency) / latencyMs))
    deadlineCapacityImages = requestCapacity * nCap
    why.push(`时间预算 ${deadlineSeconds}s、实测单请求约 ${(latencyMs / 1000).toFixed(1)}s、并发 ${concurrency} → 最多排 ${requestCapacity} 个请求（≈${deadlineCapacityImages} 张），超出部分这轮不排。`)
  }

  // ── 预算护栏 ──────────────────────────────────────────────────
  // 注意：nCap 只限制「单个请求最多几张」；一个素材要 7 张、nCap=4 时应该是 2 个请求，而不是砍成 4 张
  const imagesRequested = todoList.reduce((sum, asset) => sum + normalizeVariants(asset), 0)
  let budgetImages = Number.POSITIVE_INFINITY
  if (unitCost > 0 && caps.maxCostPerRun > 0) {
    budgetImages = Math.floor(caps.maxCostPerRun / unitCost)
    why.push(`成本护栏：单价 $${unitCost}/张，预算 $${caps.maxCostPerRun} → 本轮最多 ${budgetImages} 张（本次请求 ${imagesRequested} 张 ≈ $${(imagesRequested * unitCost).toFixed(3)}）。`)
  } else if (unitCost === 0) {
    why.push('未配置该模型单价：成本护栏失效，只按张数与后端能力限制（可在设置里补单价）。')
  }

  let maxImagesThisRun = Math.max(0, Math.min(
    imagesRequested,
    caps.maxImagesPerRun,
    budgetImages,
    deadlineCapacityImages,
  ))

  if (maxImagesThisRun < imagesRequested) {
    why.push(`本次 ${imagesRequested} 张里只排 ${maxImagesThisRun} 张，剩下的留到下一轮（避免一次性打满配额/预算）。`)
  }

  // ── 逐素材切分：把张数预算铺到素材上，得到可执行的波次 ─────────
  const planAssets = []
  let remaining = maxImagesThisRun
  for (const asset of todoList) {
    if (remaining <= 0) break
    const want = normalizeVariants(asset)
    const take = Math.min(want, remaining)
    if (take <= 0) continue
    planAssets.push({
      name: asset.name,
      images: take,
      requests: Math.ceil(take / nCap),
      seeded: asset.seed != null,
    })
    remaining -= take
  }

  const totalRequests = planAssets.reduce((sum, item) => sum + item.requests, 0)
  const estimatedSeconds = totalRequests === 0 ? 0 : Math.round((totalRequests * latencyMs) / concurrency / 1000)

  // 波次：每波最多 concurrency 个请求，每个请求最多 nCap 张
  // 说明：并发是按「请求」算的 —— 一个请求里 n 张是串行出的，所以 requestCapacity 的
  // 单位是请求数，deadlineCapacityImages = 请求数 × nCap 才是可保交付的张数。
  const waves = []
  let waveRemaining = []
  for (const item of planAssets) {
    let left = item.images
    while (left > 0) {
      const take = Math.min(left, nCap)
      waveRemaining.push({ name: item.name, images: take })
      left -= take
      if (waveRemaining.length >= concurrency) {
        waves.push(waveRemaining)
        waveRemaining = []
      }
    }
  }
  if (waveRemaining.length > 0) waves.push(waveRemaining)

  const confidence = Number(clamp(0.25 + observations / 12, 0.25, 0.95).toFixed(2))

  const recommendation = []
  if (observations < 4 && String(assets[0]?.quality ?? '') !== 'low') {
    recommendation.push('这套组合还没跑热，建议先按 quality=low 出一轮草稿确认提示词，再对选中的素材出终稿——最省钱的做法是「草稿多、终稿少」。')
  }
  if (maxImagesThisRun < imagesRequested) {
    recommendation.push(`剩余 ${imagesRequested - maxImagesThisRun} 张建议下一轮再跑（本插件会记住哪些已完成，不会重复生成）。`)
  }
  if (maxImagesThisRun > 0 && observations < 2) {
    recommendation.push('冷启动阶段本轮会先跑 1 张探针（这是故意的，防止提示词写错整批打水漂）；连着成功两次后会自动放量。')
  }

  const ok = refuse.length === 0 && maxImagesThisRun > 0
  if (maxImagesThisRun === 0 && refuse.length === 0) refuse.push('按当前护栏算出的可生成张数为 0（预算或上限太小）。')

  return {
    ok,
    backend,
    assets_total: assets.length,
    assets_todo: todoList.length,
    assets_reused: reusedList.length,
    images_todo: imagesRequested,
    max_images_this_run: maxImagesThisRun,
    n_per_request: nCap,
    concurrency,
    images_per_wave: nCap * concurrency,
    requests: totalRequests,
    waves,
    plan_assets: planAssets,
    estimate: {
      seconds: estimatedSeconds,
      cost_usd: Number((maxImagesThisRun * unitCost).toFixed(4)),
      currency: 'USD',
      latency_ms_basis: latencyMs,
    },
    risk,
    confidence,
    why,
    refuse,
    stop_rules: stopRules,
    recommendation,
  }
}

/** 给模型看的一句话结论。 */
export function summarizePlan(plan) {
  if (!plan.ok) {
    return `❌ 不建议开跑（${plan.refuse.join(' / ')}）`
  }
  if (plan.nothing_to_do) {
    return `♻️ 无需生成：${plan.assets_reused} 个素材已存在，直接复用。`
  }
  return `✅ 本轮规划：一次最多 ${plan.images_per_wave} 张（并发 ${plan.concurrency} × 单请求 ${plan.n_per_request} 张），`
    + `本次执行 ${plan.max_images_this_run} 张 / ${plan.requests} 个请求，预计 ${plan.estimate.seconds}s、$${plan.estimate.cost_usd}；`
    + `跳过重复 ${plan.assets_reused} 个；风险 ${plan.risk}。`
}
