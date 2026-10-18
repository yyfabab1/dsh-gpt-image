/**
 * 真机验收：合集图**逐格**像素化。
 *
 * 以前的做法（整图按 48×32 像素化）会把 12 个精灵挤成一片糊；
 * 正确做法是整图一次像素化、逻辑分辨率 = 列数×每格逻辑像素，再逐格切出来。
 *
 * 用法：node scripts/verify-sheet-pixel.mjs <合集图> <列> <行> <每格逻辑宽> [调色板]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { computeSlices } from '../lib/sheet.js'
import { decodePngRgba, encodePngRgba } from '../lib/pngcodec.js'
import { nearestUpscale, pixelPurity } from '../lib/pixelize.js'

const file = process.argv[2]
const columns = Number(process.argv[3] ?? 4)
const rows = Number(process.argv[4] ?? 4)
const perCell = Number(process.argv[5] ?? 32)
const palette = Number(process.argv[6] ?? 16)
if (!file) { console.error('用法：node scripts/verify-sheet-pixel.mjs <合集图> <列> <行> <每格逻辑宽> [调色板]'); process.exit(1) }

const decoded = decodePngRgba(await readFile(file))
if (!decoded) { console.error('解不开'); process.exit(1) }
console.log(`合集图 ${path.basename(file)}  ${decoded.width}×${decoded.height}  →  ${columns}×${rows} 格`)

const started = Date.now()
const sliced = computeSlices({
  decoded,
  items: Array.from({ length: columns * rows }, (_, i) => ({ name: `cell_${String(i + 1).padStart(2, '0')}` })),
  columns, rows, trim: true, clean: true,
  pixel: { width: perCell, palette },
})
console.log(`切图 ok=${sliced.ok}  用时 ${Date.now() - started}ms`)
if (!sliced.ok) { console.error(sliced.error); process.exit(1) }
console.log(`像素化：${sliced.pixel ? `${sliced.pixel.note}\n         每格 ${sliced.pixel.per_cell} 逻辑像素，整图逻辑 ${sliced.pixel.logical.width}×${sliced.pixel.logical.height}` : '（跳过）'}`)
if (sliced.warnings.length) console.log(`提醒：${sliced.warnings.slice(0, 6).join('；')}`)

const outRoot = 'D:\\AHC\\aishengtu图片地址\\_pixelize-check\\sheet'
await mkdir(outRoot, { recursive: true })
let pureCount = 0
for (const slice of sliced.slices) {
  const purity = pixelPurity({ pixels: slice.pixels, width: slice.width, height: slice.height })
  if (purity.pure) pureCount += 1
  const zoom = Math.max(1, Math.min(8, Math.floor(160 / Math.max(slice.width, slice.height)) || 1))
  const up = nearestUpscale(slice.pixels, slice.width, slice.height, slice.width * zoom, slice.height * zoom)
  await writeFile(path.join(outRoot, `${slice.name}.png`), encodePngRgba(up.width, up.height, up.pixels))
  console.log(`  ${slice.name}  ${slice.width}×${slice.height}  ${purity.colors.count} 色  抗锯齿 ${purity.aa.pixels} 方块 ${purity.block.size}  pure=${purity.pure}`)
}
console.log(`\n真像素 ${pureCount}/${sliced.slices.length} 格；预览写到 ${outRoot}（放大便于看）`)
