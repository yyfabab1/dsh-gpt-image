/**
 * F 组 · 生成端优化 + I 组 · 可观测性。
 *
 * F1 Prompt 模板库：带变量的模板（{角色}_{元素}_{风格}）→ 批量套用，风格天然统一
 * F2 批量调度：一次提交 N 个变体（换 seed/参数），排队 + 限流 + 重试
 * F3 成本追踪：每张图的耗时/金额，按项目汇总（复用 spend.js 的分账）
 * F4 Prompt 反向提取：从 approved 的图反推 prompt 特征
 *
 * I1 健康度仪表盘 / I2 审核效率 / I3 漏斗 / I4 趋势
 *
 * 设计原则：全部是**确定性统计**，不猜。样本不足就明说。
 */
import { readJson, writeJsonAtomic, nowIso } from './util.js'
import path from 'node:path'

// ───────── F1 Prompt 模板库 ─────────

export const TEMPLATE_FILE = 'prompt-templates.json'

/**
 * 模板变量替换。支持 `{角色}` 与 `{role}`（中英混排常见）。
 * 缺变量**不静默留空** —— 那会让 prompt 少一截却看不出来；而是记进 missing 由调用方决定。
 */
export function renderTemplate(template, vars = {}) {
  const missing = []
  const text = String(template ?? '').replace(/\{([^{}]+)\}/g, (whole, key) => {
    const value = vars[key] ?? vars[key.trim()]
    if (value === undefined || value === null || value === '') {
      missing.push(key)
      return whole   // 保留占位符，让人一眼看出缺哪个
    }
    return String(value)
  })
  return { text, missing: [...new Set(missing)], complete: missing.length === 0 }
}

/** 模板是否合法（至少要有一个变量，否则不算"模板"）。 */
export function validateTemplate(template) {
  const errors = []
  const text = String(template?.text ?? '')
  if (!template?.id) errors.push('缺少 id')
  if (!text.trim()) errors.push('模板内容为空')
  const vars = [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1])
  if (vars.length === 0) errors.push('没有任何 {变量} —— 那不叫模板，直接写 prompt 就行')
  return { ok: errors.length === 0, errors, variables: [...new Set(vars)] }
}

export const DEFAULT_TEMPLATES = {
  version: 1,
  templates: [
    {
      id: 'icon-basic',
      name: '基础图标',
      text: '{元素}，{风格}，居中构图，纯黑背景便于抠图，无文字、无边框、无阴影',
      tags: ['icon'],
      note: '最常用：生成后靠 A1 管线抠背景 + 归一尺寸',
    },
    {
      id: 'card-frame',
      name: '卡面插画',
      text: '{角色}的特写，{场景}背景，{风格}，纵向构图，主体居中偏上，无文字',
      tags: ['card'],
    },
    {
      id: 'unit-sprite',
      name: '单位立绘',
      text: '{阵营}的{兵种}，{风格}，正面朝向镜头，完整入画不裁切，纯黑背景',
      tags: ['unit'],
    },
    {
      id: 'tile-seamless',
      name: '无缝地块',
      text: '无缝平铺的{材质}地表纹理，{风格}，俯视视角，四边可拼接，均匀密度，无文字',
      tags: ['tile'],
    },
  ],
}

export class TemplateLibrary {
  constructor(file, data) {
    this.file = file
    this.data = data
  }

  static async load(dataDir) {
    const file = path.join(dataDir, TEMPLATE_FILE)
    const raw = await readJson(file, null)
    if (!raw || !Array.isArray(raw.templates)) return new TemplateLibrary(file, { ...DEFAULT_TEMPLATES })
    return new TemplateLibrary(file, { version: 1, templates: raw.templates })
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
  }

  get templates() {
    return this.data.templates
  }

  get(id) {
    return this.data.templates.find((item) => item.id === id) ?? null
  }

