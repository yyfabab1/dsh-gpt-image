/**
 * 缩略图：把原图缩成小图给面板用，并缓存到磁盘。
 *
 * 为什么必须做（这是"素材仓库加载慢/有时不加载"的真凶）：
 *   画廊每个格子都用 `/api/file` 直接发**原图** —— 一张 1024×1024 的 PNG 约 700KB~2MB。
 *   200 个格子就是 **140MB+**，而浏览器对同一域名只有 **6 个并发连接**：
 *   请求排队 → 页面长时间空白 → 部分请求超时 → 表现就是"慢"和"有时候干脆不出来"。
 *
 * 缩到最长边 200px 后，单张约 8~15KB，**小两个数量级**；再配合 immutable 缓存头，
 * 第二次打开几乎是瞬间。
 *
 * 缓存策略：
 *   · 落到 `<dataDir>/thumbs/<key>.png`，key 由「原图路径 + mtime + 目标宽度」算出
 *   · 原图改了 → mtime 变 → key 变 → 自动重建（不会拿到过期缩略图）
 *   · 缩略图本身就是缓存，删了会自动重建，所以可以随时清理
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { decodePngRgba, encodePngRgba } from './pngcodec.js'

/** 缩略图缓存 key：原图路径 + mtime + 宽度。 */
export function thumbKey({ file, mtimeMs, width }) {
  return createHash('sha1')
    .update(`${file}|${Math.round(mtimeMs)}|${width}`)
    .digest('hex')
    .slice(0, 24)
}

/**
 * 缩小 RGBA 图（面积平均，比最近邻更适合"看清是什么素材"）。
 * 像素画想要硬边也可以，但缩略图目的是辨认，平均更稳。
 */
export function downscale(png, maxWidth = 200) {
  const ratio = Math.min(1, maxWidth / Math.max(png.width, png.height))
  const outW = Math.max(1, Math.round(png.width * ratio))
  const outH = Math.max(1, Math.round(png.height * ratio))
  if (outW === png.width && outH === png.height) return png
  const out = new Uint8ClampedArray(outW * outH * 4)
  const xStep = png.width / outW
  const yStep = png.height / outH

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * yStep)
    const y1 = Math.min(png.height, Math.max(y0 + 1, Math.floor((y + 1) * yStep)))
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * xStep)
      const x1 = Math.min(png.width, Math.max(x0 + 1, Math.floor((x + 1) * xStep)))
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * png.width + sx) * 4
          const alpha = png.pixels[i + 3]
          // 加权：透明像素不参与颜色平均，否则边缘会发黑
          r += png.pixels[i] * alpha
          g += png.pixels[i + 1] * alpha
          b += png.pixels[i + 2] * alpha
          a += alpha
          n += 1
        }
      }
      const di = (y * outW + x) * 4
      if (a > 0) {
        out[di] = r / a
        out[di + 1] = g / a
        out[di + 2] = b / a
      }
      out[di + 3] = n > 0 ? a / n : 0
    }
  }
  return { width: outW, height: outH, pixels: out }
}

/**
 * 取缩略图（有缓存就直接读）。
 * @param {{file:string, dataDir:string, maxWidth?:number}} params
 * @returns {Promise<{ok:boolean, buffer?:Buffer, cached?:boolean, width?:number, height?:number, error?:string}>}
 */
export async function getThumbnail({ file, dataDir, maxWidth = 200 }) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return { ok: false, error: '原图不存在' }
  const width = Math.min(512, Math.max(16, Math.round(Number(maxWidth) || 200)))
  const key = thumbKey({ file, mtimeMs: info.mtimeMs, width })
  const dir = path.join(dataDir, 'thumbs')
  const target = path.join(dir, `${key}.png`)

  const hit = await readFile(target).catch(() => null)
  if (hit) return { ok: true, buffer: hit, cached: true }

  const source = await readFile(file).catch(() => null)
  if (!source) return { ok: false, error: '读不到原图' }
  const png = decodePngRgba(source)
  if (!png) return { ok: false, error: '不是 8bit PNG（缩略图只支持 PNG）' }
  const small = downscale(png, width)
  const buffer = encodePngRgba(small.width, small.height, small.pixels)
  await mkdir(dir, { recursive: true }).catch(() => {})
  await writeFile(target, buffer).catch(() => {})
  return { ok: true, buffer, cached: false, width: small.width, height: small.height }
}
