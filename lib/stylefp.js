/**
 * 风格指纹：把项目里现有素材的「画风」量化，生成时按指纹匹配参考图。
 *
 * 比「随便挑 2 张同类图」强在哪：卡牌和 UI 图标同属一个项目，但主色/线条/像素密度差很远，
 * 用错参考图会把新图画串味。这里先给每张图算指纹，再按「与目标素材同类」筛选，
 * 并把量化结果写进提示词（主色、线条、颗粒度），风格一致性明显更好。
 *
 * 零依赖：自己解 PNG（zlib 解压 + 反滤波），只采样不建全图。
 */
import { readFile } from 'node:fs/promises'
import zlib from 'node:zlib'

/** 解 PNG 的 IDAT 并按需反滤波，返回 RGB 采样像素。 */
export function decodeSample(buffer, { maxPixels = 4096, step = 1 } = {}) {
  if (!buffer || buffer.length < 60) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) return null // 隔行扫描不支持
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width <= 0 || height <= 0 || idat.length === 0) return null
  if (bitDepth !== 8) return null // 只处理 8bit（游戏素材基本都是）
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
  if (channels === 0) return null // 调色板太少见，跳过
  let raw
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
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
  // 采样
  const pixels = []
  const total = width * height
  const stridePx = Math.max(1, Math.floor(total / maxPixels))
  for (let index = 0; index < total; index += stridePx) {
    const x = index % width
    const y = (index - x) / width
    const base = y * stride + x * channels
    const r = out[base]
    const g = channels >= 3 ? out[base + 1] : r
    const b = channels >= 3 ? out[base + 2] : r
    const a = channels === 4 ? out[base + 3] : channels === 2 ? out[base + 1] : 255
    pixels.push([r, g, b, a])
  }
  return { width, height, colorType, hasAlpha: channels === 4 || channels === 2, pixels }
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/**
 * 解 JPEG（基线 DCT）并采样像素。
 * 只做「够算风格指纹」的精度：DC 系数 + 直流重建，不追求逐像素还原。
 * 为什么需要：游戏素材库里 JPEG 很常见（参考图、扫描件），不支持就等于整库索引失败。
 */
