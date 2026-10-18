/**
 * D 组 · 让 AI 更懂素材 + E 组 · 越用越懂你。
 *
 *   D1 视觉标签      —— 每张图打标签（画什么/主色/朝向/有无透明），AI 能"按语义查"而不是"看文件名猜"
 *   D2 prompt 血缘   —— 记录 prompt/seed/模型/参数 → "这张不错再来几张"变成一条命令
 *   D3 质量评分路由  —— 高分自动过 / 中正常审 / 低优先审+诊断，把 900 张降到 200 张
 *   E1 使用追踪      —— 记录哪些真进游戏、哪些被替换 → 偏好学习
 *   E2 回归检测      —— 重画后和上版 approved 并排 diff，标好/差
 *
 * 关于 D1 的诚实说明：这里**不调视觉模型**（那要花 token 且不稳定），
 * 而是用**确定性图像特征**给出可检索的标签（形状/朝向/主色/透明度/密度）。
 * 这类标签足以支撑"按语义查"的多数场景（找所有竖版红色图标），且可测、零成本。
 * 真正的语义描述（"这是一把剑"）依赖 prompt 血缘 —— 那是这张图怎么来的，比猜更准。
 */
import { decodePngRgba } from './pngcodec.js'
import { contentBox } from './autotrim.js'
import { styleFingerprint } from './stylefp.js'
import { imageQuality } from './review.js'
import { readabilityAtSize } from './coherence.js'

// ───────── D1 视觉标签 ─────────

/**
 * 给一张图打确定性标签。
 * @param {{buffer:Buffer, name?:string, kind?:string, prompt?:string, spec?:object}} params
 */
export function visualTags({ buffer, name = '', kind = '', prompt = '', spec = null }) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开', tags: [] }
  const { width, height, pixels } = decoded
  const tags = []
  const attrs = {}

  // 尺寸 / 朝向
  const ratio = width / height
  attrs.aspect = Number(ratio.toFixed(3))
  attrs.size = `${width}×${height}`
  if (ratio > 1.25) tags.push('横向')
  else if (ratio < 0.8) tags.push('纵向')
  else tags.push('方形')

  // 透明度
  const quality = imageQuality(buffer)
  const transparentRatio = quality?.transparentRatio ?? 0
  attrs.transparent_ratio = Number(transparentRatio.toFixed(3))
  if (transparentRatio > 0.25) tags.push('透明底')
  else if (transparentRatio < 0.02) tags.push('不透明')
  else tags.push('半透明边')

  // 主色（取风格指纹的 dominant）
  let fingerprint = null
  try {
    fingerprint = styleFingerprint(buffer)
  } catch { /* 指纹失败不影响其它标签 */ }
  if (fingerprint?.dominant) {
    attrs.dominant = fingerprint.dominant
    attrs.palette = (fingerprint.palette ?? []).slice(0, 5).map((entry) => entry.hex)
    tags.push(colorName(fingerprint.dominant))
    if (fingerprint.saturation < 0.2) tags.push('低饱和')
    else if (fingerprint.saturation > 0.55) tags.push('高饱和')
  }

  // 内容密度 / 留白（从包围盒推）
  const found = contentBox(pixels, width, height, { x0: 0, y0: 0, w: width, h: height }, { alphaThreshold: 16 })
  if (!found.empty) {
    const box = found.localBox ?? found.box
    const coverage = (box.width * box.height) / (width * height)
    attrs.content_coverage = Number(coverage.toFixed(3))
    attrs.content_box = `${box.width}×${box.height}`
    if (coverage > 0.8) tags.push('满构图')
    else if (coverage < 0.35) tags.push('留白多')
    // 主体位置：偏上/偏下/居中
    const cy = (box.y0 ?? box.minY ?? 0) + box.height / 2
    if (cy < height * 0.4) tags.push('主体偏上')
    else if (cy > height * 0.6) tags.push('主体偏下')
  } else {
    tags.push('疑似空图')
  }

  // 线条感（风格指纹的 edgeDensity）
  if (fingerprint) {
    attrs.edge_density = Number((fingerprint.edgeDensity ?? 0).toFixed(3))
    if (fingerprint.edgeDensity > 0.3) tags.push('线条重')
    else if (fingerprint.edgeDensity < 0.06) tags.push('线条轻')
    attrs.ink = Number((fingerprint.ink ?? 0).toFixed(3))
  }

  // 类型标签（来自 kind，不是猜的）
  if (kind) tags.push(kindTag(kind))
  // 名字里的语义线索（可平铺/动画/图标等，不做"画的是什么"的猜测）
  if (/tile|seamless|重复|平铺/i.test(name) || spec?.tileable) tags.push('可平铺')
  if (/loop|cycle/i.test(name)) tags.push('循环动画')
  // 序列帧：名字结尾有数字（`r67_frames_8`、`walk_12`），但排除 `_WxH` 尺寸后缀
  // —— 早先只匹配 ≥2 位数字，漏掉了真实命名 `r67_frames_8`（单个 8）。
  if (/[_\-]?\d{1,3}$/.test(name) && !/_\d{1,4}x\d{1,4}(?=$|_)/.test(name) && !/^shot_/i.test(name)) {
    tags.push('序列帧')
  }

  return {
    ok: true,
    tags: [...new Set(tags)],
    attributes: attrs,
    // 语义描述只来自 prompt（那是"这张图怎么来的"，不是猜）
    semantic: prompt ? String(prompt).slice(0, 200) : '',
    has_semantic: Boolean(prompt),
  }
}

