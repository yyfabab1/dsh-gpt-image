/**
 * 拆件傀儡（cutout puppet）管线：**部件图 → 切分 → 命名 → 枢轴 → 骨骼 JSON → 图集**
 *
 * 设计前提（这条最重要）：
 *   **"拼起来" 是运行时按骨骼矩阵绘制，不是让 AI 生成一张拼好的图。**
 *   AI 只负责素材和初版元数据，精确拼合由程序按 JSON 做。
 *   所以本模块的产物是「图集 PNG + skeleton.json」，游戏运行时读这两样就能拼。
 *
 * 两种版面（layout），差别很大，选错了会白忙：
 *
 *   ① `positional`（**推荐**）—— "炸开视图"
 *      AI 把角色按 T-pose 画好，但四肢从身体**拉开一点点**，每个部件是独立岛、互不重叠。
 *      好处：**部件在图纸上的位置本身就编码了正确的装配关系**。
 *      切分只要按 alpha 连通域，装配位置直接取自几何 —— 不需要猜、不需要骨骼模板、
 *      也不可能把左手装到右肩。关节缝隙还能用 `autoAssemble` 自动合拢。
 *
 *   ② `grid` —— 固定网格零件表
 *      AI 把零件一格一个摆进 4×4 网格（像乐高的零件盘）。
 *      好处：布局稳定、切图永不串件；坏处：**格子里没有位置信息**，
 *      装配位置只能靠模板给的粗略默认偏移，剩下的必须人调。
 *
 * 所以：**先做 positional，grid 作为备用**。两者都产出同一份 skeleton.json 格式。
 *
 * 枢轴（pivot）约定：
 *   每个部件的 `pivot` 是**部件自身矩形内的像素坐标**（左上为原点），
 *   表示"这个部件绕哪个点转"。上臂绕肩转、前臂绕肘转、小腿绕膝转。
 *   AI 给不出精确 pivot（这是它的能力边界），所以：
 *     模板给一个合理的默认值 → `autoAssemble` 用几何把关节合拢 →
 *     **最后一定要人在预览器里拖一下确认**（buildPreviewHtml 提供这个交互）。
 */
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { findComponents } from './autotrim.js'

export const RIG_VERSION = 1

/* ============================================================================
 * 一、人形部件模板
 * --------------------------------------------------------------------------
 * `z` 是绘制顺序（小的先画，压在后面）。
 * `offset` 是 grid 版面下的默认摆放偏移，单位是「躯干高度的倍数」，原点在髋部中心，
 *   x 向右为正、y 向上为正（和数学坐标系一致，导出时再翻成屏幕坐标）。
 * `pivotRatio` 是默认枢轴（占部件自身宽高的比例）。
 *   约定：**四肢按"自然下垂"画**（肩/髋在上端，肘/膝在上端），这样 [0.5, 0.08] 就是正确的关节。
 *   这条约定会写进提示词 —— 不写清楚，模型把手臂画成横的，默认 pivot 就全错。
 * ========================================================================== */

export const HUMANOID_SLOTS = [
  // —— 远侧（右）整条链压在最底下，先画 ——
  { name: 'upper_arm_R', parent: 'torso', z: 1, offset: [-0.34, 0.30], pivotRatio: [0.5, 0.08] },
  { name: 'forearm_R', parent: 'upper_arm_R', z: 2, offset: [-0.34, 0.02], pivotRatio: [0.5, 0.08] },
  { name: 'hand_R', parent: 'forearm_R', z: 3, offset: [-0.34, -0.16], pivotRatio: [0.5, 0.2] },
  { name: 'thigh_R', parent: 'hip', z: 4, offset: [-0.12, -0.16], pivotRatio: [0.5, 0.08] },
  { name: 'shin_R', parent: 'thigh_R', z: 5, offset: [-0.12, -0.48], pivotRatio: [0.5, 0.08] },
  { name: 'foot_R', parent: 'shin_R', z: 6, offset: [-0.12, -0.72], pivotRatio: [0.5, 0.2] },
  // —— 躯干 ——
  { name: 'hip', parent: null, z: 10, offset: [0, -0.14], pivotRatio: [0.5, 0.5] },
  { name: 'torso', parent: 'hip', z: 11, offset: [0, 0.18], pivotRatio: [0.5, 0.95] },
  { name: 'head', parent: 'torso', z: 20, offset: [0, 0.62], pivotRatio: [0.5, 0.95] },
  { name: 'hair', parent: 'head', z: 25, offset: [0, 0.66], pivotRatio: [0.5, 0.9] },
  // —— 近侧（左）压在躯干上面 ——
  { name: 'thigh_L', parent: 'hip', z: 30, offset: [0.12, -0.16], pivotRatio: [0.5, 0.08] },
  { name: 'shin_L', parent: 'thigh_L', z: 31, offset: [0.12, -0.48], pivotRatio: [0.5, 0.08] },
  { name: 'foot_L', parent: 'shin_L', z: 32, offset: [0.12, -0.72], pivotRatio: [0.5, 0.2] },
  { name: 'upper_arm_L', parent: 'torso', z: 40, offset: [0.34, 0.30], pivotRatio: [0.5, 0.08] },
  { name: 'forearm_L', parent: 'upper_arm_L', z: 41, offset: [0.34, 0.02], pivotRatio: [0.5, 0.08] },
  { name: 'hand_L', parent: 'forearm_L', z: 42, offset: [0.34, -0.16], pivotRatio: [0.5, 0.2] },
]

/**
 * 正俯视（从头顶垂直往下看）士兵。
 *
 * 为什么单独一套模板：俯视视角下**腿完全被身体挡住**，看得见的只有
 * 身体（肩背）、脑袋（头盔顶）、两条胳膊、枪。所以：
 *   - 前视模板的 thigh/shin/foot 在这里毫无意义（改了也看不见）
 *   - 枢轴约定也反过来：四肢从肩膀**朝前伸**（画面向上 = 角色前方），
 *     所以枢轴在部件**下端**（0.92）＝肩/肘的位置
 *   - 枪挂在右前臂上（双手持枪的简化：左手托枪身，右臂带枪）
 *
 * offset 是 grid 版面用的粗略摆放，原点在身体中心，y 向上为正（=角色前方）。
 */
export const TOPDOWN_SLOTS = [
  { name: 'shadow', parent: 'body', z: 1, offset: [0, 0], pivotRatio: [0.5, 0.5] },
  { name: 'body', parent: null, z: 10, offset: [0, 0], pivotRatio: [0.5, 0.5] },
  { name: 'head', parent: 'body', z: 20, offset: [0, 0.06], pivotRatio: [0.5, 0.5] },
  { name: 'upper_arm_R', parent: 'body', z: 32, offset: [-0.11, 0.10], pivotRatio: [0.5, 0.92] },
  { name: 'forearm_R', parent: 'upper_arm_R', z: 34, offset: [-0.11, 0.24], pivotRatio: [0.5, 0.92] },
  { name: 'upper_arm_L', parent: 'body', z: 36, offset: [0.11, 0.10], pivotRatio: [0.5, 0.92] },
  { name: 'forearm_L', parent: 'upper_arm_L', z: 38, offset: [0.11, 0.24], pivotRatio: [0.5, 0.92] },
  { name: 'rifle', parent: 'forearm_R', z: 50, offset: [-0.06, 0.40], pivotRatio: [0.32, 0.86] },
]

/** 模板表。以后要加四足 / Q 版，往这里加一项即可。 */
export const RIG_TEMPLATES = {
  humanoid: {
    id: 'humanoid',
    label: '人形（16 件，侧/前视）',
    grid: { columns: 4, rows: 4 },
    slots: HUMANOID_SLOTS,
    view: 'side',
  },
  topdown_soldier: {
    id: 'topdown_soldier',
    label: '正俯视士兵（8 件：身/头/双臂/枪）',
    grid: { columns: 4, rows: 2 },
    slots: TOPDOWN_SLOTS,
    view: 'top',
  },
}

export function listTemplates() {
  return Object.values(RIG_TEMPLATES).map((t) => ({
    id: t.id,
    label: t.label,
    view: t.view ?? 'side',
    grid: t.grid,
    slots: t.slots.map((s) => s.name),
    count: t.slots.length,
  }))
}

export function getTemplate(id = 'humanoid') {
  return RIG_TEMPLATES[id] ?? null
}

/* ============================================================================
 * 二、提示词：强制"可切分"
 * ========================================================================== */

/** positional 版：炸开视图，位置即装配关系（推荐）。 */
export const POSITIONAL_PROMPT = [
  '2D cutout puppet character, deconstructed exploded view, front orthographic view, T-pose',
  'the whole character is drawn in its correct anatomical layout, but every limb is pulled apart from the body by a small even gap (4-8 px)',
  'each body part is a separate island that does not touch or overlap any other part: head, hair, torso, hip, upper arm, forearm, hand, thigh, shin, foot for both sides',
  'limbs drawn hanging DOWN with the joint end at the TOP of each piece (shoulder at top of upper arm, elbow at top of forearm, hip at top of thigh, knee at top of shin)',
  'uniform scale, flat cel-shaded colors, clean crisp edges, no outline glow, no cast shadow, no drop shadow',
  'fully transparent background, no scenery, no checkerboard, no grid lines, no text, no labels',
  'game asset, single character, centered',
].join(', ')

/** grid 版：固定网格零件盘。 */
export const GRID_PROMPT = [
  '2D cutout puppet parts sheet, modular character parts, front orthographic T-pose reference',
  'arranged in a strict 4x4 grid, exactly one body part per cell, left-to-right then top-to-bottom',
  'cells in order: head, hair, torso, hip | upper arm L, forearm L, hand L, upper arm R | forearm R, hand R, thigh L, shin L | foot L, thigh R, shin R, foot R',
  'each part isolated inside its own cell with clear empty margin, no part crosses a cell border, no overlap',
  'limbs drawn hanging DOWN with the joint end at the TOP of each piece',
  'uniform scale across all parts, flat cel-shaded colors, clean crisp edges',
  'fully transparent background, no scenery, no checkerboard, no grid lines, no text, no labels',
].join(', ')

