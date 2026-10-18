/**
 * 生音频（桥接 VoiceStudio）测试。
 *
 * 全部离线：起一个**假的 VoiceStudio 服务端**来模拟它真实的接口形状
 * （/api/env · /api/roles · /api/role/<id> · /api/jobs · /api/job/<id>）。
 * 绝不连真实的 8756 —— 那样测试就依赖"用户有没有把 VoiceStudio 打开"，
 * 属于伪测试（换个机器就红）。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  audioHealth, audioRoles, audioRole, audioCreateJob, audioJob, audioWait,
  audioBase, newOutputsOf, parseToneScript, runAudio, audioHome,
} from '../lib/audio.js'

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** 用环境变量把模块指向假服务端（用完必须还原，否则影响其它测试）。 */
async function withBase(base, fn) {
  const before = process.env.VOICESTUDIO_URL
  process.env.VOICESTUDIO_URL = base
  try { return await fn() } finally {
    if (before === undefined) delete process.env.VOICESTUDIO_URL
    else process.env.VOICESTUDIO_URL = before
  }
}

/** 造一个"能跑完任务"的假 VoiceStudio。 */
async function fakeVoiceStudio({ roles = [{ id: 'r1', name: '阿塔尼斯', outputs: [] }], wavPath, failJob = false } = {}) {
  let jobPolls = 0
  const jobs = new Map()
  const state = { created: [], roleReads: 0 }
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/api/env') return json(200, { ok: true, app: 'VoiceStudio' })
    if (url.pathname === '/api/roles') return json(200, { roles })
    if (url.pathname.startsWith('/api/role/')) {
      state.roleReads += 1
      const rid = decodeURIComponent(url.pathname.slice('/api/role/'.length))
      const role = roles.find((r) => r.id === rid)
      if (!role) return json(404, { error: 'no such role' })
      return json(200, { role })
    }
    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      state.created.push(body)
      const job = { id: `job${jobs.size + 1}`, state: 'running', pct: 0, stage: '排队', body }
      jobs.set(job.id, job)
      return json(200, { job })
    }
    if (url.pathname.startsWith('/api/job/')) {
      const jid = decodeURIComponent(url.pathname.slice('/api/job/'.length))
      const job = jobs.get(jid)
      if (!job) return json(404, { error: 'no such job' })
      jobPolls += 1
      job.pct = Math.min(100, jobPolls * 50)
      if (jobPolls >= 2) {
        job.state = failJob ? 'failed' : 'done'
        job.stage = job.state
        if (failJob) job.error = '出声体检没过'
        else {
          // 任务完成 → 把成品追加进角色的 outputs（真实服务就是这么做的）
          const role = roles.find((r) => r.id === job.body.role)
          if (role) role.outputs.push({ kind: job.body.kind === 'speak' ? 'speech' : 'song', text: '测试', wav: wavPath, at: 'now', seconds: 1.2 })
        }
      }
      return json(200, { job })
    }
    json(404, { error: 'unknown' })
  })
  return { ...server, state, jobs, roleReads: () => state.roleReads }
}

test('parseToneScript：把 [语气] 标签和台词分开，行号从 1 开始', () => {
  const plan = parseToneScript('[愤怒] 你竟敢骗我！\n[低语][颤抖] 别出声。\n\n普通一句')
  assert.equal(plan.length, 3)
  assert.equal(plan[0].text, '你竟敢骗我！')
  assert.equal(plan[0].tone, '愤怒')
  assert.deepEqual(plan[0].tags, ['愤怒'])
  assert.equal(plan[1].tone, '低语+颤抖')
  assert.equal(plan[1].text, '别出声。')
  assert.equal(plan[2].index, 3)
  assert.equal(plan[2].tone, '')
  assert.deepEqual(parseToneScript(''), [])
})

