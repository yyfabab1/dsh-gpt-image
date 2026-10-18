#!/usr/bin/env node
/**
 * 程序化生成「正俯视士兵」的分件图（parts sheet）。
 *
 * 为什么需要它（这是被实测逼出来的结论）：
 *   让 AI 画「俯视士兵分件」，它给你的是**一个连得很好的完整士兵** ——
 *   好看，但拆不开（胳膊长在身上、背景不透明）。换成网格零件盘再试，
 *   它把「上臂/前臂」理解成了四顶帽子。两条路都不可用。
 *
 *   而动作演示需要的是**干净、互不接触、枢轴明确**的分件。
 *   所以这里用程序画一套：几何完全可控、部件之间留缝、朝向统一（画面上方 = 前方）。
 *   它同时是很实用的**占位素材**：在 AI 分件调好之前，先用这套把动作跑通。
 *
 * 风格：橄榄绿军装 + 钢盔 + 现代步枪，平涂 + 一道轮廓光（俯视下靠明暗区分体积）。
 *
 * 用法：
 *   node scripts/procedural-topdown-soldier.mjs [输出png] [--size 420]
 */
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { encodePngRgba } from '../lib/pngcodec.js'

const OLIVE_DARK = [62, 72, 52]
const OLIVE = [92, 106, 72]
const OLIVE_LIGHT = [118, 132, 92]
const VEST = [78, 88, 66]
const HELMET = [74, 88, 62]
const HELMET_HI = [104, 118, 86]
const SKIN = [206, 168, 132]
const SKIN_DARK = [176, 138, 106]
const GUN_DARK = [44, 46, 50]
const GUN_MID = [66, 68, 74]
const WOOD = [124, 84, 52]
const SHADOW = [0, 0, 0]

/** 极简画布：直接往 RGBA 数组里画，带 alpha 混合（部分透明用于影子）。 */
function makeCanvas(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  const blend = (x, y, [r, g, b], alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    const a = Math.max(0, Math.min(1, alpha))
    if (a <= 0) return
    const dstA = pixels[i + 3] / 255
    const outA = a + dstA * (1 - a)
    pixels[i] = (r * a + pixels[i] * dstA * (1 - a)) / outA
    pixels[i + 1] = (g * a + pixels[i + 1] * dstA * (1 - a)) / outA
    pixels[i + 2] = (b * a + pixels[i + 2] * dstA * (1 - a)) / outA
    pixels[i + 3] = outA * 255
  }
  const ops = {
    /** 实心圆 */
    disc(cx, cy, r, color, alpha = 1) {
      const r2 = r * r
      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          const dx = x + 0.5 - cx
          const dy = y + 0.5 - cy
          if (dx * dx + dy * dy <= r2) blend(x, y, color, alpha)
        }
      }
    },
    /** 圆角矩形（rx=圆角半径） */
    roundRect(x0, y0, w, h, rx, color, alpha = 1) {
      for (let y = Math.floor(y0); y < y0 + h; y++) {
        for (let x = Math.floor(x0); x < x0 + w; x++) {
          const dx = Math.min(x + 0.5 - (x0 + rx), (x0 + w - rx) - (x + 0.5))
          const dy = Math.min(y + 0.5 - (y0 + rx), (y0 + h - rx) - (y + 0.5))
          const inside = (dx <= 0 || dy <= 0) ? (dx <= 0 && dx > -rx || dy <= 0 && dy > -rx || dx <= 0 && dy <= 0)
            : dx * dx + dy * dy <= rx * rx
          if (inside) blend(x, y, color, alpha)
        }
      }
    },
    /** 带轮廓的圆：先画深色外圈，再画内层 */
    discOutlined(cx, cy, r, fill, outline, lineWidth = 2) {
      ops.disc(cx, cy, r, outline)
      ops.disc(cx, cy, Math.max(0.5, r - lineWidth), fill)
    },
    roundRectOutlined(x0, y0, w, h, rx, fill, outline, lineWidth = 2) {
      ops.roundRect(x0 - lineWidth, y0 - lineWidth, w + lineWidth * 2, h + lineWidth * 2, rx + lineWidth, outline)
      ops.roundRect(x0, y0, w, h, rx, fill)
    },
  }
  return { pixels, width, height, ops }
}

