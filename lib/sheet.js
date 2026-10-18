/**
 * 图标集批量生成（sprite sheet）：一次请求出一整张合集图，再自动切成单张素材。
 *
 * 为什么省一大半钱：现在是一张图一个请求（你的单价 ~0.04 元/张 × N）。
 * 一张合集图里放 8~16 个图标，**一个请求就出完**，再按网格切开即可 ——
 * 请求数从 N 降到 1，钱和等待时间都省。
 *
 * 切开用零依赖的 PNG 解码/编码（lib/pngcodec.js），保留透明通道。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { encodePngRgba, decodePngRgba } from './pngcodec.js'
import { contentBox, fitToTarget, absoluteBox, cropRegion, keyOutFlatBackground, trimEdgeStripes, eraseGridLines } from './autotrim.js'
import { ensureDir, safeSegment } from './util.js'
import { pixelize, pixelPurity } from './pixelize.js'

/** 网格推算：按素材数量选最接近正方形的排布（3×3、4×4…）。 */
export function gridFor(count) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.max(1, Math.ceil(count / columns))
  return { columns, rows, capacity: columns * rows }
}

/** 生成合集图的提示词：明确要求「每个格子一个图标、格子之间留白、不要文字」。 */
export function sheetPrompt({ items = [], columns, rows, style = '', background = 'transparent' }) {
  const list = items.map((item, index) => `${index + 1}. ${item}`).join('; ')
  return [
    `A sprite sheet of ${items.length} game icons arranged in a strict ${columns}x${rows} grid, evenly spaced, each icon centered in its own cell with clear padding between cells.`,
    `Icons in reading order: ${list}.`,
    'All icons share one consistent art style, identical line weight, identical lighting and identical color palette.',
    `Pure ${background} background, no borders, no grid lines, no cell frames, no background panel behind items, no text, no labels, no watermark, no drop shadow between cells.`,
    /* 【第七十三轮 · 实战教训】上面这句"no grid lines / transparent background"**必须写**，
     *   但**不能指望它生效**：实测模型照样会画格子边线、照样会填平底。
     *   所以真正的兜底是 computeSlices 里的 clean（抠底 + 去边条纹），不是这句提示词。
     *   这里保留并要求得更死，只是为了少一点返工。 */
    style ? `Art style: ${style}.` : '',
  ].filter(Boolean).join(' ')
}

/**
 * 把一张合集图按网格切成若干单张 PNG。
 *
 * 默认 **自动对齐**（trim=true）：检测每格图标的真实包围盒 → 裁掉多余留白 → 居中按目标规格缩放。
 * 这样交出去的是「能直接用的图标」，而不是「格子」。
 *
 * @param {{sheetFile:string, outDir:string, items:Array<{name:string, width?:number, height?:number}>,
 *          columns:number, rows:number, padding?:number,
 *          trim?:boolean, targetWidth?:number, targetHeight?:number, mode?:'contain'|'stretch',
 *          alphaThreshold?:number, allowUpscale?:boolean}} params
 */
/**
 * 纯计算版切片：**不碰磁盘**，返回每格的像素与元数据。
 *
 * 抽出来的原因（prompt 2 的要求）：审核对比视图要"实时按当前规则算切片预览"，
 * 不能依赖已经切好的文件，也不能把结果写盘。所以把计算与落盘分开：
 *   computeSlices() —— 纯函数，预览和执行共用（保证"看到的"就是"会切出来的"）
 *   sliceSheet()    —— 在它之上把像素写成 PNG 文件
 *
 * @returns {{ok:boolean, error?:string, width:number, height:number, grid:object,
 *            slices:Array<{name,column,row,width,height,pixels,cell,alignment,...,png?:Buffer}>}}
 */
