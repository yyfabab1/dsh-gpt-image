/**
 * 动画装机：把精灵表（+ 描述 JSON）按**游戏规格**装进游戏目录。
 *
 * 和静态图装机（install.js）的区别：
 *   静态图 → 按 (width,height) 缩放一张图，落到代码引用的位置。
 *   精灵表 → 缩放必须**按格子**做：整张表乘同一个倍率，改完每格还是等大；
 *            否则帧会错位（这是动画装机最容易犯的错）。
 *
 * 产出三样东西：
 *   1. `<name>_sheet.png`        缩放后的精灵表（等比，格子保持等大）
 *   2. `<name>.anim.json`        运行时描述：图、格子、帧数、帧率、循环、锚点、每帧坐标
 *   3. 落到游戏目录的 `<assetDir>/anim/` 下，同名文件先备份 `.bak-before-install`
 *
 * 为什么不直接复用静态图的 fitToSpec：那个按"整图宽高"缩放，会把 5×2 的表压成
 * 一个不整除的尺寸 → 格子变成 185.6 像素这种，切帧必然错位。
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { decodePngRgba, encodePngRgba } from './pngcodec.js'
import { pngInfo } from './pnginfo.js'
import { ensureDir, safeSegment } from './util.js'

/** 最近邻缩放整张精灵表（像素画必须用最近邻，双线性会把像素边缘糊掉）。 */
export function scaleSheet(buffer, factor) {
  if (!Number.isFinite(factor) || factor <= 0) return { ok: false, error: `倍率不合法：${factor}` }
  if (Math.abs(factor - 1) < 1e-6) return { ok: true, buffer, scaled: false, factor: 1 }
  const png = decodePngRgba(buffer)
  if (!png) return { ok: false, error: '解不开精灵表（只支持 8bit PNG）' }
  const outW = Math.max(1, Math.round(png.width * factor))
  const outH = Math.max(1, Math.round(png.height * factor))
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    // 用格子中心采样（+0.5）避免整体偏半像素
    const sy = Math.min(png.height - 1, Math.floor(((y + 0.5) / factor)))
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(png.width - 1, Math.floor(((x + 0.5) / factor)))
      const si = (sy * png.width + sx) * 4
      const di = (y * outW + x) * 4
      out[di] = png.pixels[si]
      out[di + 1] = png.pixels[si + 1]
      out[di + 2] = png.pixels[si + 2]
      out[di + 3] = png.pixels[si + 3]
    }
  }
  return { ok: true, buffer: encodePngRgba(outW, outH, out), scaled: true, factor, width: outW, height: outH }
}

/** 列出某个项目里做好的动画（扫各个动画目录下的 .json，用 image 字段找配对的那张表）。 */
export async function listAnimations({ outputDir, project }) {
  const animRoot = path.join(outputDir, project, 'anim')
  const dirs = await readdir(animRoot, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const dir = path.join(animRoot, entry.name)
    const files = await readdir(dir).catch(() => [])
    for (const file of files) {
      if (!/\.json$/i.test(file) || /\.cache\.json$/i.test(file)) continue
      let data
      try {
        data = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
      } catch { continue }
      if (!data?.image || !data?.grid || !data?.cell) continue
      const sheetFile = path.join(dir, data.image)
      const ok = await stat(sheetFile).then((s) => s.isFile()).catch(() => false)
      if (!ok) continue
      found.push({ name: data.name ?? entry.name, dir, sheet: sheetFile, json: path.join(dir, file), data })
    }
  }
  return found
}

/**
 * 找动画该装到哪。
 * 优先：代码里已经引用了 `<root>/.../anim/` 或 `<root>/.../sprites/` → 用那个目录。
 * 否则：`<root>/assets/anim/`。
 */
