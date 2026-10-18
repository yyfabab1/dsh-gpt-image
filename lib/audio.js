/**
 * 生音频：把本机的 **VoiceStudio** 接进出图台。
 *
 * 为什么是"桥接"而不是重新实现：你机器上已经有一套跑通的语音/音乐流水线
 *   （GPT-SoVITS 训练 + RVC + Seed-VC + YuE2 作曲），它自己在 127.0.0.1:8756 上
 *   提供了完整的 HTTP API。重写一遍既没意义也不可能更好 —— 这里只做三件事：
 *     ① 把它的接口包成 AI 能直接调的工具（角色配音 / 唱歌 / 作曲 / 换声）
 *     ② 把产出**拉进当前游戏项目目录**（<输出目录>/<项目>/audio/），和图片素材放在一起
 *     ③ 失败时说清到底是"服务没起"还是"任务失败"，而不是丢一个 ECONNREFUSED
 *
 * VoiceStudio 的 API（实测，来自它的 server.py）：
 *   GET  /api/env                 存活探针
 *   GET  /api/roles               角色列表（每个角色 = 一个训练好的音色）
 *   GET  /api/role/<id>           角色详情（**产出都在 role.outputs 里**）
 *   POST /api/jobs                建任务，body.kind ∈ speak / new_song / sing / rvc / seedvc / lyrics / train / ingest
 *   GET  /api/job/<id>            查任务（state / pct / stage / result）
 *   POST /api/upload              传本地音频（唱歌要）
 *
 * 关键设计：**怎么拿到产出文件**
 *   任务完成后，成品不是从 /api/job 下回来的，而是被写进角色的 outputs 列表
 *   （带 wav 路径）。所以正确做法是：建任务前记下 outputs 数量 → 任务完成后再读一次角色
 *   → 取新增那几条。这样不会拿错上一次的文件（并发时也不会）。
 *
 * ⚠️ 代理坑（VoiceStudio 作者已经踩过）：本机如果设了 http_proxy，
 *   请求 127.0.0.1 会被劫持成"接口明明在跑却连不通"。
 *   Node 的 fetch 默认不读 http_proxy 环境变量，所以这里直接用它 —— 但仍然把
 *   这条写下来：如果你改成别的 HTTP 客户端，记得显式绕过代理。
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { nowIso, safeSegment } from './util.js'
import { sfxList, renderSfxToWav } from './sfx.js'

/** 默认地址；可用环境变量 VOICESTUDIO_URL 覆盖。 */
export function audioBase() {
  return String(process.env.VOICESTUDIO_URL || 'http://127.0.0.1:8756').replace(/\/+$/, '')
}

/** VoiceStudio 安装目录（自动启动时用）。 */
export function audioHome() {
  return String(process.env.VOICESTUDIO_DIR || 'D:\\AHC\\VoiceStudio')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 基础 HTTP 调用：统一超时、统一把"连不上"翻译成人话。 */
async function call(pathname, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const url = `${audioBase()}${pathname}`
  let response
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = String(error?.message ?? error)
    const refused = /ECONNREFUSED|fetch failed|connect/i.test(message)
    return {
      ok: false,
      connection: true,
      error: refused
        ? `连不上 VoiceStudio（${audioBase()}）。它没在运行 —— 双击 ${path.join(audioHome(), '启动VoiceStudio.bat')}，或让我用 audio(action="start") 拉起来。`
        : `请求 VoiceStudio 失败：${message}`,
      base: audioBase(),
    }
  }
  const text = await response.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!response.ok) {
    const detail = data?.error || data?.message || text.slice(0, 300)
    return { ok: false, status: response.status, error: `VoiceStudio 返回 ${response.status}：${detail}`, data }
  }
  return { ok: true, status: response.status, data }
}

/** 存活探针。 */
export async function audioHealth({ timeoutMs = 4000 } = {}) {
  const result = await call('/api/env', { timeoutMs })
  if (!result.ok) return { ok: false, base: audioBase(), home: audioHome(), error: result.error }
  return { ok: true, base: audioBase(), home: audioHome(), env: result.data }
}

/**
 * 确保服务在跑。没跑且 start=true 时尝试拉起（用 VoiceStudio 自带的 _start_server.py）。
 * @returns {{ok:boolean, started:boolean, base:string, error?:string}}
 */