export function computeSlices({
  decoded, items = [], columns, rows, padding = 0,
  trim = true, clean = true, targetWidth = 0, targetHeight = 0, mode = 'contain', alphaThreshold = 16, allowUpscale = true,
  encode = false, pixel = null,
}) {
  if (!decoded) return { ok: false, error: '合集图解不开（只支持 8bit PNG，非隔行）' }
  const { width, height } = decoded
  const pixels = decoded.pixels
  let cellW = Math.floor(width / columns)
  let cellH = Math.floor(height / rows)
  if (cellW < 4 || cellH < 4) return { ok: false, error: `网格太密：格子只有 ${cellW}×${cellH}` }

  /* 【第七十三轮 · 必须在**整张合集图**上先擦掉模型画的网格线，再按格切】
   * 为什么必须在整图上做：网格线的特征是"**贯穿整张图**"，
   *   而模型画的网格和这里的固定行列**并不对齐** ⇒ 线会落在**格子内部**，
   *   按格切完之后再找就抓不到了（只在格子边缘去收线是无效的，这是实测撞出来的）。
   * 擦掉线之后，后面每格的 contentBox 才不会被线撑大、居中才真的生效。
   * clean:false 时整段跳过，保持旧行为。 */
  let gridErase
  if (clean) gridErase = eraseGridLines(pixels, width, height)

  /* 【像素化：必须**在整张合集图上做一次**，不能按格各做一次】
   * 为什么：AI 画的是**一套统一网格**，方块横跨整张图对齐。
   *   · 按格各做一次 → 每格各自猜块尺寸，格与格之间不一致（同批素材大小不一）；
   *   · 而且格子宽（sheetW/columns）不一定整除块尺寸，按格采样会让方块**跨格错位**。
   * 所以：整图一次像素化 → 逻辑分辨率正好是 columns×rows 个格子，
   * 之后所有切图/居中/缩放都在**逻辑分辨率**上做（那时每格 = 一个逻辑像素块）。
   * pixel.width/height = **每格**的逻辑像素数（例如 32 表示每格 32×32 像素）。 */
  let pixelInfo = null
  const pixelWarnings = []
  if (pixel && pixel !== false) {
    const perCellW = Math.round(Number(pixel?.width) || 0)
    let perCellH = Math.round(Number(pixel?.height) || 0)
    /* 只给了每格逻辑宽时，高必须按**格子**的宽高比推 —— 不能直接等于宽。
     * 格子常常不是正方形（例：1248×832 按 4×4 切 → 每格 312×208），
     * 若令 perCellH = perCellW，块就变成 9.75×6.5 的**长方形**：
     * 那不是像素，是拉伸。真像素画的像素必须等大**且正方形**。 */
    if (perCellW > 0 && perCellH <= 0) {
      perCellH = Math.max(1, Math.round(perCellW * (cellH / cellW)))
    }
    const options = {
      method: pixel?.method ?? 'median',
      coreRatio: pixel?.coreRatio ?? 0.6,
      palette: pixel?.palette ?? 0,
      aaPasses: pixel?.aaPasses ?? 0,
      alphaThreshold,
      softAlpha: pixel?.softAlpha === true,
    }
    // 给了每格逻辑尺寸 → 整图逻辑 = 列数 × 每格；没给就让它自己检测网格。
    // 注意 pixel:true（纯自动）以前会被静默忽略（Number(true.width) 是 NaN），
    // 于是"我要像素画"这句请求石沉大海、还没有任何报错 —— 现在两种写法都走这里。
    if (perCellW > 0) {
      options.logicalWidth = Math.max(1, columns * perCellW)
      options.logicalHeight = Math.max(1, rows * perCellH)
    }
    const result = pixelize({ pixels, width, height, options })
    if (result.ok) {
      decoded.pixels = result.pixels
      decoded.width = result.width
      decoded.height = result.height
      cellW = Math.floor(result.width / columns)
      cellH = Math.floor(result.height / rows)
      pixelInfo = {
        ...result.stats,
        per_cell: perCellW > 0 ? `${perCellW}×${perCellH}` : '自动检测',
      }
      if (perCellW <= 0 && (result.width % columns !== 0 || result.height % rows !== 0)) {
        pixelWarnings.push(`像素化后的逻辑尺寸 ${result.width}×${result.height} 不能被 ${columns}×${rows} 整除，每格尺寸会有 1px 误差；给 pixel.width 指定每格逻辑尺寸可避免`)
      }
    } else {
      pixelWarnings.push(`像素化跳过：${result.reason}`)
    }
  }
  // 之后的每一步都在（可能已经像素化的）工作图上做
  const work = decoded.pixels
  const workW = decoded.width
  const workH = decoded.height

  const results = []
  const warnings = [...pixelWarnings]
  const capacity = columns * rows
  for (let index = 0; index < Math.min(items.length, capacity); index++) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const name = safeSegment(items[index]?.name ?? `icon_${index + 1}`, `icon_${index + 1}`)
    const cellBox0 = { x0: column * cellW + padding, y0: row * cellH + padding, w: cellW - padding * 2, h: cellH - padding * 2 }
    if (cellBox0.w <= 0 || cellBox0.h <= 0) { warnings.push(`${name}: 格子为空（padding 太大）`); continue }

    /* 【第七十三轮 · 实战教训：切图先做「格子卫生」= 抠底 + 去边条纹】
     * 为什么必须做（不做会怎样，都在实战里撞过）：
     *   · 模板写了 "pure transparent background"，但像素风/图标风的格子常被填成**平底**
     *     ⇒ 切出来带一块不透明底板 ⇒ 装进游戏是「灰方块 + 偏在一边的小图标」，
     *       使用者会误报成「位置错乱」。
     *   · 模型常在格子之间画**边线/底板边** ⇒ 那条线被切进每格成为**直条纹**，
     *     而且会把「内容包围盒」撑到整格 ⇒ 后面的居中/缩放**等于没做**。
     * 两步都只改 alpha 与内容边界、不改颜色，且各自带保护条件（见 autotrim.js）。
     * 可用 clean:false 关掉。 */
    let cellBox = cellBox0
    let hygiene
    /* 【只在 trim=true 时做】trim=false 的契约是"固定格子、别动像素"，
     * 抠底/去条纹都会改像素与边界，所以这时一律跳过（实测：不跳过会破坏旧行为，
     * 直接把固定格子的输出尺寸改小）。 */
    if (clean && trim) {
      /* 【必须用 set/subarray，不能用 Buffer 专有的 .copy()】
       * 像素化之后 work 是 Uint8ClampedArray（不是 Buffer），`.copy()` 不存在。
       * 这个坑只在 clean+trim 同时开启（也就是**默认路径**）时才会炸，
       * 而测试里恰好都用了 clean:false —— 于是带着一个必崩的默认路径过了测试。
       * set()/subarray() 两者通用。 */
      const snapshotCell = () => {
        const buf = Buffer.alloc(cellBox0.w * cellBox0.h * 4)
        for (let y = 0; y < cellBox0.h; y++) {
          const src = ((cellBox0.y0 + y) * workW + cellBox0.x0) * 4
          buf.set(work.subarray(src, src + cellBox0.w * 4), y * cellBox0.w * 4)
        }
        return buf
      }
      const restoreCell = (buf) => {
        for (let y = 0; y < cellBox0.h; y++) {
          const dst = ((cellBox0.y0 + y) * workW + cellBox0.x0) * 4
          work.set(buf.subarray(y * cellBox0.w * 4, (y + 1) * cellBox0.w * 4), dst)
        }
      }
      const snap = snapshotCell()
      const keyed = keyOutFlatBackground(work, workW, workH, cellBox0)
      /* 【兜底：抠完找不到主体就整体回滚】主体的颜色如果跟背景很接近（浅色图标 + 浅灰底
       * 这类），洪水填充会连主体一起抠掉，那一格就变成空图。
       * 宁可**不抠**（留一块底）也不能把图画没了 —— 所以这里回滚，回到旧行为。 */
      const probe = contentBox(work, workW, workH, cellBox0, { alphaThreshold })
      if (keyed.keyed > 0 && probe.empty) {
        restoreCell(snap)
        hygiene = { keyed: 0, rounds: 0, skipped: true, why: '抠完找不到主体，已整体回滚（主体色与底色太接近）', cut: 0 }
        warnings.push(`${name}: 底色与主体太接近，抠底已回滚（这一格保留原样）`)
      } else {
        const strip = trimEdgeStripes(work, workW, workH, cellBox0)
        if (strip.box) cellBox = strip.box
        const cut = strip.cutTop + strip.cutBottom + strip.cutLeft + strip.cutRight
        hygiene = {
          keyed: Number(keyed.keyed.toFixed(3)),
          rounds: keyed.rounds,
          skipped: keyed.skipped,
          why: keyed.why || '',
          cut,
        }
        if (cut >= Math.max(4, Math.round(Math.min(cellBox0.w, cellBox0.h) * 0.06))) {
          warnings.push(`${name}: 收掉 ${cut}px 格子边线（模型画了网格线/底板边，已自动去掉）`)
        }
        if (keyed.skipped) {
          warnings.push(`${name}: 这格的边界不是平底，跳过抠底（当作满幅场景画处理）`)
        }
      }
    }

    let contentWidth = cellBox.w
    let contentHeight = cellBox.h
    let alignment = 'fixed-cell'
    let box = null
    let mainShare = 1
    let dropped = 0

    if (trim) {
      const found = contentBox(work, workW, workH, cellBox, { alphaThreshold })
      if (found.empty) {
        warnings.push(`${name}: 这格没找到图标主体（可能是空图/纯背景，或模型没按网格画）`)
      } else {
        box = absoluteBox(found.localBox ?? found.box, cellBox)
        contentWidth = box.width
        contentHeight = box.height
        alignment = 'auto-trim'
        mainShare = found.mainShare
        dropped = found.dropped
      }
    }

    let pixelsOut
    let outWidth
    let outHeight
    if (box) {
      pixelsOut = cropRegion(work, workW, box)
      outWidth = box.width
      outHeight = box.height
    } else {
      pixelsOut = cropRegion(work, workW, { minX: cellBox.x0, minY: cellBox.y0, width: cellBox.w, height: cellBox.h })
      outWidth = cellBox.w
      outHeight = cellBox.h
    }

    const itemTarget = { width: items[index]?.width ?? targetWidth, height: items[index]?.height ?? targetHeight }
    let fitted = null
    if (itemTarget.width && itemTarget.height) {
      fitted = fitToTarget({
        pixels: pixelsOut, width: outWidth, height: outHeight,
        targetWidth: itemTarget.width, targetHeight: itemTarget.height, mode, allowUpscale,
        // 像素化的格子已经是逻辑分辨率了 → 放大必须整数倍，否则每格里的"像素"大小不一
        integerScale: Boolean(pixelInfo),
      })
      pixelsOut = fitted.pixels
      outWidth = fitted.width
      outHeight = fitted.height
    }

    if (box && (mainShare < 0.2 || contentWidth < cellW * 0.15)) {
      warnings.push(`${name}: 主体偏小（占格 ${Math.round((contentWidth / cellW) * 100)}%，主体纯度 ${mainShare}）—— 图标可能画得太小`)
    }
    results.push({
      name,
      width: outWidth,
      height: outHeight,
      pixels: pixelsOut,
      column,
      row,
      cell: `${column},${row}`,
      alignment,
      trim: box ? { from: `${cellBox.w}×${cellBox.h}`, to: `${contentWidth}×${contentHeight}`, box } : undefined,
      filled_ratio: Number((contentWidth / cellW).toFixed(3)),
      main_share: mainShare,
      dropped_specks: dropped,
      hygiene,
      fitted: fitted ? fitted.drawn : undefined,
      // encode=true 时顺带给出 PNG 字节（预览要 data URL，执行要落盘）
      png: encode ? encodePngRgba(outWidth, outHeight, pixelsOut) : undefined,
    })
  }
  return {
    ok: true,
    width,
    height,
    grid: { columns, rows, cellWidth: cellW, cellHeight: cellH, capacity },
    slices: results,
    auto_trim: Boolean(trim),
    auto_clean: Boolean(clean),
    pixel: pixelInfo,
    pixel_purity: pixelInfo ? pixelPurity({
      // 逐格复核：每格的最终产物必须自己就是真像素（整数倍方块 + 无抗锯齿）
      pixels: results[0]?.pixels ?? new Uint8ClampedArray(0),
      width: results[0]?.width ?? 0,
      height: results[0]?.height ?? 0,
      checkAA: true,
    }) : null,
    grid_erase: gridErase ? { columns: gridErase.columns, rows: gridErase.rows, pixels: gridErase.pixels } : undefined,
    target: targetWidth && targetHeight ? `${targetWidth}×${targetHeight}` : '',
    warnings,
  }
}