export function decodeJpegSample(buffer, { maxPixels = 4096 } = {}) {
  if (!buffer || buffer.length < 4) return null
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
  ]
  let offset = 2
  let width = 0
  let height = 0
  const quantTables = {}
  const huffmanTables = {}
  let components = []
  let scanData = null
  const buildHuffman = (counts, symbols) => {
    const codes = []
    let code = 0
    let pos = 0
    for (let length = 1; length <= 16; length++) {
      for (let i = 0; i < counts[length - 1]; i++) {
        codes[symbols[pos]] = { code, length }
        pos += 1
        code += 1
      }
      code <<= 1
    }
    return codes
  }
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9) break // EOI：没有扫描数据
    if (marker === 0xda) {
      // SOS 段：跳过它的头部，后面才是熵编码数据
      if (offset + 2 > buffer.length) return null
      const length = buffer.readUInt16BE(offset)
      scanData = offset + length
      break
    }
    // 段长度字段必须在界内，否则视为损坏（避免 readUInt16BE 越界抛错）
    if (offset + 2 > buffer.length) return null
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) return null
    const segment = offset + 2
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      height = buffer.readUInt16BE(segment + 1)
      width = buffer.readUInt16BE(segment + 3)
      const count = buffer[segment + 5]
      components = []
      for (let index = 0; index < count; index++) {
        const base = segment + 6 + index * 3
        components.push({
          id: buffer[base],
          h: buffer[base + 1] >> 4,
          v: buffer[base + 1] & 0x0f,
          quant: buffer[base + 2],
          dc: 0,
          pred: 0,
        })
      }
      if (marker === 0xc2) return null // 渐进式：复杂度不值得，直接放弃
    } else if (marker === 0xdb) {
      let pos = segment
      while (pos < segment + length - 2) {
        const info = buffer[pos]
        const precision = info >> 4
        const id = info & 0x0f
        pos += 1
        if (precision === 0) {
          const table = new Uint16Array(64)
          for (let index = 0; index < 64; index++) table[index] = buffer[pos + index]
          quantTables[id] = table
          pos += 64
        } else {
          pos += 128
        }
      }
    } else if (marker === 0xc4) {
      let pos = segment
      while (pos < segment + length - 2) {
        const info = buffer[pos]
        const id = info & 0x0f
        const type = info >> 4
        pos += 1
        const counts = []
        let total = 0
        for (let index = 0; index < 16; index++) { counts.push(buffer[pos + index]); total += buffer[pos + index] }
        pos += 16
        const symbols = []
        for (let index = 0; index < total; index++) symbols.push(buffer[pos + index])
        pos += total
        huffmanTables[`${type}-${id}`] = buildHuffman(counts, symbols)
      }
    }
    offset = segment + length - 2
  }
  if (!scanData || width <= 0 || height <= 0 || components.length === 0) return null
  // 熵解码：只取每个块的 DC 系数（足够做「平均色」级别的风格判断）
  let bitBuffer = 0
  let bitCount = 0
  let bytePos = scanData
  const readBit = () => {
    if (bitCount === 0) {
      if (bytePos >= buffer.length) return null
      let byte = buffer[bytePos++]
      if (byte === 0xff && buffer[bytePos] === 0x00) bytePos += 1
      bitBuffer = byte
      bitCount = 8
    }
    bitCount -= 1
    return (bitBuffer >> bitCount) & 1
  }
  const readBits = (count) => {
    let value = 0
    for (let index = 0; index < count; index++) {
      const bit = readBit()
      if (bit === null) return null
      value = (value << 1) | bit
    }
    return value
  }
  const decodeHuffman = (table) => {
    let code = 0
    for (let length = 1; length <= 16; length++) {
      const bit = readBit()
      if (bit === null) return null
      code = (code << 1) | bit
      for (const [symbol, entry] of Object.entries(table)) {
        if (entry && entry.length === length && entry.code === code) return Number(symbol)
      }
    }
    return null
  }
  const extend = (value, bits) => (value < 1 << (bits - 1) ? value - (1 << bits) + 1 : value)
  const mcuWidth = Math.max(...components.map((c) => c.h))
  const mcuHeight = Math.max(...components.map((c) => c.v))
  const blocksX = Math.ceil(width / (8 * mcuWidth))
  const blocksY = Math.ceil(height / (8 * mcuHeight))
  const pixels = []
  const totalMcus = blocksX * blocksY
  const stride = Math.max(1, Math.floor(totalMcus / maxPixels))
  for (let index = 0; index < totalMcus; index++) {
    for (const component of components) {
      for (let blockY = 0; blockY < component.v; blockY++) {
        for (let blockX = 0; blockX < component.h; blockX++) {
          const table = huffmanTables[`0-${component.dc}`] ?? huffmanTables['0-0']
          const symbol = decodeHuffman(table)
          if (symbol === null) return pixels.length > 0 ? { width, height, colorType: 2, hasAlpha: false, pixels } : null
          const bits = readBits(symbol)
          if (bits === null) return { width, height, colorType: 2, hasAlpha: false, pixels }
          component.pred += extend(bits, symbol) || 0
          // DC 系数 × 量化表[0] / 8 就是该 8×8 块的平均值（去掉 128 偏移）
          const quant = quantTables[component.quant] ?? quantTables[0]
          const value = (component.pred * (quant ? quant[0] : 1)) / 8 + 128
          if (index % stride === 0) {
            const clamped = Math.max(0, Math.min(255, value))
            const y = clamped
            pixels.push([y, y, y, 255])
          }
          // 交流系数必须跳过：不跳就等于读错后面的比特流
          for (let k = 1; k < 64; k++) {
            const acTable = huffmanTables[`1-${component.dc}`] ?? huffmanTables['1-0']
            const acSymbol = decodeHuffman(acTable)
            if (acSymbol === null) return { width, height, colorType: 2, hasAlpha: false, pixels }
            const run = acSymbol >> 4
            const size = acSymbol & 0x0f
            if (size === 0) {
              if (run === 15) { k += 15; continue }
              break
            }
            if (readBits(size) === null) return { width, height, colorType: 2, hasAlpha: false, pixels }
            k += run
          }
        }
      }
    }
  }
  return pixels.length > 0 ? { width, height, colorType: 2, hasAlpha: false, pixels } : null
}

/** 自动识别格式后采样。 */
export function decodeAnySample(buffer, options = {}) {
  const png = decodeSample(buffer, options)
  if (png) return png
  return decodeJpegSample(buffer, options)
}

/** 算一张图的风格指纹：
 *   palette      主色（出现最多的颜色，跳过全透明像素）
 *   ink          平均亮度（判断整体明暗）
 *   saturation   平均饱和度（判断鲜艳还是灰调）
 *   edgeDensity  相邻像素差 > 阈值 的比例（线条/细节密度，像素画会偏高）
 *   alphaRatio   透明像素占比（判断是否抠底素材）
 */
