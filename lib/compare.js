/**
 * 审核对比视图的数据源（prompt 2）。
 *
 * 要解决的问题：现在审核只能看 64×16 缩略图，判断不了裁剪对不对、颜色对不对、
 * 与相邻帧连不连贯 —— 审核员是在**猜**。
 *
 * 做法：给一张素材算出一组「对比用」的图，四格并排看：
 *   ① 原图（完整大图）
 *   ② 切片预览（**实时算**，不读磁盘上的 _slices/）
 *   ③ 游戏实际尺寸（缩到引擎真正渲染的尺寸）
 *   ④ 相邻帧（前一张 + 后一张，判断连贯性）
 *
 * 关键约束（prompt 2 明确要求）：
 *   - 切片预览**必须实时算**，这样改规则能立刻看到效果，不用先切一遍
 *   - **不写盘**：全部以 data URL 返回，内存里算完就丢
 *   - 大图要降采样，不能卡死
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { computeSlices } from './sheet.js'
import { fitToTarget } from './autotrim.js'
import { sliceRuleFor } from './assets.js'

/** data URL 的内联上限：超过就只给文件 URL，避免一次几 MB 把浏览器拖死。 */
export const INLINE_LIMIT_BYTES = 3 * 1024 * 1024
/** 对比预览最长边（降采样目标）——审核看构图够用，又不至于卡。 */
export const PREVIEW_MAX_EDGE = 768

/**
 * 降采样到不超过 maxEdge（保持比例）。用最近邻即可：这里只为"看清楚"，
 * 不追求画质；而且最近邻能保住像素边界，反而更容易看出切得准不准。
 */
export function downscale(decoded, maxEdge = PREVIEW_MAX_EDGE) {
  const { width, height, pixels } = decoded
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height, pixels, scaled: false }
  const ratio = maxEdge / longest
  const outW = Math.max(1, Math.round(width * ratio))
  const outH = Math.max(1, Math.round(height * ratio))
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / outH))
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / outW))
      const from = (sy * width + sx) * 4
      const to = (y * outW + x) * 4
      out[to] = pixels[from]
      out[to + 1] = pixels[from + 1]
      out[to + 2] = pixels[from + 2]
      out[to + 3] = pixels[from + 3]
    }
  }
  return { width: outW, height: outH, pixels: out, scaled: true, from: `${width}×${height}` }
}