  upsert(template) {
    const check = validateTemplate(template)
    if (!check.ok) return { ok: false, errors: check.errors }
    const index = this.data.templates.findIndex((item) => item.id === template.id)
    const record = { ...template, variables: check.variables, updatedAt: nowIso() }
    if (index >= 0) this.data.templates[index] = { ...this.data.templates[index], ...record }
    else this.data.templates.push(record)
    return { ok: true, template: this.get(template.id) }
  }

  remove(id) {
    const before = this.data.templates.length
    this.data.templates = this.data.templates.filter((item) => item.id !== id)
    return before - this.data.templates.length
  }

  /**
   * F1 核心：套模板批量展开。
   * @param {{id:string, items:Array<object>, defaults?:object}} params
   * @returns {{ok:boolean, assets:Array, missing:Array, error?:string}}
   */
  expand({ id, items = [], defaults = {} }) {
    const template = this.get(id)
    if (!template) return { ok: false, error: `没有模板 ${id}`, assets: [], missing: [] }
    const assets = []
    const missingAll = []
    for (const [index, item] of items.entries()) {
      const vars = { ...defaults, ...item }
      const rendered = renderTemplate(template.text, vars)
      if (rendered.missing.length > 0) missingAll.push({ item: item.name ?? index, missing: rendered.missing })
      assets.push({
        // 名字优先用显式给的，否则用模板 id + 变量拼（保证唯一可追溯）
        name: item.name ?? `${id}_${Object.values(vars).filter((v) => typeof v === 'string').slice(0, 2).join('_') || index + 1}`,
        prompt: rendered.text,
        template: id,
        template_name: template.name,
        vars,
        complete: rendered.complete,
      })
    }
    return {
      ok: true,
      template: { id: template.id, name: template.name, variables: template.variables ?? [] },
      assets,
      missing: missingAll,
      note: missingAll.length > 0
        ? `有 ${missingAll.length} 条缺变量（prompt 里保留了 {占位符}，便于你看出缺哪个）—— 补齐后重新展开。`
        : `套用模板「${template.name}」展开 ${assets.length} 条 prompt，变量全部齐备。`,
    }
  }
}

// ───────── F2 批量调度（变体矩阵） ─────────

/**
 * F2：一次提交 N 个变体，展开成"任务矩阵"。
 * 不做实际调度（那由 batch/run.js 负责），只负责**把意图展开成确定的清单** ——
 * 这样"再来 20 张挑一张"就是一次调用，而不是手写 20 条。
 *
 * @param {{base:{prompt:string, size?:string, ratio?:string, quality?:string},
 *          seeds?:Array<number>, count?:number, seedStart?:number,
 *          prompts?:Array<string>, sizes?:Array<string>, quality?:Array<string>,
 *          namePrefix?:string}} params
 */
export function planVariants({ base = {}, seeds, count = 0, seedStart = 0, prompts, sizes, quality, namePrefix = 'v' } = {}) {
  const promptList = (prompts?.length ? prompts : [base.prompt]).filter(Boolean)
  if (promptList.length === 0) return { ok: false, error: '没有 prompt', assets: [] }
  const sizeList = sizes?.length ? sizes : [base.size].filter(Boolean)
  const qualityList = quality?.length ? quality : [base.quality].filter(Boolean)

  // seed 列表：显式给优先；否则从 seedStart 连续取 count 个
  let seedList = seeds?.slice()
  if (!seedList?.length) {
    const n = Math.max(1, Number(count) || 1)
    seedList = Array.from({ length: n }, (_, i) => seedStart + i)
  }

  const assets = []
  let index = 0
  for (const prompt of promptList) {
    for (const size of (sizeList.length ? sizeList : [undefined])) {
      for (const q of (qualityList.length ? qualityList : [undefined])) {
        for (const seed of seedList) {
          index += 1
          assets.push({
            name: `${namePrefix}_${String(index).padStart(3, '0')}`,
            prompt,
            ...(size ? { size } : {}),
            ...(q ? { quality: q } : {}),
            seed,
          })
        }
      }
    }
  }
  return {
    ok: true,
    assets,
    matrix: {
      prompts: promptList.length,
      sizes: sizeList.length || 1,
      qualities: qualityList.length || 1,
      seeds: seedList.length,
      total: assets.length,
    },
    note: `展开 ${assets.length} 个变体（${promptList.length} prompt × ${sizeList.length || 1} 尺寸 × ${qualityList.length || 1} 质量 × ${seedList.length} seed）。`
      + `每个都带 seed，所以任何一个好结果都能用同一条 seed 精确复现。`,
    // 成本预警：变体是乘法的，容易一次跑出很多钱
    warning: assets.length > 50
      ? `⚠ 一次 ${assets.length} 张 —— 变体是乘法的，注意花费。建议先跑小批（seed 3-5 个）挑方向，再放量。`
      : '',
  }
}