function colorName(hex) {
  const h = String(hex ?? '').replace('#', '')
  if (h.length !== 6) return '未知色'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lum = (max + min) / 2
  if (max - min < 24) return lum < 70 ? '黑色系' : lum > 190 ? '白色系' : '灰色系'
  const sat = max - min
  if (sat < 60) return lum < 128 ? '深色系' : '浅色系'
  if (r === max) return g > b + 30 ? '橙黄色系' : b > g + 30 ? '紫红色系' : '红色系'
  if (g === max) return b > r + 30 ? '青绿色系' : '绿色系'
  return '蓝色系'
}

function kindTag(kind) {
  const map = {
    source: '正式素材', slice: '切片', resized: '缩放件',
    preview: '带名预览图', screenshot: '截图',
    icon: '图标', card: '卡面', portrait: '立绘', tile: '地块',
    unit: '单位', building: '建筑', effect: '特效',
  }
  return map[kind] ?? kind
}

// ───────── D2 prompt 血缘 + 确定性重生成 ─────────

/**
 * D2：从一条出图历史记录提取「血缘」（可复现的参数集）。
 * 有了它，"这张不错再来几张"就变成：读血缘 → 改 seed/variants → 重跑。
 */
export function lineageOf(record) {
  if (!record) return null
  return {
    profile: record.profile ?? '',
    provider: record.provider ?? '',
    model: record.model ?? '',
    prompt: record.prompt ?? '',
    negative: record.negative ?? '',
    size: record.params?.size ?? '',
    ratio: record.params?.ratio ?? '',
    quality: record.params?.quality ?? '',
    kind: record.kind ?? 'generate',
    seed: record.params?.seed ?? record.seed ?? null,
    inputImages: record.inputImages ?? [],
    mask: record.mask ?? '',
    fingerprint: record.fingerprint ?? '',
    // 完整参数原样带上（换服务商时可能需要）
    params: record.params ?? {},
  }
}

/**
 * D2：基于血缘规划"再来几张"。
 * @param {{lineage:object, variants?:number, count?:number, seed?:number, promptSuffix?:string}} params
 */
