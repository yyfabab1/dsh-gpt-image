/**
 * 拿**真实 AI 生成的图**跑一遍像素化，看检测到的块尺寸/逻辑分辨率合不合理。
 * 这是校准步骤：合成图上的对错是可判定的，但真实图上的阈值只能靠实测调。
 *
 * 用法：
 *   node scripts/try-pixelize.mjs                      # 默认几个像素风产物
 *   node scripts/try-pixelize.mjs <文件或目录> [...]
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pixelizePng } from '../lib/pixelize.js'
import { decodePngRgba } from '../lib/pngcodec.js'

const DEFAULT_INPUTS = [
  'D:\\AHC\\aishengtu图片地址\\ember-pixel\\px_000_1.png',
  'D:\\AHC\\aishengtu图片地址\\ember-pixel\\px_032_1.png',
  'D:\\AHC\\aishengtu图片地址\\ember-pixel\\pxset_w_1.png',
  'D:\\AHC\\aishengtu图片地址\\doomsday-ember\\Retro_16_bit_pixel_art_faction_2026-10-10T10-16-43.png',
]

async function collect(input) {
  const info = await stat(input).catch(() => null)
  if (!info) return []
  if (info.isFile()) return /\.png$/i.test(input) ? [input] : []
  const entries = await readdir(input)
  return entries.filter((name) => /\.png$/i.test(name) && !/_labeled|\.post\.|_slice/.test(name)).map((name) => path.join(input, name))
}

const inputs = []
let logical = 0
let palette = 0
for (const arg of process.argv.slice(2)) {
  const logicalMatch = /^--logical=(\d+)$/.exec(arg)
  if (logicalMatch) { logical = Number(logicalMatch[1]); continue }
  const paletteMatch = /^--palette=(\d+)$/.exec(arg)
  if (paletteMatch) { palette = Number(paletteMatch[1]); continue }
  inputs.push(...await collect(arg))
}
const list = (inputs.length > 0 ? inputs : DEFAULT_INPUTS)
const outRoot = 'D:\\AHC\\aishengtu图片地址\\_pixelize-check'
await mkdir(outRoot, { recursive: true })

console.log(`共 ${list.length} 张${logical ? `，强制逻辑宽度 ${logical}` : ''}\n`)
const rows = []
for (const file of list) {
  const buffer = await readFile(file).catch(() => null)
  if (!buffer) { console.log(`${path.basename(file)}  读不到`); continue }
  const name = path.basename(file, '.png')
  const options = { minPeriod: 3, maxPeriod: 64 }
  if (logical > 0) {
    // 显式逻辑分辨率：只知道宽，高按比例推（取整到偶数，避免半像素）
    const meta = decodePngRgba(buffer)
    options.logicalWidth = logical
    options.logicalHeight = Math.max(1, Math.round((meta.height / meta.width) * logical))
  }
  if (palette > 0) options.palette = palette
  const auto = pixelizePng({ buffer, options })
  const line = []
  if (auto.ok) {
    line.push(`块 ${auto.grid.px}×${auto.grid.py}px → ${auto.width}×${auto.height}`)
    line.push(`${auto.stats.colors} 色`)
    line.push(`${auto.stats.ms}ms`)
    const suffix = `${logical ? `.L${logical}` : '.auto'}${palette ? `.p${palette}` : ''}`
    await writeFile(path.join(outRoot, `${name}${suffix}.png`), auto.buffer)
  } else {
    line.push(`拒绝：${auto.error.slice(0, 80)}`)
  }
  rows.push({ file: path.basename(file), ok: auto.ok })
  console.log(`${auto.ok ? '✓' : '✗'} ${path.basename(file)}  ${line.join('  |  ')}`)
  if (auto.ok) console.log(`    ${auto.stats.note}`)
}

console.log(`\n成功 ${rows.filter((r) => r.ok).length}/${rows.length}，产物写到 ${outRoot}`)