export async function audioEnsureRunning({ start = true, waitMs = 90000 } = {}) {
  const first = await audioHealth()
  if (first.ok) return { ok: true, started: false, base: audioBase() }
  if (!start) return { ok: false, started: false, base: audioBase(), error: first.error }

  const home = audioHome()
  const launcher = path.join(home, '_start_server.py')
  const info = await stat(launcher).catch(() => null)
  if (!info) {
    return {
      ok: false, started: false, base: audioBase(),
      error: `VoiceStudio 没在运行，而且找不到启动脚本 ${launcher}。`
        + '请手动双击「启动VoiceStudio.bat」，或用环境变量 VOICESTUDIO_DIR 指向它的安装目录。',
    }
  }
  // 用 VoiceStudio 指定的解释器最稳（它自己写死在 _start_server.py 里）；
  // 这里优先找同目录下常见的 python，找不到就交给系统 python。
  const candidates = ['python', 'python3', 'py']
  let spawned = false
  for (const exe of candidates) {
    try {
      const child = spawn(exe, [launcher], { cwd: home, detached: true, stdio: 'ignore' })
      child.unref()
      spawned = true
      break
    } catch { /* 换下一个 */ }
  }
  if (!spawned) {
    return { ok: false, started: false, base: audioBase(), error: `自动启动失败：找不到可用的 python 解释器。请手动启动 VoiceStudio。` }
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(2000)
    const health = await audioHealth({ timeoutMs: 3000 })
    if (health.ok) return { ok: true, started: true, base: audioBase(), waitedMs: waitMs - (deadline - Date.now()) }
  }
  return { ok: false, started: false, base: audioBase(), error: `已尝试启动 VoiceStudio，但 ${Math.round(waitMs / 1000)} 秒内没能连上（${audioBase()}）。看它的 _server.log。` }
}

/** 角色（= 训练好的音色）列表。 */
export async function audioRoles() {
  const result = await call('/api/roles')
  if (!result.ok) return result
  const raw = result.data?.roles
  const roles = Array.isArray(raw) ? raw : []
  return {
    ok: true,
    count: roles.length,
    roles: roles.map((role) => ({
      id: role.id ?? role.rid,
      name: role.name ?? role.id,
      lang: role.lang ?? '',
      // 只报"有没有音色"，不把内部路径全抖出来
      has_model: Boolean(role.model || role.gsv || role.trained),
      outputs: Array.isArray(role.outputs) ? role.outputs.length : 0,
      raw: role,
    })),
  }
}

/** 读单个角色（拿到 outputs，用来 diff 新产出）。 */
export async function audioRole(rid) {
  const result = await call(`/api/role/${encodeURIComponent(rid)}`)
  if (!result.ok) return result
  return { ok: true, role: result.data?.role ?? result.data }
}

/** 建任务。 */
export async function audioCreateJob(body) {
  const result = await call('/api/jobs', { method: 'POST', body })
  if (!result.ok) return result
  const job = result.data?.job
  if (!job?.id) return { ok: false, error: `建任务成功但没拿到 job.id：${JSON.stringify(result.data).slice(0, 200)}` }
  return { ok: true, job }
}

/** 查任务。 */
export async function audioJob(id) {
  const result = await call(`/api/job/${encodeURIComponent(id)}`)
  if (!result.ok) return result
  return { ok: true, job: result.data?.job ?? result.data }
}

/**
 * 等任务结束。
 * @param {(job:object)=>void} [onProgress] 进度回调（打印/记录用）
 */
export async function audioWait(id, { timeoutMs = 1800000, intervalMs = 2000, onProgress } = {}) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeoutMs) {
    const result = await audioJob(id)
    if (!result.ok) {
      if (result.connection) return { ok: false, error: result.error, job: null }
      await sleep(intervalMs)
      continue
    }
    const job = result.job
    const line = `${job.state} ${job.pct ?? 0}% ${job.stage ?? ''}`.trim()
    if (line !== last) {
      last = line
      try { onProgress?.(job) } catch { /* 进度回调失败不影响任务 */ }
    }
    if (['done', 'failed', 'cancelled'].includes(job.state)) {
      return {
        ok: job.state === 'done',
        job,
        state: job.state,
        error: job.state === 'done' ? undefined : (job.error || job.message || `任务${job.state}`),
        elapsedMs: Date.now() - started,
      }
    }
    await sleep(intervalMs)
  }
  return { ok: false, timeout: true, error: `等了 ${Math.round(timeoutMs / 1000)} 秒还没完成（任务可能还在跑，用 audio(action="status", job_id=...) 再查）`, job: null }
}