/**
 * 正俯视士兵的拆件提示词。
 *
 * 为什么单独写：俯视视角和侧/前视的**画法完全不同** ——
 *   ① 只有 8 件：身体（肩背）、脑袋（头盔顶）、两条上臂、两条前臂、枪（+ 影子）
 *   ② 腿**看不见**（被身体挡住），写"腿"只会让模型把腿画出来破坏俯视感
 *   ③ 朝向必须统一为「画面上方 = 角色前方」，否则枢轴约定（关节在部件下端）全错
 *   ④ 俯视看的是**顶面**：头盔顶圆、肩膀、枪管顶面 —— 不能有透视侧面、不能有脸
 */
export const TOPDOWN_GRID_PROMPT = [
  "2D top-down (bird's eye) view soldier PARTS SHEET for a twin-stick RTS game, parts laid out as a parts tray",
  'viewed straight down from directly above, 90 degree top-down orthographic, NO perspective, NO side view, NO face',
  'arranged in a strict 4x2 grid, exactly one part per cell, left-to-right then top-to-bottom',
  'cells in order: torso and shoulders (viewed from above) | helmet (circle seen from the top) | left upper arm | left forearm | right upper arm | right forearm | assault rifle (top view) | empty cell',
  'each part sits alone inside its own cell with clear empty margin, no part touches another part, nothing crosses a cell border',
  'arms drawn as short straight strips (they are seen from above, so they look like simple bars), rifle drawn as a straight bar with a magazine',
  'legs and feet are NOT visible from this angle - do not draw legs or feet anywhere',
  'uniform scale across all parts, flat cel-shaded colors, crisp edges, plain flat pure white background',
  'no scenery, no ground, no shadow plane, no checkerboard, no grid lines, no text, no labels',
].join(', ')

export const TOPDOWN_PROMPT = [
  '2D top-down (bird\'s eye) view soldier sprite parts sheet for a twin-stick RTS game',
  'viewed straight down from directly above the character\'s head, 90 degree top-down orthographic, NO perspective, NO side view, NO face visible',
  'only these parts are visible from above: torso and shoulders, helmet seen from the top, two upper arms, two forearms, and a rifle',
  'legs and feet are NOT visible from this angle - do not draw legs',
  'character facing UP in the image, both arms holding the rifle pointing forward (up), rifle barrel along the body centerline',
  'each part is a separate island with a small even gap (4-8 px) from the others, no part overlaps another',
  'uniform scale across all parts, flat cel-shaded colors with a crisp rim light so shapes read from above',
  'fully transparent background, no scenery, no ground, no shadow plane, no checkerboard, no grid lines, no text, no labels',
  'game asset, single character, centred',
].join(', ')

/**
 * 组装拆件模式提示词。
 * @param {{layout?:'positional'|'grid', extra?:string, template?:string}} options
 */
export function partsPrompt({ layout = 'positional', extra = '', template = 'humanoid' } = {}) {
  const tpl = getTemplate(template)
  // 俯视模板有自己的提示词（视角、可见部件、朝向都不一样，套用前视那套会画出侧脸和腿）
  const base = tpl?.view === 'top'
    ? (layout === 'grid' ? TOPDOWN_GRID_PROMPT : TOPDOWN_PROMPT)
    : (layout === 'grid' ? GRID_PROMPT : POSITIONAL_PROMPT)
  const note = layout === 'grid' && tpl
    ? ` (template: ${tpl.label}, ${tpl.grid.columns}x${tpl.grid.rows})`
    : ''
  const extraText = String(extra ?? '').trim()
  return `${base}${note}${extraText ? `. ${extraText}` : ''}`
}

/* ============================================================================
 * 三、部件命名（这一步决定骨架对不对，不能瞎猜）
 * --------------------------------------------------------------------------
 * 两种版面在这件事上是**互补**的，必须说清楚（否则用户会以为插件坏了）：
 *
 *   grid 版面     ：格子序号 ↔ 槽位是**硬对应** → 名字精确，但格子里没有位置信息（摆放要人调）
 *   positional 版面：位置就是装配关系 → 摆放精确，但**名字得靠猜**（这里就是猜的部分）
 *
 * 所以 positional 有两条命名路：
 *   ① `nameStrategy: 'geometry'`（默认）—— 用几何规则猜人形部件：按角色包围盒归一化后，
 *      顶部小件=头、中间最大件=躯干、左右两侧向外依次=上臂/前臂/手、下段自上而下=大腿/小腿/脚。
 *      对**规范 T-pose** 准确率不错，但本质是启发式：**一定会需要人手改**（预览器支持改名）。
 *   ② 直接传 `names: ['head','torso',...]` —— 你自己给名字，最可靠。
 *
 * 关键红线：**猜错名字不能悄悄放过**。凡是没匹配上规则的，名字留在 `part_N` 并给警告，
 * 绝不硬塞一个看起来合理的名字 —— 那会让骨架层级错得很隐蔽。
 * ========================================================================== */

/**
 * 用几何规则给「炸开视图」里的部件猜人形名字。
 * @param {Array} parts splitParts 的产物
 * @returns {{names:string[], assigned:Map<string,string>, confidence:Record<string,number>, warnings:string[]}}
 */
export function guessHumanoidNames(parts = []) {
  const warnings = []
  const assigned = new Map()
  const confidence = {}
  if (parts.length === 0) return { names: [], assigned, confidence, warnings: ['没有部件'] }

  const x0 = Math.min(...parts.map((p) => p.source[0]))
  const y0 = Math.min(...parts.map((p) => p.source[1]))
  const x1 = Math.max(...parts.map((p) => p.source[0] + p.source[2]))
  const y1 = Math.max(...parts.map((p) => p.source[1] + p.source[3]))
  const bw = Math.max(1, x1 - x0)
  const bh = Math.max(1, y1 - y0)

  const info = parts.map((p) => {
    const [sx, sy, sw, sh] = p.source
    const cx = sx + sw / 2
    const cy = sy + sh / 2
    return {
      part: p,
      nx: (cx - x0) / bw,        // 0=最左 1=最右
      ny: (cy - y0) / bh,        // 0=最上 1=最下
      area: p.area ?? sw * sh,
      sw,
      sh,
      aspect: sw / Math.max(1, sh),
      offset: Math.abs((cx - x0) / bw - 0.5), // 离中线的横向距离
    }
  })
  const totalArea = info.reduce((sum, i) => sum + i.area, 0) || 1

  // —— 1) 头：最靠上、靠近中线、面积不大 ——
  const headCand = info.filter((i) => i.ny < 0.28 && i.offset < 0.22)
    .sort((a, b) => a.ny - b.ny)[0]
  if (headCand) {
    assigned.set(headCand.part.slotName, 'head')
    confidence[headCand.part.slotName] = 0.8
    headCand.taken = true
  } else {
    warnings.push('没找到像"头"的部件（最上方靠中线的位置为空）')
  }

  // —— 2) 躯干：中部、靠中线、面积最大 ——
  const torsoCand = info.filter((i) => !i.taken && i.ny > 0.20 && i.ny < 0.62 && i.offset < 0.20)
    .sort((a, b) => b.area - a.area)[0]
  if (torsoCand) {
    assigned.set(torsoCand.part.slotName, 'torso')
    confidence[torsoCand.part.slotName] = 0.7
    torsoCand.taken = true
  }

  // —— 3) 髋：中段偏下、靠中线，而且**不能是细长的肢体**
  //      （第一版没卡 aspect，结果把大腿当成髋了 —— 大腿是 16×50 的竖条，髋通常是横宽的一块）
  const hipCand = info.filter((i) => !i.taken && i.ny > 0.42 && i.ny < 0.72 && i.offset < 0.18 && i.aspect >= 0.6)
    .sort((a, b) => a.area - b.area)[0]
  if (hipCand) {
    assigned.set(hipCand.part.slotName, 'hip')
    confidence[hipCand.part.slotName] = 0.5
    hipCand.taken = true
  }

  // —— 4) 手臂：横向离中线远、纵向在上半身 ——
  const arms = info.filter((i) => !i.taken && i.offset > 0.16 && i.ny < 0.62)
  for (const side of [-1, 1]) {
    const band = arms
      .filter((i) => (i.nx - 0.5) * side > 0)
      .sort((a, b) => Math.abs(a.nx - 0.5) - Math.abs(b.nx - 0.5)) // 从靠近中线往外
    const suffix = side < 0 ? '_R' : '_L' // 画面左侧 = 角色右手（正面视角）
    const slotsForSide = ['upper_arm', 'forearm', 'hand']
    band.slice(0, 3).forEach((i, k) => {
      assigned.set(i.part.slotName, `${slotsForSide[k]}${suffix}`)
      confidence[i.part.slotName] = k === 0 ? 0.55 : 0.45
      i.taken = true
    })
    if (band.length > 3) warnings.push(`画面${side < 0 ? '左' : '右'}侧有 ${band.length} 个疑似手臂零件，>3 个没用上，请手动改名`)
    if (band.length === 0) warnings.push(`画面${side < 0 ? '左' : '右'}侧没找到手臂零件`)
  }

  // —— 5) 腿：下半身，左右分组后自上而下 = 大腿/小腿/脚；脚按"扁"识别 ——
  const legs = info.filter((i) => !i.taken && i.ny >= 0.55)
  for (const side of [-1, 1]) {
    const band = legs
      .filter((i) => (i.nx - 0.5) * side > 0)
      .sort((a, b) => a.ny - b.ny)
    const suffix = side < 0 ? '_R' : '_L'
    const slotsForSide = ['thigh', 'shin', 'foot']
    band.slice(0, 3).forEach((i, k) => {
      // 最下面那块如果明显"扁"，就叫 foot（不然可能模型把脚画成竖向的）
      let slot = slotsForSide[k]
      if (k === 2 && i.aspect > 1.4) slot = 'foot'
      assigned.set(i.part.slotName, `${slot}${suffix}`)
      confidence[i.part.slotName] = k === 0 ? 0.55 : 0.45
      i.taken = true
    })
    if (band.length === 0) warnings.push(`画面${side < 0 ? '左' : '右'}侧没找到腿部零件`)
  }

  // —— 6) 剩下的没命中规则：保留原名 + 警告（绝不硬塞一个名字） ——
  const leftover = info.filter((i) => !i.taken)
  for (const i of leftover) {
    warnings.push(`部件 ${i.part.slotName}（位置 ${(i.nx * 100).toFixed(0)}%,${(i.ny * 100).toFixed(0)}%）没匹配到任何骨骼槽位 —— 请在预览器里手动改名`)
  }
  if (totalArea > 0 && leftover.some((i) => i.area / totalArea > 0.2)) {
    warnings.push('有个占比 >20% 的大部件没识别出来，人形模板可能不适用（是不是画成怪物/四足了？）')
  }

  // 名字必须唯一：撞名就退回原名，否则骨骼会重名（validateRig 会报错）
  const used = new Set()
  const names = parts.map((p) => {
    const guess = assigned.get(p.slotName)
    if (!guess) return p.slotName
    if (used.has(guess)) return p.slotName
    used.add(guess)
    return guess
  })

  return { names, assigned, confidence, warnings }
}

