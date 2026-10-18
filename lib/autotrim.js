/**
 * 切图后的自动对齐：检测每格图标的真实内容边界，trim 掉多余留白，再按规格缩放。
 *
 * 为什么必须做：固定网格切出来的是「格子」，不是「图标」——
 * 模型画的时候每个图标的实际大小/位置都不一样，直接用格子会：
 *   · 图标偏小 → 游戏里显示特别小
 *   · 图标偏心 → 游戏里位置歪
 *   · 四周大片空白 → 等于白画
 * 这里用包围盒把内容裁出来，居中 + 按规格缩放，直接把「能用的图」交付。
 *
 * 抗噪：先做连通域分析，丢掉极小碎块（模型常在角落留孤立像素/杂点），
 * 再用「主体连通域」的包围盒，避免一个杂点把包围盒撑满整格。
 */

/** 单像素是否算「内容」：alpha 够高，且不是纯背景色。 */
function isOpaque(pixels, index, alphaThreshold) {
  return pixels[index + 3] >= alphaThreshold
}

/**
 * 连通域标记（4 邻域，迭代式洪水填充，避免递归爆栈）。
 * @returns {Array<{minX,minY,maxX,maxY,count}>} 按像素数从大到小
 */
export function findComponents(pixels, width, height, { x0 = 0, y0 = 0, w = width, h = height, alphaThreshold = 16, maxComponents = 400 } = {}) {
  const visited = new Uint8Array(w * h)
  const components = []
  const at = (x, y) => ((y0 + y) * width + (x0 + x)) * 4

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const flat = sy * w + sx
      if (visited[flat]) continue
      if (!isOpaque(pixels, at(sx, sy), alphaThreshold)) { visited[flat] = 1; continue }
      // 洪水填充
      const stack = [[sx, sy]]
      visited[flat] = 1
      let minX = sx; let maxX = sx; let minY = sy; let maxY = sy; let count = 0
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        const neighbours = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const nflat = ny * w + nx
          if (visited[nflat]) continue
          if (!isOpaque(pixels, at(nx, ny), alphaThreshold)) { visited[nflat] = 1; continue }
          visited[nflat] = 1
          stack.push([nx, ny])
        }
      }
      components.push({ minX, minY, maxX, maxY, count })
      if (components.length >= maxComponents) break
    }
  }
  components.sort((a, b) => b.count - a.count)
  return components
}

/**
 * 算出一格里「图标主体」的包围盒。
 * @returns {{empty:boolean, box:object, components:number, mainShare:number, dropped:number}}
 */
export function contentBox(pixels, width, height, cell, { alphaThreshold = 16, minShare = 0.05 } = {}) {
  const { x0, y0, w, h } = cell
  const components = findComponents(pixels, width, height, { x0, y0, w, h, alphaThreshold })
  if (components.length === 0) return { empty: true, box: null, components: 0, mainShare: 0, dropped: 0 }
  const total = components.reduce((sum, item) => sum + item.count, 0)
  const main = components[0]
  const mainShare = total > 0 ? main.count / total : 0
  // 主体占比太小 → 这格其实是空的/全是碎屑，别硬裁
  if (mainShare < minShare) {
    return { empty: true, box: null, components: components.length, mainShare: Number(mainShare.toFixed(3)), dropped: components.length }
  }
  // 合并主体 + 与它「接近」的碎块（比如图标断开的两个部分），避免把细节裁掉
  let box = { minX: main.minX, minY: main.minY, maxX: main.maxX, maxY: main.maxY }
  let dropped = 0
  for (const item of components.slice(1)) {
    const gapX = Math.max(0, Math.max(box.minX - item.maxX, item.minX - box.maxX))
    const gapY = Math.max(0, Math.max(box.minY - item.maxY, item.minY - box.maxY))
    const near = Math.max(gapX, gapY) <= Math.max(2, Math.round(Math.min(w, h) * 0.04))
    const big = item.count / total >= 0.02
    if (near && big) {
      box = {
        minX: Math.min(box.minX, item.minX),
        minY: Math.min(box.minY, item.minY),
        maxX: Math.max(box.maxX, item.maxX),
        maxY: Math.max(box.maxY, item.maxY),
      }
    } else dropped += 1
  }
  return {
    empty: false,
    // 注意：box 是「格内相对坐标」(0,0 = 该格左上角)。
    // 跨格裁剪前必须用 absoluteBox() 转成整图绝对坐标，否则会裁到错误的位置。
    box: { ...box, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 },
    localBox: { ...box, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 },
    components: components.length,
    mainShare: Number(mainShare.toFixed(3)),
    dropped,
  }
}

