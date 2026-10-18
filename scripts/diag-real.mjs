/** 真实 AI 图上的网格诊断：候选周期的 F1、自相关、块尺寸，以及按给定逻辑分辨率的效果。 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { computeEdgeMap, detectGrid, pixelize, toGray } from '../lib/pixelize.js'
import { decodePngRgba } from '../lib/pngcodec.js'

const file = process.argv[2]
const buffer = await readFile(file)
const decoded = decodePngRgba(buffer)
if (!decoded) { console.error('解不开'); process.exit(1) }
const { pixels, width, height } = decoded
console.log(`${path.basename(file)}  ${width}×${height}`)

const gray = toGray(pixels, width, height)
const edge = computeEdgeMap(gray, width, height)

function project(axis) {
  if (axis === 'x') {
    const prof = new Float64Array(width)
    for (let x = 0; x < width; x++) { let s = 0; for (let y = 0; y < height; y++) s += edge[y * width + x]; prof[x] = s / height }
    return prof
  }
  const prof = new Float64Array(height)
  for (let y = 0; y < height; y++) { let s = 0; for (let x = 0; x < width; x++) s += edge[y * width + x]; prof[y] = s / width }
  return prof
}
const profX = project('x')
const profY = project('y')

function findPeaks(profile, peakRatio) {
  let m = 0
  for (const v of profile) m += v
  m /= profile.length
  const peaks = []
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i] >= profile[i - 1] && profile[i] >= profile[i + 1] && profile[i] > m * peakRatio) peaks.push(i)
  }
  return { peaks, mean: m }
}
function acf(profile, lag) {
  let m = 0
  for (const v of profile) m += v
  m /= profile.length
  let num = 0; let a = 0; let b = 0
  for (let i = 0; i + lag < profile.length; i++) {
    const x = profile[i] - m; const y = profile[i + lag] - m
    num += x * y; a += x * x; b += y * y
  }
  return a > 0 && b > 0 ? num / Math.sqrt(a * b) : 0
}
function f1For(profile, peaks, period, tol) {
  let best = null
  for (let phase = 0; phase < period; phase++) {
    const lines = []
    for (let k = 0; ; k++) { const at = Math.round(phase + k * period); if (at >= profile.length) break; lines.push(at) }
    if (lines.length < 2) continue
    let lh = 0
    for (const line of lines) if (peaks.some((p) => Math.abs(p - line) <= tol)) lh += 1
    let ph = 0
    for (const p of peaks) if (lines.some((line) => Math.abs(p - line) <= tol)) ph += 1
    const precision = lh / lines.length
    const recall = peaks.length ? ph / peaks.length : 0
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    if (!best || f1 > best.f1) best = { f1, phase, precision, recall, teeth: lines.length }
  }
  return best
}

for (const [axis, prof] of [['x(竖线)', profX], ['y(横线)', profY]]) {
  for (const ratio of [1.25, 1.1]) {
    const { peaks, mean } = findPeaks(prof, ratio)
    const rows = []
    for (let period = 3; period <= 64; period++) {
      const r = f1For(prof, peaks, period, 1)
      if (r) rows.push({ period, ...r, acf: acf(prof, period) })
    }
    rows.sort((a, b) => b.f1 - a.f1)
    console.log(`\n=== ${axis}  peakRatio=${ratio}  峰值 ${peaks.length} 个  轮廓均值 ${mean.toFixed(4)} ===`)
    console.log('period   F1     phase  prec  recall  teeth   ACF(局部极大/正峰?)')
    for (const r of rows.slice(0, 6)) {
      const a = r.acf
      const prev = acf(prof, r.period - 1); const next = acf(prof, r.period + 1)
      const isPeak = a >= prev && a >= next && a > 0.1
      console.log(`${String(r.period).padStart(6)}  ${r.f1.toFixed(3)}  ${String(r.phase).padStart(5)}  ${r.precision.toFixed(2)}  ${r.recall.toFixed(2)}    ${String(r.teeth).padStart(3)}     ${a.toFixed(3)}  ${isPeak ? '← 是' : ''}`)
    }
  }
}

const grid = detectGrid(pixels, width, height, { minPeriod: 3, maxPeriod: 64 })
console.log('\ndetectGrid（自动）→', grid.ok ? `ok px=${grid.px} py=${grid.py} → ${grid.wLogic}×${grid.hLogic}` : `拒绝：${grid.reason}`)

// 强指定几个「常见放大倍数」的逻辑分辨率，看结果合不合理
console.log('\n若显式指定逻辑分辨率：')
for (const logical of [16, 24, 32, 48, 64, 96, 128]) {
  if (width % logical !== 0) continue
  const r = pixelize({ pixels, width, height, options: { logicalWidth: logical, logicalHeight: Math.round(height / (width / logical)), palette: 16 } })
  if (!r.ok) { console.log(`  ${logical}: 失败 ${r.reason}`); continue }
  console.log(`  ${logical} → 块 ${r.stats.block.px}px，输出 ${r.width}×${r.height}，${r.stats.colors} 色，F1 ${(r.grid.confidence ?? 0).toFixed(2)}`)
}