/**
 * 正俯视部件的几何命名。
 *
 * 和侧/前视完全不同的规则（照搬前视那套会把头和手臂全认错）：
 *   body  —— 最大的一块，且靠近整体中心
 *   head  —— 接近正圆（aspect≈1）、面积中等、位于身体中心**偏前**
 *   rifle —— 最靠前（ny 最小）的细长件，且贴近中轴
 *   arms  —— 在中轴两侧的竖条；**离身体近的是上臂，远的是前臂**
 *           （俯视时胳膊从肩膀朝前伸，肩在下、手在上）
 *   shadow —— 面积很大但颜色很淡/半透明的件（有 alpha<200 的占比高）→ 先不判，留给人改
 *
 * 认不出来仍然保留原名 + 警告，绝不硬塞。
 */
export function guessTopdownNames(parts = []) {
  const warnings = []
  const assigned = new Map()
  if (parts.length === 0) return { names: [], assigned, warnings: ['没有部件'] }

  const x0 = Math.min(...parts.map((p) => p.source[0]))
  const y0 = Math.min(...parts.map((p) => p.source[1]))
  const x1 = Math.max(...parts.map((p) => p.source[0] + p.source[2]))
  const y1 = Math.max(...parts.map((p) => p.source[1] + p.source[3]))
  const bw = Math.max(1, x1 - x0)
  const bh = Math.max(1, y1 - y0)

  const info = parts.map((p) => {
    const [sx, sy, sw, sh] = p.source
    return {
      part: p,
      cx: sx + sw / 2,
      cy: sy + sh / 2,
      nx: (sx + sw / 2 - x0) / bw,
      ny: (sy + sh / 2 - y0) / bh,
      area: p.area ?? sw * sh,
      sw, sh,
      aspect: sw / Math.max(1, sh),
      offset: Math.abs((sx + sw / 2 - x0) / bw - 0.5),
      tall: sh > sw,
    }
  })
  const take = (item, name) => { assigned.set(item.part.slotName, name); item.taken = true; return item }

  // body：最大
  const body = [...info].sort((a, b) => b.area - a.area)[0]
  if (body) take(body, 'body')

  // head：剩下的里，最接近正圆且靠近中轴
  const roundish = info.filter((i) => !i.taken && i.aspect > 0.7 && i.aspect < 1.45 && i.offset < 0.28)
    .sort((a, b) => Math.abs(a.aspect - 1) - Math.abs(b.aspect - 1))
  if (roundish[0]) take(roundish[0], 'head')

  // rifle：剩下的里最靠前（ny 最小）的细长件，且贴中轴
  const rifleCand = info.filter((i) => !i.taken && (i.aspect < 0.8 || i.aspect > 1.6) && i.offset < 0.3)
    .sort((a, b) => a.ny - b.ny)
  if (rifleCand[0]) take(rifleCand[0], 'rifle')

  // 胳膊：剩下的竖条，按左右分组，组内**ny 大的算上臂**（离身体近），ny 小的算前臂
  const limbs = info.filter((i) => !i.taken && i.tall)
  for (const side of [-1, 1]) {
    const band = limbs.filter((i) => (i.nx - 0.5) * side > 0).sort((a, b) => b.ny - a.ny) // 从靠近身体往外
    const suffix = side < 0 ? '_R' : '_L'  // 画面左侧 = 角色右手（俯视同理）
    if (band[0]) take(band[0], `upper_arm${suffix}`)
    if (band[1]) take(band[1], `forearm${suffix}`)
    if (band.length > 2) warnings.push(`画面${side < 0 ? '左' : '右'}侧有 ${band.length} 个竖条部件，多的没命名（请手动改）`)
  }

  const leftover = info.filter((i) => !i.taken)
  for (const i of leftover) {
    warnings.push(`部件 ${i.part.slotName}（位置 ${(i.nx * 100).toFixed(0)}%,${(i.ny * 100).toFixed(0)}%，面积 ${i.area}）没匹配到俯视槽位 —— 请在预览器里改名`)
  }

  const used = new Set()
  const names = parts.map((p) => {
    const guess = assigned.get(p.slotName)
    if (!guess) return p.slotName
    if (used.has(guess)) return p.slotName
    used.add(guess)
    return guess
  })
  return { names, assigned, warnings }
}

/* ============================================================================
 * 四、切分
 * ========================================================================== */

/** 取某个矩形区域里的 alpha 紧包围盒 + 不透明像素集合（供装配吸附用）。 */
function regionBox(pixels, width, cell, alphaThreshold) {
  let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1
  for (let y = cell.y0; y < cell.y0 + cell.h; y++) {
    for (let x = cell.x0; x < cell.x0 + cell.w; x++) {
      if (pixels[(y * width + x) * 4 + 3] >= alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 切分部件。
 *
 * @param {object} params
 * @param {Buffer} params.buffer 整张 PNG
 * @param {'positional'|'grid'} [params.layout]
 * @param {{columns:number, rows:number}} [params.grid] grid 版面用；不给就用模板的
 * @param {Array<{name:string,parent:string|null,z:number,pivotRatio:number[]}>} [params.slots] 槽位表
 * @param {number} [params.alphaThreshold] 低于它的算透明（默认 16，能保留半透明边缘）
 * @param {number} [params.minArea] 小于这么多像素的连通域当噪点丢弃（默认 24）
 * @returns {{ok:boolean, layout:string, sheet:object, parts:Array, warnings:string[], error?:string}}
 */
export function splitParts({
  buffer,
  layout = 'positional',
  grid,
  slots = HUMANOID_SLOTS,
  alphaThreshold = 16,
  minArea = 24,
  maxParts = 64,
  names = null,
  nameStrategy = null,
  template = 'humanoid',
} = {}) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开这张图（只支持 8bit 非隔行 PNG）' }
  const { pixels, width, height } = decoded
  const warnings = []
  const parts = []

  if (layout === 'grid') {
    const g = grid ?? { columns: 4, rows: 4 }
    if (!(g.columns > 0) || !(g.rows > 0)) return { ok: false, error: 'grid 的 columns/rows 必须是正数' }
    const cellW = width / g.columns
    const cellH = height / g.rows
    for (let row = 0; row < g.rows; row++) {
      for (let column = 0; column < g.columns; column++) {
        const index = row * g.columns + column
        const slot = slots[index]
        const cell = {
          x0: Math.round(column * cellW),
          y0: Math.round(row * cellH),
          w: Math.round(cellW),
          h: Math.round(cellH),
        }
        const box = regionBox(pixels, width, cell, alphaThreshold)
        if (!box) {
          if (slot) warnings.push(`格子 ${index + 1}（${slot.name}）是空的 —— 模型可能没画这一件`)
          continue
        }
        // 数一下这一格里是不是多个岛：零件盘里一个格子该只有一件，多了说明画串了
        const comps = findComponents(pixels, width, height, { ...cell, alphaThreshold })
        const solid = comps.filter((c) => (c.count ?? 0) >= minArea)
        parts.push({
          index,
          slotName: slot?.name ?? `part_${index + 1}`,
          source: [box.x, box.y, box.w, box.h],
          islands: solid.length,
          area: solid.reduce((sum, c) => sum + (c.count ?? 0), 0),
        })
        if (solid.length > 1) {
          warnings.push(`格子 ${index + 1}（${slot?.name ?? index}）里有 ${solid.length} 个独立块，已按整体包围盒切出；可能在格子里画串了`)
        }
      }
    }
    if (parts.length === 0) return { ok: false, error: '一个部件都没切到 —— 图是不是全透明？或者背景没抠干净？' }
  } else {
    // positional：整张图按 alpha 连通域切，位置保留
    const comps = findComponents(pixels, width, height, { alphaThreshold, maxComponents: maxParts })
    const solid = comps.filter((c) => (c.count ?? 0) >= minArea)
    const discarded = comps.length - solid.length
    if (discarded > 0) warnings.push(`丢弃了 ${discarded} 个小于 ${minArea}px 的噪点块`)
    if (solid.length === 0) return { ok: false, error: '一个部件都没切到 —— 检查透明背景（或先用 config set_upload / keyOutFlatBackground 抠掉纯色底）' }

    // 按「从上到下、从左到右」排序，让槽位分配稳定可预期
    // 注意 findComponents 返回的是 {minX,minY,maxX,maxY,count}，不是 {x,y,w,h}
    solid.sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX))
    if (solid.length > slots.length) {
      warnings.push(`切到 ${solid.length} 块，但模板只有 ${slots.length} 个槽位；多出来的会命名为 part_N`)
    }
    solid.forEach((c, i) => {
      parts.push({
        index: i,
        // positional 没有"格子序号↔槽位"的硬对应，名字由后面的命名策略决定
        // （默认几何识别；识别不到就留 part_N 并警告，绝不硬塞）
        slotName: slots[i]?.name ?? `part_${i + 1}`,
        source: [c.minX, c.minY, c.maxX - c.minX + 1, c.maxY - c.minY + 1],
        islands: 1,
        area: c.count ?? 0,
      })
    })
    if (solid.length !== slots.length) {
      warnings.push(`切到 ${solid.length} 块，模板期望 ${slots.length} 块（部件少画了/多画了都会这样）`)
    }
  }

  // ---- 命名：显式 names > nameStrategy > 版面默认 ----
  const strategy = names
    ? 'explicit'
    : (nameStrategy ?? (layout === 'grid' ? 'template-order' : 'geometry'))
  if (strategy === 'explicit' && Array.isArray(names)) {
    parts.forEach((p, i) => { if (names[i]) p.slotName = String(names[i]) })
  } else if (strategy === 'geometry') {
    /* 按模板视角选命名器：俯视和前视的几何规则完全不同，
     * 用错会把人认成手臂（实测：前视规则在俯视图上把 6 个部件认成 head/forearm/upper_arm_L_2）。
     * 俯视图没有 HUMANOID_SLOTS 那么多槽位，默认几何命名也该走俯视规则。 */
    const slotsArentHumanoid = slots !== HUMANOID_SLOTS
    const guessed = (getTemplate(template)?.view === 'top' || slotsArentHumanoid)
      ? guessTopdownNames(parts)
      : guessHumanoidNames(parts)
    parts.forEach((p, i) => { if (guessed.names[i]) p.slotName = guessed.names[i] })
    warnings.push(...guessed.warnings)
    // 一条总括警告就够：逐个数"置信度低"会把真正需要看的那几条埋掉
    warnings.push('名字是**几何启发式猜的**（不是模型识别）。骨架层级完全依赖名字，请在预览器里逐个核对，错了就改名重新导出')
  }
  // 名字必须唯一，否则骨骼重名（后面 validateRig 会直接报错）
  const seen = new Set()
  for (const p of parts) {
    if (seen.has(p.slotName)) {
      const original = p.slotName
      let n = 2
      while (seen.has(`${original}_${n}`)) n += 1
      p.slotName = `${original}_${n}`
      warnings.push(`部件重名「${original}」，第 ${p.index + 1} 个改名为 ${p.slotName}`)
    }
    seen.add(p.slotName)
  }

  return { ok: true, layout, sheet: { width, height }, parts, warnings, nameStrategy: strategy }
}

/* ============================================================================
 * 四、图集打包（shelf 行式，简单可靠）
 * ========================================================================== */

/**
 * 把部件切出来并打包成图集。
 * padding 留 2px：不留的话相邻部件边缘会互相渗色（尤其开 mipmap/线性过滤时）。
 */
export function packAtlas({ buffer, parts, sheet, padding = 2, maxWidth = 2048 } = {}) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开这张图' }
  const { pixels: src, width: srcW } = decoded
  const pw = padding

  // 按高度降序排（shelf 打包的标准做法：高的先放，行高才不会浪费）
  const ordered = [...parts].sort((a, b) => (b.source[3] - a.source[3]) || (a.slotName < b.slotName ? -1 : 1))

  const placed = []
  let cursorX = pw
  let cursorY = pw
  let rowHeight = 0
  let atlasW = 0
  for (const part of ordered) {
    const [, , w, h] = part.source
    if (cursorX + w + pw > maxWidth && cursorX > pw) {
      cursorX = pw
      cursorY += rowHeight + pw
      rowHeight = 0
    }
    placed.push({ part, x: cursorX, y: cursorY, w, h })
    cursorX += w + pw
    if (h > rowHeight) rowHeight = h
    if (cursorX > atlasW) atlasW = cursorX
  }
  let atlasH = cursorY + rowHeight + pw
  // 裁到实际用到的大小（不强制 2 的幂；引擎要的话自己在导入设置里勾）
  atlasW = Math.max(1, atlasW)
  atlasH = Math.max(1, atlasH)

  const atlas = new Uint8ClampedArray(atlasW * atlasH * 4)
  for (const p of placed) {
    const [sx0, sy0] = p.part.source
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const si = ((sy0 + y) * srcW + (sx0 + x)) * 4
        const di = ((p.y + y) * atlasW + (p.x + x)) * 4
        atlas[di] = src[si]
        atlas[di + 1] = src[si + 1]
        atlas[di + 2] = src[si + 2]
        atlas[di + 3] = src[si + 3]
      }
    }
  }

  const byName = new Map(placed.map((p) => [p.part.slotName, p]))
  // 还原成模板顺序（预览/导出的可读性靠这个顺序）
  const outParts = parts.map((part) => {
    const p = byName.get(part.slotName)
    return {
      name: part.slotName,
      slot: part.slotName,
      rect: [p.x, p.y, p.w, p.h],
      sourceRect: part.source,
      islands: part.islands,
      area: part.area,
    }
  })

  return {
    ok: true,
    buffer: encodePngRgba(atlasW, atlasH, atlas),
    width: atlasW,
    height: atlasH,
    parts: outParts,
    note: `图集 ${atlasW}×${atlasH}，${outParts.length} 个部件，留白 ${pw}px`,
  }
}