function dataUrl(png) {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

/**
 * 组装一张素材的对比数据。
 *
 * @param {{file:string, name:string, kind:string, expected?:{size?:{width,height,transparent}},
 *          siblings?:string[], rule?:object, grid?:{columns,rows}}} params
 */
export async function buildCompare({ file, name, kind = 'source', expected = null, siblings = [], rule = null, }) {
  const out = { ok: true, file, name, kind, panes: [], notes: [] }
  let decoded
  try {
    decoded = decodePngRgba(await readFile(file))
  } catch (error) {
    return { ok: false, error: `读不到或解不开：${error?.message ?? error}` }
  }
  if (!decoded) return { ok: false, error: '只支持 8bit 非隔行 PNG' }
  out.source = { width: decoded.width, height: decoded.height }

  // ① 原图（降采样后内联）
  const small = downscale(decoded, PREVIEW_MAX_EDGE)
  out.panes.push({
    id: 'original',
    label: '原图',
    detail: `${decoded.width}×${decoded.height}${small.scaled ? `（预览降采样到 ${small.width}×${small.height}）` : ''}`,
    url: dataUrl(encodePngRgba(small.width, small.height, small.pixels)),
  })

  // ② 切片预览：**实时算**，不读磁盘上的 _slices/
  const effectiveRule = rule ?? sliceRuleFor({ name, kind, expected })
  if (effectiveRule && effectiveRule.columns > 0) {
    const { columns, rows } = effectiveRule
    const items = Array.from({ length: columns * rows }, (_, i) => ({ name: `${name}_${String(i + 1).padStart(2, '0')}` }))
    const computed = computeSlices({
      decoded, items, columns, rows, trim: true,
      targetWidth: expected?.size?.width ?? 0,
      targetHeight: expected?.size?.height ?? 0,
      encode: true,
    })
    if (computed.ok) {
      out.slice_preview = {
        columns, rows,
        source: effectiveRule.source,
        // 拼一张「切完长什么样」的总览：每格并排画出来，一眼看出裁剪对不对
        cells: computed.slices.map((slice) => ({
          name: slice.name,
          cell: slice.cell,
          size: `${slice.width}×${slice.height}`,
          alignment: slice.alignment,
          filled_ratio: slice.filled_ratio,
          main_share: slice.main_share,
          url: dataUrl(slice.png),
        })),
        warnings: computed.warnings.slice(0, 8),
        detail: `${columns}×${rows} 网格，切成 ${computed.slices.length} 张（实时计算，未写盘）`,
      }
      out.panes.push({
        id: 'slice',
        label: '切片预览',
        detail: out.slice_preview.detail,
        url: out.slice_preview.cells[0]?.url ?? '',
        cells: out.slice_preview.cells,
      })
    } else {
      out.notes.push(`切片预览失败：${computed.error}`)
    }
  } else {
    out.notes.push('这张素材没有切片规则（preview/screenshot 或名字里没有格数）→ 对比视图退化为两格。')
  }

  // ③ 游戏实际尺寸：缩到清单声明的规格，看在小尺寸下还认不认得出
  const target = expected?.size
  if (target?.width && target?.height) {
    const fitted = fitToTarget({
      pixels: decoded.pixels, width: decoded.width, height: decoded.height,
      targetWidth: target.width, targetHeight: target.height, mode: 'contain', allowUpscale: true,
    })
    // 再放大回来一点才看得清（按 8 倍最近邻），否则 48×48 在屏幕上太小
    const zoom = Math.max(1, Math.min(8, Math.round(PREVIEW_MAX_EDGE / Math.max(target.width, target.height))))
    const shown = zoom > 1
      ? (() => {
          const w = fitted.width * zoom
          const h = fitted.height * zoom
          const px = new Uint8ClampedArray(w * h * 4)
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const from = (Math.floor(y / zoom) * fitted.width + Math.floor(x / zoom)) * 4
              const to = (y * w + x) * 4
              px[to] = fitted.pixels[from]; px[to + 1] = fitted.pixels[from + 1]
              px[to + 2] = fitted.pixels[from + 2]; px[to + 3] = fitted.pixels[from + 3]
            }
          }
          return { width: w, height: h, pixels: px }
        })()
      : fitted
    out.panes.push({
      id: 'ingame',
      label: '游戏实际尺寸',
      detail: `${target.width}×${target.height}${zoom > 1 ? `（放大 ${zoom}× 便于看清）` : ''}${expected.transparent ? '，要透明底' : ''}`,
      url: dataUrl(encodePngRgba(shown.width, shown.height, shown.pixels)),
    })
  } else {
    out.notes.push('清单里没有这张的尺寸要求 → 无法预览游戏实际尺寸。')
    out.panes.push({ id: 'ingame', label: '游戏实际尺寸', detail: '无规格', url: '', empty: true })
  }

  // ④ 相邻帧：前后各一张，判断连贯性（第一张/最后一张显示占位）
  const index = siblings.findIndex((item) => path.resolve(item) === path.resolve(file))
  const prev = index > 0 ? siblings[index - 1] : null
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null
  const neighbour = async (target_, label) => {
    if (!target_) return { label, detail: label === '上一张' ? '这是第一张' : '这是最后一张', url: '', empty: true }
    try {
      const decodedN = decodePngRgba(await readFile(target_))
      if (!decodedN) return { label, detail: '解不开', url: '', empty: true }
      const smallN = downscale(decodedN, 384)
      return {
        label,
        detail: path.basename(target_),
        url: dataUrl(encodePngRgba(smallN.width, smallN.height, smallN.pixels)),
      }
    } catch {
      return { label, detail: '读不到', url: '', empty: true }
    }
  }
  out.panes.push(await neighbour(prev, '上一张'))
  out.panes.push(await neighbour(next, '下一张'))
  out.neighbours = { prev, next, index, total: siblings.length }

  return out
}
