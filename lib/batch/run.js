/**
 * 批量出图（并入出图台的原「素材锻造炉」能力）：
 *   指纹去重（已有的不重跑）→ 容量规划（一次能安全生成多少）→ 波次自适应执行 → 记进同一个历史。
 */
import { assetFingerprint, galleryFingerprints } from '../fingerprint.js'
import { isRetryable } from '../api.js'
import { runImage } from '../run.js'
import { clamp, safeSegment, sleep } from '../util.js'
import { mergeLearnings } from '../warmstart.js'
import { planBatch, summarizePlan, unitCostOf } from './planner.js'

export const DEFAULT_CAPS = { maxImagesPerRun: 12, maxCostPerRun: 3, maxConcurrency: 2, maxBatch: 4 }

/**
 * 从历史里学：并发/延迟/失败率。
 * @param {{sharedOnly?:boolean, provider?:string}} options
 *   sharedOnly=true 时忽略尺寸/质量过滤 → 得到「服务商+模型」的共享经验（热启动用）
 */
export function learnedStats(gallery, { profileId = '', model = '', size = '', quality = '', provider = '', sharedOnly = false } = {}) {
  const records = (gallery?.records ?? []).filter((record) => record.status === 'ok' || record.status === 'failed')
  const matching = records
    .filter((record) => (!profileId || record.profile === profileId)
      && (!provider || (record.provider ?? '') === provider)
      && (!model || record.model === model)
      && (sharedOnly || !size || (record.params?.size ?? '') === size)
      && (sharedOnly || !quality || (record.params?.quality ?? '') === quality))
    .slice(0, 200).reverse() // 最近的在前
  const ok = matching.filter((record) => record.status === 'ok')
  const fail = matching.length - ok.length
  const latencies = ok.map((record) => record.ms).filter((ms) => Number(ms) > 0)
  const avg = latencies.length ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length) : 0
  const failRate = matching.length ? fail / matching.length : 0
  // 连着失败就不要再放量：最近 3 条全失败视为不健康
  const recentFailStreak = matching.slice(0, 3).every((record) => record.status === 'failed') && matching.length >= 3
  return {
    n: matching.length,
    ok: ok.length,
    fail,
    failRate,
    recentFailStreak,
    throttleRate: 0,
    // 连续成功才加并发（且失败率要低）；有失败记录就退回 1 路
    concurrency: ok.length >= 2 && failRate < 0.2 && !recentFailStreak ? clamp(1 + Math.floor(ok.length / 2), 1, 4) : 1,
    batch: 1,
    ewmaLatencyMs: avg,
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
  }
}

export function normalizeBatchAssets(args, profile) {
  const raw = Array.isArray(args.assets) ? args.assets : []
  return raw.map((entry, index) => {
    const item = typeof entry === 'string' ? { prompt: entry } : (entry ?? {})
    const name = safeSegment(item.name || `asset_${String(index + 1).padStart(3, '0')}`, `asset_${index + 1}`)
    const spec = {
      name,
      prompt: String(item.prompt ?? item.text ?? name),
      variants: clamp(Number(item.variants ?? args.variants ?? 1) || 1, 1, 10),
      size: item.size || args.size || '1024x1024',
      // ratio 只在 size 是档位（1K/2K…）时有意义；精确尺寸自带宽高比
      ratio: item.ratio || args.ratio || '',
      quality: item.quality || args.quality || 'low',
      kind: item.kind || 'image',
      tags: item.tags ?? args.tags ?? [],
      project: safeSegment(item.project || args.project || 'assets', 'assets'),
      // 像素画净化：单张与批量两条路必须都能传，否则「★推荐用法」的 assets=[...]
      // 会**静默忽略** pixel —— 用户以为要的是像素画，拿到的是普通插画。
      pixel: item.pixel ?? args.pixel,
      spec: item.spec ?? args.spec,
    }
    spec.fp = assetFingerprint({
      profileId: profile?.id ?? '',
      model: profile?.model ?? '',
      prompt: spec.prompt,
      size: spec.size,
      ratio: spec.ratio,
      quality: spec.quality,
      kind: spec.kind,
      // pixel 必须进指纹：否则「先普通出图、再加 pixel 重跑」会被判成重复而直接跳过，
      // 用户永远拿不到像素化产物，还看不到任何报错。
      pixel: spec.pixel === undefined ? '' : JSON.stringify(spec.pixel),
    })
    return spec
  })
}