/**
 * 把「格内相对」的包围盒转成「整图绝对」坐标。
 * 这两个坐标系混用会导致裁到完全错误的位置（图标跑到角落/消失），所以显式分开。
 */
export function absoluteBox(localBox, cell) {
  if (!localBox) return null
  const minX = cell.x0 + localBox.minX
  const minY = cell.y0 + localBox.minY
  return {
    minX,
    minY,
    maxX: minX + localBox.width - 1,
    maxY: minY + localBox.height - 1,
    width: localBox.width,
    height: localBox.height,
  }
}

/** 从大图里抠一块出来（绝对坐标）。 */
export function cropRegion(pixels, sheetWidth, box) {
  const out = Buffer.alloc(box.width * box.height * 4)
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const src = ((box.minY + y) * sheetWidth + (box.minX + x)) * 4
      const dst = (y * box.width + x) * 4
      out[dst] = pixels[src]
      out[dst + 1] = pixels[src + 1]
      out[dst + 2] = pixels[src + 2]
      out[dst + 3] = pixels[src + 3]
    }
  }
  return out
}

/**
 * 把内容按目标尺寸居中缩放（保留透明、保持宽高比、不放大超过原尺寸导致糊）。
 * @param {{pixels:Buffer, width:number, height:number, targetWidth?:number, targetHeight?:number,
 *          mode?:'contain'|'stretch', padding?:number, allowUpscale?:boolean}} params
 */
export function fitToTarget({ pixels, width, height, targetWidth = 0, targetHeight = 0, mode = 'contain', padding = 0, allowUpscale = true, integerScale = false }) {
  if (!targetWidth || !targetHeight) return { pixels, width, height, note: '没给目标尺寸，保持原样' }
  const inner = Math.max(1, targetWidth - padding * 2)
  const innerH = Math.max(1, targetHeight - padding * 2)
  const scaleX = inner / width
  const scaleY = innerH / height
  let scale = mode === 'stretch' ? null : Math.min(scaleX, scaleY)
  /**
   * integerScale（像素画专用）：**放大必须是整数倍**。
   *
   * 为什么必须：32×32 的逻辑图放到 64×64 是 2 倍，干净；但 30×30 放到 64×64
   * 自然比例是 2.13 倍 —— 每个"像素"占 2.13 个物理像素，**大小不一**，
   * 画面立刻就显得脏。这不是抗锯齿问题（可以没有中间色），而是像素本身不等大。
   * 所以放大一律向下取整到整数倍，放不满的部分留透明（居中）。
   * 缩小没法整数化（那要改逻辑分辨率），保持原样但如实回报。
   */
  let integerFactor = null
  if (integerScale && mode !== 'stretch' && scale !== null) {
    if (scale >= 1) {
      integerFactor = Math.max(1, Math.floor(scale))
      scale = integerFactor
    } else {
      integerFactor = 0 // 标记：这是缩小，做不到整数倍
    }
  }
  const drawW = mode === 'stretch' ? inner : Math.max(1, Math.round(width * (allowUpscale ? scale : Math.min(1, scale))))
  const drawH = mode === 'stretch' ? innerH : Math.max(1, Math.round(height * (allowUpscale ? scale : Math.min(1, scale))))
  const offsetX = Math.floor((targetWidth - drawW) / 2)
  const offsetY = Math.floor((targetHeight - drawH) / 2)

  const out = Buffer.alloc(targetWidth * targetHeight * 4) // 默认全透明
  for (let y = 0; y < drawH; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / drawH))
    for (let x = 0; x < drawW; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / drawW))
      const src = (sy * width + sx) * 4
      const dx = offsetX + x
      const dy = offsetY + y
      if (dx < 0 || dy < 0 || dx >= targetWidth || dy >= targetHeight) continue
      const dst = (dy * targetWidth + dx) * 4
      out[dst] = pixels[src]
      out[dst + 1] = pixels[src + 1]
      out[dst + 2] = pixels[src + 2]
      out[dst + 3] = pixels[src + 3]
    }
  }
  return {
    pixels: out,
    width: targetWidth,
    height: targetHeight,
    note: `按 ${mode} 缩放：内容 ${width}×${height} → 画到 ${drawW}×${drawH}，居中在 ${targetWidth}×${targetHeight}`
      + (integerFactor !== null ? `（整数倍 ${integerFactor}×，像素画要求）` : ''),
    drawn: { width: drawW, height: drawH, offsetX, offsetY },
    integer_scale: integerFactor,
    integer_exact: integerFactor === null ? null : (drawW === width * integerFactor),
  }
}

