/**
 * 出图尺寸守卫：在**发请求之前**按官方约束校验 size，不合法的自动吸附到最近的合法值。
 *
 * 为什么值得单独一个模块：尺寸不合法时，上游要么直接 400（白等一次），
 * 要么**默默给你一张被裁过的图**（更糟 —— 你以为出的是 2048×2048，其实是 1536×1536）。
 * 一次 400 就白花一次钱和时间；在本地挡住是纯赚。
 *
 * 约束来源：OpenAI 官方 gpt-image-2 提示词指南（cookbook）原文：
 *   - 最长边 < 3840
 *   - 两边都必须是 16 的整数倍
 *   - 长短边比例 ≤ 3:1
 *   - 总像素 655,360 ~ 8,294,400
 *   - 超过 2560×1440（3,686,400 像素）属于**实验性**，结果更不稳定
 *
 * 注意：这里只管"像素尺寸"（如 `1024x1024`）。像 Agnes 那种档位写法（`1K`/`2K`）不是像素，
 * 直接放过 —— 由各自的 provider 模板去处理。
 */

export const SIZE_RULES = {
  maxEdge: 3840,
  edgeMultiple: 16,
  maxRatio: 3,
  maxPixels: 8294400,
  minPixels: 655360,
  /** 超过这个像素数（= 2560×1440）官方标注为实验性，可靠性下降 */
  reliablePixels: 3686400,
}

const PIXEL_SIZE = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i

/** 是否是"宽x高"像素尺寸写法。 */
export function isPixelSize(size) {
  return PIXEL_SIZE.test(String(size ?? ''))
}

/** 解析 "1024x1024" → {width, height}；不是像素写法返回 null。 */
export function parsePixelSize(size) {
  const m = PIXEL_SIZE.exec(String(size ?? ''))
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!(width > 0) || !(height > 0)) return null
  return { width, height }
}

/** 把数值吸附到最近的 16 的整数倍（至少 16）。 */
export function snapEdge(value) {
  const v = Math.max(1, Math.round(Number(value) || 0))
  return Math.max(SIZE_RULES.edgeMultiple, Math.round(v / SIZE_RULES.edgeMultiple) * SIZE_RULES.edgeMultiple)
}

/** 一对宽高是否满足全部硬约束。 */
export function isValidEdges(width, height) {
  if (!(width > 0) || !(height > 0)) return false
  if (width % SIZE_RULES.edgeMultiple !== 0 || height % SIZE_RULES.edgeMultiple !== 0) return false
  if (Math.max(width, height) >= SIZE_RULES.maxEdge) return false
  if (Math.max(width, height) / Math.min(width, height) > SIZE_RULES.maxRatio) return false
  const pixels = width * height
  return pixels >= SIZE_RULES.minPixels && pixels <= SIZE_RULES.maxPixels
}

/**
 * 按约束修正一个像素尺寸，返回最近的合法尺寸（尽量保持宽高比）。
 *
 * 为什么用"迭代调整 + 兜底"而不是一次算完：
 * 第一版是「吸附 16 倍数 → 夹比例 → 再按像素上下限缩放」，
 * 但**每次缩放都会因为吸附到 16 的倍数而重新破坏比例**（实测 `17x9999` 被修成
 * `464x1408`，比例 3.03:1 仍然越界）。所以改成：每轮只修当前最严重的违约项，
 * 收敛后**再用 isValidEdges 复核**；实在收不住就退回一个一定合法的默认值。
 */
export function snapSize(size) {
  const parsed = parsePixelSize(size)
  if (!parsed) return size

  let width = snapEdge(parsed.width)
  let height = snapEdge(parsed.height)
  const maxEdge = SIZE_RULES.maxEdge - SIZE_RULES.edgeMultiple

  for (let attempt = 0; attempt < 240; attempt++) {
    if (isValidEdges(width, height)) return `${width}x${height}`

    const long = Math.max(width, height)
    const short = Math.min(width, height)
    const landscape = width >= height
    const ratio = long / short
    const pixels = width * height

    let nextLong = long
    let nextShort = short
    if (long >= SIZE_RULES.maxEdge) {
      /* 只压长边，**不动短边** —— 动短边会把宽高比改掉
       * （实测 4096×4096 被修成 3824×1280，从方图变成 3:1 长条，等于偷偷换了构图）。
       * 压完长边后，如果总像素仍超限，下一轮会等比缩小，比例就保住了。 */
      nextLong = snapEdge(maxEdge)
    } else if (ratio > SIZE_RULES.maxRatio) {
      nextLong = snapEdge(short * SIZE_RULES.maxRatio)
    } else if (pixels < SIZE_RULES.minPixels) {
      // 按比例一起放大，但至少各加一格，保证一定在推进
      const k = Math.sqrt(SIZE_RULES.minPixels / pixels)
      nextLong = Math.max(long + SIZE_RULES.edgeMultiple, snapEdge(long * k))
      nextShort = Math.max(short + SIZE_RULES.edgeMultiple, snapEdge(short * k))
    } else if (pixels > SIZE_RULES.maxPixels) {
      const k = Math.sqrt(SIZE_RULES.maxPixels / pixels)
      nextLong = Math.max(SIZE_RULES.edgeMultiple, snapEdge(long * k))
      nextShort = Math.max(SIZE_RULES.edgeMultiple, snapEdge(short * k))
    } else {
      break
    }
    nextLong = Math.min(nextLong, maxEdge)
    if (landscape) { width = nextLong; height = nextShort } else { width = nextShort; height = nextLong }
    if (width <= 0 || height <= 0) break
  }

  // 兜底：一定合法的方图（宁可牺牲宽高比，也不能返回一个会被上游拒掉/裁掉的尺寸）
  if (isValidEdges(width, height)) return `${width}x${height}`
  return '1024x1024'
}

