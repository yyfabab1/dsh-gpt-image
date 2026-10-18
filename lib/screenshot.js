/**
 * 截图：让 AI 把「做完之后的真实画面」拍下来给用户看（和 WorkBuddy 一样的用法）。
 * 走 Windows 自带的 PowerShell + System.Drawing，不依赖任何 npm 包。
 * 注意：不通过 stdout 管道取结果（受限环境下管道会被拒），改读脚本写出的 result 文件。
 */
import { spawn } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, nowIso, safeSegment } from './util.js'
import { pngInfoFromBuffer } from './pnginfo.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grab.ps1')

/** PowerShell 候选：优先绝对路径（本机 PATH 里可能没有 powershell.exe）。 */
export function powershellCandidates() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
    'powershell.exe',
    'pwsh',
  ]
}

function runCapture(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: `${exe}: ${error.message}` })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* noop */
      }
      resolve({ ok: false, error: `截图超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `${exe}: ${error.code ?? error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: true, code })
    })
  })
}

export function shotFileName({ name = '' } = {}) {
  const base = safeSegment(name || 'screen', 'screen')
  return `shot_${base}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
}

/**
 * 截一张图并落盘。
 * @param {{mode?:'screen'|'all'|'window'|'region', window?:string, region?:string,
 *          outputDir:string, project?:string, name?:string, timeoutMs?:number}} params
 */
export async function capture({ mode = 'screen', window: windowTitle = '', region = '', outputDir, project = 'screenshots', name = '', maxWidth = 1600, timeoutMs = 30000 }) {
  const dir = path.join(outputDir, safeSegment(project, 'screenshots'))
  await ensureDir(dir)
  const file = path.join(dir, shotFileName({ name }))
  const resultFile = `${file}.result.txt`
  await rm(resultFile, { force: true }).catch(() => {})

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-OutFile', file, '-Mode', mode]
  if (windowTitle) args.push('-Window', windowTitle)
  if (region) args.push('-Region', region)
  if (Number(maxWidth) > 0) args.push('-MaxWidth', String(Math.floor(Number(maxWidth))))

  const failures = []
  let captured = false
  for (const exe of powershellCandidates()) {
    const run = await runCapture(exe, args, timeoutMs)
    if (!run.ok) {
      failures.push(run.error)
      continue
    }
    // 以「脚本写出的结果文件 / PNG 是否真的存在」为准，不看退出码
    try {
      const text = (await readFile(resultFile, 'utf8')).trim()
      if (text.startsWith('OK|')) {
        captured = true
        break
      }
      if (text.startsWith('ERR|')) {
        failures.push(`${exe}: ${text.slice(4)}`)
        break
      }
    } catch {
      /* 没写结果文件，继续看 PNG */
    }
    try {
      await stat(file)
      captured = true
      break
    } catch {
      failures.push(`${exe}: 没有产出文件（退出码 ${run.code}）`)
    }
  }

  if (!captured) {
    return { ok: false, mode, error: failures.join('；').slice(0, 500) || '截图失败' }
  }

  try {
    const info = await stat(file)
    const buffer = await readFile(file)
    const png = pngInfoFromBuffer(buffer)
    await rm(resultFile, { force: true }).catch(() => {})
    return {
      ok: true,
      mode,
      file,
      bytes: info.size,
      size: `${png.width}×${png.height}`,
      width: png.width,
      height: png.height,
      capturedAt: nowIso(),
    }
  } catch (error) {
    return { ok: false, mode, error: `截图命令成功但读不回文件：${error.message}` }
  }
}