export async function sliceSheet({
  sheetFile, outDir, items = [], columns, rows, padding = 0,
  trim = true, clean = true, targetWidth = 0, targetHeight = 0, mode = 'contain', alphaThreshold = 16, allowUpscale = true,
  pixel = null,
}) {
  const buffer = await readFile(sheetFile)
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '合集图解不开（只支持 8bit PNG，非隔行）' }
  await ensureDir(outDir)
  const computed = computeSlices({
    decoded, items, columns, rows, padding, trim, clean,
    targetWidth, targetHeight, mode, alphaThreshold, allowUpscale, encode: true, pixel,
  })
  if (!computed.ok) return computed

  /* 【第八十一轮修】这里必须解构 grid_erase ——
   * 下面第 274 行 return 时要用它，但原本只解构了 5 个字段，
   * 于是 sliceSheet 一进来就抛 `gridErase is not defined`，**合集图工具整条不可用**。
   * （computeSlices 里那个 gridErase 是它自己的局部变量，这里要用的是它返回的值。） */
  const { width, height, grid, slices, warnings, grid_erase: gridErase } = computed
  const results = []
  for (const slice of slices) {
    const file = path.join(outDir, `${slice.name}.png`)
    await writeFile(file, slice.png)
    results.push({
      name: slice.name,
      file,
      width: slice.width,
      height: slice.height,
      cell: slice.cell,
      alignment: slice.alignment,
      trim: slice.trim,
      filled_ratio: slice.filled_ratio,
      main_share: slice.main_share,
      dropped_specks: slice.dropped_specks,
      fitted: slice.fitted,
    })
  }
  const cellW = grid.cellWidth
  const cellH = grid.cellHeight
  return {
    ok: true,
    sheet: { file: sheetFile, width, height },
    grid,
    slices: results,
    auto_trim: Boolean(trim),
    auto_clean: Boolean(clean),
    pixel: computed.pixel,
    pixel_purity: computed.pixel_purity,
    grid_erase: gridErase ? { columns: gridErase.columns, rows: gridErase.rows, pixels: gridErase.pixels } : undefined,
    target: computed.target,
    warnings: warnings.slice(0, 12),
    note: trim
      ? `切成 ${results.length} 张，**已自动对齐**（裁掉每格多余留白并居中${targetWidth ? `，缩放到 ${targetWidth}×${targetHeight}` : ''}）。`
        + (warnings.length > 0 ? ` 有 ${warnings.length} 张需要留意（见 warnings）。` : '')
      : `切成 ${results.length} 张（固定格子 ${cellW}×${cellH}，未 trim）。`,
    hint: '对齐后的图已经是「可直接用」的尺寸；装进游戏用 install/register。',
  }
}