/* ============================================================================
 * 【第七十三轮 · 实战教训】批量生成的合集图**不能假设它符合模板要求**
 *
 * ① 模板里写了 "pure transparent background"，但**像素风/图标风的格子常被模型
 *    填成一块平底**（浅灰、米色…）⇒ 切出来的每张图带一块不透明底板。
 *    装进游戏就是「一块灰方块 + 一个偏在一边的小图标」——
 *    使用者会报「位置错乱」，而真因其实是**底没抠 + 因此居中也失效**。
 *
 * ② 模型常在格子之间画出**边线 / 底板边**（模板虽写 "no grid lines"，它照画）
 *    ⇒ 那条线被切进每一格的边上，成为一道**直条纹**；
 *    更糟的是它会把「内容包围盒」撑到整格 ⇒ 后面的居中/缩放**等于没做**。
 *
 * 下面两个函数把这两条补上。**只改 alpha 与内容边界，不改颜色**。
 * 两者都是"先量、再动"，并且都有**保护条件**，不会把正常内容吃掉：
 *   · 抠底：边界的标准差太大（不是平底）⇒ 直接放弃；某轮抠掉过多 ⇒ 撤销该轮。
 *   · 去条纹：必须同时满足「贴边 + 整行/整列全不透明 + 颜色均匀」才收边。
 * 用法见 sheet.js 的 computeSlices —— 已默认接在切图之后。
 * ========================================================================== */