// ───────── F3 成本追踪 ─────────

/**
 * F3：按项目汇总成本（从 spend.json 的 records 来）。
 * 关键是"哪批产出性价比低"要能看出来 —— 所以同时给每张的平均成本与失败率。
 */
export function costByProject({ records = [], currency = 'CNY' } = {}) {
  const map = new Map()
  for (const record of records) {
    const key = record.project || '(未命名)'
    const bucket = map.get(key) ?? { project: key, images: 0, cost: 0, runs: 0, free_images: 0, actions: new Map() }
    bucket.images += Number(record.images ?? 0)
    bucket.cost = Number((bucket.cost + Number(record.cost ?? 0)).toFixed(4))
    bucket.runs += 1
    if (record.free || Number(record.cost ?? 0) === 0) bucket.free_images += Number(record.images ?? 0)
    bucket.actions.set(record.action ?? 'generate', (bucket.actions.get(record.action ?? 'generate') ?? 0) + 1)
    map.set(key, bucket)
  }
  const projects = [...map.values()].map((b) => ({
    project: b.project,
    images: b.images,
    cost: b.cost,
    runs: b.runs,
    free_images: b.free_images,
    paid_images: b.images - b.free_images,
    // 每张平均成本（只看付费张数，否则免费图会把均值稀释得没意义）
    cost_per_paid_image: b.images - b.free_images > 0
      ? Number((b.cost / (b.images - b.free_images)).toFixed(4))
      : 0,
    actions: Object.fromEntries(b.actions),
  })).sort((a, b) => b.cost - a.cost)
  const totalCost = Number(projects.reduce((s, p) => s + p.cost, 0).toFixed(4))
  const totalImages = projects.reduce((s, p) => s + p.images, 0)
  return {
    currency,
    projects,
    total_cost: totalCost,
    total_images: totalImages,
    average_cost: totalImages > 0 ? Number((totalCost / totalImages).toFixed(4)) : 0,
    advice: projects.length === 0
      ? '还没有花费记录。'
      : `共 ${totalCost} ${currency} / ${totalImages} 张（均 ${(totalImages > 0 ? totalCost / totalImages : 0).toFixed(4)}）。`
        + `花得最多的是「${projects[0].project}」（${projects[0].cost} ${currency}）`
        + `，单张均价最高的是「${[...projects].sort((a, b) => b.cost_per_paid_image - a.cost_per_paid_image)[0].project}」。`,
  }
}

/**
 * F3：性价比分析 —— 哪些批次"花了钱但没进游戏"。
 * 这是最该看的一个数：白花的钱。
 */