test('newOutputsOf：兼容「追加在后」和「新的在前」两种顺序', () => {
  const before = 2
  // 追加在后
  const appended = newOutputsOf({ outputs: [{ wav: 'a' }, { wav: 'b' }, { wav: 'c' }, { wav: 'd' }] }, before)
  assert.deepEqual(appended.map((x) => x.file), ['c', 'd'])
  // 新的在前
  const prepended = newOutputsOf({ outputs: [{ wav: 'd' }, { wav: 'c' }, { wav: 'a' }, { wav: 'b' }] }, before)
  // 尾部差 2 条 → d,c（真实服务是追加在后，这里只保证不漏取）
  assert.equal(prepended.length, 2)
  // 没有新增 → 空
  assert.deepEqual(newOutputsOf({ outputs: [{ wav: 'a' }] }, 1), [])
  assert.deepEqual(newOutputsOf(null, 0), [])
  // 字段兼容：wav / file / path 三种都认
  const mixed = newOutputsOf({ outputs: [{ wav: 'w' }, { file: 'f' }, { path: 'p' }, { nope: 1 }] }, 0)
  assert.deepEqual(mixed.map((x) => x.file), ['w', 'f', 'p'])
})

test('health / roles：能读懂 VoiceStudio 的响应形状', async () => {
  const fake = await fakeVoiceStudio()
  try {
    await withBase(fake.base, async () => {
      const health = await audioHealth()
      assert.equal(health.ok, true)
      assert.equal(health.base, fake.base)
      const roles = await audioRoles()
      assert.equal(roles.ok, true)
      assert.equal(roles.count, 1)
      assert.equal(roles.roles[0].id, 'r1')
      assert.equal(roles.roles[0].name, '阿塔尼斯')
      const one = await audioRole('r1')
      assert.equal(one.ok, true)
      assert.equal(one.role.name, '阿塔尼斯')
    })
  } finally {
    await fake.close()
  }
})