/**
 * 批量执行。dry_run=true 只给规划，不花钱。
 */
export async function runBatch({ profiles, gallery, settings, args = {} }) {
  const profile = profiles.get(args.profile)
  if (!profile) return { ok: false, error: `找不到配置档 ${args.profile ?? ''}；现有：${profiles.profiles.map((item) => item.id).join(', ')}` }
  const specs = normalizeBatchAssets(args, profile)
  if (specs.length === 0) return { ok: false, error: 'assets 为空：给一个素材清单（字符串或 {name,prompt}）' }

  const first = specs[0]
  const caps = { ...DEFAULT_CAPS, ...(settings.caps ?? {}), ...(args.caps ?? {}) }
  const existing = galleryFingerprints(gallery, { profile: profile.id })
  // 热启动：先拿精确经验（同尺寸/质量），再拿「服务商+模型」的共享经验合并。
  // 换尺寸/质量不再重新探针 —— 只有真·第一次（两者都空）才放 1 张。
  const providerId = profile.provider ?? 'openai'
  const exactStats = learnedStats(gallery, { profileId: profile.id, model: profile.model, size: first.size, quality: first.quality, provider: providerId })
  const sharedStats = learnedStats(gallery, { profileId: profile.id, model: profile.model, provider: providerId, sharedOnly: true })
  const stats = mergeLearnings({ exact: exactStats, shared: sharedStats })
  const unitCost = unitCostOf(profile.model, first.quality, first.size)

  const plan = planBatch({
    assets: specs,
    backend: 'openai',
    existing,
    stats,
    caps,
    unitCost,
    deadlineSeconds: Number(args.deadline_s ?? 0),
  })
  const summary = summarizePlan(plan)
  if (!plan.ok) return { ok: false, summary, plan, hint: '先看 plan.refuse 里的原因。' }
  if (args.dry_run) return { ok: true, dry_run: true, summary, plan, learned: stats }

  const project = first.project
  const byName = new Map(specs.map((spec) => [spec.name, spec]))
  const state = { concurrency: Math.max(1, plan.concurrency), stopped: '', throttleStreak: 0 }
  const results = []
  let images = 0
  let imagesAttempted = 0
  let requests = 0
  let failed = 0
  const startedAt = Date.now()
  const maxImages = plan.max_images_this_run

  const runEntry = async (entry) => {
    const spec = byName.get(entry.name)
    const attemptOnce = async () => {
      const result = await runImage({
        profiles,
        gallery,
        settings,
        args: {
          prompt: spec.prompt,
          project: spec.project,
          name: spec.name,
          n: entry.images,
          size: spec.size,
          ratio: spec.ratio || undefined,
          quality: spec.quality,
          kind: spec.kind,
          tags: spec.tags,
          output: args.output,
          pixel: spec.pixel,
          spec: spec.spec,
          // 重试也要算钱，所以第二次同样过闸门；这里由外层预算保证不超额
        },
      })
      requests += 1
      return result
    }

    // 同素材最多重试 1 次（带退避）：半夜跑批时偶尔一次超时不该整批作废。
    // 注意：重试同样花钱，所以单独限 1 次，并且记进 imagesAttempted。
    const maxAttempts = Math.max(1, Math.min(2, Number(args.retries ?? 1) + 1))
    let attempt = 0
    let result = null
    while (attempt < maxAttempts) {
      attempt += 1
      imagesAttempted += entry.images
      result = await attemptOnce()
      if (result.ok) break
      const retryable = isRetryable(result.status, result.error ?? '') || result.throttled || result.timedOut
      if (!retryable || attempt >= maxAttempts) break
      await sleep(Math.min(20_000, 4000 * attempt))
    }
    if (result.ok) images += result.images ?? 0
    else failed += 1
    return {
      name: entry.name,
      ok: Boolean(result.ok),
      images: result.images ?? 0,
      attempted: entry.images * attempt,
      attempts: attempt,
      files: result.files ?? [],
      ms: result.ms,
      error: result.error,
      throttled: Boolean(result.throttled),
      prompt: spec.prompt,
    }
  }

  let attemptedBudget = maxImages
  for (const wave of plan.waves) {
    if (state.stopped) break
    // 按「已尝试张数」而不是「已成功张数」判停：一张失败也是花了钱的
    if (imagesAttempted >= maxImages) { state.stopped = 'budget'; break }
    const trimmed = []
    for (const entry of wave) {
      if (attemptedBudget <= 0) break
      const take = Math.min(entry.images, attemptedBudget)
      if (take <= 0) continue
      trimmed.push({ name: entry.name, images: take })
      attemptedBudget -= take
      if (trimmed.length >= Math.max(1, state.concurrency)) break
    }
    if (trimmed.length === 0) { state.stopped = 'budget'; break }
    const settled = await Promise.all(trimmed.map(runEntry))
    results.push(...settled)
    const throttled = settled.filter((item) => !item.ok && item.throttled).length
    const failures = settled.filter((item) => !item.ok).length
    if (failures > 0) {
      // 失败要连续计数：限流和普通错误都算「后端不健康」，别继续硬撞着烧钱
      state.throttleStreak += 1
      state.concurrency = clamp(Math.floor(state.concurrency / 2), 1, 8)
      if (state.throttleStreak >= 3) {
        state.stopped = throttled > 0 ? 'throttled' : 'repeated-failures'
        break
      }
      if (throttled > 0) await sleep(Math.min(30_000, 3000 * state.throttleStreak))
    } else if (settled.every((item) => item.ok)) {
      state.throttleStreak = 0
      state.concurrency = Math.min(plan.concurrency, caps.maxConcurrency, state.concurrency + 1)
    }
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const promptLog = results.map((item) => ({
    name: item.name,
    images: item.images,
    status: item.ok ? 'ok' : 'failed',
    size: byName.get(item.name)?.size,
    quality: byName.get(item.name)?.quality,
    prompt: String(item.prompt ?? '').slice(0, 300),
    files: (item.files ?? []).map((file) => file.replace(/\\/g, '/')),
    error: item.error ? String(item.error).slice(0, 200) : undefined,
  }))

  return {
    ok: images > 0 || Boolean(plan.nothing_to_do),
    project,
    summary: `${summary} 实跑：${images} 张 / ${requests} 个请求，耗时 ${seconds}s，失败 ${failed} 个。`,
    spend_note: `${imagesAttempted} 张计费（含失败 ${failed} 个）—— 失败也会烧钱，所以判停用「已尝试张数」而不是「已成功张数」。`,
    plan: {
      images_per_wave: plan.images_per_wave,
      concurrency: plan.concurrency,
      n_per_request: plan.n_per_request,
      max_images_this_run: plan.max_images_this_run,
      why: plan.why,
      refuse: plan.refuse,
      recommendation: plan.recommendation,
    },
    dedupe: { reused_assets: plan.assets_reused, note: plan.assets_reused > 0 ? '这些素材之前已经生成过（指纹相同），这轮没有重复花钱。' : '' },
    executed: { images, images_attempted: imagesAttempted, requests, failed, seconds, stopped_reason: state.stopped || 'complete' },
    learned: { ...learnedStats(gallery, { profileId: profile.id, model: profile.model, size: first.size, quality: first.quality }) },
    prompt_log: promptLog,
    results,
  }
}