export function costEffectiveness({ records = [], installedKeys = [], currency = 'CNY' } = {}) {
  const installed = new Set(installedKeys.map((k) => String(k)))
  const byProject = new Map()
  for (const record of records) {
    const key = record.project || '(未命名)'
    const bucket = byProject.get(key) ?? { project: key, images: 0, cost: 0, installed: 0, runs: 0, runs_hit: 0 }
    const images = Number(record.images ?? 0)
    bucket.images += images
    bucket.cost = Number((bucket.cost + Number(record.cost ?? 0)).toFixed(4))
    bucket.runs += 1
    // 按**这一条记录里名字的命中比例**折算，而不是"命中一个就算整条都进游戏了"
    // （早先那样会把 10 张里只用了 1 张算成 10 张都用上，得出"零浪费"的假结论）
    const names = (record.names ?? []).filter(Boolean)
    const hits = names.filter((n) => installed.has(String(n))).length
    if (hits > 0) {
      bucket.runs_hit += 1
      bucket.installed += names.length > 0 ? (images * hits) / names.length : images
    }
    byProject.set(key, bucket)
  }
  const rows = [...byProject.values()].map((b) => {
    const used = Number(b.installed.toFixed(2))
    return {
      project: b.project,
      images: b.images,
      cost: b.cost,
      runs: b.runs,
      runs_hit: b.runs_hit,
      installed: used,
      utilization: b.images > 0 ? Number((used / b.images).toFixed(3)) : 0,
      wasted_cost: b.images > 0
        ? Number(((b.cost * (b.images - used)) / b.images).toFixed(4))
        : 0,
    }
  }).sort((a, b) => b.wasted_cost - a.wasted_cost)
  const wasted = Number(rows.reduce((s, r) => s + r.wasted_cost, 0).toFixed(4))
  return {
    currency,
    projects: rows,
    total_wasted: wasted,
    note: '利用率按「记录里被装机的名字比例」折算（近似）。'
      + '想更准，就让装机时把实际用到的素材名记进 history 的 names。',
    advice: rows.length === 0
      ? '没有记录可分析。'
      : wasted > 0
        ? `约有 ${wasted} ${currency} 花在了没进游戏的图上。` +
          `利用率最低的是「${[...rows].sort((a, b) => a.utilization - b.utilization)[0].project}」。` +
          `如果某项目持续低利用，说明它的提示词/规格需要先对齐再生成。`
        : '所有花过钱的图都进游戏了，没有明显浪费。',
  }
}

// ───────── F4 Prompt 反向提取 ─────────

/**
 * F4：从一张 approved 的图反推 prompt 特征。
 *
 * 诚实说明：这里**不猜"画的是什么"**（那需要视觉模型，慢且不稳）。
 * 反推的是**可复用进生成管线的结构化特征**：主色、明暗、密度、线条风格、
 * 构图形状、透明要求 —— 这些能直接拼成 prompt 里的风格词段落。
 * 语义部分（"这是把剑"）如果没有血缘记录，就**明确留空**，不编造。
 *
 * @param {{fingerprint:object, quality:object, kind?:string, spec?:object, imageSize?:{width,height}}} params
 */