/* ============================================================================
 * 五、骨架生成 + 自动装配
 * ========================================================================== */

const DEFAULT_PIVOT_RATIO = [0.5, 0.1]

/**
 * 由切分结果生成骨架。
 *
 * 关键点：
 *   - **positional 版面**：装配位置直接取部件在图纸上的位置 —— 图纸本身就是角色，
 *     所以"零变换时部件回到原始位置"这条性质天然成立（见下方 pose=identity 的推导）。
 *   - **grid 版面**：用模板给的粗略偏移摆放，必须靠 autoAssemble + 人调。
 *
 * @param {object} params
 * @param {Array} params.parts splitParts 的产物（带 source / slotName）
 * @param {object} [params.atlas] packAtlas 的产物（用来填 atlas 宽高）
 * @param {Array} [params.slots] 模板槽位
 * @param {'positional'|'grid'} [params.layout]
 * @param {string} [params.name]
 * @param {string} [params.imageName] 图集文件名（写进 JSON，运行时要能找到）
 */
export function buildSkeleton({
  parts,
  atlas,
  slots = HUMANOID_SLOTS,
  layout = 'positional',
  name = 'character',
  imageName = 'atlas.png',
  templateName = 'humanoid',
} = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return { ok: false, error: '没有部件，先切分' }
  const slotByName = new Map(slots.map((s) => [s.name, s]))
  const atlasRect = new Map((atlas?.parts ?? []).map((p) => [p.name, p.rect]))

  // 部件中心/尺寸（用源图坐标算，positional 的位置平移到以角色包围盒中心为原点）
  const allX = parts.map((p) => p.source[0])
  const allY = parts.map((p) => p.source[1])
  const allR = parts.map((p) => p.source[0] + p.source[2])
  const allB = parts.map((p) => p.source[1] + p.source[3])
  const bbox = {
    x0: Math.min(...allX),
    y0: Math.min(...allY),
    x1: Math.max(...allR),
    y1: Math.max(...allB),
  }
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const charH = Math.max(1, bbox.y1 - bbox.y0)
  // 屏幕坐标 y 向下；骨骼用 y 向上（引擎里普遍如此），所以翻一次
  const toWorld = (px, py) => ({ x: px - cx, y: -(py - cy) })

  const bones = []
  const boneParts = []
  for (const part of parts) {
    const slot = slotByName.get(part.slotName)
    const ratio = slot?.pivotRatio ?? DEFAULT_PIVOT_RATIO
    const [sx, sy, sw, sh] = part.source
    // 枢轴：部件矩形内的像素坐标
    const pivot = [
      Math.min(sw - 1, Math.max(0, Math.round(ratio[0] * (sw - 1)))),
      Math.min(sh - 1, Math.max(0, Math.round(ratio[1] * (sh - 1)))),
    ]
    let worldPivot
    if (layout === 'grid') {
      const offset = slot?.offset ?? [0, 0]
      worldPivot = { x: offset[0] * charH, y: offset[1] * charH }
    } else {
      worldPivot = toWorld(sx + pivot[0], sy + pivot[1])
    }
    const rect = atlasRect.get(part.slotName) ?? [0, 0, sw, sh]
    boneParts.push({
      name: part.slotName,
      slot: part.slotName,
      rect,
      sourceRect: part.source,
      // pivot 用**图集矩形内**的坐标（rect 和图集里的实际像素一一对应）
      pivot: [pivot[0], pivot[1]],
      pivotRatio: [pivot[0] / Math.max(1, rect[2] - 1), pivot[1] / Math.max(1, rect[3] - 1)],
      zOrder: slot?.z ?? 10 + boneParts.length,
      parent: slot?.parent ?? null,
      world: worldPivot,
    })
  }

  // 父级不存在（模板和切出来的名字对不上）→ 挂到根上，别丢部件
  const names = new Set(boneParts.map((b) => b.name))
  for (const b of boneParts) {
    if (b.parent && !names.has(b.parent)) b.parent = null
  }
  // 找根（可能有多个：名字没对上时）
  const roots = boneParts.filter((b) => !b.parent)
  const rootName = roots.find((b) => b.name === 'hip')?.name ?? roots[0]?.name ?? boneParts[0].name
  for (const b of boneParts) if (!b.parent && b.name !== rootName) b.parent = rootName

  // 转成「父级相对」的骨骼偏移
  const worldByName = new Map(boneParts.map((b) => [b.name, b.world]))
  for (const b of boneParts) {
    const parentWorld = b.parent ? worldByName.get(b.parent) : { x: 0, y: 0 }
    bones.push({
      name: b.name,
      parent: b.parent,
      x: Number((b.world.x - (parentWorld?.x ?? 0)).toFixed(2)),
      y: Number((b.world.y - (parentWorld?.y ?? 0)).toFixed(2)),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    })
  }

  // 绘制顺序：按 zOrder 升序
  const drawOrder = [...boneParts].sort((a, b) => a.zOrder - b.zOrder).map((b) => b.name)

  return {
    ok: true,
    skeleton: {
      version: RIG_VERSION,
      name,
      template: templateName,
      layout,
      atlas: { image: imageName, width: atlas?.width ?? 0, height: atlas?.height ?? 0 },
      bones,
      parts: boneParts,
      drawOrder,
      meta: {
        // 记下来，方便以后判断"位置是几何来的还是模板猜的"
        placement: layout === 'grid' ? 'template-offset' : 'sheet-geometry',
        bbox,
        charHeight: charH,
      },
    },
    warnings: layout === 'grid'
      ? ['grid 版面的装配位置来自模板粗略偏移，务必在预览器里调整']
      : [],
  }
}

