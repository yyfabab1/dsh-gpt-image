/** 校准「抗锯齿混合色」判据：在几种典型输入上量一下命中率，别靠猜。 */
import { rgbToOklab, nearestUpscale } from '../lib/pixelize.js'

function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 }
}

/** 随机噪点（不是像素画）。 */
function noise(w, h) {
  const px = new Uint8ClampedArray(w * h * 4)
  const r = rng(7)
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = Math.floor(r() * 256); px[i * 4 + 1] = Math.floor(r() * 256); px[i * 4 + 2] = Math.floor(r() * 256); px[i * 4 + 3] = 255
  }
  return { pixels: px, width: w, height: h }
}

/** 有限色板（12 色）的像素画，硬边。 */
function paletteArt(w, h, seed = 3) {
  const px = new Uint8ClampedArray(w * h * 4)
  const r = rng(seed)
  const palette = []
  for (let i = 0; i < 12; i++) palette.push([Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)])
  for (let i = 0; i < w * h; i++) {
    const c = palette[Math.floor(r() * palette.length)]
    px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255
  }
  return { pixels: px, width: w, height: h }
}

function countBlend(pixels, width, height, tolerance, minEnd) {
  const okAt = (x, y) => { const i = (y * width + x) * 4; return rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]) }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const between = (p, a, b) => {
    const dAB = dist(a, b)
    if (dAB < 1e-4) return false
    const dPA = dist(p, a); const dPB = dist(p, b)
    if (dPA < 1e-4 || dPB < 1e-4) return false
    if (Math.min(dPA, dPB) < minEnd * dAB) return false
    return Math.abs(dPA + dPB - dAB) / dAB < tolerance
  }
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const p = rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2])
      if (x > 0 && x < width - 1 && between(p, okAt(x - 1, y), okAt(x + 1, y))) { n += 1; continue }
      if (y > 0 && y < height - 1 && between(p, okAt(x, y - 1), okAt(x, y + 1))) n += 1
    }
  }
  return n / (width * height)
}

/** 用盒式缩放做出「非整数倍 + 插值混合」的脏图（典型抗锯齿）。 */
function fractionalResample(art, tw, th) {
  const px = new Uint8ClampedArray(tw * th * 4)
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * art.width) / tw); const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * art.width) / tw))
      const y0 = Math.floor((y * art.height) / th); const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * art.height) / th))
      const acc = [0, 0, 0]; let n = 0
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * art.width + sx) * 4
        acc[0] += art.pixels[i]; acc[1] += art.pixels[i + 1]; acc[2] += art.pixels[i + 2]; n += 1
      }
      const o = (y * tw + x) * 4
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(acc[c] / Math.max(1, n))
      px[o + 3] = 255
    }
  }
  return { pixels: px, width: tw, height: th }
}

/** 在块边界做 1px 线性混合（理想抗锯齿）。 */
function withAA(art, k) {
  const px = new Uint8ClampedArray(art.pixels)
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      if (x % k !== 0 && y % k !== 0) continue
      const i = (y * art.width + x) * 4
      const l = x > 0 ? (y * art.width + x - 1) * 4 : i
      const r = x < art.width - 1 ? (y * art.width + x + 1) * 4 : i
      for (let c = 0; c < 3; c++) px[i + c] = Math.round((art.pixels[l + c] + art.pixels[r + c]) / 2)
    }
  }
  return { pixels: px, width: art.width, height: art.height }
}

const cases = {
  '噪点(非像素画)': noise(64, 64),
  '12色像素画·原生': paletteArt(64, 64),
  '12色像素画·4×最近邻': nearestUpscale(paletteArt(16, 16).pixels, 16, 16, 64, 64),
  '12色像素画·4×+1pxAA': withAA(nearestUpscale(paletteArt(16, 16).pixels, 16, 16, 64, 64), 4),
  '12色像素画·2.13×盒式': fractionalResample(paletteArt(30, 30), 64, 64),
}

console.log('tol/minEnd    ' + Object.keys(cases).map((k) => k.padStart(20)).join(''))
for (const tolerance of [0.02, 0.05, 0.1, 0.15]) {
  for (const minEnd of [0, 0.2, 0.3]) {
    const row = Object.values(cases).map((c) => (countBlend(c.pixels, c.width, c.height, tolerance, minEnd) * 100).toFixed(2).padStart(19) + '%')
    console.log(`${tolerance} / ${minEnd}    `.padEnd(14) + row.join(''))
  }
}