/**
 * 校验尺寸。
 * @returns {{ok:boolean, kind:'pixel'|'tier'|'unknown', size:string|null, original:string,
 *            errors:string[], warnings:string[], fixed:string|null}}
 */
export function checkImageSize(size, { model = '' } = {}) {
  const original = String(size ?? '').trim()
  if (!original) return { ok: true, kind: 'unknown', size: null, original, errors: [], warnings: [], fixed: null }

  if (!isPixelSize(original)) {
    // 档位写法（1K/2K/…/auto）或服务商自定义：不在这里判，交给 provider 模板
    return { ok: true, kind: 'tier', size: original, original, errors: [], warnings: [], fixed: null }
  }

  const parsed = parsePixelSize(original)
  const errors = []
  const warnings = []
  const { width, height } = parsed

  if (width % SIZE_RULES.edgeMultiple !== 0 || height % SIZE_RULES.edgeMultiple !== 0) {
    errors.push(`${width}×${height} 的边长不是 ${SIZE_RULES.edgeMultiple} 的整数倍`)
  }
  if (Math.max(width, height) >= SIZE_RULES.maxEdge) {
    errors.push(`最长边 ${Math.max(width, height)}px ≥ ${SIZE_RULES.maxEdge}px 上限`)
  }
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (ratio > SIZE_RULES.maxRatio) {
    errors.push(`长短边比 ${ratio.toFixed(2)}:1 超过 ${SIZE_RULES.maxRatio}:1`)
  }
  const pixels = width * height
  if (pixels > SIZE_RULES.maxPixels) errors.push(`总像素 ${pixels} 超过 ${SIZE_RULES.maxPixels} 上限`)
  if (pixels < SIZE_RULES.minPixels) errors.push(`总像素 ${pixels} 低于 ${SIZE_RULES.minPixels} 下限`)
  if (pixels > SIZE_RULES.reliablePixels) {
    warnings.push(`总像素 ${pixels} 超过 2560×1440（官方标注为实验性尺寸，结果更不稳定）；要稳就用 2K 及以下`)
  }

  const fixed = errors.length > 0 ? snapSize(original) : null
  return {
    ok: errors.length === 0,
    kind: 'pixel',
    size: original,
    original,
    errors,
    warnings,
    fixed,
    ratio: Number(ratio.toFixed(3)),
    pixels,
    model,
  }
}

/**
 * 一眼看懂的合法尺寸清单（写进文档/提示里用）。
 *
 * ⚠️ 注意下限：总像素不得低于 655,360，也就是**最小只能出约 816×816**。
 * 所以「生成 512×512 的小图标」是**做不到的** —— 正确做法是先出 1024×1024（或更大）再本地缩小
 * （用 pixelize/fitToTarget 那一套，还不花钱）。这条很多人不知道，会一直撞 400。
 */
export function popularSizes() {
  return [
    { label: '方图（最稳的默认）', size: '1024x1024', note: '通用默认' },
    { label: '竖图', size: '1024x1536', note: '角色立绘 / 手机界面 / 卡面' },
    { label: '横图', size: '1536x1024', note: '场景 / 横幅' },
    { label: '2K / QHD', size: '2560x1440', note: '官方推荐的上限可靠性边界，再大属实验性' },
    { label: '最小可用方图', size: '816x816', note: '受总像素下限 655,360 约束' },
  ]
}

/** 生成尺寸的可行下限（平方根，方便解释"为什么不能出 512"）。 */
export function minSquareEdge() {
  return snapEdge(Math.ceil(Math.sqrt(SIZE_RULES.minPixels)))
}