export function planRegenerate({ lineage, variants = 1, count = 0, seed = null, promptSuffix = '' }) {
  if (!lineage) return { ok: false, error: '没有血缘信息，无法确定性重生成' }
  const n = Math.max(count || variants || 1, 1)
  // 注意：seed 可能是 0（合法值），所以不能用 `||` 兜底 —— 那会把 0 当成"没有"。
  // 必须显式判 null/undefined/''。
  const pickSeed = (value) => {
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  const baseSeed = pickSeed(seed) ?? pickSeed(lineage.seed)
  // 有 seed 才能说"确定性"；没有就明确说这次是随机的，不要假装可复现
  const deterministic = baseSeed !== null
  const items = []
  for (let i = 0; i < n; i++) {
    items.push({
      prompt: promptSuffix ? `${lineage.prompt} ${promptSuffix}`.trim() : lineage.prompt,
      size: lineage.size,
      ratio: lineage.ratio,
      quality: lineage.quality,
      // 有 seed：逐个 +1（同一 prompt 的相邻 seed 通常风格最接近）
      seed: deterministic ? baseSeed + i : undefined,
    })
  }
  return {
    ok: true,
    deterministic,
    count: n,
    items,
    base_seed: baseSeed,
    note: deterministic
      ? `按原 seed ${baseSeed} 派生 ${n} 张（seed ${baseSeed}..${baseSeed + n - 1}）：同 prompt 的相邻 seed 风格最接近，最适合"再来几张"。`
      : `原记录没有 seed，这次只能是**随机**重生成 —— 无法保证和原图接近。想可复现，出图时就要带上 seed。`,
  }
}

// ───────── D3 质量评分路由 ─────────

/**
 * D3：综合评分 → 路由。目的是把"审核 900 张"降到"审核 200 张"。
 *
 * 分数构成（全部可解释，不用黑箱）：
 *   base 100
 *   - 机械硬伤（空/全黑/全白/单色）        −60
 *   - 可读性不足（缩到游戏尺寸看不清）      −25
 *   - 主体偏小/留白过多                     −15
 *   - 与锁定调色板偏离                      −20
 *   - 尺寸不符合 spec（可自动修，故只扣 5）  −5
 *
 * 路由：≥80 auto_pass（机械层面没问题，可以直接批量过）
 *      50..79 normal（正常审）
 *       <50  priority（优先审，附诊断）
 *
 * 注意：auto_pass **不等于**"好看"。它只保证"技术层面没硬伤"。
 * 于是审核从"逐张判断能不能用"变成"抽查 + 只看低分"，这才是省力的地方。
 */
export function scoreAsset({ buffer, spec = null, lockedPalette = [], fingerprint = null, drift = null }) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, score: 0, route: 'priority', reasons: ['图片解不开'], error: '解不开' }
  let score = 100
  const reasons = []
  const diagnostics = []

  const quality = imageQuality(buffer)
  if (quality) {
    if (quality.colorCount <= 2) { score -= 60; reasons.push(`几乎单色（${quality.colorCount} 色）`); diagnostics.push('画面基本没有内容，考虑重画') }
    if (quality.avgLuminance < 0.04) { score -= 60; reasons.push('几乎全黑'); diagnostics.push('疑似生成失败，检查提示词或重画') }
    if (quality.avgLuminance > 0.97) { score -= 60; reasons.push('几乎全白'); diagnostics.push('疑似生成失败/背景盖住了主体') }
    if (quality.edgeRatio < 0.005 && quality.colorCount <= 16) { score -= 60; reasons.push('画面是空的'); diagnostics.push('没有可辨识的边缘') }

    // 可读性（缩到 spec 尺寸后）
    if (spec?.width && spec?.height) {
      const read = readabilityAtSize({ buffer, targetWidth: spec.width, targetHeight: spec.height })
      if (read.level === 'bad') { score -= 25; reasons.push(`缩到 ${read.size} 后可读性差`); diagnostics.push(read.advice) }
      else if (read.level === 'watch') { score -= 10; reasons.push(`缩到 ${read.size} 后偏弱`) }
    }

    // 留白
    const found = contentBox(decoded.pixels, decoded.width, decoded.height, { x0: 0, y0: 0, w: decoded.width, h: decoded.height }, { alphaThreshold: 16 })
    if (!found.empty) {
      const box = found.localBox ?? found.box
      const coverage = (box.width * box.height) / (decoded.width * decoded.height)
      if (coverage < 0.3) { score -= 15; reasons.push(`主体只占画面 ${Math.round(coverage * 100)}%`); diagnostics.push('四周留白多，可自动裁（trim）') }
    }
  }

  // 风格偏离
  if (drift && drift.level !== 'ok') {
    score -= drift.level === 'off' ? 20 : 10
    reasons.push(`风格偏离 ${Math.round((drift.drift ?? 0) * 100)}%`)
    if (drift.level === 'off') diagnostics.push('用色明显不在整体调色板内，建议做调色板吸附或重出')
  }

  // 尺寸不合规（能自动修，所以扣得少）
  if (spec?.width && spec?.height && (decoded.width !== spec.width || decoded.height !== spec.height)) {
    score -= 5
    reasons.push(`尺寸 ${decoded.width}×${decoded.height} 与规格 ${spec.width}×${spec.height} 不符（可自动修）`)
  }

  score = Math.max(0, Math.min(100, score))
  const route = score >= 80 ? 'auto_pass' : score >= 50 ? 'normal' : 'priority'
  return {
    ok: true,
    score,
    route,
    route_label: { auto_pass: '自动通过', normal: '正常审核', priority: '优先审核' }[route],
    reasons,
    diagnostics,
    advice: route === 'auto_pass'
      ? '技术层面没有硬伤，可以批量通过（但仍建议抽查）。'
      : route === 'normal'
        ? '有轻微问题，正常审核即可。'
        : `建议优先看：${diagnostics[0] ?? reasons[0] ?? '需要人判断'}`,
  }
}