test('服务没在跑时给出「双击启动」的提示，而不是丢 ECONNREFUSED', async () => {
  const fake = await fakeVoiceStudio()
  const deadBase = fake.base
  await fake.close() // 端口关了 → 连不上
  await withBase(deadBase, async () => {
    const health = await audioHealth()
    assert.equal(health.ok, false)
    const result = await runAudio({
      profiles: { data: {} },
      settings: { outputDir: os.tmpdir() },
      args: { action: 'roles', autostart: false },
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /连不上|没在运行|VoiceStudio/)
    assert.match(result.error, /启动VoiceStudio|audio\(action="start"\)/, '要告诉人怎么启动')
  })
})

test('端到端：speak 建任务 → 轮询 → 从角色产出里捞出成品 → 复制进项目目录', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audio-'))
  try {
    const wavPath = path.join(dir, 'out.wav')
    await writeFile(wavPath, Buffer.from('RIFFfakewav'))
    const fake = await fakeVoiceStudio({ wavPath })
    try {
      await withBase(fake.base, async () => {
        const result = await runAudio({
          profiles: { data: { lastProject: 'game' } },
          settings: { outputDir: path.join(dir, 'out') },
          args: {
            action: 'speak',
            role: 'r1',
            script: '[愤怒] 你竟敢骗我！',
            project: 'game',
            name: 'hero_angry',
            wait_s: 30,
          },
        })
        assert.equal(result.ok, true, result.error)
        assert.equal(result.media, 'audio')
        assert.equal(result.action, 'speak')
        assert.equal(result.files.length, 1)
        assert.match(result.files[0], /hero_angry\.wav$/)
        assert.equal(result.output_dir, path.join(dir, 'out', 'game', 'audio'))
        // 文件真的复制过去了，内容一致
        const copied = await readFile(result.files[0])
        assert.equal(copied.toString(), 'RIFFfakewav')
        // 发给 VoiceStudio 的任务体要对
        assert.equal(fake.state.created.length, 1)
        assert.equal(fake.state.created[0].kind, 'speak')
        assert.equal(fake.state.created[0].role, 'r1')
        assert.equal(fake.state.created[0].script, '[愤怒] 你竟敢骗我！')
        assert.equal(fake.state.created[0].lang, 'zh')
      })
    } finally {
      await fake.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：song 要有 style + lyrics，缺一个就在本地挡住（不白跑一次长任务）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audio2-'))
  try {
    const wavPath = path.join(dir, 's.wav')
    await writeFile(wavPath, Buffer.from('RIFF'))
    const fake = await fakeVoiceStudio({ wavPath })
    try {
      await withBase(fake.base, async () => {
        const noStyle = await runAudio({ profiles: { data: {} }, settings: { outputDir: dir }, args: { action: 'song', role: 'r1', lyrics: '词' } })
        assert.equal(noStyle.ok, false)
        assert.match(noStyle.error, /style/)
        const noLyrics = await runAudio({ profiles: { data: {} }, settings: { outputDir: dir }, args: { action: 'song', role: 'r1', style: 'dark ambient' } })
        assert.equal(noLyrics.ok, false)
        assert.match(noLyrics.error, /lyrics/)
        assert.equal(fake.state.created.length, 0, '本地就该挡住，不该建任务')

        const ok = await runAudio({
          profiles: { data: {} }, settings: { outputDir: dir },
          args: { action: 'song', role: 'r1', style: 'dark ambient, slow', lyrics: '夜色沉沉', duration: 60, steps: 16, wait_s: 30 },
        })
        assert.equal(ok.ok, true, ok.error)
        assert.equal(fake.state.created[0].kind, 'new_song')
        assert.equal(fake.state.created[0].duration, 60)
        assert.equal(fake.state.created[0].steps, 16)
      })
    } finally {
      await fake.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('角色校验：没指定 or 指定了不存在的角色 → 列出可选角色，不建任务', async () => {
  const fake = await fakeVoiceStudio({ roles: [{ id: 'r1', name: '甲', outputs: [] }, { id: 'r2', name: '乙', outputs: [] }] })
  try {
    await withBase(fake.base, async () => {
      const none = await runAudio({ profiles: { data: {} }, settings: { outputDir: os.tmpdir() }, args: { action: 'speak', script: '喂' } })
      assert.equal(none.ok, false)
      assert.match(none.error, /role/)
      assert.equal(none.available_roles.length, 2)
      const bad = await runAudio({ profiles: { data: {} }, settings: { outputDir: os.tmpdir() }, args: { action: 'speak', role: '不存在', script: '喂' } })
      assert.equal(bad.ok, false)
      assert.match(bad.error, /找不到角色/)
      assert.equal(fake.state.created.length, 0)
    })
  } finally {
    await fake.close()
  }
})

test('任务失败 → 把 VoiceStudio 的失败原因带出来，而不是笼统说"失败了"', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audio3-'))
  try {
    const fake = await fakeVoiceStudio({ failJob: true, wavPath: path.join(dir, 'x.wav') })
    try {
      await withBase(fake.base, async () => {
        const result = await runAudio({
          profiles: { data: {} }, settings: { outputDir: dir },
          args: { action: 'speak', role: 'r1', script: '喂', wait_s: 30 },
        })
        assert.equal(result.ok, false)
        assert.match(result.error, /出声体检没过/, '要带出上游具体的失败原因')
        assert.ok(result.job_id, '要给出 job_id 方便查日志')
      })
    } finally {
      await fake.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wait_s=0 → 只提交不等（长任务不阻塞对话）', async () => {
  const fake = await fakeVoiceStudio({ wavPath: path.join(os.tmpdir(), 'never.wav') })
  try {
    await withBase(fake.base, async () => {
      const result = await runAudio({
        profiles: { data: {} }, settings: { outputDir: os.tmpdir() },
        args: { action: 'speak', role: 'r1', script: '喂', wait_s: 0 },
      })
      assert.equal(result.ok, true)
      assert.equal(result.pending, true)
      assert.ok(result.task_id === undefined || result.job_id)
      assert.match(result.message, /status/)
      assert.equal(fake.state.created.length, 1, '任务应该已经建了')
    })
  } finally {
    await fake.close()
  }
})

test('audioBase / audioHome 可被环境变量覆盖（换端口/换目录不用改代码）', () => {
  const beforeUrl = process.env.VOICESTUDIO_URL
  const beforeDir = process.env.VOICESTUDIO_DIR
  try {
    process.env.VOICESTUDIO_URL = 'http://127.0.0.1:9999/'
    process.env.VOICESTUDIO_DIR = 'E:\\Voice'
    assert.equal(audioBase(), 'http://127.0.0.1:9999', '末尾斜杠要被去掉')
    assert.equal(audioHome(), 'E:\\Voice')
  } finally {
    if (beforeUrl === undefined) delete process.env.VOICESTUDIO_URL; else process.env.VOICESTUDIO_URL = beforeUrl
    if (beforeDir === undefined) delete process.env.VOICESTUDIO_DIR; else process.env.VOICESTUDIO_DIR = beforeDir
  }
})
