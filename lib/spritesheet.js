/**
 * 多帧动画：**视频 → 抽帧 → 抠底 → 对齐打包 → 精灵表 + JSON**
 *
 * ┌─ 为什么是这条路（研究结论）──────────────────────────────────────────┐
 * │ 让模型"一张一张生成连贯的帧"是**做不到**的：逐帧生图之间没有任何机制        │
 * │ 约束一致性 —— 每张都是独立采样，角色会漂、光照会变、比例会跳。              │
 * │                                                                  │
 * │ 视频模型不一样：**时间连贯性是它训练目标的一部分**（相邻帧必须在隐空间里靠近， │
 * │ 否则视频会闪）。所以正确做法是：                                    │
 * │                                                                  │
 * │   ① 生成/选定角色参考图（锁外观）                                    │
 * │   ② 让**视频模型**生成一段动画（连贯性由模型保证）                      │
 * │   ③ 按目标帧率**抽帧**                                            │
 * │   ④ 抠底得到透明 alpha                                             │
 * │   ⑤ **所有帧用同一个包围盒**对齐打包（关键：逐帧各自紧裁会让角色抖动）      │
 * │   ⑥ 出精灵表 PNG + 描述 JSON                                      │
 * │                                                                  │
 * │ 这也是这个圈子里的主流做法（AutoSprite / SpriteMaster / video2sprites / │
 * │ ComfyUI 的 sprite-sheet 工作流，都是"video → frames → sheet"）。      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 依赖：ffmpeg（外部程序）。找不到会**明确报错并给安装指引**，不静默失败。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { findLoopPoint } from './anchor.js'

const run = promisify(execFile)

/* ============================================================================
 * 一、找 ffmpeg
 * ========================================================================== */

/** 常见安装位置（Windows 上 ffmpeg 很少在 PATH 里，多半躺在某个软件目录下）。 */
const FFMPEG_GUESSES = [
  'ffmpeg',
  'ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
]

/**
 * 找可用的 ffmpeg。
 * 顺序：显式指定 → 环境变量 FFMPEG_PATH / DSH_FFMPEG → PATH → 常见候选 → 浅层按层扫描。
 *
 * 结果缓存在模块级：一次进程里只扫一次（扫描可能要几百毫秒到几秒，不该每次工具调用都付）。
 */
let ffmpegCache = null
export async function findFfmpeg({ explicit = '', scanRoots = null, timeoutMs = 8000, timeBudgetMs = 8000, fresh = false } = {}) {
  if (!fresh && ffmpegCache && !explicit) return ffmpegCache
  const tryOne = async (candidate, source) => {
    if (!candidate) return null
    try {
      const { stdout, stderr } = await run(candidate, ['-version'], { timeout: timeoutMs, windowsHide: true })
      const text = `${stdout}\n${stderr}`
      const version = (text.match(/ffmpeg version ([^\s]+)/i) ?? [])[1] ?? ''
      if (!version) return null
      return { path: candidate, version, source }
    } catch { return null }
  }

  const envPaths = [String(process.env.FFMPEG_PATH ?? '').trim(), String(process.env.DSH_FFMPEG ?? '').trim()].filter(Boolean)
  const candidates = [
    [explicit, '参数指定'],
    ...envPaths.map((p) => [p, '环境变量']),
    ...FFMPEG_GUESSES.map((c) => [c, c === 'ffmpeg' || c === 'ffmpeg.exe' ? 'PATH' : '常见位置']),
  ]
  for (const [candidate, source] of candidates) {
    const hit = await tryOne(candidate, source)
    if (hit) { if (!explicit) ffmpegCache = hit; return hit }
  }

  /* 最后兜底：按层浅扫几个根目录。
   * 为什么值得做：这台机器上 ffmpeg 就躺在剪映和 ComfyUI 的目录里，用户根本不知道有。
   * 为什么必须按层（BFS）：D:\ 有 167 个顶层目录，DFS 会一头扎进某个子树把配额烧光。
   * 为什么配额要给这么大：167 个目录 × 每个几十项就到几千了，6000 根本不够（实测没找到）。 */
  const roots = scanRoots ?? ['D:\\', 'C:\\Program Files', 'C:\\Program Files (x86)', path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean)
  for (const root of roots) {
    const found = await shallowFind(root, 'ffmpeg.exe', { maxDepth: 3, limit: 80000, timeBudgetMs }).catch(() => null)
    if (found) {
      const hit = await tryOne(found, '浅层扫描')
      if (hit) { if (!explicit) ffmpegCache = hit; return hit }
    }
  }
  return null
}