/** 窗口内「不透明内容」的包围盒（整图坐标）。没有内容返回 null。 */
export function opaqueBox(pixels, width, height, cell, { alphaThreshold = 200 } = {}) {
  let minX = cell.x0 + cell.w
  let minY = cell.y0 + cell.h
  let maxX = -1
  let maxY = -1
  for (let y = cell.y0; y < cell.y0 + cell.h; y++) {
    for (let x = cell.x0; x < cell.x0 + cell.w; x++) {
      if (pixels[(y * width + x) * 4 + 3] >= alphaThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x0: minX, y0: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 抠底：把「从边界连得通的平底」置为透明。**多轮**：抠完一轮重算包围盒，再从
 * 包围盒边界抠下一轮 —— 因为模型常画成「外层留白 + 一块颜色略不同的内层底板」，
 * 只从图边界扩散会在底板边上停下，卡面就留一块灰方块。
 *
 * 两个容差缺一不可：
 *   · globalTolerance —— 与边框中位色的差（放宽到 70，容忍平底上的渐变）
 *   · localTolerance  —— 与**相邻**像素的差（12；像素画是硬边，跨不过去）
 * 真正防止吃掉主体的是 localTolerance + maxShare，不是"边界平不平"。
 *
 * @returns {{keyed:number, rounds:number, skipped:boolean, why:string}}
 */
export function keyOutFlatBackground(pixels, width, height, cell, {
  globalTolerance = 70, localTolerance = 12, flatSd = 62, maxRounds = 4, maxShare = 0.88,
} = {}) {
  const at = (x, y) => (y * width + x) * 4
  const lum = (i) => (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
  const seedPerimeter = (box) => {
    const out = []
    if (!box) {
      for (let x = cell.x0; x < cell.x0 + cell.w; x++) { out.push([x, cell.y0], [x, cell.y0 + cell.h - 1]) }
      for (let y = cell.y0; y < cell.y0 + cell.h; y++) { out.push([cell.x0, y], [cell.x0 + cell.w - 1, y]) }
      return out
    }
    for (let x = box.x0; x < box.x0 + box.w; x++) { out.push([x, box.y0], [x, box.y0 + box.h - 1]) }
    for (let y = box.y0; y < box.y0 + box.h; y++) { out.push([box.x0, y], [box.x0 + box.w - 1, y]) }
    return out
  }

  let total = 0
  let rounds = 0
  let firstFlat = null
  const cellPixels = cell.w * cell.h

  for (let pass = 0; pass < maxRounds; pass++) {
    const box = pass === 0 ? null : opaqueBox(pixels, width, height, cell)
    if (pass > 0 && !box) break
    const seeds = seedPerimeter(box).filter(([x, y]) => pixels[at(x, y) + 3] >= 200)
    if (seeds.length < 16) break

    const cols = seeds.map(([x, y]) => { const i = at(x, y); return [pixels[i], pixels[i + 1], pixels[i + 2]] })
    const med = [0, 1, 2].map((c) => {
      const arr = cols.map((v) => v[c]).sort((a, b) => a - b)
      return arr[arr.length >> 1]
    })
    const mean = cols.reduce((s, c) => s + (c[0] + c[1] + c[2]) / 3, 0) / cols.length
    const sd = Math.sqrt(cols.reduce((s, c) => s + ((c[0] + c[1] + c[2]) / 3 - mean) ** 2, 0) / cols.length)
    if (pass === 0) firstFlat = sd <= flatSd
    if (sd > flatSd) break                      /* 这层边界不平 ⇒ 是内容，停手 */

    const gd = (i) => Math.max(
      Math.abs(pixels[i] - med[0]), Math.abs(pixels[i + 1] - med[1]), Math.abs(pixels[i + 2] - med[2]))
    const nearG = (i) => gd(i) <= globalTolerance
    const nearL = (i, j) => Math.max(
      Math.abs(pixels[i] - pixels[j]),
      Math.abs(pixels[i + 1] - pixels[j + 1]),
      Math.abs(pixels[i + 2] - pixels[j + 2])) <= localTolerance

    const seen = new Uint8Array(cellPixels)
    const idx = (x, y) => (y - cell.y0) * cell.w + (x - cell.x0)
    const stack = []
    for (const [x, y] of seeds) {
      const k = idx(x, y)
      if (!seen[k] && nearG(at(x, y))) { seen[k] = 1; stack.push([x, y]) }
    }
    const hit = []
    while (stack.length) {
      const [x, y] = stack.pop()
      const i = at(x, y)
      pixels[i + 3] = 0
      hit.push(i)
      const push = (nx, ny) => {
        if (nx < cell.x0 || ny < cell.y0 || nx >= cell.x0 + cell.w || ny >= cell.y0 + cell.h) return
        const k = idx(nx, ny)
        if (seen[k]) return
        const j = at(nx, ny)
        if (nearG(j) && nearL(j, i)) { seen[k] = 1; stack.push([nx, ny]) }
      }
      push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1)
    }

    if (hit.length / cellPixels > maxShare) {   /* 安全阀：抠太多 ⇒ 撤销该轮，可能把主体吃了 */
      for (const i of hit) pixels[i + 3] = 255
      break
    }
    total += hit.length
    rounds++
  }
  return { keyed: total / cellPixels, rounds, skipped: firstFlat === false, why: firstFlat === false ? '边界不是平底' : '' }
}

/**
 * 去条纹：把「贴着边界、整行/整列全不透明、颜色均匀」的边线收掉。
 * 单位是**像素行/列**；只在最外 edgeShare 的范围内收，且至少保留 minShare 的尺寸。
 * 普通内容不满足"颜色均匀"或"整行全不透明"，不会被误伤。
 *
 * @returns {{cutTop:number, cutBottom:number, cutLeft:number, cutRight:number, box:object|null}}
 */
export function trimEdgeStripes(pixels, width, height, cell, {
  alphaThreshold = 12, uniformSd = 12, edgeShare = 0.12, minShare = 0.30,
} = {}) {
  const box = opaqueBox(pixels, width, height, cell, { alphaThreshold })
  if (!box) return { cutTop: 0, cutBottom: 0, cutLeft: 0, cutRight: 0, box: null }
  const op = (x, y) => pixels[(y * width + x) * 4 + 3] > alphaThreshold
  const lum = (x, y) => { const i = (y * width + x) * 4; return (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 }
  const uniform = (vals) => {
    if (!vals.length) return false
    const m = vals.reduce((s, v) => s + v, 0) / vals.length
    return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) < uniformSd
  }
  const rowStripe = (y) => {
    const vals = []
    for (let x = box.x0; x < box.x0 + box.w; x++) { if (!op(x, y)) return false; vals.push(lum(x, y)) }
    return uniform(vals)
  }
  const colStripe = (x) => {
    const vals = []
    for (let y = box.y0; y < box.y0 + box.h; y++) { if (!op(x, y)) return false; vals.push(lum(x, y)) }
    return uniform(vals)
  }

  let { x0, y0, w, h } = box
  const minW = Math.max(4, Math.round(w * minShare))
  const minH = Math.max(4, Math.round(h * minShare))
  const nearTop = cell.y0 + Math.round(cell.h * edgeShare)
  const nearBottom = cell.y0 + cell.h - 1 - Math.round(cell.h * edgeShare)
  const nearLeft = cell.x0 + Math.round(cell.w * edgeShare)
  const nearRight = cell.x0 + cell.w - 1 - Math.round(cell.w * edgeShare)

  let cutTop = 0; let cutBottom = 0; let cutLeft = 0; let cutRight = 0
  while (h > minH && y0 <= nearTop && rowStripe(y0)) { y0++; h--; cutTop++ }
  while (h > minH && y0 + h - 1 >= nearBottom && rowStripe(y0 + h - 1)) { h--; cutBottom++ }
  while (w > minW && x0 <= nearLeft && colStripe(x0)) { x0++; w--; cutLeft++ }
  while (w > minW && x0 + w - 1 >= nearRight && colStripe(x0 + w - 1)) { w--; cutRight++ }

  return { cutTop, cutBottom, cutLeft, cutRight, box: { x0, y0, w, h } }
}

/**
 * 擦掉"模型自己画的网格线"（合集图切图前的前置处理）。
 *
 * 【为什么需要它 —— 第七十三轮实测】模板里写了 `no grid lines`，模型**照画**；
 * 而且**模型画的网格和工具的固定行列并不对齐**（它的格距/边距是它自己定的）。
 * 于是按 tool 的行列切下去，网格线会**落在每一格的内部**：
 *   · 成为一道横杠/竖杠（用户报的"奇怪条纹/横杠"）；
 *   · 把"内容包围盒"撑大，让后续的居中与缩放失效。
 * 只在**格子边缘**去收线是不够的 —— 线会出现在格子的任何位置。
 *
 * 【怎么可靠地认出网格线】靠"**贯穿整张合集图**"这个特征：
 *   网格线那一列/行，在**整张图的高度/宽度**上都是同一种颜色（而且是不透明的）。
 *   真实素材几乎不可能有"贯穿整图的单一颜色细线"——
 *   一把竖着的剑只占整图高度的一小部分，达不到 minShare。
 * 所以判定条件同时要三个：
 *   ① 该列/行里"不透明且颜色接近本条中位数"的像素占比 ≥ minShare（默认 0.85）；
 *   ② 连续成条，且**厚度 ≤ maxThickness**（默认 8px）—— 防止把一大块纯色区域当线擦掉。
 * 命中就把那些像素的 alpha 置 0。**只改 alpha，不改颜色。**
 *
 * @returns {{columns:number, rows:number, pixels:number, runs:Array<{axis:string,at:number,thickness:number}>}}
 */
export function eraseGridLines(pixels, width, height, {
  tolerance = 48, minShare = 0.85, maxThickness = 8, alphaThreshold = 200,
} = {}) {
  const runs = []
  let killed = 0

  const medianOf = (get) => {
    const arr = get().sort((a, b) => a - b)
    return arr.length ? arr[arr.length >> 1] : 0
  }
  const near = (i, m) => Math.max(
    Math.abs(pixels[i] - m[0]), Math.abs(pixels[i + 1] - m[1]), Math.abs(pixels[i + 2] - m[2])) <= tolerance

  /* ---- 竖线（按列） ---- */
  const colHit = new Array(width).fill(false)
  for (let x = 0; x < width; x++) {
    const med = [0, 1, 2].map((c) => medianOf(() => {
      const out = []
      for (let y = 0; y < height; y++) { const i = (y * width + x) * 4; if (pixels[i + 3] >= alphaThreshold) out.push(pixels[i + c]) }
      return out
    }))
    let op = 0; let hit = 0
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] < alphaThreshold) continue
      op++
      if (near(i, med)) hit++
    }
    if (op / height >= minShare && hit / height >= minShare) colHit[x] = true
  }
  const killCols = new Set()
  for (let x = 0; x < width;) {
    if (!colHit[x]) { x++; continue }
    let e = x
    while (e + 1 < width && colHit[e + 1]) e++
    const thickness = e - x + 1
    if (thickness <= maxThickness) { for (let k = x; k <= e; k++) killCols.add(k); runs.push({ axis: 'col', at: x, thickness }) }
    x = e + 1
  }

  /* ---- 横线（按行） ---- */
  const rowHit = new Array(height).fill(false)
  for (let y = 0; y < height; y++) {
    const med = [0, 1, 2].map((c) => medianOf(() => {
      const out = []
      for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (pixels[i + 3] >= alphaThreshold) out.push(pixels[i + c]) }
      return out
    }))
    let op = 0; let hit = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] < alphaThreshold) continue
      op++
      if (near(i, med)) hit++
    }
    if (op / width >= minShare && hit / width >= minShare) rowHit[y] = true
  }
  const killRows = new Set()
  for (let y = 0; y < height;) {
    if (!rowHit[y]) { y++; continue }
    let e = y
    while (e + 1 < height && rowHit[e + 1]) e++
    const thickness = e - y + 1
    if (thickness <= maxThickness) { for (let k = y; k <= e; k++) killRows.add(k); runs.push({ axis: 'row', at: y, thickness }) }
    y = e + 1
  }

  for (const y of killRows) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (pixels[i + 3] >= alphaThreshold) { pixels[i + 3] = 0; killed++ } }
  for (const x of killCols) for (let y = 0; y < height; y++) { const i = (y * width + x) * 4; if (pixels[i + 3] >= alphaThreshold) { pixels[i + 3] = 0; killed++ } }

  return { columns: killCols.size, rows: killRows.size, pixels: killed, runs }
}
