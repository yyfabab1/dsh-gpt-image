/**
 * 对比：朴素缩放 vs 像素化净化（同一目标逻辑分辨率）。
 * 目的是**看得见**的验收 —— 像素画的好坏没法只看数字。
 *
 * 产出三张同尺寸可对比的图（都放大 ×8 便于观看）：
 *   <name>.naive.png     —— 盒式均值缩放（大多数工具的默认做法）
 *   <name>.pixel.png     —— 块核心区采样 + 调色板精炼
 *   <name>.nearest.png   —— 纯最近邻（会丢细节，作为另一个基线）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { nearestUpscale, pixelize } from '../lib/pixelize.js'
import { decodePngRgba, encodePngRgba } from '../lib/pngcodec.js'

const file = process.argv[2]
const crop = (process.argv[3] ?? '0,0,312,208').split(',').map(Number)
const logicalW = Number(process.argv[4] ?? 48)
const palette = Number(process.argv[5] ?? 16)
const zoom = Number(process.argv[6] ?? 8)

const decoded = decodePngRgba(await readFile(file))
if (!decoded) { console.error('解不开'); process.exit(1) }

// 裁出单元格
const [cx, cy, cw, ch] = crop
const cropped = new Uint8ClampedArray(cw * ch * 4)
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const src = ((cy + y) * decoded.width + (cx + x)) * 4
    const dst = (y * cw + x) * 4
    for (let c = 0; c < 4; c++) cropped[dst + c] = decoded.pixels[src + c]
  }
}
const logicalH = Math.max(1, Math.round((ch / cw) * logicalW))

/** 盒式均值缩放（基线）。 */
function boxDownscale(pixels, width, height, tw, th) {
  const out = new Uint8ClampedArray(tw * th * 4)
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * width) / tw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / tw))
      const y0 = Math.floor((y * height) / th)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / th))
      const acc = [0, 0, 0, 0]
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4
          acc[0] += pixels[i]; acc[1] += pixels[i + 1]; acc[2] += pixels[i + 2]; acc[3] += pixels[i + 3]
          n += 1
        }
      }
      const o = (y * tw + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / Math.max(1, n))
    }
  }
  return out
}

function uniqueCount(pixels) {
  const seen = new Set()
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    seen.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2])
  }
  return seen.size
}

const outDir = 'D:\\AHC\\aishengtu图片地址\\_pixelize-check'
await mkdir(outDir, { recursive: true })
const base = path.basename(file, '.png')
const save = async (suffix, pixels, w, h) => {
  const up = nearestUpscale(pixels, w, h, w * zoom, h * zoom)
  await writeFile(path.join(outDir, `${base}.${suffix}.png`), encodePngRgba(up.width, up.height, up.pixels))
  return { colors: uniqueCount(pixels), size: `${w}×${h}` }
}

// 基线 1：盒式均值缩放
const boxed = boxDownscale(cropped, cw, ch, logicalW, logicalH)
const naive = await save('naive', boxed, logicalW, logicalH)

// 基线 2：最近邻直接抽点
const nearestPixels = new Uint8ClampedArray(logicalW * logicalH * 4)
for (let y = 0; y < logicalH; y++) {
  for (let x = 0; x < logicalW; x++) {
    const sx = Math.min(cw - 1, Math.floor((x * cw) / logicalW))
    const sy = Math.min(ch - 1, Math.floor((y * ch) / logicalH))
    const src = (sy * cw + sx) * 4
    const dst = (y * logicalW + x) * 4
    for (let c = 0; c < 4; c++) nearestPixels[dst + c] = cropped[src + c]
  }
}
const near = await save('nearest', nearestPixels, logicalW, logicalH)

// 像素化：显式逻辑分辨率 + 调色板精炼
const result = pixelize({
  pixels: cropped, width: cw, height: ch,
  options: { logicalWidth: logicalW, logicalHeight: logicalH, palette, coreRatio: 0.6, method: 'median' },
})
if (!result.ok) { console.error('像素化失败：', result.reason); process.exit(1) }
const pixel = await save('pixel', result.pixels, result.width, result.height)

console.log(`裁切 ${cx},${cy} ${cw}×${ch} → 逻辑 ${logicalW}×${logicalH}（放大 ×${zoom} 便于观看）`)
console.log(`朴素盒式缩放  ${naive.size}  ${naive.colors} 色`)
console.log(`纯最近邻抽点  ${near.size}  ${near.colors} 色`)
console.log(`像素化净化    ${pixel.size}  ${pixel.colors} 色   ${result.applied.join('；')}`)