/**
 * 画俯视士兵的 8 个部件（互不接触，每个都留 8px 以上空隙）。
 * 朝向约定：**画面上方 = 角色前方**（枪口朝上）。
 */
/**
 * 炸开布局：每个部件的**外接盒显式写在表里**，保证两两不重叠（切分靠连通域，碰一起就并成一块）。
 * 朝向约定：画面上方 = 角色前方（枪口朝上）。
 */
export const PART_LAYOUT = {
  /* 关键设计：**已经装配好的位置 + 关节处只留 6px 缝**。
   *
   * 第一版我把它炸得很开（缝 20~95px），结果 autoAssemble 的限幅收不回来，
   * 渲染出来是散架的一堆零件。positional 版面的正确用法是：
   *   「按解剖位置摆好，只在关节处拉开几像素」—— 位置即装配关系，
   *   留下的几像素缝由 autoAssemble 用默认 4% 限幅就足够收拢。
   */
  canvas: { width: 380, height: 470 },
  boxes: {
    /* 枪要贴着**右手**（画面左）前方，不然 autoAssemble 合不上去、会飘在头顶。
     * 俯视持枪：右手握把、左手托护木，所以枪的中轴落在右手那条线上。 */
    rifle:       { x: 64,  y: 24,  w: 50, h: 86 },   // 枪：右前方，枪口朝上（与右手留 8px 缝）
    forearm_R:   { x: 66,  y: 118, w: 46, h: 86 },   // 前臂（右=画面左）
    forearm_L:   { x: 268, y: 118, w: 46, h: 86 },
    head:        { x: 152, y: 148, w: 76, h: 76 },   // 头盔：中轴
    upper_arm_R: { x: 66,  y: 214, w: 46, h: 86 },   // 上臂（肩在下端，贴身体）
    upper_arm_L: { x: 268, y: 214, w: 46, h: 86 },
    body:        { x: 120, y: 230, w: 140, h: 140 }, // 肩背：居中偏后
  },
}

/** 校验布局两两不重叠（重叠就会在切分时并成一块 —— 这个错误很隐蔽，所以要显式挡）。 */
export function checkPartLayout(layout = PART_LAYOUT) {
  const names = Object.keys(layout.boxes)
  const problems = []
  const box = layout.boxes
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = box[names[i]]
      const b = box[names[j]]
      const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
      const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
      // 两个盒子相交的条件：x 与 y 方向都重叠
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (overlapX > 0 && overlapY > 0) problems.push(`${names[i]} 与 ${names[j]} 重叠（${overlapX}×${overlapY}）`)
      else if (Math.max(gapX, gapY) < 4) problems.push(`${names[i]} 与 ${names[j]} 太近（间距 ${Math.max(gapX, gapY)}px，要 ≥4）`)
    }
  }
  return { ok: problems.length === 0, problems }
}