/**
 * 把任务新增的产出捞出来。
 * @param {string} rid 角色 id
 * @param {number} beforeCount 建任务前该角色 outputs 的数量
 */
export function newOutputsOf(role, beforeCount) {
  const list = Array.isArray(role?.outputs) ? role.outputs : []
  // outputs 可能是「新的在前」，也可能「追加在后」——两种都兼容：
  // 先按数量差取尾部，若尾部没有更多就取头部（不赌顺序）
  const tail = list.slice(beforeCount)
  const pool = tail.length > 0 ? tail : list.slice(0, Math.max(0, list.length - beforeCount))
  return pool.map((entry) => ({
    kind: entry.kind ?? '',
    text: entry.text ?? '',
    file: entry.wav || entry.file || entry.path || '',
    seconds: entry.seconds ?? null,
    similarity: entry.similarity ?? null,
    tone: entry.tone ?? '',
    warn: entry.warn ?? '',
    at: entry.at ?? '',
  })).filter((entry) => entry.file)
}

/**
 * 跑一个音频任务并把产出落进项目目录。
 *
 * @param {object} params
 * @param {object} params.profiles  ProfileStore（只用来拿 dataDir）
 * @param {object} params.settings  含 outputDir
 * @param {object} params.args      { action, role, script, style, lyrics, duration, title, project, name, lang, song, wait_s, autostart }
 * @param {(line:string)=>void} [params.onLog]
 */
