/**
 * 软件光栅化：把「骨架 + 图集 + 某一时刻的 pose」画成像素，再把多帧拼成一张联系表。
 *
 * 为什么要在 Node 里自己画（而不是只靠浏览器预览器）：
 *   ① 给人看动作最直接的方式是**一张图**（联系表/精灵表），而不是让他去开个 html
 *   ② 游戏要的本来就是**帧图**（spritesheet），这层直接把交付物产出来
 *   ③ 能在测试里断言"这一帧画出来了、不透明像素够多"，比截图比对可靠得多
 *
 * 实现方式：逆变换采样（每个目标像素反算回图集坐标再取色）。
 * 比正向绘制简单、没有缝隙、也不用处理旋转后的包围盒裁剪。
 *
 * 坐标约定跟 rig.js 一致：骨骼 y 向上，屏幕 y 向下 —— 画的时候取负号。
 */
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { worldTransforms, bonesByDepth } from './rig.js'
import { sampleAnimation } from './motion.js'

/** 双线性采样（为了旋转后的边缘不锯齿；像素画请用 nearest）。 */
function sampleBilinear(src, srcW, srcH, x, y, out) {
  if (x < 0 || y < 0 || x >= srcW - 1 || y >= srcH - 1) return false
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const i00 = (y0 * srcW + x0) * 4
  const i10 = (y0 * srcW + x0 + 1) * 4
  const i01 = ((y0 + 1) * srcW + x0) * 4
  const i11 = ((y0 + 1) * srcW + x0 + 1) * 4
  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy
  for (let c = 0; c < 4; c++) {
    out[c] = src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11
  }
  return true
}

function sampleNearest(src, srcW, srcH, x, y, out) {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi < 0 || yi < 0 || xi >= srcW || yi >= srcH) return false
  const i = (yi * srcW + xi) * 4
  out[0] = src[i]; out[1] = src[i + 1]; out[2] = src[i + 2]; out[3] = src[i + 3]
  return true
}

/**
 * 算一组 pose 下所有部件的世界包围盒（用于决定画布大小）。
 * @returns {{minX,minY,maxX,maxY}} 屏幕坐标（y 向下）
 */
