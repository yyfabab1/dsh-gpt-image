/**
 * L 组 · 自动化触发（监听 / webhook / git hook）。
 *
 * 现实约束（必须先说清）：
 *   本插件是 DSH 的**同步工具插件**，没有常驻进程。
 *   所以 L1 的"监听"不能是永久的 fs.watch —— DSH 一关就没了。
 *   这里做的是**可被调用的防抖扫描**：谁触发都行（webhook / git hook / 你手动 /
 *   DSH 的定时任务），触发后由这套逻辑判断"哪些文件写完了、该处理了"。
 *
 *   真正的"一直在看"交给 DSH 的 task_board_schedule（cron）——
 *   那才是常驻的正确位置。插件负责"被叫醒后干什么"。
 *
 *   L1 防抖  —— 写入稳定后才处理（你指出的 L1↔H1 冲突的解法）
 *   L2 webhook —— 外部脚本上报（带路径/批次/来源）
 *   L4 git hook —— 提交时校验契约与引用完整性
 */
import { stat, writeFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from './util.js'

// ───────── L1 防抖扫描 ─────────

export const DEFAULT_DEBOUNCE_MS = 5000

/**
 * L1：判断哪些文件"写完了"。
 *
 * 这是 L1↔H1 冲突的解法：**文件 mtime 距今超过防抖窗口**才算写完。
 * 不这么做的话，watch 到一个正在写的半成品就读它 —— 读到截断的 PNG。
 *
 * @param {{files:Array<{file:string,mtime:string,bytes:number}>, debounceMs?:number, now?:number,
 *          stableAcross?:Map<string,{size:number,at:number}>}} params
 * @returns {{ready:Array, pending:Array, summary:object}}
 */
export function debounceScan({ files = [], debounceMs = DEFAULT_DEBOUNCE_MS, now = Date.now(), stableAcross = null } = {}) {
  const ready = []
  const pending = []
  for (const item of files) {
    const mtime = new Date(item.mtime ?? 0).getTime()
    const age = Number.isFinite(mtime) ? now - mtime : 0
    const quiet = age >= debounceMs
    // 二次校验：如果给了上一轮的尺寸记录，还要求尺寸没变过
    // （有的脚本先创建文件再写内容，mtime 可能因为缓冲而"看起来旧"）
    let stable = quiet
    if (quiet && stableAcross) {
      const prev = stableAcross.get(item.file)
      if (prev && prev.size !== item.bytes) {
        stable = false
        pending.push({ ...item, reason: `尺寸仍在变（${prev.size} → ${item.bytes}），可能还在写`, wait_ms: debounceMs })
        continue
      }
    }
    if (stable) ready.push({ ...item, quiet_ms: age })
    else pending.push({ ...item, reason: `刚写入 ${Math.round(age / 1000)}s（防抖窗 ${Math.round(debounceMs / 1000)}s）`, wait_ms: debounceMs - age })
  }
  return {
    ready,
    pending,
    summary: { total: files.length, ready: ready.length, pending: pending.length },
    advice: pending.length === 0
      ? `${ready.length} 个文件都已写入稳定，可以处理。`
      : `${pending.length} 个文件还在防抖窗内（或尺寸仍在变）——**先不读**，避免读到写了一半的截断文件。`
        + `这是 L1↔H1 冲突的解法：不等写入稳定就读，会拿到坏文件。`,
  }
}

/**
 * L1：限流 + 熔断（你指出的"外部脚本失控会刷爆队列"）。
 *
 * 判据：单位时间内新增文件数超过阈值 → 限流（只处理前 N 个）；
 * 连续超阈值 → 熔断（停止处理并告警），避免被失控脚本拖垮。
 */
export function throttleScan({ newFiles = [], windowMs = 60000, maxPerWindow = 200, consecutiveBursts = 0, breakerAt = 3 } = {}) {
  const burst = newFiles.length > maxPerWindow
  const nextStreak = burst ? consecutiveBursts + 1 : 0
  if (nextStreak >= breakerAt) {
    return {
      ok: false,
      tripped: true,
      process: [],
      deferred: newFiles,
      summary: { incoming: newFiles.length, processing: 0, deferred: newFiles.length, burst_streak: nextStreak },
      advice: `⛔ 熔断：连续 ${nextStreak} 轮新增都超过 ${maxPerWindow} 个/${Math.round(windowMs / 1000)}s —— 有脚本在失控刷文件。`
        + `已停止处理，避免把它写坏的文件读进来。先查是哪个脚本，再手动恢复。`,
    }
  }
  if (burst) {
    return {
      ok: true,
      throttled: true,
      process: newFiles.slice(0, maxPerWindow),
      deferred: newFiles.slice(maxPerWindow),
      summary: { incoming: newFiles.length, processing: maxPerWindow, deferred: newFiles.length - maxPerWindow, burst_streak: nextStreak },
      advice: `⚠ 限流：本轮新增 ${newFiles.length} 超过上限 ${maxPerWindow} —— 先处理前 ${maxPerWindow} 个，其余下轮再说。`
        + `连续 ${nextStreak}/${breakerAt} 轮超限就会熔断。`,
    }
  }
  return {
    ok: true,
    process: newFiles,
    deferred: [],
    summary: { incoming: newFiles.length, processing: newFiles.length, deferred: 0, burst_streak: 0 },
    advice: `新增 ${newFiles.length} 个，在正常范围内。`,
  }
}

// ───────── L2 webhook ─────────

/**
 * L2：解析外部脚本的上报。
 * 主动上报比被动轮询快，而且**带上下文**（批次/来源），
 * 这正是 H2 归属标注最准的来源（不是靠目录+日期猜）。
 */
export function parseWebhook(payload = {}) {
  const errors = []
  const files = Array.isArray(payload.files) ? payload.files.filter((f) => typeof f === 'string') : []
  if (files.length === 0 && !payload.batch_only) errors.push('需要 files（字符串数组）')
  const writer = payload.writer ?? payload.source ?? payload.agent ?? ''
  if (!writer) errors.push('需要 writer/source（谁写的）—— 没有它就退回"按目录猜"，归属会不准')
  const when = payload.when ?? nowIso()
  return {
    ok: errors.length === 0,
    errors,
    event: {
      kind: payload.event ?? payload.kind ?? 'batch_done',
      files,
      writer: writer || 'unknown',
      batchId: payload.batch_id ?? payload.batchId ?? `wh_${Date.now().toString(36)}`,
      when,
      note: payload.note ?? '',
      // 外部脚本可以顺便声明元信息，省得我们再猜
      project: payload.project ?? '',
      元信息: payload.meta ?? null,
    },
    advice: errors.length === 0
      ? `收到 ${files.length} 个文件的上报（来自 ${writer}，批次 ${payload.batch_id ?? '(自动生成)'}）。`
        + '这份上报会同时写进来源登记（H2），所以这批图的归属是**精确的**，不是猜的。'
      : `上报缺字段：${errors.join('；')}`,
  }
}

/** 生成给外部脚本用的上报片段（他们直接贴进自己的脚本）。 */
export function webhookSnippet({ url = 'http://127.0.0.1:3080/gpt-image/api/webhook', writer = 'my-script' } = {}) {
  return {
    curl: `curl -X POST ${url} -H "Content-Type: application/json" -d '{"writer":"${writer}","batch_id":"my-batch-001","files":["D:/AHC/aishengtu图片地址/proj/a.png","D:/AHC/aishengtu图片地址/proj/b.png"],"note":"批量重制 r45"}'`,
    node: `await fetch('${url}', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    writer: '${writer}',
    batch_id: 'my-batch-001',
    files: outputPaths,          // 你刚写完的文件绝对路径数组
    note: '批量重制 r45',
    project: 'proj',
  }),
})`,
    note: '写完**再**上报（不要边写边报）—— 上报到达时系统会再走一次防抖确认，但那只是保险。',
  }
}

// ───────── L4 git hook ─────────

/**
 * L4：生成 git hook 脚本。
 *
 * 装在游戏仓库里，提交/合并时自动校验：
 *   - 素材契约（尺寸/透明）
 *   - 引用完整性（缺图/冗余）
 * 问题在**提交时**暴露，而不是上线前。
 *
 * 设计：hook 只做**校验 + 报告**，不自动改文件 ——
 * 提交时自动改文件是最容易出事的设计（改了什么、谁改的都不清楚）。
 * 要自动修，让人显式跑一次。
 */
export function buildGitHook({ hook = 'pre-commit', gameRoot = '', outputDir = '', blockOnMissing = true } = {}) {
  const isWindows = process.platform === 'win32'
  const script = isWindows ? buildPowerShellHook({ hook, gameRoot, blockOnMissing }) : buildShellHook({ hook, gameRoot, blockOnMissing })
  return {
    ok: true,
    hook,
    file: path.join(gameRoot || '<gameRoot>', '.git', 'hooks', hook),
    platform: isWindows ? 'powershell' : 'sh',
    script,
    install: isWindows
      ? `把上面的内容存成 ${path.join(gameRoot || '<gameRoot>', '.git', 'hooks', `${hook}.ps1`)}，再在同目录建 ${hook}.cmd 内容为：\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${hook}.ps1"`
      : `保存到 ${path.join(gameRoot || '<gameRoot>', '.git', 'hooks', hook)}，然后 chmod +x 它`,
    blockOnMissing,
    note: blockOnMissing
      ? '缺图会**阻止提交**（因为游戏跑起来会坏）。冗余只警告不阻止（它不影响运行）。'
      : '只警告不阻止。',
    caveat: 'hook 里调的是本插件的 HTTP 接口 —— 需要 DSH 在跑。DSH 不在时 hook 会放行（不阻塞你提交），只打印提示。',
  }
}

function buildShellHook({ hook, gameRoot, blockOnMissing }) {
  const guard = blockOnMissing ? '' : '\n# 只警告不阻止：把下面的 exit 1 改成 exit 0\nexit 0'
  return `#!/bin/sh
# dsh-gpt-image 素材校验（${hook}）
# 由插件生成；只校验不改文件。
API="\${DSH_WEB_URL:-http://127.0.0.1:3080}/gpt-image/api"
ROOT="${gameRoot || '$(git rev-parse --show-toplevel)'}"

if ! curl -s --max-time 3 "$API/assets?limit=1" >/dev/null 2>&1; then
  echo "[素材校验] DSH 没在跑，跳过（不阻塞提交）"
  exit 0
fi

echo "[素材校验] 检查引用完整性…"
RESULT=$(curl -s --max-time 30 "$API/references?root=$ROOT")
MISSING=$(echo "$RESULT" | grep -o '"missing":[0-9]*' | head -1 | cut -d: -f2)
ORPHANS=$(echo "$RESULT" | grep -o '"orphans":[0-9]*' | head -1 | cut -d: -f2)

if [ "\${MISSING:-0}" != "0" ]; then
  echo "❌ 有 $MISSING 个素材被代码引用但磁盘不存在 —— 提交后游戏会缺图"
  echo "$RESULT" | head -30
  exit 1
fi
if [ "\${ORPHANS:-0}" != "0" ]; then
  echo "⚠ 有 $ORPHANS 个素材存在但没被引用（冗余，不阻止提交）"
fi
echo "✅ 引用完整性 OK"
exit 0${guard}
`
}

function buildPowerShellHook({ hook, gameRoot, blockOnMissing }) {
  const guard = blockOnMissing ? '' : '\n# 只警告不阻止\nexit 0'
  return `# dsh-gpt-image 素材校验（${hook}）
# 由插件生成；只校验不改文件。
$ErrorActionPreference = 'Continue'
$api = if ($env:DSH_WEB_URL) { "$env:DSH_WEB_URL/gpt-image/api" } else { 'http://127.0.0.1:3080/gpt-image/api' }
$root = '${gameRoot || ''}'
if (-not $root) { $root = (git rev-parse --show-toplevel) }

try {
  Invoke-RestMethod -Uri "$api/assets?limit=1" -TimeoutSec 3 | Out-Null
} catch {
  Write-Host '[素材校验] DSH 没在跑，跳过（不阻塞提交）'
  exit 0
}

Write-Host '[素材校验] 检查引用完整性…'
try {
  $result = Invoke-RestMethod -Uri "$api/references?root=$([uri]::EscapeDataString($root))" -TimeoutSec 30
} catch {
  Write-Host '[素材校验] 查询失败，跳过'
  exit 0
}

if ($result.summary.missing -gt 0) {
  Write-Host "❌ 有 $($result.summary.missing) 个素材被代码引用但磁盘不存在 —— 提交后游戏会缺图" -ForegroundColor Red
  $result.missing | Select-Object -First 10 | ForEach-Object { Write-Host "   - $($_.key)" }
  exit 1
}
if ($result.summary.orphans -gt 0) {
  Write-Host "⚠ 有 $($result.summary.orphans) 个素材存在但没被引用（冗余，不阻止提交）" -ForegroundColor Yellow
}
Write-Host '✅ 引用完整性 OK' -ForegroundColor Green
exit 0${guard}
`
}

/** L4：真的把 hook 装进 git 仓库。 */
export async function installGitHook({ gameRoot, hook = 'pre-commit', blockOnMissing = true, force = false } = {}) {
  if (!gameRoot) return { ok: false, error: '需要 gameRoot' }
  const hooksDir = path.join(gameRoot, '.git', 'hooks')
  try {
    const info = await stat(path.join(gameRoot, '.git'))
    if (!info.isDirectory()) return { ok: false, error: `${gameRoot} 下没有 .git 目录（不是 git 仓库？）` }
  } catch {
    return { ok: false, error: `${gameRoot} 下没有 .git 目录（不是 git 仓库？）` }
  }
  const built = buildGitHook({ hook, gameRoot, blockOnMissing })
  const target = built.file
  if (!force) {
    try {
      await stat(target)
      return { ok: false, error: `${target} 已存在。确认要覆盖就带 force=true（建议先备份原 hook）。` }
    } catch { /* 不存在就装 */ }
  }
  await mkdir(hooksDir, { recursive: true })
  const isWindows = process.platform === 'win32'
  if (isWindows) {
    // Windows 上 git 认 .cmd / sh 都行；用 ps1 + cmd 包装最稳
    await writeFile(`${target}.ps1`, built.script, 'utf8')
    await writeFile(`${target}.cmd`, `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${hook}.ps1"\r\n`, 'utf8')
    // 同时放一个 sh 版，git-for-windows 用 bash 时会走这个
    await writeFile(target, buildShellHook({ hook, gameRoot, blockOnMissing }), 'utf8')
    try { await chmod(target, 0o755) } catch { /* Windows 上 chmod 可能无效，不重要 */ }
    return { ok: true, files: [target, `${target}.ps1`, `${target}.cmd`], note: '装了 3 个文件（sh + ps1 + cmd），git 用哪个都能跑。' }
  }
  await writeFile(target, built.script, 'utf8')
  await chmod(target, 0o755)
  return { ok: true, files: [target], note: '已装并加了可执行权限。' }
}