export async function findAnimDestination({ root, name }) {
  /* 返回的是**最终的动画目录**，调用方不再往后面拼子目录。
   * 第一版写错了：这里返回 assets（存在的父目录），调用方又拼了一个 anim，
   * 于是第一次装到 assets/anim，第二次因为 assets/anim 已存在、匹配到 assets/anim
   * 又拼一次 → assets/anim/anim。路径取决于"目录是否已存在"，这种 bug 很难发现
   * （两次装的文件不一样，但都没报错）。 */
  const guessed = ['assets/anim', 'assets/sprites', 'assets/animation']
  for (const rel of guessed) {
    const dir = path.join(root, rel)
    const exists = await stat(dir).then((s) => s.isDirectory()).catch(() => false)
    if (exists) return { dir, kind: 'existing-dir' }
  }
  const assetsDir = path.join(root, 'assets')
  const hasAssets = await stat(assetsDir).then((s) => s.isDirectory()).catch(() => false)
  return { dir: path.join(root, 'assets', 'anim'), kind: hasAssets ? 'under-assets' : 'fallback' }
}

/**
 * 装机。
 * @param {object} params
 * @param {string} params.root 游戏目录
 * @param {string} params.outputDir 插件输出目录
 * @param {string} params.project 项目名
 * @param {string[]} [params.names] 只装这几个动画
 * @param {number} [params.cellWidth] 目标格子宽（不给就不缩放）
 * @param {number} [params.cellHeight] 目标格子高
 * @param {boolean} [params.dryRun] 只看会做什么，不写盘
 * @param {string} [params.configFormat] anim=通用 JSON（默认）| plain=只给 {image,frameWidth,frameHeight,frames,fps,loop}
 */
