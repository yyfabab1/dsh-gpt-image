/**
 * 硬性规定：每一张生出来的素材，都额外产出一张「画面内写着素材名」的预览图。
 *
 * 为什么：素材一多，AI（和人）会分不清哪张是什么。干净图仍然原样保留给游戏用，
 * 预览图（*_labeled.png）把名字印在画面顶部，并且：
 *   · 缩略图会先放大到最短边 ≥ MinSide，再画名字（40×60 的小图也能看清）
 *   · 透明底铺棋盘格，一眼看出有没有抠干净
 *
 * ── 体积策略（labeled.png 曾经吃掉 928MB，教训）──────────────────────
 *   预览图默认**缩到最长边 384px**：名字照样看得清，体积只剩 2~3%。
 *   三种策略：
 *     'small'（默认）→ 缩小预览图，建议值
 *     'on'           → 原尺寸预览图（旧行为，很占地方）
 *     'off'          → 完全不生成（明确关掉，不是"悄悄没做"）
 *   关掉时 labelForAsset 返回 {ok:false, skipped:true}，上层必须区分
 *   「跳过」和「失败」—— 跳过不算错误。
 */
import { spawn } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, safeSegment } from './util.js'
import { pngInfoFromBuffer } from './pnginfo.js'
import { powershellCandidates } from './screenshot.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'label.ps1')

/** 预览图策略默认值。 */
export const DEFAULT_LABEL_POLICY = { mode: 'small', maxSide: 384 }

let policy = { ...DEFAULT_LABEL_POLICY }

/**
 * 设置预览图策略。插件加载配置时调用；工具里也能通过 config(action="set_label") 改。
 * @param {{mode?:'on'|'small'|'off', maxSide?:number}} next
 */
export function setLabelPolicy(next = {}) {
  const mode = ['on', 'small', 'off'].includes(next.mode) ? next.mode : policy.mode
  const maxSide = Number.isFinite(Number(next.maxSide)) && Number(next.maxSide) >= 0
    ? Math.round(Number(next.maxSide))
    : policy.maxSide
  policy = { mode, maxSide }
  return getLabelPolicy()
}

export function getLabelPolicy() {
  return { ...policy }
}

/** 实际要传给 label.ps1 的 MaxSide（'on' 时为 0 = 不限制）。 */
function effectiveMaxSide() {
  if (policy.mode === 'on') return 0
  if (policy.mode === 'off') return 0
  return policy.maxSide > 0 ? policy.maxSide : DEFAULT_LABEL_POLICY.maxSide
}

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
 * @param {{file:string, text:string, sub?:string, outFile?:string, minSide?:number, maxSide?:number, timeoutMs?:number}} params
 */
export async function labelImage({ file, text, sub = '', outFile, minSide = 200, maxSide = null, timeoutMs = 30000 }) {
  const target = outFile ?? file.replace(/\.([a-z0-9]+)$/i, '_labeled.$1')
  await ensureDir(path.dirname(target))
  const resultFile = `${target}.result.txt`
  await rm(resultFile, { force: true }).catch(() => {})
  const limit = maxSide === null ? effectiveMaxSide() : Math.max(0, Math.round(Number(maxSide) || 0))
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-In', file, '-Out', target, '-Text', String(text ?? 'asset'), '-MinSide', String(minSide), '-MaxSide', String(limit)]
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
 *
 * 会先看策略：
 *   'off'   → 直接跳过（返回 skipped，**不是错误**，上层不能记成失败）
 *   'small' → 缩到最长边 maxSide 再画名字
 *   'on'    → 原尺寸
 *
 * @param {{file:string, name:string, project?:string, size?:string, label?:string}} params
 */
export async function labelForAsset({ file, name, project = '', size = '' }) {
  const label = String(name || '').trim()
  if (!label) return { ok: false, error: '没有素材名（硬规定：每个素材必须有 name）' }
  if (policy.mode === 'off') {
    return {
      ok: false,
      skipped: true,
      reason: 'labeledPreview = off（预览图开关关着，不是失败）',
      policy: getLabelPolicy(),
    }
  }
  let dimensions = String(size || '')
  if (!dimensions) {
    const info = await pngInfo(file)
    dimensions = info.width ? `${info.width}×${info.height}` : ''
  }
  const sub = [project, dimensions].filter(Boolean).join(' · ')
  const result = await labelImage({ file, text: label, sub })
  if (result.ok) {
    result.policy = getLabelPolicy()
  }
  return result
}