/**
 * 自动装配：把关节的缝自动合拢。
 *
 * 原理：对每个有父级的部件，找出"它的枢轴"到"父件不透明区域"的最近点，
 * 沿这个向量平移一小段（不超过角色高度的 `maxShift` 倍），让关节贴上去。
 * 为什么只挪一点点：整张爆炸图已经有正确的大致位置，这里只是收缝；
 * 不限幅的话会把手掌吸到躯干上（视觉上"拼歪了"比"留缝"更难发现）。
 *
 * @param {object} skeleton
 * @param {object} params
 * @param {Buffer} params.buffer 图集 PNG（用来查父件的不透明区域）
 * @param {number} [params.maxShift] 单件最大位移（角色高度的比例，默认 0.04）
 * @param {number} [params.snapPx] 小于这个像素数的缝隙就不动（默认 2）
 */
export function autoAssemble({ skeleton, buffer, maxShift = 0.04, snapPx = 2, alphaThreshold = 32 } = {}) {
  if (!skeleton?.bones) return { ok: false, error: '没有骨架' }
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开图集' }
  const { pixels, width } = decoded
  const partByName = new Map(skeleton.parts.map((p) => [p.name, p]))
  const charH = skeleton.meta?.charHeight ?? 256
  const limit = charH * maxShift

  const world = worldTransforms(skeleton)
  const moves = []

  // 按层级从根往下处理：父级先归位，子级再跟着
  for (const name of bonesByDepth(skeleton)) {
    const bone = skeleton.bones.find((b) => b.name === name)
    if (!bone || !bone.parent) continue
    const part = partByName.get(name)
    const parentPart = partByName.get(bone.parent)
    if (!part || !parentPart) continue

    const w = world.get(name)
    const parentW = world.get(bone.parent)
    if (!w || !parentW) continue

    // 当前枢轴的世界坐标（骨骼原点就是枢轴）
    const pivotX = w.x
    const pivotY = -w.y // 翻回屏幕坐标
    const near = nearestOpaquePoint(pixels, width, decoded.height, parentPart.rect, parentW, axisFlip(pivotX, pivotY), alphaThreshold)
    if (!near) continue
    const dx = near.screenX - pivotX
    const dy = near.screenY - pivotY
    const dist = Math.hypot(dx, dy)
    if (dist <= snapPx || dist > limit) continue
    const k = Math.min(1, limit / dist)
    const shift = { x: dx * k, y: -dy * k } // 回到 y 向上的骨骼坐标
    bone.x = Number((bone.x + shift.x).toFixed(2))
    bone.y = Number((bone.y + shift.y).toFixed(2))
    moves.push({ bone: name, dx: Number(shift.x.toFixed(2)), dy: Number(shift.y.toFixed(2)), gap: Number(dist.toFixed(2)) })
    // 父级动过之后，子级的期望位置会变 —— 重算世界变换
    Object.assign(world, worldTransforms(skeleton))
  }

  return { ok: true, moves, moved: moves.length }
}

/** 只是为了可读性：pivot 本来是屏幕坐标，包一层不改变值。 */
function axisFlip(x, y) { return { screenX: x, screenY: y } }

/**
 * 在父件的不透明区域里，找离给定点最近的点（粗采样，够用且快）。
 * 返回屏幕坐标。
 */
function nearestOpaquePoint(pixels, imageWidth, imageHeight, rect, parentWorld, target, alphaThreshold = 32) {
  const [rx, ry, rw, rh] = rect
  // 父件的世界枢轴 → 父件矩形左上角的屏幕位置
  const originX = parentWorld.x - (parentWorld.pivot?.[0] ?? 0)
  const originY = -(parentWorld.y) - (parentWorld.pivot?.[1] ?? 0)
  let best = null
  let bestDist = Infinity
  const step = Math.max(1, Math.floor(Math.max(rw, rh) / 96))
  for (let y = 0; y < rh; y += step) {
    for (let x = 0; x < rw; x += step) {
      const ax = rx + x
      const ay = ry + y
      if (ax < 0 || ay < 0 || ax >= imageWidth || ay >= imageHeight) continue
      if (pixels[(ay * imageWidth + ax) * 4 + 3] < alphaThreshold) continue
      const sx = originX + x
      const sy = originY + y
      const d = Math.hypot(sx - target.screenX, sy - target.screenY)
      if (d < bestDist) {
        bestDist = d
        best = { screenX: sx, screenY: sy }
      }
    }
  }
  return best
}

/* ============================================================================
 * 六、世界变换（预览器 / 校验 / 引擎侧都要用同一套数学）
 * ========================================================================== */

/** 按深度排序骨骼名（父在子前）。带环保护。 */
export function bonesByDepth(skeleton) {
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]))
  const depth = new Map()
  const visiting = new Set()
  const walk = (name) => {
    if (depth.has(name)) return depth.get(name)
    if (visiting.has(name)) return 0 // 环：当根处理，不让它死循环
    visiting.add(name)
    const bone = byName.get(name)
    const d = bone?.parent ? walk(bone.parent) + 1 : 0
    visiting.delete(name)
    depth.set(name, d)
    return d
  }
  for (const b of skeleton.bones) walk(b.name)
  return [...skeleton.bones].sort((a, b) => (depth.get(a.name) ?? 0) - (depth.get(b.name) ?? 0)).map((b) => b.name)
}

/**
 * 算世界变换。返回 Map<name, {x,y,rotation,scaleX,scaleY,pivot}>。
 * 数学按 2D 仿射：先父级变换，再叠加自身平移/旋转/缩放。
 */
export function worldTransforms(skeleton, pose = {}) {
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]))
  const partByName = new Map((skeleton.parts ?? []).map((p) => [p.name, p]))
  const out = new Map()
  for (const name of bonesByDepth(skeleton)) {
    const bone = byName.get(name)
    const override = pose[name] ?? {}
    const rotation = (bone.rotation ?? 0) + (override.rotation ?? 0)
    const scaleX = (bone.scaleX ?? 1) * (override.scaleX ?? 1)
    const scaleY = (bone.scaleY ?? 1) * (override.scaleY ?? 1)
    const localX = bone.x + (override.x ?? 0)
    const localY = bone.y + (override.y ?? 0)
    if (!bone.parent || !out.has(bone.parent)) {
      out.set(name, {
        x: localX, y: localY, rotation, scaleX, scaleY,
        pivot: partByName.get(name)?.pivot ?? [0, 0],
      })
      continue
    }
    const p = out.get(bone.parent)
    const rad = (p.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    // 父级坐标系里：先缩放，再旋转，再平移
    const lx = localX * p.scaleX
    const ly = localY * p.scaleY
    out.set(name, {
      x: p.x + lx * cos - ly * sin,
      y: p.y + lx * sin + ly * cos,
      rotation: p.rotation + rotation,
      scaleX: p.scaleX * scaleX,
      scaleY: p.scaleY * scaleY,
      pivot: partByName.get(name)?.pivot ?? [0, 0],
    })
  }
  return out
}

/**
 * 把世界变换摊平成「每个部件该怎么画」的列表（预览器和引擎都直接照这个画）。
 * @returns {Array<{name, drawX, drawY, rotation, scaleX, scaleY, rect, zOrder}>}
 *   drawX/drawY 是把图集矩形左上角放到哪里（屏幕坐标，y 向下）。
 */
export function drawList(skeleton, pose = {}) {
  const world = worldTransforms(skeleton, pose)
  const partByName = new Map((skeleton.parts ?? []).map((p) => [p.name, p]))
  const order = skeleton.drawOrder ?? (skeleton.parts ?? []).map((p) => p.name)
  const list = []
  for (const name of order) {
    const part = partByName.get(name)
    const w = world.get(name)
    if (!part || !w) continue
    // 枢轴在世界坐标（骨骼原点 = 枢轴）；部件左上角 = 枢轴 - pivot（自身坐标系里，暂不旋转）
    list.push({
      name,
      rect: part.rect,
      pivot: part.pivot,
      zOrder: part.zOrder,
      // 屏幕坐标：y 向上翻成 y 向下
      drawX: w.x - part.pivot[0],
      drawY: -w.y - part.pivot[1],
      rotation: w.rotation,
      scaleX: w.scaleX,
      scaleY: w.scaleY,
    })
  }
  return list
}

/* ============================================================================
 * 七、校验
 * ========================================================================== */