/**
 * 按层扫描找文件（BFS + 时间预算）。
 *
 * 为什么必须是 BFS 而不是递归 DFS：
 *   这台机器 D:\ 有 167 个顶层目录，DFS 会一头扎进第一个子树，
 *   把配额和时间全花在很深的目录里，等不到浅层的目标就超限了（实测没找到）。
 *   按层扫保证"深度 2 的目标在第 2 层就被检查"，和子树大小无关。
 *
 * 同时带时间预算：宁可找不到，也不能让一次工具调用卡几十秒。
 */
async function shallowFind(root, name, { maxDepth = 3, limit = 6000, timeBudgetMs = 6000 } = {}) {
  const started = Date.now()
  const target = name.toLowerCase()
  let visited = 0
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next = []
    for (const dir of level) {
      if (Date.now() - started > timeBudgetMs) return null
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (Date.now() - started > timeBudgetMs) return null
        visited += 1
        if (visited > limit) return null
        if (entry.isFile() && entry.name.toLowerCase() === target) return path.join(dir, entry.name)
        if (!entry.isDirectory()) continue
        if (/^(Windows|System32|node_modules|\.git|\$Recycle|System Volume Information|ProgramData|AppData)$/i.test(entry.name)) continue
        next.push(path.join(dir, entry.name))
      }
    }
    level = next
  }
  return null
}

/* ============================================================================
 * 二、探视频信息
 * ========================================================================== */

/**
 * 读视频的时长/分辨率/帧率。
 * 没有 ffprobe 也能用：解析 `ffmpeg -i` 写到 stderr 的那段信息。
 * @returns {{ok:boolean, width:number, height:number, fps:number, durationSec:number, raw?:string, error?:string}}
 */
export async function probeVideo({ ffmpeg, video, timeoutMs = 20000 } = {}) {
  const info = await stat(video).catch(() => null)
  if (!info?.isFile()) return { ok: false, error: `读不到视频文件：${video}` }
  let stderr = ''
  try {
    // ffmpeg -i 没有输出文件时会以非 0 退出，这是正常的 —— 信息在 stderr 里
    const result = await run(ffmpeg, ['-hide_banner', '-i', video], { timeout: timeoutMs, windowsHide: true })
    stderr = `${result.stdout}\n${result.stderr}`
  } catch (error) {
    stderr = String(error?.stderr ?? error?.stdout ?? error?.message ?? '')
  }
  const duration = (stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/) ?? [])
  const durationSec = duration.length >= 4
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : 0
  const stream = stderr.match(/Video:\s*[^\n]*?,\s*(\d{2,5})x(\d{2,5})[^\n]*?([\d.]+)\s*fps/) ?? null
  const width = stream ? Number(stream[1]) : 0
  const height = stream ? Number(stream[2]) : 0
  const fps = stream ? Number(stream[3]) : 0
  if (!width || !height) {
    return { ok: false, error: `解析不出视频尺寸（是不是不是视频文件？）`, raw: stderr.slice(0, 600) }
  }
  return {
    ok: true, width, height, fps, durationSec,
    ...(durationSec > 0 && fps > 0 ? { estimatedFrames: Math.round(durationSec * fps) } : {}),
  }
}

/* ============================================================================
 * 三、抽帧
 * ========================================================================== */

/**
 * 从视频抽帧（输出 PNG）。
 *
 * 帧率怎么定：
 *   给了 count → fps = count / duration（"我要 8 帧"最直观，而且和时长解耦）
 *   给了 fps   → 按该帧率抽
 *   都没给    → 12fps（游戏 sprite 的常用值，比视频原帧率省很多）
 *
 * @returns {{ok:boolean, frames:string[], dir:string, fps:number, count:number, error?:string}}
 */