export function reversePrompt({ fingerprint, quality, kind = 'icon', spec = null, imageSize = null } = {}) {
  if (!fingerprint) return { ok: false, error: '没有图像指纹，无法反推' }
  const words = []
  const attrs = {}

  // 主色 → 风格词
  if (fingerprint.dominant) {
    attrs.dominant = fingerprint.dominant
    const palette = (fingerprint.palette ?? []).slice(0, 4).map((p) => p.hex)
    attrs.palette = palette
    words.push(`主色 ${fingerprint.dominant}`)
    if (palette.length > 1) words.push(`配色 ${palette.join('/')}`)
  }
  // 饱和 / 线条 / 密度 → 风格描述
  if (fingerprint.saturation !== undefined) {
    attrs.saturation = Number(fingerprint.saturation.toFixed(3))
    words.push(fingerprint.saturation < 0.25 ? '低饱和' : fingerprint.saturation > 0.55 ? '高饱和' : '中等饱和')
  }
  if (fingerprint.edgeDensity !== undefined) {
    attrs.edgeDensity = Number(fingerprint.edgeDensity.toFixed(3))
    words.push(fingerprint.edgeDensity > 0.3 ? '线条明确（卡通/矢量感）' : fingerprint.edgeDensity < 0.08 ? '写实/柔和过渡' : '细节适中')
  }
  if (fingerprint.alphaRatio !== undefined) {
    attrs.alphaRatio = Number(fingerprint.alphaRatio.toFixed(3))
    words.push(fingerprint.alphaRatio > 0.1 ? '透明背景' : '满幅不透明')
  }
  // 构图（从明暗/内容占比推）
  if (quality) {
    if (quality.avgLuminance !== undefined) {
      attrs.avgLuminance = Number(quality.avgLuminance.toFixed(3))
      words.push(quality.avgLuminance < 0.3 ? '暗调' : quality.avgLuminance > 0.7 ? '亮调' : '中间调')
    }
  }
  if (imageSize) {
    attrs.aspect = Number((imageSize.width / imageSize.height).toFixed(3))
    words.push(attrs.aspect > 1.2 ? '横向构图' : attrs.aspect < 0.83 ? '纵向构图' : '方形构图')
  }
  if (spec?.transparent) words.push('需要透明通道')

  // 可复用的风格段落（直接能贴进新 prompt）
  const styleSentence = `${words.join('，')}`
  return {
    ok: true,
    features: attrs,
    style_words: words,
    // 这个可以直接拼进新 prompt 作为风格约束
    prompt_fragment: styleSentence ? `${styleSentence}。` : '',
    // 语义留空：没有血缘就不知道画的是什么，不编
    semantic_unknown: true,
    note: '反推的是**可复用的风格特征**（颜色/明暗/线条/构图），不是"画的是什么"。'
      + '要知道画的是什么，靠出图时记录的 prompt 血缘（lineage），而不是猜。',
    usage: '把 prompt_fragment 拼到新 prompt 末尾，就能让新图往这张的风格靠。',
  }
}

// ───────── I 组 可观测性 ─────────

/**
 * I1：素材健康度仪表盘 —— 一页看全。
 */
export function healthDashboard({ scan, catalog, reviewStats = null, paletteResult = null, readabilityWarnings = 0, orphans = 0 } = {}) {
  const tally = scan?.tally ?? {}
  const total = tally.total ?? 0
  const approved = tally.approved ?? 0
  const rejected = tally.rejected ?? 0
  const pending = tally.pending ?? 0
  const unreviewed = tally.unreviewed ?? 0
  const reviewed = approved + rejected + pending
  const byKind = scan?.by_kind ?? {}
  return {
    total,
    by_kind: byKind,
    generated: tally.generated ?? 0,
    external: tally.external ?? 0,
    approved,
    rejected,
    pending,
    unreviewed,
    reviewed,
    review_progress: total > 0 ? Number((reviewed / total).toFixed(3)) : 0,
    reject_rate: reviewed > 0 ? Number((rejected / reviewed).toFixed(3)) : 0,
    style_drift: paletteResult?.drift_count ?? 0,
    style_consistency: paletteResult?.consistency?.average ?? null,
    readability_warnings: readabilityWarnings,
    orphans,
    locked_palette_size: paletteResult?.locked_palette?.length ?? 0,
    advice: [
      total === 0 ? '素材目录是空的。' : `共 ${total} 张（本插件生成 ${tally.generated ?? 0}，外部产物 ${tally.external ?? 0}）。`,
      reviewed === 0
        ? '⚠ 一张都没审过 —— 先去画廊标一批，后面所有统计（漂移/偏好/路由）都需要审核结论作基准。'
        : `已审 ${reviewed} 张（${Math.round((reviewed / Math.max(1, total)) * 100)}%）：合格 ${approved}｜不合格 ${rejected}｜待定 ${pending}，驳回率 ${reviewed > 0 ? Math.round((rejected / reviewed) * 100) : 0}%。`,
      unreviewed > 0 ? `还有 ${unreviewed} 张没审。` : '全部审完。',
      (paletteResult?.drift_count ?? 0) > 0 ? `⚠ ${paletteResult.drift_count} 张风格偏离整体调色板。` : '',
      readabilityWarnings > 0 ? `⚠ ${readabilityWarnings} 张缩到游戏尺寸后可能看不清。` : '',
      orphans > 0 ? `🧹 ${orphans} 个孤儿文件（源图已不在）。` : '',
    ].filter(Boolean),
  }
}

