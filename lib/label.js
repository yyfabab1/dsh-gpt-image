/**
 * 硬性规定：每一张生出来的素材，都额外产出一张「画面内写着素材名」的预览图。
 *
 * 为什么：素材一多，AI（和人）会分不清哪张是什么。干净图仍然原样保留给游戏用，
 * 预览图（*_labeled.png）把名字印在画面顶部，并且：
 *   · 缩略图会先放大到最短边 ≥ MinSide，再画名字（40×60 的小图也能看清）
 *   · 透明底铺棋盘格，一眼看出有没有抠干净
 */
import { spawn } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, safeSegment } from './util.js'
import { pngInfoFromBuffer } from './pnginfo.js'
import { powershellCandidates } from './screenshot.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'label.ps1')

function runLabel(exe, args, timeoutMs) {
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
      resolve({ ok: false, error: 'label timeout' })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(error.code ?? error.message) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ ok: true })
    })
  })
}

/** 从提示词里取一个可读的短名（兜底命名，保证「必须有名字」这条硬规定永远成立）。 */
export function nameFromPrompt(prompt, fallback = 'asset') {
  const words = String(prompt ?? '')
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  const slug = words.join('_').slice(0, 40)
  return safeSegment(slug || fallback, fallback)
}

/**
 * 生成带名字的预览图。
 * @param {{file:string, text:string, sub?:string, outFile?:string, minSide?:number, timeoutMs?:number}} params
 */
export async function labelImage({ file, text, sub = '', outFile, minSide = 200, timeoutMs = 30000 }) {
  const target = outFile ?? file.replace(/\.([a-z0-9]+)$/i, '_labeled.$1')
  await ensureDir(path.dirname(target))
  const resultFile = `${target}.result.txt`
  await rm(resultFile, { force: true }).catch(() => {})
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-In', file, '-Out', target, '-Text', String(text ?? 'asset'), '-MinSide', String(minSide)]
  if (sub) args.push('-Sub', String(sub))
  const failures = []
  for (const exe of powershellCandidates()) {
    const run = await runLabel(exe, args, timeoutMs)
    if (!run.ok) {
      failures.push(run.error)
      continue
    }
    try {
      const buffer = await readFile(target)
      const png = pngInfoFromBuffer(buffer)
      await rm(resultFile, { force: true }).catch(() => {})
      return { ok: true, file: target, width: png.width, height: png.height, bytes: buffer.length }
    } catch {
      failures.push(`${exe}: no output`)
    }
  }
  return { ok: false, error: failures.join('; ').slice(0, 300) }
}

/**
 * 给一张素材产出预览图（硬规定入口）。
 * @param {{file:string, name:string, project?:string, size?:string, label?:string}} params
 */
export async function labelForAsset({ file, name, project = '', size = '' }) {
  const label = String(name || '').trim()
  if (!label) return { ok: false, error: '没有素材名（硬规定：每个素材必须有 name）' }
  let dimensions = String(size || '')
  if (!dimensions) {
    const info = await pngInfo(file)
    dimensions = info.width ? `${info.width}×${info.height}` : ''
  }
  const sub = [project, dimensions].filter(Boolean).join(' · ')
  return labelImage({ file, text: label, sub })
}
