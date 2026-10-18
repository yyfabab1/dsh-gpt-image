/**
 * 出图自检（AI 审图的机械部分）：在花钱重画之前，先用确定性规则筛掉明显不能用的图。
 *
 * 为什么：模型自己"看一眼"要花 token 且不稳定；而最常见的废图是有客观特征的 ——
 * 全黑/全白/几乎空白/纯色块/尺寸不对/该透明却不透明。这些先用代码判掉，
 * 既省钱又比"让模型猜"可靠；模型只需要看剩下的少数可疑图。
 */
import { readFile } from 'node:fs/promises'
import { decodeAnySample } from './stylefp.js'

/** 判断一张图"信息量"：颜色数、亮度分布、边缘比例。 */
export function imageQuality(buffer) {
  const decoded = decodeAnySample(buffer, { maxPixels: 8192 })
  if (!decoded) return null
  const { pixels, width, height } = decoded
  if (pixels.length === 0) return null
  const colors = new Set()
  let sum = 0
  let min = 255
  let max = 0
  let transparent = 0
  let edges = 0
  let prev = null
  for (const [r, g, b, a] of pixels) {
    if (a < 24) { transparent += 1; prev = [r, g, b, a]; continue }
    colors.add(`${r >> 3}-${g >> 3}-${b >> 3}`)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    sum += lum
    if (lum < min) min = lum
    if (lum > max) max = lum
    if (prev && prev[3] >= 24) {
      const diff = Math.abs(r - prev[0]) + Math.abs(g - prev[1]) + Math.abs(b - prev[2])
      if (diff > 48) edges += 1
    }
    prev = [r, g, b, a]
  }
  const opaque = pixels.length - transparent
  return {
    width,
    height,
    sampled: pixels.length,
    colorCount: colors.size,
    avgLuminance: opaque ? sum / opaque / 255 : 0,
    contrast: (max - min) / 255,
    edgeRatio: opaque ? edges / opaque : 0,
    transparentRatio: transparent / pixels.length,
  }
}

/**
 * 自检结论。
 * @param {{buffer:Buffer, expect?:{width?:number,height?:number,transparent?:boolean,max?:boolean}}} params
 */
export function reviewImage({ buffer, expect = null }) {
  const quality = imageQuality(buffer)
  if (!quality) return { ok: false, verdict: 'unreadable', problems: ['图片解不开（格式不支持或文件损坏）'], quality: null }
  const problems = []
  const { colorCount, avgLuminance, contrast, edgeRatio, transparentRatio, width, height } = quality

  if (colorCount <= 2) problems.push(`几乎单色（只采到 ${colorCount} 种颜色）—— 基本是废图`)
  if (avgLuminance < 0.04) problems.push(`几乎全黑（平均亮度 ${(avgLuminance * 100).toFixed(1)}%）`)
  if (avgLuminance > 0.97) problems.push(`几乎全白（平均亮度 ${(avgLuminance * 100).toFixed(1)}%）`)
  if (contrast < 0.05 && colorCount <= 8) problems.push(`对比度极低（${(contrast * 100).toFixed(1)}%）且颜色少 —— 看不到内容`)
  if (edgeRatio < 0.005 && colorCount <= 16) problems.push('几乎没有边缘/线条 —— 画面是空的')

  if (expect) {
    if (expect.width && expect.height) {
      const sizeOk = expect.max
        ? width <= expect.width && height <= expect.height
        : width === expect.width && height === expect.height
      if (!sizeOk) problems.push(`尺寸 ${width}×${height} 与要求 ${expect.max ? '≤' : ''}${expect.width}×${expect.height} 不符（install 会按规格缩放）`)
    }
    if (expect.transparent && transparentRatio < 0.02) problems.push('要求透明底，但几乎没有透明像素')
  }

  const blocking = problems.filter((problem) => !/尺寸/.test(problem))
  return {
    ok: blocking.length === 0,
    verdict: blocking.length === 0 ? (problems.length > 0 ? 'needs-fit' : 'good') : 'suspect',
    problems,
    quality,
    advice: blocking.length === 0
      ? (problems.length > 0 ? '内容没问题，安装时按规格缩放即可。' : '可以直接用。')
      : '建议重画这一张：问题出在画面内容本身（空/全黑/全白/不可辨），放大缩小都救不回来。',
  }
}

export async function reviewFile(file, expect = null) {
  try {
    return reviewImage({ buffer: await readFile(file), expect })
  } catch (error) {
    return { ok: false, verdict: 'unreadable', problems: [`读不到文件：${error.message}`], quality: null }
  }
}

/** 批量自检：只返回需要人/模型再看一眼的。 */
export async function reviewBatch(files, { expectations = {} } = {}) {
  const reviewed = []
  for (const file of files) {
    const name = file.split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').replace(/_\d+$/, '')
    const expect = expectations[name]?.size
      ? { width: expectations[name].size.width, height: expectations[name].size.height, max: expectations[name].size.max, transparent: expectations[name].transparent }
      : null
    const result = await reviewFile(file, expect)
    reviewed.push({ file, ...result })
  }
  const suspects = reviewed.filter((item) => item.verdict === 'suspect' || item.verdict === 'unreadable')
  return {
    reviewed: reviewed.length,
    good: reviewed.filter((item) => item.verdict === 'good').length,
    needs_fit: reviewed.filter((item) => item.verdict === 'needs-fit').length,
    suspect: suspects.length,
    suspects: suspects.slice(0, 20),
    good_files: reviewed.filter((item) => item.verdict === 'good').slice(0, 50),
    note: suspects.length > 0
      ? `有 ${suspects.length} 张画面本身有问题（空图/全黑/全白/不可辨）：这些不要装进游戏，直接重画。`
      : '全部通过自检。',
  }
}