/**
 * I2：审核效率统计 —— 平均耗时、驳回原因分布、哪类最常被驳。
 * @param {{records:Array<{name,kind,note,at}>, now?:number}} params
 */
export function reviewEfficiency({ events = [] } = {}) {
  // events: [{ at, file, kind, state, note, ms }] —— 由调用方从审核记录组装
  const decisions = events.filter((e) => e.state && e.state !== 'unreviewed')
  const rejected = decisions.filter((e) => e.state === 'rejected')
  const durations = events.map((e) => Number(e.ms)).filter((n) => Number.isFinite(n) && n > 0)
  const byReason = new Map()
  for (const item of rejected) {
    const reason = String(item.note ?? '').trim() || '(未写原因)'
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  const byKind = new Map()
  for (const item of decisions) {
    const kind = item.kind ?? '未知'
    const bucket = byKind.get(kind) ?? { kind, total: 0, rejected: 0 }
    bucket.total += 1
    if (item.state === 'rejected') bucket.rejected += 1
    byKind.set(kind, bucket)
  }
  const kinds = [...byKind.values()]
    .map((b) => ({ ...b, reject_rate: b.total > 0 ? Number((b.rejected / b.total).toFixed(3)) : 0 }))
    .sort((a, b) => b.reject_rate - a.reject_rate)
  const avgMs = durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null
  return {
    decisions: decisions.length,
    approved: decisions.filter((e) => e.state === 'approved').length,
    rejected: rejected.length,
    average_ms: avgMs,
    average_seconds: avgMs === null ? null : Number((avgMs / 1000).toFixed(1)),
    throughput_per_hour: avgMs && avgMs > 0 ? Math.round(3600000 / avgMs) : null,
    reject_reasons: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    by_kind: kinds,
    advice: decisions.length === 0
      ? '还没有审核记录。'
      : avgMs === null
        ? `已审 ${decisions.length} 张（没有耗时数据，无法算效率）。`
        : `已审 ${decisions.length} 张，平均 ${(avgMs / 1000).toFixed(1)} 秒/张（约 ${Math.round(3600000 / avgMs)} 张/小时）。`
          + (byReason.size > 0 ? `最集中的驳回原因是「${[...byReason.entries()].sort((a, b) => b[1] - a[1])[0][0]}」—— 说明生成端该在这上面改。` : ''),
  }
}

/**
 * I3：生成 → 审核 → 装机 漏斗。哪一步流失最多一目了然。
 * @param {{generated:number, reviewed:number, approved:number, installed:number}} params
 */
export function pipelineFunnel({ generated = 0, reviewed = 0, approved = 0, installed = 0 } = {}) {
  const stages = [
    { stage: '生成', count: generated, from: null },
    { stage: '审核', count: reviewed, from: generated },
    { stage: '合格', count: approved, from: reviewed },
    { stage: '装机', count: installed, from: approved },
  ]
  const withRates = stages.map((s, i) => ({
    ...s,
    conversion: s.from && s.from > 0 ? Number((s.count / s.from).toFixed(3)) : null,
    drop: s.from === null ? null : Math.max(0, s.from - s.count),
    index: i,
  }))
  // 找流失最多的一步
  const worst = withRates.filter((s) => s.drop !== null).sort((a, b) => b.drop - a.drop)[0]
  return {
    stages: withRates,
    overall: generated > 0 ? Number((installed / generated).toFixed(3)) : 0,
    biggest_drop: worst ? { from: stages[worst.index - 1]?.stage ?? '-', to: worst.stage, drop: worst.drop, rate: worst.conversion } : null,
    advice: generated === 0
      ? '还没有生成记录。'
      : installed === 0
        ? `生成 ${generated} 张，但一张都没装机 —— 检查是不是审核没做完，或 install 没跑。`
        : worst && worst.drop > 0
          ? `流失最多的一步是「${stages[worst.index - 1]?.stage} → ${worst.stage}」（丢 ${worst.drop} 张，留存 ${Math.round((worst.conversion ?? 0) * 100)}%）。`
            + `整体从生成到装机留存 ${Math.round((installed / generated) * 100)}%。`
          : `生成 ${generated} → 装机 ${installed}，中间没有明显流失。`,
  }
}

/**
 * I4：趋势追踪 —— 按天/周聚合，看系统在变好还是变差。
 * @param {{points:Array<{date:string, generated?:number, approved?:number, rejected?:number, avgScore?:number}>}} params
 */
export function trending({ points = [], bucket = 'day' } = {}) {
  const keyOf = (date) => {
    const day = String(date).slice(0, 10)
    if (bucket !== 'week') return day
    // ISO 周：取该周的周一
    const d = new Date(`${day}T00:00:00Z`)
    const dow = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - dow)
    return d.toISOString().slice(0, 10)
  }
  const map = new Map()
  for (const point of points) {
    const key = keyOf(point.date ?? '')
    if (!key || key === 'undefined') continue
    const bucket_ = map.get(key) ?? { period: key, generated: 0, approved: 0, rejected: 0, scoreSum: 0, scoreN: 0 }
    bucket_.generated += Number(point.generated ?? 0)
    bucket_.approved += Number(point.approved ?? 0)
    bucket_.rejected += Number(point.rejected ?? 0)
    if (Number.isFinite(Number(point.avgScore))) { bucket_.scoreSum += Number(point.avgScore); bucket_.scoreN += 1 }
    map.set(key, bucket_)
  }
  const series = [...map.values()].map((b) => {
    const reviewed = b.approved + b.rejected
    return {
      period: b.period,
      generated: b.generated,
      approved: b.approved,
      rejected: b.rejected,
      reject_rate: reviewed > 0 ? Number((b.rejected / reviewed).toFixed(3)) : null,
      avg_score: b.scoreN > 0 ? Number((b.scoreSum / b.scoreN).toFixed(1)) : null,
    }
  }).sort((a, b) => a.period.localeCompare(b.period))

  // 趋势方向：比较最近一半与更早一半
  let direction = 'unknown'
  if (series.length >= 4) {
    const half = Math.floor(series.length / 2)
    const older = series.slice(0, half)
    const recent = series.slice(half)
    const rate = (list) => {
      const approved = list.reduce((s, x) => s + x.approved, 0)
      const rejected = list.reduce((s, x) => s + x.rejected, 0)
      return approved + rejected > 0 ? approved / (approved + rejected) : null
    }
    const olderRate = rate(older)
    const recentRate = rate(recent)
    if (olderRate !== null && recentRate !== null) {
      direction = recentRate > olderRate + 0.05 ? 'improving' : recentRate < olderRate - 0.05 ? 'worsening' : 'flat'
    }
  }
  return {
    bucket,
    series,
    direction,
    direction_label: { improving: '在变好', worsening: '在变差', flat: '基本持平', unknown: '数据还不够' }[direction],
    advice: series.length < 4
      ? `只有 ${series.length} 个周期，还看不出趋势（至少 4 个才比较）。`
      : direction === 'improving'
        ? '最近一段的合格率在上升 —— 生成端或审核标准的调整见效了。'
        : direction === 'worsening'
          ? '最近一段的合格率在下降 —— 检查是不是换了模型/提示词，或审核标准变严了。'
          : '合格率基本稳定。',
  }
}