export function validateRig(skeleton) {
  const errors = []
  const warnings = []
  if (!skeleton || typeof skeleton !== 'object') return { ok: false, errors: ['骨架不是对象'], warnings }
  if (skeleton.version !== RIG_VERSION) warnings.push(`版本号是 ${skeleton.version}，当前管线产出 ${RIG_VERSION}`)
  if (!Array.isArray(skeleton.bones) || skeleton.bones.length === 0) errors.push('没有骨骼')
  if (!Array.isArray(skeleton.parts) || skeleton.parts.length === 0) errors.push('没有部件')
  if (!skeleton.atlas?.image) errors.push('缺少 atlas.image（运行时要靠它找图集）')

  const names = new Set()
  for (const bone of skeleton.bones ?? []) {
    if (!bone.name) { errors.push('有骨骼缺 name'); continue }
    if (names.has(bone.name)) errors.push(`骨骼重名：${bone.name}`)
    names.add(bone.name)
    for (const key of ['x', 'y']) {
      if (typeof bone[key] !== 'number' || !Number.isFinite(bone[key])) errors.push(`骨骼 ${bone.name} 的 ${key} 不是有限数字`)
    }
  }
  for (const bone of skeleton.bones ?? []) {
    if (bone.parent && !names.has(bone.parent)) errors.push(`骨骼 ${bone.name} 的父级 ${bone.parent} 不存在`)
  }
  // 环检测
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]))
  for (const bone of skeleton.bones) {
    const seen = new Set([bone.name])
    let cursor = bone.parent
    while (cursor) {
      if (seen.has(cursor)) { errors.push(`骨骼层级有环：${bone.name} → … → ${cursor}`); break }
      seen.add(cursor)
      cursor = byName.get(cursor)?.parent ?? null
    }
  }
  const partNames = new Set()
  for (const part of skeleton.parts ?? []) {
    if (!part.name) errors.push('有部件缺 name')
    if (partNames.has(part.name)) errors.push(`部件重名：${part.name}`)
    partNames.add(part.name)
    if (!names.has(part.name)) errors.push(`部件 ${part.name} 没有同名骨骼`)
    const rect = part.rect
    if (!Array.isArray(rect) || rect.length !== 4) errors.push(`部件 ${part.name} 的 rect 不合法`)
    const pivot = part.pivot
    if (!Array.isArray(pivot) || pivot.length !== 2) {
      errors.push(`部件 ${part.name} 的 pivot 不合法`)
    } else if (Array.isArray(rect) && rect.length === 4) {
      if (pivot[0] < 0 || pivot[1] < 0 || pivot[0] > rect[2] || pivot[1] > rect[3]) {
        // 枢轴跑出部件矩形：旋转时会绕着空气转，这是最常见的手工编辑事故
        errors.push(`部件 ${part.name} 的 pivot ${JSON.stringify(pivot)} 跑出了 rect ${JSON.stringify(rect)}`)
      }
    }
  }
  const draw = skeleton.drawOrder ?? []
  for (const name of draw) if (!partNames.has(name)) errors.push(`drawOrder 里有不存在的部件：${name}`)
  if (draw.length !== partNames.size) warnings.push(`drawOrder 有 ${draw.length} 项，部件有 ${partNames.size} 个（可能漏了）`)
  if (new Set(draw).size !== draw.length) errors.push('drawOrder 有重复项')

  /* 动画校验：
   * 通道里写了不存在的骨骼 → 引擎会静默忽略（症状是"这段为什么没动"）；
   * 关键帧时间不单调或超出 0~1 → 插值乱跳（动作抽搐），也是静默错。
   * 这两种都必须报出来，不能靠肉眼看。 */
  const animations = skeleton.animations
  if (animations !== undefined) {
    if (!animations || typeof animations !== 'object' || Array.isArray(animations)) {
      errors.push('animations 必须是对象（{ 名字: {duration, channels} }）')
    } else {
      for (const [animName, animation] of Object.entries(animations)) {
        if (!animation || typeof animation !== 'object') { errors.push(`动画 ${animName} 不是对象`); continue }
        if (!(Number(animation.duration) > 0)) errors.push(`动画 ${animName} 的 duration 必须 > 0`)
        if (!animation.channels || typeof animation.channels !== 'object') {
          errors.push(`动画 ${animName} 没有 channels`); continue
        }
        for (const [boneName, channel] of Object.entries(animation.channels)) {
          if (!names.has(boneName)) errors.push(`动画 ${animName} 的通道写了不存在的骨骼：${boneName}`)
          for (const [prop, keys] of Object.entries(channel ?? {})) {
            if (!['rotation', 'x', 'y', 'scaleX', 'scaleY'].includes(prop)) {
              errors.push(`动画 ${animName}.${boneName} 的通道属性不合法：${prop}`)
              continue
            }
            if (!Array.isArray(keys) || keys.length === 0) { errors.push(`动画 ${animName}.${boneName}.${prop} 没有关键帧`); continue }
            let last = -1
            for (const key of keys) {
              if (!Array.isArray(key) || key.length !== 2 || !Number.isFinite(key[0]) || !Number.isFinite(key[1])) {
                errors.push(`动画 ${animName}.${boneName}.${prop} 有非法关键帧：${JSON.stringify(key)}`)
                break
              }
              if (key[0] < 0 || key[0] > 1) {
                errors.push(`动画 ${animName}.${boneName}.${prop} 的时间 ${key[0]} 超出 0~1`)
                break
              }
              if (key[0] < last) {
                errors.push(`动画 ${animName}.${boneName}.${prop} 的关键帧时间不是递增的（${last} → ${key[0]}）`)
                break
              }
              last = key[0]
            }
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0, errors, warnings,
    parts: partNames.size, bones: names.size,
    animations: Object.keys(animations ?? {}).length,
  }
}

/* ============================================================================
 * 八、导出：通用 JSON + Spine / DragonBones 适配
 * ========================================================================== */

/** 通用格式：就是 skeleton 本身（游戏自己写 20 行运行时就能吃）。 */
export function toGeneric(skeleton) {
  return { format: 'generic', version: RIG_VERSION, ...structuredClone(skeleton) }
}

/**
 * Spine 3.8 JSON。
 * 映射：骨骼同名；每个部件是 slot + region attachment；pivot 转成 Spine 的
 * 归一化 (x,y)（Spine 的 y 轴向上，且 attachment 的 offset 是以 pivot 为原点的）。
 */
export function toSpine(skeleton) {
  const bones = skeleton.bones.map((b) => ({
    name: b.name,
    ...(b.parent ? { parent: b.parent } : {}),
    x: b.x,
    y: b.y,
    ...(b.rotation ? { rotation: b.rotation } : {}),
    ...(b.scaleX !== 1 ? { scaleX: b.scaleX } : {}),
    ...(b.scaleY !== 1 ? { scaleY: b.scaleY } : {}),
  }))
  const slots = skeleton.drawOrder.map((name, index) => ({ name, bone: name, attachment: name, color: 'ffffffff', ...(index === 0 ? {} : {}) }))
  const attachments = {}
  for (const part of skeleton.parts) {
    const [rx, ry, rw, rh] = part.rect
    const [px, py] = part.pivot
    attachments[part.name] = {
      [part.name]: {
        type: 'region',
        // Spine 用"pivot 在图块里的归一化位置 + 图块以 pivot 为中心的偏移"
        x: -px,
        y: -(rh - py),
        width: rw,
        height: rh,
        ...(skeleton.atlas?.image ? { path: part.name } : {}),
      },
    }
  }
  return {
    format: 'spine',
    skeleton: { spine: '3.8.99', x: 0, y: 0, width: skeleton.atlas?.width ?? 0, height: skeleton.atlas?.height ?? 0 },
    bones,
    slots,
    skins: [{ name: 'default', attachments }],
    animations: {},
    // 非标准但有用：把 rect/pivot 也带上，方便自定义导入器
    _dsh: {
      atlas: skeleton.atlas,
      parts: skeleton.parts.map((p) => ({ name: p.name, rect: p.rect, pivot: p.pivot, zOrder: p.zOrder })),
      note: 'Spine 需要把多个 region 放进同一张图集；这里的 _dsh 字段是为了让自定义导入器能直接按 rect 取图。',
    },
  }
}

/** DragonBones 5.x JSON（骨架/槽位/皮肤三段）。 */
export function toDragonBones(skeleton) {
  const bones = skeleton.bones.map((b) => ({
    name: b.name,
    ...(b.parent ? { parent: b.parent } : {}),
    transform: { x: b.x, y: b.y, skX: b.rotation, skY: b.rotation, scX: b.scaleX, scY: b.scaleY },
  }))
  const slots = skeleton.drawOrder.map((name) => ({ name, parent: name, displayIndex: 0 }))
  const partsOf = {}
  for (const part of skeleton.parts) {
    const [rx, ry, rw, rh] = part.rect
    const [px, py] = part.pivot
    partsOf[part.name] = [{
      name: part.name,
      type: 0, // 图片
      width: rw,
      height: rh,
      // DragonBones 的 pivot 是归一化的（0~1，y 向下）
      pivot: { x: rw ? px / rw : 0.5, y: rh ? py / rh : 0.5 },
      // 图集里的 frame
      frame: { x: rx, y: ry, w: rw, h: rh },
    }]
  }
  return {
    format: 'dragonbones',
    frameRate: 24,
    name: skeleton.name,
    version: '5.5',
    compatibleVersion: '5.5',
    armature: [{
      type: 'Armature',
      frameRate: 24,
      name: skeleton.name,
      aabb: { x: -(skeleton.atlas?.width ?? 0) / 2, y: -(skeleton.atlas?.height ?? 0) / 2, width: skeleton.atlas?.width ?? 0, height: skeleton.atlas?.height ?? 0 },
      bone: bones,
      slot: slots,
      skin: [{ name: '', slot: skeleton.parts.map((p) => ({ name: p.name, display: [{ name: p.name, path: p.name, type: 'image', transform: { x: 0, y: 0 } }] })) }],
      animation: [],
      defaultActions: [],
    }],
    // 非标准：让自定义导入器能直接取图
    _dsh: { atlas: skeleton.atlas, parts: partsOf, note: 'DragonBones 的图集通常在 _tex.json 里描述；这里把 frame 放在 _dsh 供自定义导入器使用。' },
  }
}

/** 导出：返回可写盘的文件列表。 */
export function exportRig({ skeleton, format = 'generic' } = {}) {
  const check = validateRig(skeleton)
  if (!check.ok) return { ok: false, error: '骨架有问题，先修再导出', ...check }
  const name = skeleton.name || 'character'
  if (format === 'generic') {
    return { ok: true, format, files: [{ name: `${name}.skeleton.json`, content: JSON.stringify(toGeneric(skeleton), null, 2) }], check }
  }
  if (format === 'spine') {
    return { ok: true, format, files: [{ name: `${name}.spine.json`, content: JSON.stringify(toSpine(skeleton), null, 2) }], check }
  }
  if (format === 'dragonbones') {
    return { ok: true, format, files: [{ name: `${name}.dragonbones.json`, content: JSON.stringify(toDragonBones(skeleton), null, 2) }], check }
  }
  return {
    ok: false,
    error: `不认识的格式「${format}」。可用：generic（通用 JSON）/ spine / dragonbones。`
      + ' Godot / Unity 请用 generic 那套（它们的原生格式差异大，直出容易错，不如给一份能跑的运行时脚本）。',
  }
}

/* ============================================================================
 * 九、预览器：自包含 HTML（拖关节 + 转关节验证拼合）
 * ========================================================================== */

/**
 * 生成一个**单文件**预览器。
 * 为什么做成单文件：不需要起服务器、不需要装依赖，双击就能看，
 * 而且能把图集（data URL）和骨架（内联 JSON）一起带走 —— 发给别人也能开。
 */
export function buildPreviewHtml({ skeleton, atlasPng, title = '部件拼合预览' } = {}) {
  if (!skeleton) return null
  const dataUrl = atlasPng ? `data:image/png;base64,${atlasPng.toString('base64')}` : ''
  const payload = JSON.stringify({ skeleton, atlas: dataUrl }).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#0f1216;--panel:#161b22;--line:#2a3442;--fg:#e6edf3;--muted:#9aa7b4;--accent:#4a9eff;--warn:#ffb020}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;height:100vh}
  aside{width:290px;flex:0 0 290px;border-right:1px solid var(--line);padding:14px;overflow:auto}
  main{flex:1;display:flex;flex-direction:column;min-width:0}
  h1{font-size:15px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:12px;margin-bottom:12px}
  .row{display:flex;gap:8px;align-items:center;margin:6px 0;font-size:12.5px}
  .row label{flex:0 0 74px;color:var(--muted)}
  input[type=range]{flex:1}
  button{background:var(--accent);color:#04121f;border:0;border-radius:7px;padding:7px 11px;font-weight:700;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  .pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;
    background:rgba(74,158,255,.18);color:var(--accent);margin-left:6px}
  .list{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
  .item{padding:5px 7px;border-radius:6px;cursor:pointer;font-size:12.5px;display:flex;justify-content:space-between}
  .item:hover{background:rgba(255,255,255,.05)}
  .item.on{background:rgba(74,158,255,.16);color:var(--accent)}
  .item .z{color:var(--muted);font-size:11px}
  canvas{flex:1;display:block;background:
    linear-gradient(45deg,#1a1f27 25%,transparent 25%,transparent 75%,#1a1f27 75%),
    linear-gradient(45deg,#1a1f27 25%,transparent 25%,transparent 75%,#1a1f27 75%);
    background-size:20px 20px;background-position:0 0,10px 10px;cursor:crosshair}
  .bar{border-top:1px solid var(--line);padding:8px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12.5px}
  .hint{color:var(--muted);font-size:12px}
  textarea{width:100%;height:120px;background:#0b0e12;color:var(--fg);border:1px solid var(--line);
    border-radius:7px;font:11px/1.5 ui-monospace,Consolas,monospace;padding:8px;margin-top:8px}
  .warn{color:var(--warn);font-size:12px;margin-top:8px}
</style>
</head>
<body>
<aside>
  <h1>部件拼合预览 <span class="pill" id="cnt"></span></h1>
  <div class="sub">拖画布上的<b>蓝色小圆</b>可以转关节；点左侧列表选部件，再拖可改它的枢轴。</div>
  <div class="row"><label>根旋转</label><input type="range" id="rootRot" min="-180" max="180" value="0"></div>
  <div class="row"><label>缩放</label><input type="range" id="zoom" min="20" max="300" value="100"></div>
  <div class="row"><button class="ghost" id="reset">全部归零</button><button class="ghost" id="assemble">合拢关节</button></div>
  <div class="row"><label>改名</label><input id="rename" placeholder="选中部件后改名"></div>
  <div class="row"><label>动画</label><select id="animSel"></select></div>
  <div class="row"><label>时间</label><input type="range" id="animTime" min="0" max="1000" value="0"><span id="animLabel" style="font-size:11px;opacity:.6;min-width:46px"></span></div>
  <div class="row"><button class="ghost" id="animPlay">▶ 播放</button><button class="ghost" id="animStop">■ 停止</button></div>
  <div class="list" id="list"></div>
  <div class="warn" id="warn"></div>
  <div style="margin-top:12px"><button id="save">导出骨架 JSON</button></div>
  <textarea id="out" readonly placeholder="点上面按钮导出"></textarea>
</aside>
<main>
  <canvas id="cv"></canvas>
  <div class="bar">
    <span id="status" class="hint">就绪</span>
    <span style="flex:1"></span>
    <span class="hint">滚轮缩放 · 空格复位</span>
  </div>
</main>
<script>
const DATA = ${payload}
const sk = DATA.skeleton
const img = new Image()
let loaded = false
img.onload = () => { loaded = true; draw() }
img.src = DATA.atlas
const cv = document.getElementById('cv')
const ctx = cv.getContext('2d')
const partByName = new Map((sk.parts||[]).map(p => [p.name, p]))
const bones = new Map((sk.bones||[]).map(b => [b.name, b]))
let selected = (sk.drawOrder||[])[0] || ''
let dragging = null      // {name}
let draggingPivot = null // {name}
let zoom = 1
const pose = {}          // name -> {rotation}
document.getElementById('cnt').textContent = (sk.parts||[]).length + ' 件'
document.getElementById('warn').textContent = sk.layout === 'grid'
  ? 'grid 版面的装配位置来自模板粗略偏移，请用「合拢关节」+ 手动微调'
  : 'positional 版面：位置取自图纸几何，通常只需微调 pivot'

function depthOf(name){
  let d = 0, b = bones.get(name), guard = 0
  while (b && b.parent && guard++ < 64) { d++; b = bones.get(b.parent) }
  return d
}
/*
 * ★ 两个顺序不能混：
 *   drawSeq = drawOrder（按 zOrder）—— 决定谁压在谁上面。
 *   treeSeq = 按层级深度 —— 侧栏展示、合拢关节（父先归位）都该用它。
 * 第一版图省事只留了一个 depth 排序的数组，结果绘制顺序被覆盖：
 * 远侧手臂（z1）被画到了躯干（z11）上面 —— 静默错，只在美术细节上看得出。
 */
let drawSeq = [...(sk.drawOrder||[])]
let treeSeq = [...(sk.drawOrder||[])].sort((a,b)=>depthOf(a)-depthOf(b))
function rebuildSeq(){
  drawSeq = [...(sk.drawOrder||[])]
  treeSeq = [...(sk.drawOrder||[])].sort((a,b)=>depthOf(a)-depthOf(b))
}
function world(name){
  const b = bones.get(name)
  if (!b) return {x:0,y:0,rotation:0,sx:1,sy:1}
  const p = b.parent ? world(b.parent) : {x:0,y:0,rotation:0,sx:1,sy:1}
  const rot = b.rotation + ((pose[name]||{}).rotation||0)
  const rad = p.rotation*Math.PI/180
  const lx = b.x*p.sx, ly = b.y*p.sy
  return {
    x: p.x + lx*Math.cos(rad) - ly*Math.sin(rad),
    y: p.y + lx*Math.sin(rad) + ly*Math.cos(rad),
    rotation: p.rotation + rot,
    sx: p.sx*b.scaleX, sy: p.sy*b.scaleY,
  }
}
function toScreen(x,y,cx,cy){
  return { x: cx + x*zoom, y: cy - y*zoom }
}
function draw(){
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth, h = cv.clientHeight
  cv.width = w*dpr; cv.height = h*dpr
  ctx.setTransform(dpr,0,0,dpr,0,0)
  ctx.clearRect(0,0,w,h)
  if (!loaded) { ctx.fillStyle='#9aa7b4'; ctx.font='14px sans-serif'; ctx.fillText('等图集加载…',20,30); return }
  const cx = w/2, cy = h/2
  for (const name of drawSeq) {
    const part = partByName.get(name)
    if (!part) continue
    const p = world(name)
    const [rx,ry,rw,rh] = part.rect
    const [px,py] = part.pivot
    const o = toScreen(p.x, p.y, cx, cy)
    ctx.save()
    ctx.translate(o.x, o.y)
    ctx.rotate(p.rotation*Math.PI/180)
    ctx.scale(p.sx, p.sy)
    ctx.drawImage(img, rx, ry, rw, rh, -px, -py, rw, rh)
    ctx.restore()
    // 枢轴点
    ctx.beginPath()
    ctx.arc(o.x, o.y, name===selected?6:4, 0, Math.PI*2)
    ctx.fillStyle = name===selected ? '#ffb020' : '#4a9eff'
    ctx.fill()
  }
}
function renderList(){
  const el = document.getElementById('list')
  el.innerHTML = ''
  for (const name of treeSeq) {
    const part = partByName.get(name)
    const div = document.createElement('div')
    div.className = 'item' + (name===selected?' on':'')
    div.innerHTML = '<span>'+name+'</span><span class="z">z'+(part?part.zOrder:'')+'</span>'
    div.onclick = () => { selected = name; renderList(); syncRename(); draw() }
    el.appendChild(div)
  }
}
function syncRename(){
  const input = document.getElementById('rename')
  input.value = selected || ''
  input.placeholder = selected ? '当前：'+selected : '选中部件后改名'
}

/**
 * 改名：名字决定**骨骼层级**（parent 是按名字查的），所以改名必须一起改：
 * 部件名、骨骼名、所有子骨骼的 parent、drawOrder。
 * 这是 AI 猜错名字后的唯一修复手段，不能只改显示。
 */
function renamePart(oldName, newName){
  newName = String(newName||'').trim()
  if (!newName || newName === oldName) return false
  if (partByName.has(newName) || bones.has(newName)) {
    document.getElementById('status').textContent = '改名失败：已经有叫「'+newName+'」的部件了'
    return false
  }
  const part = partByName.get(oldName)
  const bone = bones.get(oldName)
  if (part) { part.name = newName; part.slot = newName; partByName.delete(oldName); partByName.set(newName, part) }
  if (bone) {
    bone.name = newName
    bones.delete(oldName); bones.set(newName, bone)
    for (const b of bones.values()) if (b.parent === oldName) b.parent = newName
  }
  const idx = (sk.drawOrder||[]).indexOf(oldName)
  if (idx >= 0) sk.drawOrder[idx] = newName
  // 重排 order（层级可能变了）
  rebuildSeq()
  selected = newName
  renderList(); syncRename(); draw()
  document.getElementById('status').textContent = '已改名：'+oldName+' → '+newName
  return true
}
document.getElementById('rename').addEventListener('change', e => {
  if (renamePart(selected, e.target.value)) e.target.value = selected
})
renderList()
syncRename()

// —— 拖拽：默认转关节；按住 Shift 拖 = 改枢轴 ——
function pick(mx,my){
  const w = cv.clientWidth, h = cv.clientHeight, cx = w/2, cy = h/2
  let best = null, bestD = 18
  for (const name of treeSeq) {
    const p = world(name)
    const o = toScreen(p.x,p.y,cx,cy)
    const d = Math.hypot(o.x-mx, o.y-my)
    if (d < bestD) { bestD = d; best = name }
  }
  return best
}
cv.addEventListener('pointerdown', e => {
  const r = cv.getBoundingClientRect()
  const name = pick(e.clientX-r.left, e.clientY-r.top) || selected
  if (e.shiftKey) draggingPivot = { name }
  else dragging = { name, lastX:e.clientX, lastY:e.clientY }
  selected = name; renderList(); draw()
  cv.setPointerCapture(e.pointerId)
})
cv.addEventListener('pointermove', e => {
  if (dragging) {
    const dx = e.clientX - dragging.lastX
    dragging.lastX = e.clientX; dragging.lastY = e.clientY
    const name = dragging.name
    // 屏幕像素 → 角度：用拖拽方向的水平分量近似（够用且直觉）
    const deg = dx * 0.8
    pose[name] = pose[name] || {}
    pose[name].rotation = ((pose[name].rotation||0) + deg) % 360
    draw()
  } else if (draggingPivot) {
    const part = partByName.get(draggingPivot.name)
    if (part) {
      // 枢轴在图块内相对位移（要考虑当前旋转，这里简化：按未旋转算）
      const r = cv.getBoundingClientRect()
      const o = world(draggingPivot.name)
      const w = cv.clientWidth, h = cv.clientHeight
      const s = toScreen(o.x, o.y, w/2, h/2)
      const ox = (e.clientX-r.left) - s.x
      const oy = (e.clientY-r.top) - s.y
      part.pivot = [
        Math.max(0, Math.min(part.rect[2], part.pivot[0] + ox/zoom)),
        Math.max(0, Math.min(part.rect[3], part.pivot[1] + oy/zoom)),
      ]
      draw()
    }
  }
})
cv.addEventListener('pointerup', () => { dragging = null; draggingPivot = null })
cv.addEventListener('wheel', e => {
  e.preventDefault()
  zoom = Math.max(0.2, Math.min(3, zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
  document.getElementById('zoom').value = zoom*100
  draw()
}, { passive:false })
document.getElementById('zoom').oninput = e => { zoom = e.target.value/100; draw() }
document.getElementById('rootRot').oninput = e => {
  const root = (sk.bones||[]).find(b => !b.parent)
  if (root) { pose[root.name] = pose[root.name]||{}; pose[root.name].rotation = Number(e.target.value) }
  draw()
}
document.getElementById('reset').onclick = () => {
  for (const k of Object.keys(pose)) delete pose[k]
  document.getElementById('rootRot').value = 0
  draw()
}
/**
 * 「合拢关节」：对每个子部件，沿"它的枢轴 → 父件最近不透明点"的方向挪一点点。
 * 为什么限幅：整张爆炸图大致位置已经对了，这里只收缝；不限幅会把手掌吸到躯干上。
 */
document.getElementById('assemble').onclick = () => {
  const limit = (sk.meta && sk.meta.charHeight ? sk.meta.charHeight : 256) * 0.06
  const byName = bones
  const wcache = new Map()
  const W = name => { if (wcache.has(name)) return wcache.get(name); const v = world(name); wcache.set(name, v); return v }
  let moved = 0
  for (const name of treeSeq) {
    const b = byName.get(name); if (!b || !b.parent) continue
    const part = partByName.get(name), pp = partByName.get(b.parent)
    if (!part || !pp) continue
    const w = W(name), pw = W(b.parent)
    const target = { x: w.x, y: w.y }
    // 父件不透明区域（在图集坐标里采样，转成世界坐标）
    const [rx,ry,rw,rh] = pp.rect
    const step = Math.max(1, Math.floor(Math.max(rw,rh)/48))
    let best = null, bd = Infinity
    for (let y=0;y<rh;y+=step) for (let x=0;x<rw;x+=step) {
      if (!isOpaque(rx+x, ry+y)) continue
      const wx = pw.x - pp.pivot[0] + x
      const wy = pw.y + pp.pivot[1] - y
      const d = Math.hypot(wx-target.x, wy-target.y)
      if (d < bd) { bd = d; best = {x:wx,y:wy} }
    }
    if (!best || bd < 2 || bd > limit) continue
    const k = Math.min(1, limit/bd)
    b.x += (best.x - target.x) * k
    b.y += (best.y - target.y) * k
    wcache.clear(); moved++
  }
  document.getElementById('status').textContent = moved ? ('合拢了 '+moved+' 个关节') : '已经是合拢的（或缝隙超出限幅）'
  draw()
}
// 用离屏 canvas 查图集不透明度（避免每次 getImageData）
let alphaCache = null
function isOpaque(x,y){
  if (!alphaCache) {
    const c = document.createElement('canvas')
    c.width = img.naturalWidth; c.height = img.naturalHeight
    const g = c.getContext('2d')
    g.drawImage(img,0,0)
    alphaCache = g.getImageData(0,0,c.width,c.height).data
  }
  const i = (Math.floor(y)*img.naturalWidth + Math.floor(x))*4 + 3
  return alphaCache[i] > 32
}
document.getElementById('save').onclick = () => {
  const out = JSON.parse(JSON.stringify(sk))
  // 把拖过的枢轴和关节点写回去
  for (const part of out.parts||[]) {
    const live = partByName.get(part.name)
    if (live) part.pivot = live.pivot.map(v => Math.round(v*100)/100)
  }
  for (const b of out.bones||[]) {
    const live = bones.get(b.name)
    if (live) { b.x = Math.round(live.x*100)/100; b.y = Math.round(live.y*100)/100 }
  }
  out.pose = pose
  const text = JSON.stringify(out, null, 2)
  const ta = document.getElementById('out')
  ta.value = text
  ta.select()
  navigator.clipboard && navigator.clipboard.writeText(text).catch(()=>{})
  // 同时下载一份
  const blob = new Blob([text], {type:'application/json'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = (out.name||'character')+'.skeleton.json'
  a.click()
  document.getElementById('status').textContent = '已导出（并复制到剪贴板）'
}
window.addEventListener('resize', draw)
window.addEventListener('keydown', e => { if (e.code==='Space') { e.preventDefault(); document.getElementById('reset').click() } })
draw()

/* ============================================================================
 * 时间轴动画
 * ----------------------------------------------------------------------------
 * 这里内联一份采样器（不能 import，预览器必须单文件自包含）。
 * 数学要和 lib/motion.js 的 sampleChannel 完全一致 —— 否则预览里看到的动作
 * 和引擎里跑出来的不是同一个，那预览就失去意义了（所以两边都是 smoothstep 插值）。
 * ========================================================================== */
const animations = sk.animations || {}
const animNames = Object.keys(animations)
let playing = false
let playT = 0
let lastFrame = 0
const sel = document.getElementById('animSel')
const timeBar = document.getElementById('animTime')
const timeLabel = document.getElementById('animLabel')
for (const name of animNames) {
  const opt = document.createElement('option')
  opt.value = name
  const a = animations[name]
  opt.textContent = (a.label || name) + ' · ' + (a.duration||0).toFixed(2) + 's' + (a.loop ? ' ↻' : '')
  sel.appendChild(opt)
}
if (animNames.length > 0) sel.value = animNames[0]
document.getElementById('animPlay').disabled = animNames.length === 0
document.getElementById('animStop').disabled = animNames.length === 0
if (animNames.length === 0) { timeLabel.textContent = '无动画'; timeBar.disabled = true }

function sampleChannel(keys, t) {
  if (!keys || keys.length === 0) return 0
  const time = Math.max(0, Math.min(1, t))
  if (time <= keys[0][0]) return keys[0][1]
  if (time >= keys[keys.length-1][0]) return keys[keys.length-1][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]
    if (time <= t1) {
      const [t0, v0] = keys[i-1]
      const span = t1 - t0
      const k = span <= 1e-9 ? 1 : (time - t0) / span
      const eased = k*k*(3-2*k)
      return v0 + (v1-v0)*eased
    }
  }
  return keys[keys.length-1][1]
}
/** 当前播放位置对应的 pose（叠加在手动 pose 之上：动画优先） */
function currentAnimPose() {
  const name = sel.value
  const anim = animations[name]
  if (!anim || !anim.channels) return null
  const duration = Math.max(0.001, Number(anim.duration)||1)
  let t = playT / duration
  if (anim.loop) { t = t % 1; if (t < 0) t += 1 } else { t = Math.max(0, Math.min(1, t)) }
  const out = {}
  for (const boneName of Object.keys(anim.channels)) {
    const entry = {}
    for (const prop of Object.keys(anim.channels[boneName])) {
      entry[prop] = sampleChannel(anim.channels[boneName][prop], t)
    }
    out[boneName] = entry
  }
  return out
}
let animPose = null
const baseWorld = world
// 覆盖 world()：动画采样值叠加到骨骼基准变换上
world = function(name) {
  const base = baseWorld(name)
  if (!animPose || !animPose[name]) return base
  const add = animPose[name]
  return { ...base, rotation: base.rotation + (add.rotation||0), x: base.x + (add.x||0), y: base.y + (add.y||0) }
}
function tick(now) {
  if (!playing) return
  const dt = lastFrame ? (now - lastFrame)/1000 : 0
  lastFrame = now
  const anim = animations[sel.value]
  if (!anim) { playing = false; return }
  playT += dt
  const duration = Math.max(0.001, Number(anim.duration)||1)
  if (!anim.loop && playT >= duration) { playT = duration; playing = false; document.getElementById('animPlay').textContent = '▶ 播放' }
  if (anim.loop) playT = playT % duration
  timeBar.value = Math.round((playT/duration)*1000)
  timeLabel.textContent = playT.toFixed(2)+'s'
  animPose = currentAnimPose()
  draw()
  if (playing) requestAnimationFrame(tick)
}
document.getElementById('animPlay').onclick = () => {
  if (animNames.length === 0) return
  playing = !playing
  document.getElementById('animPlay').textContent = playing ? '❚❚ 暂停' : '▶ 播放'
  if (playing) { lastFrame = 0; requestAnimationFrame(tick) }
}
document.getElementById('animStop').onclick = () => {
  playing = false
  document.getElementById('animPlay').textContent = '▶ 播放'
  playT = 0; animPose = null
  timeBar.value = 0; timeLabel.textContent = '0.00s'
  draw()
}
timeBar.oninput = e => {
  const anim = animations[sel.value]
  if (!anim) return
  playing = false
  document.getElementById('animPlay').textContent = '▶ 播放'
  const duration = Math.max(0.001, Number(anim.duration)||1)
  playT = (Number(e.target.value)/1000) * duration
  timeLabel.textContent = playT.toFixed(2)+'s'
  animPose = currentAnimPose()
  draw()
}
sel.onchange = () => { playing = false; playT = 0; animPose = null; timeBar.value = 0; timeLabel.textContent = '0.00s'; draw() }
</script>
</body>
</html>`
}
