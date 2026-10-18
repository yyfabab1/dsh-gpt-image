/**
 * 零依赖 PNG 编解码（8bit、非隔行）—— 切图用。
 * 只做 RGBA 输出，保留透明通道；解码复用 stylefp 的反滤波实现思路但保留完整像素。
 */
import zlib from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 解码成 { width, height, pixels: Buffer(RGBA) } */
export function decodePngRgba(buffer) {
  if (!buffer || buffer.length < 60 || !buffer.subarray(0, 8).equals(SIG)) return null
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (offset + 12 + length > buffer.length) return null
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) return null // 隔行不支持
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!width || !height || idat.length === 0 || bitDepth !== 8) return null
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
  if (channels === 0) return null

  let raw
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const stride = width * channels
  const unfiltered = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = unfiltered.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? unfiltered.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = value & 0xff
    }
  }
  // 统一成 RGBA
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0, count = width * height; i < count; i++) {
    const src = i * channels
    const dst = i * 4
    if (channels === 4) {
      pixels[dst] = unfiltered[src]
      pixels[dst + 1] = unfiltered[src + 1]
      pixels[dst + 2] = unfiltered[src + 2]
      pixels[dst + 3] = unfiltered[src + 3]
    } else if (channels === 3) {
      pixels[dst] = unfiltered[src]
      pixels[dst + 1] = unfiltered[src + 1]
      pixels[dst + 2] = unfiltered[src + 2]
      pixels[dst + 3] = 255
    } else if (channels === 2) {
      pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = unfiltered[src]
      pixels[dst + 3] = unfiltered[src + 1]
    } else {
      pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = unfiltered[src]
      pixels[dst + 3] = 255
    }
  }
  return { width, height, pixels }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 把 RGBA 像素编码成 PNG（带透明通道）。 */
export function encodePngRgba(width, height, pixels) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  // 兼容 Buffer / Uint8Array / Uint8ClampedArray：
  // 解码器给的是 Buffer，而图像处理（降采样、放大）常产出 TypedArray，
  // 以前只认 Buffer，传 TypedArray 会炸 "pixels.copy is not a function"。
  const src = Buffer.isBuffer(pixels) ? pixels : Buffer.from(pixels.buffer ?? pixels, pixels.byteOffset ?? 0, pixels.byteLength)
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0 // filter none
    src.copy(raw, offset, y * stride, (y + 1) * stride)
    offset += stride
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
