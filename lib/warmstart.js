/**
 * 热启动：把「学习结果」的粒度从「模型+尺寸+质量」放宽到「服务商+模型」。
 *
 * 为什么：换一个尺寸或质量档就重新冷启动 1 张探针，纯属浪费 ——
 * 同一家中转站同一个模型的稳定性、限流行为、量级延迟都是一样的。
 * 现在：先按精确键找经验，找不到就退到「服务商+模型」的共享经验；
 * 只有连共享经验都没有（真·第一次）才放 1 张探针。
 */

/** 精确键：模型 + 尺寸 + 质量（最贴合当前任务）。 */
export function exactKey({ model = '', size = '', quality = '' }) {
  return [model || '-', size || '-', quality || '-'].join('|')
}

/** 共享键：只按服务商 + 模型（跨尺寸/质量复用，这就是热启动）。 */
export function sharedKey({ provider = '', model = '' }) {
  return [provider || 'openai', model || '-'].join('|')
}

/**
 * 合并两种经验：共享经验给「并发/稳定性」，精确经验给「延迟」（延迟对尺寸敏感）。
 * @param {{exact?:object, shared?:object}} sources
 */
export function mergeLearnings({ exact = null, shared = null } = {}) {
  const pick = (key) => (exact && Number(exact[key]) ? exact[key] : (shared ? shared[key] : undefined))
  const n = (exact?.n ?? 0) + (shared?.n ?? 0)
  return {
    n,
    // 有任一来源的样本就算「热」：不再强制探针
    warmed: n >= 2,
    exactSamples: exact?.n ?? 0,
    sharedSamples: shared?.n ?? 0,
    concurrency: Math.max(
      Number(exact?.concurrency ?? 0),
      Number(shared?.concurrency ?? 0),
      1,
    ),
    batch: Math.max(Number(exact?.batch ?? 0), Number(shared?.batch ?? 0), 1),
    failRate: Number(exact?.failRate ?? shared?.failRate ?? 0),
    recentFailStreak: Boolean(exact?.recentFailStreak ?? shared?.recentFailStreak ?? false),
    // 延迟：精确值缺失时退回共享值（总比默认 20s 准）
    ewmaLatencyMs: pick('ewmaLatencyMs') ?? 0,
    maxLatencyMs: pick('maxLatencyMs') ?? 0,
  }
}
