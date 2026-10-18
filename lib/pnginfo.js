/**
 * 读 PNG 头，拿到真实尺寸 / 是否带透明通道（不用任何图像库）。
 * 用途：把「生成出来的图」和「游戏里要求的规格」直接对上，回答
 * 「我生图的内容到底能不能用在游戏里」。
 */
import { readFile } from 'node:fs/promises'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// PNG colorType: 0=灰度 2=RGB 3=调色板 4=灰度+A 6=RGBA
const HAS_ALPHA = new Set([4, 6])

export function pngInfoFromBuffer(buffer) {
  if (!buffer || buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    return { format: 'unknown' }
  }
  return {
    format: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    hasAlphaChannel: HAS_ALPHA.has(buffer[25]),
  }
}

export async function pngInfo(file) {
  try {
    const buffer = await readFile(file)
    return { ...pngInfoFromBuffer(buffer), bytes: buffer.length }
  } catch (error) {
    return { format: 'unreadable', error: String(error?.message ?? error) }
  }
}

/** "40×60" / "40x60" / "≤110×72" → {width,height,max}；解析不出返回 null。 */
export function parseSizeSpec(text) {
  const match = String(text ?? '').match(/(≤|<=|max)?\s*(\d{1,4})\s*[×xX*]\s*(\d{1,4})/)
  if (!match) return null
  return { width: Number(match[2]), height: Number(match[3]), max: Boolean(match[1]) }
}
