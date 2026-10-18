/**
 * 真机验收：拿真实产物跑完整后处理管线，看**最终交付的图是不是真像素**。
 *
 * 这是「争取让以后像素都是真像素」的验收口 —— 不是看它像不像，而是按定义判定：
 *   ① 有限色板（无中间色）② 无抗锯齿混合色 ③ 整数倍均匀方块 ④ alpha 二值
 *
 * 用法：
 *   node scripts/verify-purity.mjs <图> <逻辑宽> <成品宽> <成品高> [调色板]
 *   node scripts/verify-purity.mjs "D:\...\px_000_1.png" 48 96 64 16
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { applySpecFixes } from '../lib/spec.js'
import { pixelPurity, nearestUpscale, uniformBlockSize } from '../lib/pixelize.js'
import { decodePngRgba, encodePngRgba } from '../lib/pngcodec.js'

const [file, logicalW, targetW, targetH, palette] = [
  process.argv[2],
  Number(process.argv[3] ?? 48),
  Number(process.argv[4] ?? 96),
  Number(process.argv[5] ?? 64),
  Number(process.argv[6] ?? 16),
]
if (!file) { console.error('用法：node scripts/verify-purity.mjs <图> <逻辑宽> <成品宽> <成品高> [调色板]'); process.exit(1) }

const buffer = await readFile(file)
const spec = {
  width: targetW, height: targetH, alpha: 'any', trim: false,
  pixel: { width: logicalW, palette, method: 'median' },
}
const fixed = applySpecFixes({ buffer, spec })
if (!fixed.ok) { console.error('失败：', fixed.error); process.exit(1) }

console.log(`输入：${path.basename(file)}`)
console.log(`规格：逻辑宽 ${logicalW} → 成品 ${targetW}×${targetH}，调色板 ${palette}`)
console.log(`\n做了：${fixed.applied.join('\n      ')}`)
if (fixed.skipped?.length) console.log(`跳过：${fixed.skipped.join('\n      ')}`)
console.log(`\n输出尺寸：${fixed.width}×${fixed.height}`)

// 独立复核（不信任管线自己报的结论，重新算一遍）
const decoded = decodePngRgba(fixed.buffer)
const recheck = pixelPurity({
  pixels: decoded.pixels, width: decoded.width, height: decoded.height,
  allowSoftAlpha: false,
})
console.log(`复核方块边长：${uniformBlockSize(decoded.pixels, decoded.width, decoded.height)}`)

const report = fixed.purity ?? recheck
console.log(`\n=== 真像素判定 ===`)
console.log(`pure        : ${report.pure}`)
console.log(`score       : ${report.score}`)
console.log(`色板        : ${report.colors.count} 色（上限 ${report.colors.limit || '不限'}），板外像素 ${report.colors.outside}`)
console.log(`抗锯齿      : ${report.aa.pixels} 个像素（${(report.aa.ratio * 100).toFixed(2)}%）`)
console.log(`方块        : 边长 ${report.block.size}px（期望倍率 ${report.block.scale ?? '-'}）ok=${report.block.ok}`)
console.log(`alpha 二值  : ${report.alpha.ok}（半透明 ${report.alpha.partial}）`)
if (report.reasons.length) console.log(`不合格原因  : ${report.reasons.join('；')}`)
console.log(`结论        : ${report.verdict}`)

const outRoot = 'D:\\AHC\\aishengtu图片地址\\_pixelize-check'
await mkdir(outRoot, { recursive: true })
const base = path.basename(file, '.png')
await writeFile(path.join(outRoot, `${base}.final.png`), fixed.buffer)
// 再出一张放大预览（若本身已经是整数倍就不重复放大）
const zoom = Math.max(1, Math.min(8, Math.floor(512 / Math.max(fixed.width, fixed.height)) || 1))
const preview = nearestUpscale(decoded.pixels, decoded.width, decoded.height, decoded.width * zoom, decoded.height * zoom)
await writeFile(path.join(outRoot, `${base}.final_x${zoom}.png`), encodePngRgba(preview.width, preview.height, preview.pixels))
console.log(`\n产物：${path.join(outRoot, `${base}.final.png`)}`)
console.log(`预览：${path.join(outRoot, `${base}.final_x${zoom}.png`)}（×${zoom}）`)

if (!report.pure) process.exitCode = 2