export function poseBounds(skeleton, poses) {
  const partByName = new Map((skeleton.parts ?? []).map((p) => [p.name, p]))
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const pose of poses) {
    const world = worldTransforms(skeleton, pose)
    for (const part of skeleton.parts ?? []) {
      const w = world.get(part.name)
      if (!w) continue
      const [rx, ry, rw, rh] = part.rect
      const [px, py] = part.pivot
      // 部件的四个角（屏幕坐标）
      const corners = [[0, 0], [rw, 0], [0, rh], [rw, rh]]
      const rad = (w.rotation * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      for (const [u, v] of corners) {
        // 相对枢轴的偏移（图集单位），先缩放再旋转，再加到世界枢轴
        const ox = (u - px) * w.scaleX
        const oy = (v - py) * w.scaleY
        const sx = w.x + ox * cos - oy * sin
        const sy = -w.y + ox * sin + oy * cos
        if (sx < minX) minX = sx
        if (sx > maxX) maxX = sx
        if (sy < minY) minY = sy
        if (sy > maxY) maxY = sy
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

/**
 * 把某个 pose 画进目标 RGBA 缓冲区。
 * @param {object} params
 * @param {object} params.skeleton
 * @param {{pixels:Uint8ClampedArray,width:number,height:number}} params.atlas 已解码的图集
 * @param {object} params.pose
 * @param {Uint8ClampedArray} params.target 目标像素（会被就地写入）
 * @param {number} params.targetW
 * @param {number} params.targetH
 * @param {number} params.offsetX 世界坐标 → 目标坐标的平移
 * @param {number} params.offsetY
 * @param {number} params.scale 缩放（2 = 放大两倍画，更清楚）
 * @param {boolean} [params.nearest] 用最近邻（像素画用）
 */
export function drawPose({ skeleton, atlas, pose = {}, target, targetW, targetH, offsetX = 0, offsetY = 0, scale = 1, nearest = false }) {
  const world = worldTransforms(skeleton, pose)
  const partByName = new Map((skeleton.parts ?? []).map((p) => [p.name, p]))
  const order = skeleton.drawOrder ?? (skeleton.parts ?? []).map((p) => p.name)
  const sample = nearest ? sampleNearest : sampleBilinear
  const rgba = [0, 0, 0, 0]
  let drawn = 0

  for (const name of order) {
    const part = partByName.get(name)
    const w = world.get(name)
    if (!part || !w) continue
    const [rx, ry, rw, rh] = part.rect
    const [px, py] = part.pivot
    const rad = (w.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    // 世界枢轴在目标画布上的位置
    const cx = (w.x + offsetX) * scale
    const cy = (-w.y + offsetY) * scale
    const halfW = (Math.hypot(rw, rh) * Math.max(Math.abs(w.scaleX), Math.abs(w.scaleY)) * scale) / 2 + 2
    const x0 = Math.max(0, Math.floor(cx - halfW))
    const x1 = Math.min(targetW - 1, Math.ceil(cx + halfW))
    const y0 = Math.max(0, Math.floor(cy - halfW))
    const y1 = Math.min(targetH - 1, Math.ceil(cy + halfW))

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // 目标像素 → 相对枢轴 → 反向旋转 → 图集局部坐标
        const dx = (x + 0.5 - cx) / scale
        const dy = (y + 0.5 - cy) / scale
        const ox = (dx * cos + dy * sin) / (w.scaleX || 1)
        const oy = (-dx * sin + dy * cos) / (w.scaleY || 1)
        const u = rx + ox + px
        const v = ry + oy + py
        /* ★ 裁剪必须用**最终采样坐标 (u,v) 对部件自己的矩形**做判断。
         * 两个踩过的错：
         *   ① 只挡"超出图集范围" → 图集里部件挤在一起，会采到**邻居部件的像素**
         *      （症状：同一部件被复制画到别处，每个错像素都来自真实像素，很难看图定位）
         *   ② 用局部偏移 (ox,oy) 和 [0,w] 比 → ox 是"相对枢轴"的，左半是负数，
         *      结果每个部件只画出从枢轴到右下那 1/4（头盔画成四分之一圆就是这么来的）
         */
        if (u < rx - 0.5 || v < ry - 0.5 || u > rx + rw + 0.5 || v > ry + rh + 0.5) continue
        if (!sample(atlas.pixels, atlas.width, atlas.height, u, v, rgba)) continue
        const a = rgba[3] / 255
        if (a <= 0.004) continue
        const di = (y * targetW + x) * 4
        const dstA = target[di + 3] / 255
        const outA = a + dstA * (1 - a)
        if (outA <= 0) continue
        target[di] = (rgba[0] * a + target[di] * dstA * (1 - a)) / outA
        target[di + 1] = (rgba[1] * a + target[di + 1] * dstA * (1 - a)) / outA
        target[di + 2] = (rgba[2] * a + target[di + 2] * dstA * (1 - a)) / outA
        target[di + 3] = outA * 255
        drawn += 1
      }
    }
  }
  return { drawn }
}

/**
 * 渲染一帧。
 * @returns {{buffer:Buffer, width:number, height:number, drawn:number}}
 */
export function renderFrame({ skeleton, atlasPng, pose = {}, scale = 2, padding = 4, nearest = false, size = null }) {
  const atlas = decodePngRgba(atlasPng)
  if (!atlas) return { ok: false, error: '图集解不开' }
  const bounds = size ?? (() => {
    const b = poseBounds(skeleton, [pose])
    return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }
  })()
  const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + padding * 2) * scale))
  const height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY + padding * 2) * scale))
  const target = new Uint8ClampedArray(width * height * 4)
  const { drawn } = drawPose({
    skeleton, atlas, pose, target, targetW: width, targetH: height,
    offsetX: -bounds.minX + padding, offsetY: -bounds.minY + padding, scale, nearest,
  })
  return { ok: true, buffer: encodePngRgba(width, height, target), width, height, drawn, bounds }
}

/**
 * 渲染一段动画的联系表（多帧排一行/网格），用来"一眼看动作对不对"。
 *
 * @param {object} params
 * @param {object} params.skeleton
 * @param {Buffer} params.atlasPng
 * @param {object} params.animation skeleton.animations 里的一条
 * @param {number} [params.columns] 每行几帧（默认帧数，即一行）
 * @param {number} [params.scale] 放大倍数（默认 2）
 * @param {number[][]} [params.background] 背景色（默认透明）
 * @param {boolean} [params.grid] 画分隔线（方便数帧）
 */