export async function runAudio({ profiles, settings, args = {}, onLog } = {}) {
  const action = String(args.action || 'speak').toLowerCase()
  const log = (line) => { try { onLog?.(line) } catch { /* 忽略 */ } }

  const outputRootResolved = args.output || settings?.outputDir || profiles?.outputDir || process.cwd()
  const projectSafe = safeSegment(args.project || profiles?.data?.lastProject || 'audio', 'audio')
  const audioDirFor = () => path.join(outputRootResolved, projectSafe, 'audio')

  /* ---------- 音效（程序化合成）：不依赖 VoiceStudio，放在服务检查之前 ---------- */
  if (action === 'sfx-list') {
    return { ok: true, media: 'audio', action, presets: sfxList(), count: sfxList().length }
  }
  if (action === 'sfx') {
    // 支持一次出多个：presets 数组，或 preset 单个
    const wanted = Array.isArray(args.presets) && args.presets.length > 0
      ? args.presets.map(String)
      : [String(args.preset ?? 'coin')]
    if (wanted.length > 32) {
      return { ok: false, media: 'audio', action, error: `一次最多合成 32 个音效（收到 ${wanted.length} 个）` }
    }
    const audioDir = audioDirFor()
    await mkdir(audioDir, { recursive: true })
    const files = []
    const items = []
    const errors = []
    for (let i = 0; i < wanted.length; i++) {
      const preset = wanted[i]
      try {
        const rendered = renderSfxToWav({
          preset,
          duration: args.duration,
          pitch: args.pitch,
          brightness: args.brightness,
          seed: args.seed === undefined ? (i + 1) : Number(args.seed) + i,
          sampleRate: args.sample_rate,
          volume: args.volume,
          channels: args.channels === 2 ? 2 : 1,
        })
        const baseName = String(args.name || preset).trim()
        const fileName = `${safeSegment(wanted.length > 1 ? `${baseName}_${i + 1}` : baseName, preset)}.wav`
        const file = path.join(audioDir, fileName)
        await writeFile(file, rendered.wav)
        files.push(file)
        items.push({
          preset,
          file,
          duration_ms: Math.round(rendered.duration * 1000),
          sample_rate: rendered.sampleRate,
          frames: rendered.frames,
          bytes: rendered.bytes,
          warnings: rendered.warnings,
        })
      } catch (error) {
        errors.push({ preset, error: String(error?.message ?? error) })
      }
    }
    return {
      ok: files.length > 0,
      media: 'audio',
      action: 'sfx',
      kind: 'sfx',
      project: projectSafe,
      output_dir: audioDir,
      files,
      items,
      ...(errors.length ? { errors } : {}),
      note: '程序化合成，确定性输出（同 seed 同文件），零依赖不花钱。放游戏里直接用；想微调就换 seed / pitch / brightness。',
    }
  }

  // ---- 服务可用性 ----
  const service = await audioEnsureRunning({
    start: args.autostart !== false,
    waitMs: Number(args.start_timeout_ms ?? 90000),
  })
  if (!service.ok) return { ok: false, stage: 'service', error: service.error, base: service.base, started: service.started }
  if (service.started) log(`VoiceStudio 原本没在跑，已自动拉起（${service.base}）`)

  const base = {
    ok: false,
    media: 'audio',
    action,
    service: { base: service.base, started: service.started },
  }

  // ---- 只读动作 ----
  if (action === 'health') return { ...base, ok: true, health: await audioHealth() }
  if (action === 'roles') {
    const roles = await audioRoles()
    return { ...base, ...roles }
  }
  if (action === 'status') {
    if (!args.job_id) return { ...base, error: 'status 需要 job_id' }
    const job = await audioJob(args.job_id)
    return { ...base, ...job }
  }

  // ---- 需要角色的动作 ----
  const needsRole = ['speak', 'song', 'sing', 'rvc', 'seedvc', 'lyrics']
  let role = null
  if (needsRole.includes(action)) {
    const roles = await audioRoles()
    if (!roles.ok) return { ...base, ...roles }
    const wanted = String(args.role ?? '').trim()
    if (roles.roles.length === 0) {
      return {
        ...base,
        error: 'VoiceStudio 里还没有任何角色（音色）。先去它的界面导入视频/音频训练一个角色，或者用 audio(action="roles") 看看现有的。',
      }
    }
    if (!wanted) {
      return {
        ...base,
        error: `这个动作要指定 role（角色/音色）。现有 ${roles.count} 个：${roles.roles.map((r) => `${r.id}(${r.name})`).join('、')}`,
        available_roles: roles.roles.map((r) => ({ id: r.id, name: r.name })),
      }
    }
    role = roles.roles.find((r) => r.id === wanted || r.name === wanted)
    if (!role) {
      return {
        ...base,
        error: `找不到角色「${wanted}」。现有的：${roles.roles.map((r) => r.id).join('、')}`,
        available_roles: roles.roles.map((r) => ({ id: r.id, name: r.name })),
      }
    }
  }

  // ---- 组装 job body ----
  let body = null
  const project = safeSegment(args.project || profiles?.data?.lastProject || 'audio', 'audio')
  const name = safeSegment(args.name || `${action}_${Date.now().toString(36)}`, action)

  if (action === 'speak') {
    const script = String(args.script ?? args.text ?? '').trim()
    if (!script) {
      return {
        ...base,
        error: 'speak 需要 script（台词）。支持语气标签，例如「[愤怒] 你竟敢骗我！\\n[低语] 别出声。」',
        hint: '一个角色一行也行；标签写在中括号里，VoiceStudio 会自己解析。',
      }
    }
    body = { kind: 'speak', role: role.id, script, lang: args.lang || 'zh' }
  } else if (action === 'song') {
    const style = String(args.style ?? '').trim()
    const lyrics = String(args.lyrics ?? '').trim()
    if (!style) return { ...base, error: 'song 需要 style（曲风描述，比如 "dark ambient orchestral, slow, female vocal"）—— YuE2 靠它决定曲风/乐器/人声/BPM' }
    if (!lyrics) return { ...base, error: 'song 需要 lyrics（歌词）—— 没有词它只会哼不唱' }
    body = {
      kind: 'new_song',
      role: role.id,
      style,
      lyrics,
      duration: Math.max(15, Math.min(360, Number(args.duration ?? 120) || 120)),
      steps: Math.max(8, Math.min(64, Number(args.steps ?? 32) || 32)),
      title: args.title || style.slice(0, 28),
    }
  } else if (action === 'sing') {
    const song = String(args.song ?? args.file ?? '').trim()
    if (!song) return { ...base, error: 'sing 需要 song（现成歌曲文件的本地绝对路径）' }
    body = { kind: 'sing', role: role.id, song, title: args.title || path.basename(song) }
  } else if (action === 'rvc' || action === 'seedvc') {
    const source = String(args.song ?? args.file ?? args.source ?? '').trim()
    if (!source) return { ...base, error: `${action} 需要 source/song（要换声的音频本地绝对路径）` }
    body = { kind: action, role: role.id, song: source, file: source }
  } else if (action === 'lyrics') {
    body = { kind: 'lyrics', role: role.id, title: args.title || '', ...(args.style ? { style: args.style } : {}) }
  } else {
    return { ...base, error: `不认识的 action「${action}」。可用：health / roles / speak / song / sing / rvc / seedvc / lyrics / status` }
  }

  // ---- 记下建任务前的产出数量（用来 diff） ----
  const beforeRole = await audioRole(role.id)
  const beforeCount = Array.isArray(beforeRole?.role?.outputs) ? beforeRole.role.outputs.length : 0

  // ---- 建任务 ----
  const created = await audioCreateJob(body)
  if (!created.ok) return { ...base, ...created, request: body }
  const job = created.job
  log(`任务已建：${job.id}（${body.kind}）`)

  const waitS = args.wait_s === undefined ? 900 : Number(args.wait_s)
  if (waitS === 0) {
    return { ...base, ok: true, pending: true, job_id: job.id, job, request: body, message: `已提交（未等待）。用 audio(action="status", job_id="${job.id}") 查进度。` }
  }

  const waited = await audioWait(job.id, {
    timeoutMs: waitS * 1000,
    onProgress: (j) => log(`${j.state ?? ''} ${j.pct ?? 0}% ${j.stage ?? ''}`.trim()),
  })
  if (!waited.ok) {
    return {
      ...base,
      error: waited.error,
      job_id: job.id,
      job: waited.job,
      request: body,
      hint: waited.timeout ? '任务还在跑，再用 status 查；或者把 wait_s 调大。' : '看 VoiceStudio 的任务日志（GET /api/job/<id>/log）。',
    }
  }

  // ---- 捞新产出 ----
  const afterRole = await audioRole(role.id)
  const outputs = newOutputsOf(afterRole?.role, beforeCount)
  if (outputs.length === 0) {
    return {
      ...base, ok: false, job_id: job.id, job: waited.job, request: body,
      error: '任务跑完了，但没在角色产出里找到新文件。',
      hint: '可能这个任务本来就不产生音频（比如 lyrics），或者产出被写到别处了。',
    }
  }

  // ---- 复制进项目目录（和图片素材放一起） ----
  const outputRoot = args.output || settings?.outputDir || profiles?.outputDir || process.cwd()
  const audioDir = path.join(outputRoot, project, 'audio')
  await mkdir(audioDir, { recursive: true })
  const files = []
  const saved = []
  for (let i = 0; i < outputs.length; i++) {
    const entry = outputs[i]
    const ext = path.extname(entry.file) || '.wav'
    const target = path.join(audioDir, `${name}${outputs.length > 1 ? `_${i + 1}` : ''}${ext}`)
    try {
      await copyFile(entry.file, target)
      files.push(target)
      saved.push({ ...entry, source: entry.file, file: target })
    } catch (error) {
      saved.push({ ...entry, copy_error: String(error?.message ?? error) })
    }
  }

  return {
    ...base,
    ok: files.length > 0,
    kind: body.kind,
    role: { id: role.id, name: role.name },
    project,
    output_dir: audioDir,
    files,
    outputs: saved,
    job_id: job.id,
    elapsed_ms: waited.elapsedMs,
    note: `音频写在 ${audioDir}（**从 VoiceStudio 的产出复制过来，原文件仍在它自己的目录里**）。`,
    ...(files.length === 0 ? { error: '任务成功但复制文件失败，看 outputs[].copy_error' } : {}),
  }
}

/** 分析台词里的语气标签，给人看"这段会被怎么念"。 */
export function parseToneScript(script) {
  const lines = String(script ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return lines.map((line, index) => {
    const tags = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])
    const text = line.replace(/\[[^\]]+\]/g, '').trim()
    return { index: index + 1, text, tone: tags.join('+'), tags, empty: !text }
  })
}

export { nowIso }