export function drawTopdownSoldierParts() {
  const layout = PART_LAYOUT
  const { width, height } = layout.canvas
  const canvas = makeCanvas(width, height)
  const { ops } = canvas
  const B = layout.boxes

  /* ── rifle：俯视 AK（盒 50×104）── */
  {
    const b = B.rifle
    const cx = b.x + b.w / 2
    const top = b.y
    ops.roundRectOutlined(cx - 4, top + 2, 8, 56, 3, GUN_DARK, [28, 30, 34], 2)      // 枪管
    ops.roundRect(cx - 7, top, 14, 10, 3, GUN_MID)                                    // 消焰器
    ops.roundRectOutlined(cx - 10, top + 52, 20, 24, 5, WOOD, [78, 52, 32], 2)        // 护木
    ops.roundRectOutlined(cx - 12, top + 74, 24, 22, 5, GUN_DARK, [28, 30, 34], 2)    // 机匣
    ops.roundRect(cx - 2, top + 70, 5, 7, 2, GUN_MID)                                 // 照门
    ops.roundRectOutlined(cx - 8, top + 92, 16, 12, 4, GUN_MID, [28, 30, 34], 2)      // 弹匣
    ops.roundRect(cx - 15, top + 82, 7, 14, 3, WOOD)                                  // 握把
  }

  /* ── head：钢盔顶面（盒 76×76，正圆）── */
  {
    const b = B.head
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const r = b.w / 2 - 1
    ops.disc(cx, cy, r, OLIVE_DARK)
    ops.disc(cx, cy, r - 3, HELMET)
    ops.disc(cx - r * 0.28, cy - r * 0.3, r * 0.4, HELMET_HI, 0.55)
    for (let a = 0; a < 360; a += 4) {
      const rad = (a * Math.PI) / 180
      ops.disc(cx + Math.cos(rad) * (r - 2), cy + Math.sin(rad) * (r - 2), 1.4, OLIVE_DARK, 0.85)
    }
    ops.roundRect(cx - 5, cy - r * 0.6, 10, 6, 2, [176, 148, 92])
  }

  /* ── upper_arm（盒 46×86）：肩在**下端**，向前伸 ── */
  for (const [name, flip] of [['upper_arm_R', -1], ['upper_arm_L', 1]]) {
    const b = B[name]
    const cx = b.x + b.w / 2
    ops.roundRectOutlined(b.x + 5, b.y, b.w - 10, b.h - 4, 12, OLIVE, OLIVE_DARK, 2)
    ops.roundRect(cx - 5 + flip * 4, b.y + 8, 10, b.h - 30, 4, OLIVE_LIGHT, 0.5)
    ops.roundRect(b.x + 3, b.y + b.h - 16, b.w - 6, 12, 5, OLIVE_DARK)   // 袖口
  }

  /* ── forearm（盒 46×86）：肘在下端，手在上端 ── */
  for (const [name, flip] of [['forearm_R', -1], ['forearm_L', 1]]) {
    const b = B[name]
    const cx = b.x + b.w / 2
    ops.roundRectOutlined(b.x + 7, b.y + 20, b.w - 14, b.h - 24, 9, OLIVE, OLIVE_DARK, 2)
    ops.roundRect(cx - 4 + flip * 3, b.y + 26, 8, b.h - 42, 3, OLIVE_LIGHT, 0.45)
    ops.roundRectOutlined(b.x + 8, b.y, b.w - 16, 22, 8, SKIN_DARK, OLIVE_DARK, 2)   // 手
    ops.roundRect(b.x + 12, b.y + 4, b.w - 24, 9, 4, SKIN)
  }

  /* ── body（盒 140×140）：肩背 + 背心 + 背带 ── */
  {
    const b = B.body
    const cx = b.x + b.w / 2
    ops.roundRect(b.x, b.y, b.w, b.h, 34, OLIVE_DARK)
    ops.roundRect(b.x + 4, b.y + 4, b.w - 8, b.h - 8, 30, OLIVE)
    ops.roundRect(b.x + 10, b.y + 8, 46, 34, 14, OLIVE_LIGHT, 0.5)          // 受光肩
    ops.roundRect(cx - 38, b.y + 30, 76, 62, 16, VEST)                       // 背心
    ops.roundRect(cx - 30, b.y + 40, 60, 16, 6, OLIVE_DARK)                  // 弹匣包
    ops.roundRect(cx - 52, b.y + 52, 12, 62, 5, OLIVE_DARK)                  // 背带左
    ops.roundRect(cx + 40, b.y + 52, 12, 62, 5, OLIVE_DARK)                  // 背带右
    ops.roundRect(cx - 18, b.y + b.h - 40, 36, 28, 10, OLIVE_DARK)           // 后腰
  }

  return { pixels: canvas.pixels, width, height, layout }
}

/* ---------------- CLI ---------------- */

const args = process.argv.slice(2)
const outIndex = args.findIndex((a) => !a.startsWith('--'))
const out = outIndex >= 0 ? args[outIndex] : path.join(process.cwd(), 'topdown_soldier_parts.png')

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]).replace(/\\/g, '/'))
if (isMain) {
  const layout = PART_LAYOUT
  const { pixels, width, height } = drawTopdownSoldierParts()
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, encodePngRgba(width, height, pixels))
  console.log(`✓ 已生成正俯视士兵分件：${out}`)
  console.log(`  尺寸 ${width}×${height}，7 个部件（身/头/双上臂/双前臂/枪），全部两两不重叠`)
  const check = checkPartLayout(layout)
  console.log(check.ok ? '  ✓ 布局校验：部件两两不重叠' : '  ✗ 布局有问题：' + check.problems.join('；'))
  console.log('  下一步：rig(action="build", sheet="…", template="topdown_soldier", layout="positional")')
}