export function renderContactSheet({
  skeleton, atlasPng, animation, frames = 8, columns = null, scale = 2,
  padding = 4, grid = true, nearest = false, times = null,
}) {
  const atlas = decodePngRgba(atlasPng)
  if (!atlas) return { ok: false, error: '图集解不开' }
  if (!animation?.channels) return { ok: false, error: '这个动画没有通道' }

  const duration = Math.max(0.001, Number(animation.duration) || 1)
  const count = Math.max(1, Math.min(32, Number(frames) || 8))
  const sampleTimes = Array.isArray(times) && times.length > 0
    ? times
    : (animation.loop
      // 循环动作**不要取 t=1**：那和 t=0 是同一帧，最后会白多一张重复的
      ? Array.from({ length: count }, (_, i) => (duration * i) / count)
      : Array.from({ length: count }, (_, i) => (duration * i) / Math.max(1, count - 1)))

  const poses = sampleTimes.map((t) => sampleAnimation(animation, t))
  // 所有帧共用同一个包围盒，否则每帧会各自居中、看起来在抖
  const b = poseBounds(skeleton, poses)
  const frameW = Math.max(1, Math.ceil((b.maxX - b.minX + padding * 2) * scale))
  const frameH = Math.max(1, Math.ceil((b.maxY - b.minY + padding * 2) * scale))
  const cols = Math.max(1, Math.min(count, Number(columns) || count))
  const rows = Math.ceil(count / cols)
  const gap = grid ? 1 : 0
  const sheetW = cols * frameW + (cols - 1) * gap
  const sheetH = rows * frameH + (rows - 1) * gap
  const sheet = new Uint8ClampedArray(sheetW * sheetH * 4)

  const framesDrawn = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    // 每帧先画到独立缓冲（这样 alpha 合成只跟这一帧自己算）
    const frame = new Uint8ClampedArray(frameW * frameH * 4)
    const { drawn } = drawPose({
      skeleton, atlas, pose: poses[i], target: frame, targetW: frameW, targetH: frameH,
      offsetX: -b.minX + padding, offsetY: -b.minY + padding, scale, nearest,
    })
    // 贴进联系表
    const ox = col * (frameW + gap)
    const oy = row * (frameH + gap)
    for (let y = 0; y < frameH; y++) {
      for (let x = 0; x < frameW; x++) {
        const si = (y * frameW + x) * 4
        const di = ((oy + y) * sheetW + (ox + x)) * 4
        sheet[di] = frame[si]; sheet[di + 1] = frame[si + 1]
        sheet[di + 2] = frame[si + 2]; sheet[di + 3] = frame[si + 3]
      }
    }
    framesDrawn.push({ index: i, time: Number(sampleTimes[i].toFixed(4)), drawn })
  }

  // 分隔线：让人一眼看出每帧边界
  if (grid) {
    for (let c = 1; c < cols; c++) {
      const x = c * frameW + (c - 1) * gap
      for (let y = 0; y < sheetH; y++) {
        const di = (y * sheetW + x) * 4
        sheet[di] = 60; sheet[di + 1] = 70; sheet[di + 2] = 88; sheet[di + 3] = 255
      }
    }
    for (let r = 1; r < rows; r++) {
      const y = r * frameH + (r - 1) * gap
      for (let x = 0; x < sheetW; x++) {
        const di = (y * sheetW + x) * 4
        sheet[di] = 60; sheet[di + 1] = 70; sheet[di + 2] = 88; sheet[di + 3] = 255
      }
    }
  }

  return {
    ok: true,
    buffer: encodePngRgba(sheetW, sheetH, sheet),
    width: sheetW, height: sheetH,
    frames: framesDrawn,
    frame_size: [frameW, frameH],
    columns: cols, rows,
    animation: { name: animation.id ?? animation.label ?? '', duration, loop: Boolean(animation.loop) },
    note: `联系表 ${sheetW}×${sheetH}，${count} 帧（${cols}×${rows}），每帧 ${frameW}×${frameH}，放大 ${scale}×`,
  }
}

/**
 * 渲染一段动画成**精灵表**（游戏直接用：每帧等大、横向一排）。
 * 跟联系表的差别：不留分隔线、不做居中抖动补偿以外的装饰。
 */
export function renderSpriteSheet({ skeleton, atlasPng, animation, frames = 8, scale = 1, nearest = true }) {
  const sheet = renderContactSheet({ skeleton, atlasPng, animation, frames, columns: frames, scale, grid: false, nearest })
  if (!sheet.ok) return sheet
  return {
    ...sheet,
    kind: 'spritesheet',
    note: `精灵表 ${sheet.width}×${sheet.height}，${frames} 帧横排，每帧 ${sheet.frame_size[0]}×${sheet.frame_size[1]}`,
    usage: '按 frame_size 横向切帧即可；顺序就是动画播放顺序。',
  }
}
