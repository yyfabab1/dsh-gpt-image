/**
 * 装上就能用（install）：把生成出来的母图按游戏要求的规格处理，然后放进游戏里。
 *
 * 为什么需要这一步：模型只能出 1024 级别的大图，而游戏要的是 40×60 / 48×48 这种规格；
 * 手工缩放很容易做出「几百字节的空图」→ 游戏里就是黑屏。这里统一做：
 *   按规格缩放（保留透明通道）→ 落到游戏目录里代码期望的位置 → 立刻复核一遍
 *
 * 对这个项目（doomsday-ember）这类把素材以 data URL 存进 JS 的工程，
 * 额外输出一个 .dataurl.txt，直接喂给他们自己的 wiring 脚本即可。
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkProject, isSpecDoc, readExpectations } from './check.js'
import { pngInfo, pngInfoFromBuffer } from './pnginfo.js'
import { ensureDir, safeSegment } from './util.js'
import { powershellCandidates } from './screenshot.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resize.ps1')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'out'])

function runResize(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* noop */
      }
      resolve({ ok: false, error: 'resize timeout' })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `${error.code ?? error.message}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ ok: true })
    })
  })
}

/** 按规格缩放一张图（保留 alpha）。 */
export async function fitToSpec({ file, outFile, width, height, max = false, mode = 'fit', timeoutMs = 30000 }) {
  await ensureDir(path.dirname(outFile))
  const resultFile = `${outFile}.result.txt`
  await rm(resultFile, { force: true }).catch(() => {})
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-In', file, '-Out', outFile, '-Width', String(width), '-Height', String(height), '-Mode', mode]
  if (max) args.push('-Max')
  const failures = []
  for (const exe of powershellCandidates()) {
    const run = await runResize(exe, args, timeoutMs)
    if (!run.ok) {
      failures.push(run.error)
      continue
    }
    try {
      await stat(outFile)
      const info = await pngInfo(outFile)
      await rm(resultFile, { force: true }).catch(() => {})
      return { ok: true, file: outFile, ...info }
    } catch {
      failures.push(`${exe}: no output`)
    }
  }
  return { ok: false, error: failures.join('; ').slice(0, 300) }
}

async function walk(root, { maxFiles = 4000, depth = 6, files = [], level = 0 } = {}) {
  if (level > depth || files.length >= maxFiles) return files
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(full, { maxFiles, depth, files, level: level + 1 })
    } else if (entry.isFile()) files.push(full)
  }
  return files
}

/**
 * 在游戏目录里找到某个素材 key 的「落位」：
 *  1) 磁盘上已有同名文件（任意后缀变体，如 key.png / key_48.png）→ 直接替换它（这就是游戏在读的文件）
 *  2) 否则找代码里引用的路径（如 assets/xx.png）→ 用同一目录 + <key>.png
 *  3) 再否则用 <root>/assets/<key>.png
 */
export async function findDestination({ root, key }) {
  const files = await walk(root, { maxFiles: 4000 })
  const candidates = files.filter((file) => {
    const base = path.basename(file).replace(/\.[a-z0-9]+$/i, '')
    return base === key || base.replace(/_\d+x\d+$/i, '').replace(/_\d+$/, '') === key
  })
  if (candidates.length > 0) {
    // 命中多个时优先取最「像素材」的那张：排除明显的输出/备份目录
    candidates.sort((a, b) => a.length - b.length)
    return { kind: 'existing', file: candidates[0], allMatches: candidates }
  }
  const assetDirs = new Set()
  for (const file of files) {
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|json|html|lua|py)$/i.test(file)) continue
    let text
    try {
      if ((await stat(file)).size > 1024 * 1024) continue
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/["'`(]([\w@./\\-]*(?:assets|images|img|art|sprites|icons)[\w@./\\-]*\.(?:png|webp|jpg|jpeg))["'`)]/gi)) {
      const ref = match[1].replace(/\\/g, '/')
      const resolved = path.resolve(path.dirname(file), ref)
      if (resolved.startsWith(path.resolve(root))) assetDirs.add(path.dirname(resolved))
    }
  }
  if (assetDirs.size > 0) {
    const dir = [...assetDirs][0]
    return { kind: 'asset-dir', file: path.join(dir, `${key}.png`), assetDirs: [...assetDirs].slice(0, 5) }
  }
  return { kind: 'fallback', file: path.join(root, 'assets', `${key}.png`) }
}