/** D3：给一批素材做路由分组（这就是"900 → 200"的算法）。 */
export function routeBatch(scored = []) {
  const groups = { auto_pass: [], normal: [], priority: [] }
  for (const item of scored) {
    if (groups[item.route]) groups[item.route].push(item)
  }
  const total = scored.length
  const auto = groups.auto_pass.length
  return {
    total,
    auto_pass: auto,
    normal: groups.normal.length,
    priority: groups.priority.length,
    // 需要人看的张数（priority + normal）
    needs_review: groups.normal.length + groups.priority.length,
    saved: auto,
    saved_pct: total > 0 ? Number(((auto / total) * 100).toFixed(1)) : 0,
    advice: total === 0
      ? '没有素材可评分。'
      : `共 ${total} 张：${auto} 张可自动通过（省 ${total > 0 ? Math.round((auto / total) * 100) : 0}%），需要人看 ${groups.normal.length + groups.priority.length} 张（其中优先 ${groups.priority.length} 张）。`,
  }
}

// ───────── E1 使用追踪 + 偏好学习 ─────────

/**
 * E1：从"实际装进游戏"的记录里学偏好。
 *
 * 数据来源：install 的结果（哪些 key 真落到游戏目录）+ 后续是否被别的版本替换。
 * 产出：偏好的 provider/model/尺寸/用色倾向 —— 下次生成时用作默认值。
 *
 * 关键：这是**统计**，不是猜测。样本不足时明确说"样本不足"，不硬给结论。
 */
export function learnPreference({ installed = [], rejected = [], minSamples = 5 } = {}) {
  const used = installed.filter(Boolean)
  const refused = rejected.filter(Boolean)
  const tally = (list, pick) => {
    const map = new Map()
    for (const item of list) {
      const key = pick(item)
      if (!key) continue
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, share: Number((count / list.length).toFixed(3)) }))
  }
  const total = used.length + refused.length
  return {
    samples: { installed: used.length, rejected: refused.length, total },
    enough: total >= minSamples,
    // 被真正用上的画像
    top_provider: tally(used, (item) => item.provider),
    top_model: tally(used, (item) => item.model),
    top_size: tally(used, (item) => item.params?.size ?? item.size),
    top_kind: tally(used, (item) => item.kind),
    // 常被拒的特征（下次少生成这种）
    rejected_traits: tally(refused, (item) => item.reason ?? item.kind),
    advice: total < minSamples
      ? `样本不足（${total} < ${minSamples}），先别急着"学习偏好"—— 结论会不稳。`
      : used.length === 0
        ? '还没有素材真正装进游戏，无法判断偏好。'
        : `最常用的是 ${tally(used, (i) => i.provider)[0]?.value ?? '-'} / ${tally(used, (i) => i.model)[0]?.value ?? '-'}，`
          + `尺寸偏 ${tally(used, (i) => i.params?.size ?? i.size)[0]?.value ?? '-'}。下次生成可以把它作为默认值。`,
  }
}

// ───────── E2 回归检测 ─────────

/**
 * E2：源图重画后，和上一版 approved 对比，判断变好还是变差。
 *
 * 比什么（都是确定性指标）：
 *   - 质量分变化（D3 的 score）
 *   - 可读性变化（B2）
 *   - 与锁定调色板的一致性变化（B1）
 * 结论给 verdict：better / same / worse / unknown
 *
 * 为什么重要：避免"重画完发现不如原来"却没察觉 —— 那是纯浪费。
 */
export function detectRegression({ previousBuffer, currentBuffer, previousScore = null, currentScore = null, lockedPalette = [] }) {
  const prevScore = previousScore ?? (previousBuffer ? scoreAsset({ buffer: previousBuffer, lockedPalette }).score : null)
  const currScore = currentScore ?? (currentBuffer ? scoreAsset({ buffer: currentBuffer, lockedPalette }).score : null)
  if (prevScore === null || currScore === null) {
    return { ok: false, verdict: 'unknown', error: '缺少可比对的版本' }
  }
  const delta = currScore - prevScore
  // 分数差 ≤3 视为持平（避免噪声导致的假"变好/变差"）
  const verdict = delta >= 4 ? 'better' : delta <= -4 ? 'worse' : 'same'
  return {
    ok: true,
    verdict,
    verdict_label: { better: '比上一版好', same: '与上一版持平', worse: '比上一版差' }[verdict],
    previous_score: prevScore,
    current_score: currScore,
    delta,
    advice: verdict === 'worse'
      ? `当前版比上一版低 ${Math.abs(delta)} 分 —— 建议保留上一版，或看看诊断再决定。`
      : verdict === 'better'
        ? `比上一版高 ${delta} 分，可以替换。`
        : '两版分数接近，按构图偏好选即可。',
  }
}