export function styleFingerprint(buffer) {
  const decoded = decodeAnySample(buffer)
  if (!decoded) return null
  const { pixels } = decoded
  if (pixels.length === 0) return null
  const buckets = new Map()
  let transparent = 0
  let lumSum = 0
  let satSum = 0
  let edges = 0
  let considered = 0
  let prev = null
  for (const [r, g, b, a] of pixels) {
    if (a < 24) {
      transparent += 1
      prev = [r, g, b, a]
      continue
    }
    considered++
    lumSum += 0.299 * r + 0.587 * g + 0.114 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    satSum += max === 0 ? 0 : (max - min) / max
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
    if (prev && prev[3] >= 24) {
      const diff = Math.abs(r - prev[0]) + Math.abs(g - prev[1]) + Math.abs(b - prev[2])
      if (diff > 60) edges += 1
    }
    prev = [r, g, b, a]
  }
  const palette = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [r, g, b] = key.split('-').map((v) => (Number(v) << 4) + 8)
      return { hex: hex(r, g, b), share: Number((count / Math.max(1, considered)).toFixed(3)) }
    })
  return {
    pixels: considered,
    palette,
    dominant: palette[0]?.hex ?? '#000000',
    ink: considered ? Number((lumSum / considered / 255).toFixed(3)) : 0,
    saturation: considered ? Number((satSum / considered).toFixed(3)) : 0,
    edgeDensity: considered ? Number((edges / considered).toFixed(3)) : 0,
    alphaRatio: Number((transparent / pixels.length).toFixed(3)),
    size: `${decoded.width}×${decoded.height}`,
  }
}

/** 判断像素画（线条密、色板窄）。 */
export function styleLabel(fingerprint) {
  if (!fingerprint) return 'unknown'
  const { edgeDensity, palette, alphaRatio, saturation } = fingerprint
  const colors = palette.length
  if (edgeDensity > 0.25 && colors <= 4) return '像素画/低色板'
  if (edgeDensity > 0.18) return '线条明确（卡通/矢量感）'
  if (saturation < 0.15) return '灰调/写实'
  if (alphaRatio > 0.5) return '抠底图标/贴图'
  return '厚涂/平滑插画'
}

/** 两张图的相似度 0~1（主色 + 明暗 + 饱和 + 线条密度）。 */
export function styleSimilarity(a, b) {
  if (!a || !b) return 0
  const paletteScore = (() => {
    const setB = new Set(b.palette.map((item) => item.hex))
    const hit = a.palette.filter((item) => {
      if (setB.has(item.hex)) return true
      // 允许相近色（每通道差 ≤ 24）
      const [ar, ag, ab] = item.hex.slice(1).match(/../g).map((v) => parseInt(v, 16))
      return b.palette.some((other) => {
        const [br, bg, bb] = other.hex.slice(1).match(/../g).map((v) => parseInt(v, 16))
        return Math.abs(ar - br) <= 24 && Math.abs(ag - bg) <= 24 && Math.abs(ab - bb) <= 24
      })
    }).length
    return hit / Math.max(1, a.palette.length)
  })()
  const inkScore = 1 - Math.min(1, Math.abs(a.ink - b.ink) / 0.5)
  const satScore = 1 - Math.min(1, Math.abs(a.saturation - b.saturation) / 0.5)
  const edgeScore = 1 - Math.min(1, Math.abs(a.edgeDensity - b.edgeDensity) / 0.3)
  return Number((paletteScore * 0.4 + inkScore * 0.2 + satScore * 0.2 + edgeScore * 0.2).toFixed(3))
}

/** 把指纹转成给模型看的风格描述（拼进提示词）。 */
export function fingerprintPrompt(fingerprint) {
  if (!fingerprint) return ''
  const colors = fingerprint.palette.map((item) => item.hex).join(', ')
  return `keep the same art style as the existing game assets: dominant palette ${colors}, `
    + `overall ${fingerprint.ink < 0.4 ? 'dark' : fingerprint.ink > 0.7 ? 'bright' : 'mid-tone'} values, `
    + `saturation ${fingerprint.saturation < 0.3 ? 'muted' : fingerprint.saturation > 0.6 ? 'vivid' : 'moderate'}, `
    + `${fingerprint.edgeDensity > 0.2 ? 'crisp outlines and clear line work' : 'soft edges and smooth shading'}, `
    + `${fingerprint.alphaRatio > 0.4 ? 'transparent background' : 'full-bleed background'}`
}

export async function fingerprintOfFile(file) {
  try {
    return styleFingerprint(await readFile(file))
  } catch {
    return null
  }
}