/**
 * 把生成结果按规格装进游戏。
 * @param {{root:string, outputDir:string, project:string, names?:string[], dataUrl?:boolean, copyBackup?:boolean}} params
 */
export async function installAssets({ root, outputDir, project, names = [], dataUrl = false }) {
  if (!root) return { ok: false, error: '需要 root（游戏目录）' }
  const check = await checkProject({ root, outputDir, project })
  if (check.generated === 0) return { ok: false, error: `输出目录里没有 ${project} 的图` }
  const { expectations } = await readExpectations(root)
  const targets = (check.items ?? []).filter((item) => names.length === 0 || names.includes(item.key))
  const results = []
  const fitDir = path.join(outputDir, project, '_fitted')
  await ensureDir(fitDir)

  for (const item of targets) {
    const expected = expectations[item.key]
    if (!expected?.size) {
      results.push({ key: item.key, ok: false, skipped: true, why: '清单里没有这个素材的尺寸要求（无法按规格处理）' })
      continue
    }
    const { width, height, max } = expected.size
    const fittedFile = path.join(fitDir, `${safeSegment(item.key)}_${max ? 'max' : ''}${width}x${height}.png`)
    const fit = await fitToSpec({ file: path.join(outputDir, item.file), outFile: fittedFile, width, height, max })
    if (!fit.ok) {
      results.push({ key: item.key, ok: false, why: `缩放失败：${fit.error}` })
      continue
    }
    const destination = await findDestination({ root, key: item.key })
    await mkdir(path.dirname(destination.file), { recursive: true })
    let backup = ''
    try {
      await stat(destination.file)
      if (destination.kind === 'existing') {
        backup = `${destination.file}.bak-before-install`
        await copyFile(destination.file, backup)
      }
    } catch {
      /* 目标不存在则无需备份 */
    }
    await copyFile(fittedFile, destination.file)
    const written = await pngInfo(destination.file)
    let dataUrlFile = ''
    if (dataUrl) {
      const buffer = await readFile(destination.file)
      dataUrlFile = `${destination.file}.dataurl.txt`
      await writeFile(dataUrlFile, `data:image/png;base64,${buffer.toString('base64')}\n`, 'utf8')
    }
    results.push({
      key: item.key,
      ok: true,
      expected: `${max ? '≤' : ''}${width}×${height}`,
      produced: `${written.width}×${written.height}`,
      hasAlpha: written.hasAlphaChannel,
      destination: destination.file,
      placed_as: destination.kind,
      backup: backup || undefined,
      data_url_file: dataUrlFile || undefined,
    })
  }

  // 装完立刻复核：尺寸应该达标了，剩下就看代码有没有引用
  const after = await checkProject({ root, outputDir, project })
  const fitted = after.items.filter((item) => names.length === 0 || names.includes(item.key))
  const resolvedProblems = fitted.filter((item) => !(item.problems ?? []).some((problem) => /要求 .*实际生成/.test(problem))).map((item) => item.key)
  const notReferenced = fitted.filter((item) => item.verdict === 'not-referenced').map((item) => item.key)
  return {
    ok: results.some((item) => item.ok),
    installed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
    size_fixed: resolvedProblems,
    still_not_referenced: notReferenced,
    verdict_after: after.summary,
    hint: notReferenced.length > 0
      ? `尺寸已达标并已落到游戏里；但 ${notReferenced.join('、')} 在代码里还没有引用 —— 把它们登记进素材表（或跑你自己的 wiring 脚本）就能真正显示。`
      : '尺寸达标且代码里已有引用：游戏刷新后就应该能看到。',
    next: '这是界面可见的变化 —— 用截图工具拍一张游戏画面给用户看（screenshot mode=window window="<窗口标题>" attach=true）。',
  }
}