export async function extractFrames({
  ffmpeg, video, outDir, fps = null, count = null, durationSec = 0,
  startSec = 0, endSec = null, maxWidth = null, timeoutMs = 180000,
  selectIndices = null,
} = {}) {
  if (!ffmpeg) return { ok: false, error: '没有可用的 ffmpeg' }
  if (!video) return { ok: false, error: 'extractFrames 需要 video' }
  const info = await stat(video).catch(() => null)
  if (!info?.isFile()) return { ok: false, error: `读不到视频：${video}` }
  const dir = outDir || path.join(os.tmpdir(), `frames-${Date.now().toString(36)}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  let targetFps = Number(fps) || 0
  if (!targetFps && count && durationSec > 0) targetFps = Math.max(1, Number(count) / durationSec)
  if (!targetFps) targetFps = 12
  // 帧率夹取：低于 1 帧/秒没意义，高于 60 只是浪费
  targetFps = Math.min(60, Math.max(1, targetFps))

  const filters = [`fps=${Number(targetFps.toFixed(4))}`]
  if (maxWidth) filters.push(`scale='min(${Math.round(maxWidth)},iw)':-2:flags=lanczos`)
  /* selectIndices：只把指定的这几帧写到磁盘。
   * 为什么重要：autoLoop 要抽 count×5 帧才够找出周期，但最终只用 count 帧。
   * 老做法是"全抽出来 → 全抠底 → 丢掉 80%"，50 帧就是 100 个 PNG 白写白抠。
   * 有了它就能「先用小图粗筛，再只抽要的那几帧全尺寸」。 */
  const picks = Array.isArray(selectIndices) ? selectIndices.filter((n) => Number.isInteger(n) && n >= 0) : []
  if (picks.length > 0) {
    // ffmpeg filter 里逗号必须转义成 \,
    filters.push(`select='${picks.map((n) => `eq(n\\,${n})`).join('+')}'`)
  }
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (startSec > 0) args.push('-ss', String(startSec))
  args.push('-i', video)
  if (endSec !== null && endSec > startSec) args.push('-t', String(endSec - startSec))
  args.push('-vf', filters.join(','))
  if (picks.length > 0) args.push('-vsync', '0')
  else if (count) args.push('-frames:v', String(Math.round(count)))
  args.push(path.join(dir, 'f_%04d.png'))

  try {
    await run(ffmpeg, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    return { ok: false, error: `ffmpeg 抽帧失败：${String(error?.stderr ?? error?.message ?? error).slice(0, 400)}`, dir }
  }
  const files = (await readdir(dir)).filter((name) => /^f_\d+\.png$/i.test(name)).sort()
  if (files.length === 0) return { ok: false, error: 'ffmpeg 成功退出但没产出任何帧（视频可能没有视频流）', dir }
  return {
    ok: true,
    frames: files.map((name) => path.join(dir, name)),
    dir,
    fps: Number(targetFps.toFixed(3)),
    count: files.length,
    /* 用 select 取帧时，返回的 frames[i] 对应的是原时间线上的 picks[i] ——
     * 上层要拿它做"粗筛帧 → 精选帧"的对应关系。 */
    ...(picks.length > 0 ? { pickedIndices: picks } : {}),
  }
}

/* ============================================================================
 * 四、抠底（透明化）
 * ========================================================================== */

/**
 * 把**边缘连通**的纯色背景抠成透明。
 *
 * 为什么用"从边缘泛洪"而不是"全图颜色匹配"：
 *   全图匹配会把角色身上与背景同色的区域一起抠掉（白底上的白牙、黑底上的黑靴）。
 *   从边缘泛洪只吃"和外面连在一起"的那一片，角色内部的同色区安全。
 *
 * @param {Buffer} buffer PNG
 * @param {object} options
 * @param {number} [options.tolerance] 颜色距离容差（0~441，默认 46）
 * @param {boolean} [options.requireUniformBg] 边缘颜色差异过大时是否放弃（默认 true）
 * @returns {{ok:boolean, buffer?:Buffer, changed?:number, bg?:number[], note?:string, error?:string}}
 */
export function alphaFromEdgeBackground(buffer, { tolerance = 46, requireUniformBg = true } = {}) {
  const decoded = decodePngRgba(buffer)
  if (!decoded) return { ok: false, error: '解不开（只支持 8bit PNG）' }
  const { pixels, width, height } = decoded

  // 1) 采样四条边，取出现最多的颜色当背景色
  const counts = new Map()
  const sample = (x, y) => {
    const i = (y * width + x) * 4
    const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (let x = 0; x < width; x++) { sample(x, 0); sample(x, height - 1) }
  for (let y = 0; y < height; y++) { sample(0, y); sample(width - 1, y) }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const [bgKey, bgCount] = sorted[0] ?? ['0,0,0', 0]
  const bg = bgKey.split(',').map(Number)
  const borderTotal = width * 2 + height * 2
  const share = bgCount / Math.max(1, borderTotal)

  // 边缘颜色不统一 → 可能不是"纯色背景"，强行抠会挖出奇怪的洞
  if (requireUniformBg && share < 0.5) {
    return {
      ok: false,
      error: `边缘颜色不统一（主色只占 ${(share * 100).toFixed(0)}%），不像纯色背景`,
      note: '如果是渐变/实景背景，需要真正的分割模型；或者让视频模型直接输出纯色底。',
      bg,
    }
  }

  const dist = (i) => Math.abs(pixels[i] - bg[0]) + Math.abs(pixels[i + 1] - bg[1]) + Math.abs(pixels[i + 2] - bg[2])
  const visited = new Uint8Array(width * height)
  const queue = []
  const pushIfBg = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const flat = y * width + x
    if (visited[flat]) return
    const i = flat * 4
    if (pixels[i + 3] < 8) { visited[flat] = 1; queue.push(flat); return }   // 本来透明：也算背景，继续扩
    if (dist(i) > tolerance) return
    visited[flat] = 1
    queue.push(flat)
  }
  for (let x = 0; x < width; x++) { pushIfBg(x, 0); pushIfBg(x, height - 1) }
  for (let y = 0; y < height; y++) { pushIfBg(0, y); pushIfBg(width - 1, y) }

  let changed = 0
  while (queue.length > 0) {
    const flat = queue.pop()
    const i = flat * 4
    if (pixels[i + 3] !== 0) changed += 1
    pixels[i + 3] = 0
    const x = flat % width
    const y = (flat - x) / width
    pushIfBg(x - 1, y); pushIfBg(x + 1, y); pushIfBg(x, y - 1); pushIfBg(x, y + 1)
  }

  return {
    ok: true,
    buffer: encodePngRgba(width, height, pixels),
    changed,
    bg,
    share: Number(share.toFixed(3)),
    note: `背景色 rgb(${bg.join(',')})，抠掉 ${changed} 像素（${(changed / (width * height) * 100).toFixed(1)}%）`,
  }
}

/* ============================================================================
 * 五、对齐打包（防抖动的关键）
 * ========================================================================== */

/** 算单张图的不透明包围盒。 */
function opaqueBounds(pixels, width, height, alphaThreshold = 8) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < alphaThreshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 把一组帧打包成精灵表。
 *
 * ★ 最关键的一条：**所有帧必须用同一个包围盒（union）**。
 *   逐帧各自紧裁再居中，会让角色每帧位置微微不同 —— 播起来就是"抖动"，
 *   这是 AI 视频转精灵表最常见的翻车点。所以这里先算 union，再统一裁。
 *
 * @param {object} params
 * @param {string[]} params.frames PNG 路径（已抠好底）
 * @param {number} [params.columns] 每行几帧（默认全部一行）
 * @param {number} [params.scale] 放大倍数（1=原尺寸；像素风建议整数倍）
 * @param {number} [params.dropDuplicateLast] 循环动画：末帧和首帧几乎一样时丢掉（默认 true）
 * @param {number} [params.pad] union 包围盒外再留的边（默认 1）
 * @param {boolean} [params.alignBottom] 以底边对齐（角色站立类常用；默认 false = 用 union 顶部）
 */
export async function packSpriteSheet({
  frames = [], columns = null, scale = 1, dropDuplicateLast = true, pad = 1, equalize = true,
} = {}) {
  const decoded = []
  for (const file of frames) {
    const buffer = await readFile(file).catch(() => null)
    if (!buffer) return { ok: false, error: `读不到帧：${file}` }
    const png = decodePngRgba(buffer)
    if (!png) return { ok: false, error: `帧解不开（要 8bit PNG）：${file}` }
    decoded.push({ file, ...png })
  }
  if (decoded.length === 0) return { ok: false, error: '没有帧' }

  // 尺寸必须一致（ffmpeg 抽出来的本来就一致，手工喂的可能不一致）
  const w0 = decoded[0].width
  const h0 = decoded[0].height
  const sizeMismatch = decoded.filter((f) => f.width !== w0 || f.height !== h0)
  if (sizeMismatch.length > 0) {
    return { ok: false, error: `帧尺寸不一致：第一帧 ${w0}×${h0}，另有 ${sizeMismatch.length} 帧不同` }
  }

  // 循环动画：末帧 ≈ 首帧时丢掉（否则播完会多停一帧）
  let used = decoded
  let droppedLast = false
  if (dropDuplicateLast && decoded.length > 2) {
    const first = opaqueBounds(decoded[0].pixels, w0, h0)
    const last = opaqueBounds(decoded[decoded.length - 1].pixels, w0, h0)
    const same = first && last
      && Math.abs(first.minX - last.minX) <= 1 && Math.abs(first.minY - last.minY) <= 1
      && Math.abs(first.w - last.w) <= 1 && Math.abs(first.h - last.h) <= 1
    if (same) { used = decoded.slice(0, -1); droppedLast = true }
  }

  // union 包围盒（所有帧一起算）
  let uMinX = w0; let uMinY = h0; let uMaxX = -1; let uMaxY = -1
  for (const frame of used) {
    const b = opaqueBounds(frame.pixels, w0, h0)
    if (!b) continue
    if (b.minX < uMinX) uMinX = b.minX
    if (b.minY < uMinY) uMinY = b.minY
    if (b.maxX > uMaxX) uMaxX = b.maxX
    if (b.maxY > uMaxY) uMaxY = b.maxY
  }
  if (uMaxX < 0) return { ok: false, error: '所有帧都是全透明（抠底抠过头了？）' }

  const cellW = Math.max(1, Math.round((uMaxX - uMinX + 1 + pad * 2) * scale))
  const cellH = Math.max(1, Math.round((uMaxY - uMinY + 1 + pad * 2) * scale))
  const count = used.length
  const cols = Math.max(1, Math.min(count, Number(columns) || count))
  const rows = Math.ceil(count / cols)
  const sheetW = cols * cellW
  const sheetH = rows * cellH
  const sheet = new Uint8ClampedArray(sheetW * sheetH * 4)

  for (let index = 0; index < count; index++) {
    const frame = used[index]
    const col = index % cols
    const row = Math.floor(index / cols)
    const cellX = col * cellW
    const cellY = row * cellH
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        // 目标格内像素 → 源图坐标（用 union 原点 + pad，保证所有帧同一套映射）
        const sx = Math.floor(x / scale) + uMinX - pad
        const sy = Math.floor(y / scale) + uMinY - pad
        if (sx < 0 || sy < 0 || sx >= w0 || sy >= h0) continue
        const si = (sy * w0 + sx) * 4
        if (frame.pixels[si + 3] === 0) continue
        const di = ((cellY + y) * sheetW + (cellX + x)) * 4
        sheet[di] = frame.pixels[si]
        sheet[di + 1] = frame.pixels[si + 1]
        sheet[di + 2] = frame.pixels[si + 2]
        sheet[di + 3] = frame.pixels[si + 3]
      }
    }
  }

  return {
    ok: true,
    buffer: encodePngRgba(sheetW, sheetH, sheet),
    width: sheetW, height: sheetH,
    cell: [cellW, cellH],
    columns: cols, rows,
    count,
    scale,
    union: { x: uMinX, y: uMinY, w: uMaxX - uMinX + 1, h: uMaxY - uMinY + 1 },
    droppedLast,
    frames: used.map((f) => path.basename(f.file)),
    note: `精灵表 ${sheetW}×${sheetH}，${count} 帧（${cols}×${rows}），每格 ${cellW}×${cellH}`
      + (droppedLast ? '；末帧与首帧重复已丢弃' : ''),
  }
}

/* ============================================================================
 * 六、动画描述 JSON（引擎无关）
 * ========================================================================== */

/**
 * 生成精灵表描述 JSON。
 * 这是最小可用的一套：谁都能吃。
 */
export function buildSheetJson({
  name = 'animation', sheet = 'sheet.png', sheetWidth = 0, sheetHeight = 0,
  cell = [0, 0], columns = 1, rows = 1, count = 0, fps = 12, loop = true,
  scale = 1, union = null, pivot = null,
} = {}) {
  return {
    version: 1,
    name,
    image: sheet,
    imageSize: [sheetWidth, sheetHeight],
    cell: { x: 0, y: 0, w: cell[0], h: cell[1] },
    grid: { columns, rows, count },
    fps,
    frameDurationMs: Math.round(1000 / Math.max(1, fps)),
    loop: Boolean(loop),
    scale,
    /* pivot：每格内的锚点（归一化 0~1）。默认底边中点 —— 站立角色贴地最常见的锚点。 */
    pivot: pivot ?? [0.5, 1],
    union,
    frames: Array.from({ length: count }, (_, i) => ({
      index: i,
      col: i % Math.max(1, columns),
      row: Math.floor(i / Math.max(1, columns)),
      x: (i % Math.max(1, columns)) * cell[0],
      y: Math.floor(i / Math.max(1, columns)) * cell[1],
      w: cell[0], h: cell[1],
    })),
    usage: '按 frames[i].x/y/w/h 从 image 里取格；播放顺序就是 frames 顺序；时间间隔 frameDurationMs。',
  }
}

/* ============================================================================
 * 七、一条龙：视频 → 精灵表
 * ========================================================================== */

/**
 * 完整流程。每一步的产物都留在工作目录里，方便中途排查。
 *
 * @param {object} params
 * @param {string} [params.video] 输入视频
 * @param {string} params.outDir 输出目录
 * @param {number} [params.count] 要几帧
 * @param {number} [params.fps] 或者直接给帧率
 * @param {boolean} [params.alpha] 是否抠底（默认 true）
 * @param {number} [params.columns] 精灵表每行几帧
 * @param {number} [params.scale] 放大倍数
 * @param {string} [params.ffmpeg] 显式指定 ffmpeg
 * @param {string} [params.name] 动画名
 * @param {boolean} [params.loop] 是否循环
 */
export async function videoToSpriteSheet({
  video, outDir, count = null, fps = null, alpha = true, tolerance = 46,
  columns = null, scale = 1, ffmpeg = '', name = 'animation', loop = true,
  maxWidth = null, startSec = 0, endSec = null,
  deleteVideo = true, keepRawFrames = false, force = false,
} = {}) {
  if (!outDir) return { ok: false, error: '需要 outDir' }
  await mkdir(outDir, { recursive: true })

  /* ── 缓存：同一段视频 + 同一套参数，不重复跑 ──────────────────────────
   * 为什么值得做：一段 5 秒视频抽帧 + 抠 50 张要几秒，但用户常常只改 scale 或
   * columns 就重跑；而且 i2v 出来后通常要试好几个帧数。缓存能直接省掉整条链路。
   * 判重依据：视频的 路径 + 字节数 + mtime（内容变了 mtime 必变）+ 影响结果的参数。
   * force=true 强制重跑。 */
  const paramsKey = JSON.stringify({
    count, fps, alpha, tolerance, columns, scale, name,
    loop, maxWidth, startSec, endSec, keepRawFrames,
  })
  const cacheFile = path.join(outDir, `${name}.cache.json`)
  const videoInfo = await stat(video).catch(() => null)
  if (!force && videoInfo) {
    const cached = await readFile(cacheFile, 'utf8').then((text) => JSON.parse(text)).catch(() => null)
    const same = cached
      && cached.video?.path === video
      && cached.video?.size === videoInfo.size
      && cached.video?.mtimeMs === Math.round(videoInfo.mtimeMs)
      && cached.paramsKey === paramsKey
    if (same) {
      const sheetOk = await stat(cached.result?.sheet?.file ?? '').then((s) => s.isFile()).catch(() => false)
      const jsonOk = await stat(cached.result?.json ?? '').then((s) => s.isFile()).catch(() => false)
      if (sheetOk && jsonOk) {
        return {
          ...cached.result,
          cached: true,
          note: (cached.result.note ?? '') + '（命中缓存，没有重复抽帧；要强制重跑就传 force=true）',
        }
      }
    }
  }

  const found = await findFfmpeg({ explicit: ffmpeg })
  if (!found) {
    return {
      ok: false, stage: 'ffmpeg',
      error: '找不到 ffmpeg，无法抽帧。',
      howToFix: [
        '装一个：winget install --id Gyan.FFmpeg   （或 https://ffmpeg.org/download.html 下 zip 解压后加进 PATH）',
        '已经有的话，把路径告诉插件：设环境变量 FFMPEG_PATH，或调用时传 ffmpeg="D:\\\\...\\\\ffmpeg.exe"',
      ],
    }
  }

  const probed = await probeVideo({ ffmpeg: found.path, video })
  if (!probed.ok) return { ok: false, stage: 'probe', error: probed.error, ffmpeg: found, raw: probed.raw }

  /* loop === 'auto'：先**小图粗筛**找周期，再**只抽要的那几帧全尺寸**。
   *
   * 为什么这么绕：视频模型给的是一段连续运动，"取前 N 帧"会在末尾顿一下；
   * 要找出真正的周期，就得先看到足够长的序列（count×5 帧）。
   * 但最终只用 count 帧 —— 老做法是"全抽出来 → 全抠底 → 丢掉 80%"，
   * 一个 10 帧的需求会白写白抠 50 帧（100 个 PNG）。
   * 现在改成：
   *   ① 粗筛：count×5 帧，缩到 160px 宽 → 找周期（小图足够，指纹本来就是 16×16）
   *   ② 精选：一次 ffmpeg select 调用，只把那 count 帧按全尺寸抽出来
   *   ③ 只抠这 count 帧
   * 磁盘写入从 100 个文件降到十几张，抠底次数从 50 降到 10。
   */
  const autoLoop = loop === 'auto'
  const wantCount = Number(count) || 8
  const extractCount = autoLoop
    ? Math.min(60, Math.max(wantCount * 5, 40))
    : count ?? null

  const coarseLimit = 160
  const extracted = await extractFrames({
    ffmpeg: found.path, video,
    outDir: path.join(outDir, autoLoop ? 'frames_probe' : 'frames'),
    fps: autoLoop ? null : fps,
    count: extractCount,
    durationSec: probed.durationSec,
    startSec, endSec,
    maxWidth: autoLoop ? coarseLimit : maxWidth,
  })
  if (!extracted.ok) return { ok: false, stage: 'extract', error: extracted.error, ffmpeg: found }

  /* ── 粗筛阶段：抠底（小图，很快）→ 找周期 → 算出要精抽的帧号 ── */
  let loopInfo = null
  let picks = null
  if (autoLoop && extracted.count >= 8) {
    const coarseKeyed = []
    for (const file of extracted.frames) {
      const buffer = await readFile(file)
      const keyed = alpha ? alphaFromEdgeBackground(buffer, { tolerance }) : null
      coarseKeyed.push(keyed?.ok ? keyed.buffer : buffer)
    }
    const found2 = findLoopPoint({ frames: coarseKeyed, minFrames: 4 })
    if (found2.ok) {
      const cycle = found2.length
      /* 周期比要的帧数还短时，**不能硬凑**：想从 8 帧的周期里取 10 帧，
       * 重采样一定出现重复帧（实测：要 10 帧只抽出 8 个文件，精灵表少两格）。
       * 所以按周期封顶，并把这件事说清楚 —— 想更多帧就得提高抽帧密度。 */
      const usable = Math.max(1, Math.min(wantCount, cycle))
      const seen = new Set()
      picks = []
      for (let i = 0; i < usable; i++) {
        const idx = Math.round((i * cycle) / usable) % cycle
        if (seen.has(idx)) continue
        seen.add(idx)
        picks.push(idx)
      }
      loopInfo = {
        cycleFrames: cycle,
        distance: found2.distance,
        sampled: picks.length,
        note: found2.note + `，重采样成 ${picks.length} 帧`
          + (usable < wantCount ? `（周期只有 ${cycle} 帧，要 ${wantCount} 帧会出重复帧，所以按周期封顶）` : ''),
        candidates: found2.candidates,
        two_pass: `粗筛 ${extracted.count} 帧（${coarseLimit}px）找周期 → 只精抽 ${picks.length} 帧全尺寸`,
      }
    } else {
      loopInfo = { ok: false, error: found2.error, note: '自动循环失败，退回按顺序取帧' }
      picks = Array.from({ length: wantCount }, (_, i) => i)
    }
  }

  /* ── 精选阶段：只抽要的那几帧（全尺寸）── */
  let fine = extracted
  if (autoLoop && picks) {
    fine = await extractFrames({
      ffmpeg: found.path, video,
      outDir: path.join(outDir, 'frames'),
      fps: extracted.fps,          // 必须和粗筛同帧率，帧号才对得上
      durationSec: probed.durationSec,
      startSec, endSec,
      maxWidth,
      selectIndices: picks,
    })
    if (!fine.ok) {
      // 精抽失败就退回用粗筛帧（质量差一点，但至少有结果）
      loopInfo = { ...loopInfo, fallback: `精抽失败（${fine.error}），退回粗筛帧` }
      fine = extracted
      picks = null
    }
    // 粗筛目录用完就删（小图，但没必要留）
    await rm(extracted.dir, { recursive: true, force: true }).catch(() => {})
  }

  // 抠底（现在只处理最终要用的帧）
  let alphaInfo = null
  const framesForSheet = []
  for (const file of fine.frames) {
    const buffer = await readFile(file)
    if (!alpha) { framesForSheet.push(file); continue }
    const keyed = alphaFromEdgeBackground(buffer, { tolerance })
    if (!keyed.ok) {
      // 抠底失败不致命：保留原帧，但要说清楚（否则用户会以为精灵表"有白底"是 bug）
      alphaInfo = alphaInfo ?? { ok: false, error: keyed.error, note: keyed.note }
      framesForSheet.push(file)
      continue
    }
    const target = file.replace(/\.png$/i, '.alpha.png')
    await writeFile(target, keyed.buffer)
    framesForSheet.push(target)
    alphaInfo = { ok: true, bg: keyed.bg, share: keyed.share, note: keyed.note }
  }

  const framesToPack = framesForSheet

  const packed = await packSpriteSheet({
    frames: framesToPack, columns, scale,
    // auto 循环已经取到"不含重复结尾"的一轮了，不要再丢末帧
    dropDuplicateLast: autoLoop ? false : loop === true,
  })
  if (!packed.ok) return { ok: false, stage: 'pack', error: packed.error, ffmpeg: found, frames: extracted.frames }

  const sheetFile = path.join(outDir, `${name}_sheet.png`)
  await writeFile(sheetFile, packed.buffer)
  const json = buildSheetJson({
    name, sheet: path.basename(sheetFile),
    sheetWidth: packed.width, sheetHeight: packed.height,
    cell: packed.cell, columns: packed.columns, rows: packed.rows, count: packed.count,
    fps: fps ?? (count && probed.durationSec > 0 ? count / probed.durationSec : extracted.fps),
    loop: loop !== false, scale, union: packed.union,
  })
  const jsonFile = path.join(outDir, `${name}.json`)
  await writeFile(jsonFile, `${JSON.stringify(json, null, 2)}\n`, 'utf8')

  /* ── 收尾：删中间产物 ────────────────────────────────────────────────
   * 只在**全部成功之后**才删，任何一步失败都保留原文件（否则视频没了、帧也没成）。
   * 删视频的理由很实际：一段 5 秒 mp4 就有几百 KB~几 MB，而真正要交付的是帧和精灵表；
   * 视频只是中间产物，留着只占空间（这次 D 盘被塞满就是教训）。
   */
  let cleaned = null
  if (deleteVideo || !keepRawFrames) {
    cleaned = { video: null, rawFrames: 0, freedBytes: 0 }
    if (deleteVideo) {
      const info = await stat(video).catch(() => null)
      if (info?.isFile()) {
        const ok = await rm(video, { force: true }).then(() => true).catch(() => false)
        if (ok) { cleaned.video = video; cleaned.freedBytes += info.size }
      }
    }
    if (!keepRawFrames && alpha) {
      // 抠完底之后，原始帧（非 .alpha）就只是中间产物了
      for (const file of fine.frames) {
        if (!framesForSheet.includes(file.replace(/\.png$/i, '.alpha.png'))) continue
        const info = await stat(file).catch(() => null)
        if (!info?.isFile()) continue
        const ok = await rm(file, { force: true }).then(() => true).catch(() => false)
        if (ok) { cleaned.rawFrames += 1; cleaned.freedBytes += info.size }
      }
    }
    cleaned.note = [
      cleaned.video ? `已删除源视频` : null,
      cleaned.rawFrames > 0 ? `已删除 ${cleaned.rawFrames} 张未抠底的原始帧` : null,
      cleaned.freedBytes > 0 ? `共省出 ${(cleaned.freedBytes / 1024 / 1024).toFixed(1)} MB` : null,
    ].filter(Boolean).join('，') || '没有需要删除的中间产物'
  }

  const result = {
    ok: true,
    ffmpeg: found,
    video,
    probed,
    frames: { count: fine.count, dir: fine.dir, fps: fine.fps },
    ...(autoLoop ? { coarse_probe: extracted.count } : {}),
    alpha: alphaInfo,
    ...(loopInfo ? { loop: loopInfo } : {}),
    sheet: {
      file: sheetFile, width: packed.width, height: packed.height,
      cell: packed.cell, columns: packed.columns, rows: packed.rows,
      count: packed.count, droppedLast: packed.droppedLast, note: packed.note,
    },
    json: jsonFile,
    outDir,
    ...(cleaned ? { cleaned } : {}),
    note: '这是"视频甩帧"路线：连贯性由视频模型保证，程序只负责抽帧/抠底/对齐/打包。'
      + '逐帧生图做不到连贯，因为相邻帧之间没有任何机制约束。',
  }

  /* 写缓存（下一次同样的视频+参数直接命中，不重复抽帧）。
   * 注意：缓存里不存视频路径以外的中间状态；视频被删了也不影响，
   * 因为命中缓存时根本不需要再读视频。 */
  await writeFile(cacheFile, `${JSON.stringify({
    video: {
      path: video,
      size: videoInfo?.size ?? 0,
      mtimeMs: videoInfo ? Math.round(videoInfo.mtimeMs) : 0,
    },
    paramsKey,
    createdAt: new Date().toISOString(),
    result,
  }, null, 2)}
`, 'utf8').catch(() => {})

  return result
}