/** 从大图里抠一块出来（绝对坐标）。已移到 autotrim.js 统一维护。 */

/**
 * 一个请求出一整张图标集。
 * @param {{runImage:Function, profiles:object, gallery:object, settings:object,
 *          args:{items:string[], project:string, style?:string, name?:string, size?:string,
 *                quality?:string, output?:string, background?:string}}} params
 */
export async function generateSheet({ runImage, profiles, gallery, settings, args = {} }) {
  const items = (args.items ?? []).map((item) => (typeof item === 'string' ? item : item.prompt ?? item.name ?? ''))
  if (items.length === 0) return { ok: false, error: 'items 为空：给一组图标描述' }
  const { columns, rows, capacity } = gridFor(items.length)
  if (items.length > capacity) items.length = capacity
  const prompt = sheetPrompt({ items, columns, rows, style: args.style ?? '', background: args.background ?? 'transparent' })
  const name = safeSegment(args.name || `sheet_${items.length}`, 'sheet')

  // 合集图本身要够大，否则切出来每格太小
  const size = args.size || (items.length <= 4 ? '1024x1024' : '1536x1024')
  const generated = await runImage({
    profiles,
    gallery,
    settings,
    args: { prompt, project: args.project, name, size, quality: args.quality ?? 'low', kind: 'sprite-sheet', output: args.output },
  })
  if (!generated.ok) return { ok: false, error: generated.error, one_request_saved: items.length - 1 }
  const sheetFile = (generated.files ?? [])[0]
  if (!sheetFile) return { ok: false, error: '合集图没有落盘' }

  const outDir = path.join(path.dirname(sheetFile), `${name}_slices`)
  const sliced = await sliceSheet({
    sheetFile, outDir, columns, rows,
    items: items.map((item, index) => ({ name: `${name}_${String(index + 1).padStart(2, '0')}` })),
    pixel: args.pixel ?? null,
    targetWidth: args.slice_width ?? 0, targetHeight: args.slice_height ?? 0,
  })
  if (!sliced.ok) return { ok: false, error: sliced.error, sheet: sheetFile }

  return {
    ok: true,
    sheet: { file: sheetFile, requested_size: size },
    grid: sliced.grid,
    slices: sliced.slices,
    pixel: sliced.pixel,
    pixel_purity: sliced.pixel_purity,
    requests_used: 1,
    requests_saved: Math.max(0, items.length - 1),
    cost_note: `一个请求出了 ${items.length} 个图标（分开画要 ${items.length} 个请求）—— 省 ${Math.max(0, items.length - 1)} 个请求的等待与失败风险。`,
    prompt,
    hint: '把 slices 里的单张按规格 install/register 进游戏；切得不准就调 padding 或让模型强调格子留白。'
      + (sliced.pixel ? `已逐格像素化到 ${sliced.pixel.per_cell} 逻辑像素。` : '要真像素画就传 pixel={width:32,height:32}（每格逻辑像素数）。'),
  }
}