export async function installAnimations({
  root, outputDir, project, names = [], cellWidth = null, cellHeight = null,
  dryRun = false, configFormat = 'anim',
}) {
  if (!root) return { ok: false, error: '需要 root（游戏目录）' }
  const all = await listAnimations({ outputDir, project })
  if (all.length === 0) {
    return { ok: false, error: `输出目录里没有 ${project} 的动画（找 ${path.join(outputDir, project, 'anim')}）` }
  }
  const targets = all.filter((item) => names.length === 0 || names.includes(item.name))
  if (targets.length === 0) {
    return { ok: false, error: `没有匹配的动画：${names.join('、')}`, available: all.map((item) => item.name) }
  }

  const results = []
  for (const item of targets) {
    const cell = { w: Number(item.data.cell?.w) || 0, h: Number(item.data.cell?.h) || 0 }
    if (!cell.w || !cell.h) {
      results.push({ name: item.name, ok: false, why: '描述文件里没有 cell 尺寸' })
      continue
    }

    /* 缩放：**按格子**算倍率，整表乘同一个倍率。
     * 如果宽高要求的倍率不一致（目标格子比例和源不一致），拒绝 ——
     * 强行拉伸会让角色变形，而且格子仍然等大但比例错了。 */
    let factor = 1
    if (cellWidth && cellHeight) {
      const fx = Number(cellWidth) / cell.w
      const fy = Number(cellHeight) / cell.h
      if (Math.abs(fx - fy) > 0.02) {
        results.push({
          name: item.name, ok: false,
          why: `目标格子 ${cellWidth}×${cellHeight} 和源格子 ${cell.w}×${cell.h} 比例不一致（${fx.toFixed(3)} vs ${fy.toFixed(3)}）—— 缩放会变形，已拒绝`,
          suggest: `把目标格子改成 ${Math.round(cell.w * Math.min(fx, fy))}×${Math.round(cell.h * Math.min(fx, fy))}，或者重新生成动画`,
        })
        continue
      }
      factor = fx
    }

    const destInfo = await findAnimDestination({ root, name: item.name })
    const destDir = destInfo.dir   // 已经是最终动画目录，不要再拼子目录
    const destSheet = path.join(destDir, `${safeSegment(item.name)}_sheet.png`)
    const destJson = path.join(destDir, `${safeSegment(item.name)}.anim.json`)

    if (dryRun) {
      results.push({
        name: item.name, ok: true, dry_run: true,
        would_write: [destSheet, destJson],
        scale: Number(factor.toFixed(3)),
        cell: `${Math.round(cell.w * factor)}×${Math.round(cell.h * factor)}`,
        frames: item.data.grid?.count,
      })
      continue
    }

    const scaled = scaleSheet(await readFile(item.sheet), factor)
    if (!scaled.ok) {
      results.push({ name: item.name, ok: false, why: `缩放失败：${scaled.error}` })
      continue
    }
    await ensureDir(destDir)

    // 同名先备份（和静态图装机一致）
    const backups = []
    for (const file of [destSheet, destJson]) {
      const exists = await stat(file).then((s) => s.isFile()).catch(() => false)
      if (exists) {
        const backup = `${file}.bak-before-install`
        await copyFile(file, backup)
        backups.push(backup)
      }
    }
    await writeFile(destSheet, scaled.buffer)

    const info = await pngInfo(destSheet)
    const finalCellW = Math.round(cell.w * factor)
    const finalCellH = Math.round(cell.h * factor)
    const count = Number(item.data.grid?.count) || 0
    const columns = Number(item.data.grid?.columns) || 1
    const fps = Number(item.data.fps) || 12
    /* 运行时描述：这个是给**引擎**看的，所以帧坐标要按缩放后的实际值重算，
     * 不能直接抄源 JSON 的（那是源尺寸的坐标）。 */
    const frames = Array.from({ length: count }, (_, i) => ({
      index: i,
      x: (i % columns) * finalCellW,
      y: Math.floor(i / columns) * finalCellH,
      w: finalCellW,
      h: finalCellH,
    }))
    const config = configFormat === 'plain'
      ? {
        image: path.basename(destSheet),
        frameWidth: finalCellW, frameHeight: finalCellH,
        frames: count, fps, loop: item.data.loop !== false,
      }
      : {
        version: 1,
        name: item.name,
        image: path.basename(destSheet),
        imageSize: [info.width, info.height],
        cell: { x: 0, y: 0, w: finalCellW, h: finalCellH },
        grid: { columns, rows: Math.ceil(count / columns), count },
        fps,
        frameDurationMs: Math.round(1000 / Math.max(1, fps)),
        loop: item.data.loop !== false,
        pivot: item.data.pivot ?? [0.5, 1],
        frames,
        source: { sheet: path.basename(item.sheet), cell: `${cell.w}×${cell.h}`, scale: Number(factor.toFixed(3)) },
        usage: '按 frames[i] 的 x/y/w/h 从 image 里取格；播放顺序 = frames 顺序；间隔 frameDurationMs。',
      }
    await writeFile(destJson, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    results.push({
      name: item.name, ok: true,
      sheet: destSheet,
      config: destJson,
      cell: `${finalCellW}×${finalCellH}`,
      sheet_size: `${info.width}×${info.height}`,
      frames: count,
      fps,
      scale: Number(factor.toFixed(3)),
      placed_in: destInfo.kind,
      backups: backups.length > 0 ? backups : undefined,
    })
  }

  const installed = results.filter((r) => r.ok && !r.dry_run).length
  return {
    ok: results.some((r) => r.ok),
    dry_run: Boolean(dryRun),
    project,
    total: targets.length,
    installed: dryRun ? 0 : installed,
    failed: results.filter((r) => !r.ok).length,
    results,
    hint: dryRun
      ? '只算了计划没写盘。确认后传 dry_run=false 真装。'
      : '已经装进去了：精灵表 + 运行时配置都在游戏目录里。还差一步——把动画登记进你的资源加载流程（或直接用这个 .anim.json）。',
    why: '缩放**按格子**算倍率、整表乘同一个倍率：这是动画装机唯一正确的方式。按整图宽高缩放会让格子变成非整数像素，切帧必然错位。',
  }
}
