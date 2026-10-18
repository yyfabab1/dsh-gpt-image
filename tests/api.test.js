/**
 * API 驱动测试：起一个本地假上游（node:http），覆盖
 * 同步 images、自动补 /v1、异步提交+轮询、Responses 模式、限流与错误。
 * 全程零成本、零外部依赖。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { pollTask, probe, runGeneration } from '../lib/api.js'
import { normalizeProvider } from '../lib/protocol.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(text)
      }
    })
  })
}

const profile = (base, extra = {}) => ({ id: 'p', provider: 'openai', baseUrl: base, apiKey: 'sk-test', model: 'gpt-image-2.5-sunburst', ...extra })

// ---- 瞬时故障重试：上游抽风不该让整次出图白费 ----

test('上游先返回 500 再成功：自动重试并最终成功', async () => {
  let calls = 0
  const { base, close } = await startServer(async (req, res) => {
    await readJsonBody(req)
    calls += 1
    if (calls === 1) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'do_request_failed', message: 'Failed to reach upstream, please retry later' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
  })
  try {
    const attempts = []
    const result = await runGeneration({
      profile: profile(`${base}/v1`),
      provider: normalizeProvider({ id: 'openai' }),
      prompt: '一只猫',
      params: { size: '1024x1024', quality: 'low', output_format: 'png', moderation: 'auto' },
      retries: 2,
      onEvent: (type, data) => { if (type === 'retry') attempts.push(data) },
    })
    assert.equal(result.ok, true, `应重试后成功，实际失败：${result.error}`)
    assert.equal(calls, 2, '应一共请求 2 次')
    assert.equal(attempts.length, 1, '应发出 1 次 retry 事件')
    assert.equal(attempts[0].status, 500)
  } finally {
    await close()
  }
})

test('永久性错误（400 语义错误）不重试，避免白烧钱', async () => {
  let calls = 0
  const { base, close } = await startServer(async (req, res) => {
    await readJsonBody(req)
    calls += 1
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid size parameter', type: 'invalid_request_error' } }))
  })
  try {
    const result = await runGeneration({
      profile: profile(`${base}/v1`),
      provider: normalizeProvider({ id: 'openai' }),
      prompt: 'x',
      params: { size: 'bad', quality: 'low', output_format: 'png', moderation: 'auto' },
      retries: 3,
    })
    assert.equal(result.ok, false)
    assert.equal(calls, 1, '400 语义错误只该请求 1 次')
  } finally {
    await close()
  }
})

test('retries 用尽后如实失败，并带上最后一次的状态', async () => {
  let calls = 0
  const { base, close } = await startServer(async (req, res) => {
    await readJsonBody(req)
    calls += 1
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'service unavailable' } }))
  })
  try {
    const result = await runGeneration({
      profile: profile(`${base}/v1`),
      provider: normalizeProvider({ id: 'openai' }),
      prompt: 'x',
      params: { size: '1024x1024', quality: 'low', output_format: 'png', moderation: 'auto' },
      retries: 1,
      pollTimeoutMs: 1,
    })
    assert.equal(result.ok, false)
    assert.equal(calls, 2, 'retries=1 → 总共 2 次尝试')
    assert.equal(result.status, 503)
  } finally {
    await close()
  }
})

test('isRetryable 认得上游瞬时错误，但不认语义错误', async () => {
  const { isRetryable } = await import('../lib/api.js')
  assert.equal(isRetryable(500, 'boom'), true)
  assert.equal(isRetryable(502, '<html>502 Bad Gateway</html>'), true)
  assert.equal(isRetryable(0, 'ECONNRESET'), true)
  assert.equal(isRetryable(429, 'rate limit exceeded'), true)
  assert.equal(isRetryable(400, { error: { code: 'do_request_failed', message: 'Failed to reach upstream, please retry later' } }), true)
  assert.equal(isRetryable(400, { error: { message: 'invalid size parameter' } }), false, '语义错误重试是白试')
  assert.equal(isRetryable(401, { error: { message: 'invalid api key' } }), false, 'Key 错重试也没用')
})

test('同步 Images API：解析 b64_json 并落成图片对象', async () => {
  let seen = null
  const { base, close } = await startServer(async (req, res) => {
    seen = { url: req.url, auth: req.headers.authorization, body: await readJsonBody(req) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
  })
  try {
    const result = await runGeneration({
      profile: profile(`${base}/v1`),
      provider: normalizeProvider({ id: 'openai' }),
      prompt: '一只猫',
      params: { size: '1024x1024', quality: 'low', output_format: 'png', moderation: 'auto', n: 1 },
    })
    assert.equal(result.ok, true)
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, PNG_B64)
    assert.equal(seen.url, '/v1/images/generations')
    assert.equal(seen.auth, 'Bearer sk-test')
    assert.equal(seen.body.prompt, '一只猫')
    assert.equal(seen.body.n, undefined)
  } finally {
    await close()
  }
})

test('baseUrl 少写 /v1：第一次 404，自动补 /v1 重试成功', async () => {
  const paths = []
  const { base, close } = await startServer((req, res) => {
    paths.push(req.url)
    if (req.url === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  try {
    const result = await runGeneration({
      profile: profile(base),
      provider: normalizeProvider({ id: 'openai' }),
      prompt: 'x',
      params: { output_format: 'png', moderation: 'auto', n: 1 },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(paths, ['/images/generations', '/v1/images/generations'], '先试原样，404 后补 /v1')
  } finally {
    await close()
  }
})

test('异步模式：提交拿 task_id → 立即首次轮询 → 完成后从 result.data 取图', async () => {
  let polls = 0
  const { base, close } = await startServer(async (req, res) => {
    if (req.method === 'POST') {
      await readJsonBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ task_id: 'task_123' }))
    }
    polls += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    if (polls < 2) return res.end(JSON.stringify({ status: 'processing' }))
    return res.end(JSON.stringify({ status: 'completed', result: { data: [{ b64_json: PNG_B64 }] } }))
  })
  try {
    const result = await runGeneration({
      profile: profile(`${base}/v1`, { provider: 'sb2api-async' }),
      provider: normalizeProvider({ id: 'sb2api-async' }),
      prompt: '异步出图',
      params: { output_format: 'png', moderation: 'auto', n: 1 },
      pollIntervalMs: 1000,
      waitS: 10,
    })
    assert.equal(result.ok, true)
    assert.equal(result.taskId, 'task_123')
    assert.equal(result.images.length, 1)
    assert.ok(polls >= 2, `至少轮询两次，实际 ${polls}`)
  } finally {
    await close()
  }
})

test('异步模式：wait_s=0 只提交不等待，返回 task_id', async () => {
  const { base, close } = await startServer(async (req, res) => {
    await readJsonBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ task_id: 'task_999' }))
  })
  try {
    const result = await runGeneration({
      profile: profile(`${base}/v1`, { provider: 'sb2api-async' }),
      provider: normalizeProvider({ id: 'sb2api-async' }),
      prompt: 'x',
      params: { output_format: 'png', moderation: 'auto', n: 1 },
      waitS: 0,
    })
    assert.equal(result.ok, true)
    assert.equal(result.pending, true)
    assert.equal(result.taskId, 'task_999')
  } finally {
    await close()
  }
})

test('job：once=true 时只查一次并回报当前状态', async () => {
  let polls = 0
  const { base, close } = await startServer((req, res) => {
    polls += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'processing', progress: 40 }))
  })
  try {
    const result = await pollTask({ profile: profile(`${base}/v1`, { provider: 'sb2api-async' }), provider: normalizeProvider({ id: 'sb2api-async' }), taskId: 't1', once: true, timeoutMs: 1000 })
    assert.equal(result.pending, true)
    assert.equal(result.status, 'processing')
    assert.equal(polls, 1)
  } finally {
    await close()
  }
})

test('Responses 模式：tool_choice=required，从 output[].image_generation_call 取图；n>1 并发单张', async () => {
  const bodies = []
  const { base, close } = await startServer(async (req, res) => {
    const body = await readJsonBody(req)
    bodies.push({ url: req.url, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output: [{ type: 'image_generation_call', result: PNG_B64, revised_prompt: 'cat' }] }))
  })
  try {
    const result = await runGeneration({
      profile: profile(`${base}/v1`, { apiMode: 'responses' }),
      provider: normalizeProvider({ id: 'openai' }),
      prompt: '一只猫',
      params: { size: '1024x1024', quality: 'low', output_format: 'png', moderation: 'auto', n: 3 },
    })
    assert.equal(result.ok, true)
    assert.equal(result.images.length, 3, 'n=3 时并发三次单张请求')
    assert.equal(bodies.length, 3)
    assert.equal(bodies[0].url, '/v1/responses')
    assert.equal(bodies[0].body.tool_choice, 'required')
    assert.equal(bodies[0].body.tools[0].type, 'image_generation')
    assert.equal(bodies[0].body.tools[0].action, 'generate')
    assert.equal(bodies[0].body.tools[0].size, '1024x1024')
    assert.equal(bodies[0].body.n, undefined, 'Responses 模式不发 n')
  } finally {
    await close()
  }
})

test('错误处理：429 标记为可退避，400 带出上游原话', async () => {
  const { base, close } = await startServer((req, res) => {
    if (req.url.endsWith('/images/generations')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
    }
    res.writeHead(404)
    res.end('{}')
  })
  try {
    const result = await runGeneration({ profile: profile(`${base}/v1`), provider: normalizeProvider({ id: 'openai' }), prompt: 'x', params: { output_format: 'png', moderation: 'auto' } })
    assert.equal(result.ok, false)
    assert.equal(result.throttled, true)
    assert.match(result.error, /rate limit/)
  } finally {
    await close()
  }
})

test('probe：能列出模型；缺 /v1 时自动纠正并给出建议', async () => {
  const { base, close } = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5-sunburst' }] }))
    }
    res.writeHead(404)
    res.end('{}')
  })
  try {
    const result = await probe({ profile: profile(base), provider: normalizeProvider({ id: 'openai' }) })
    assert.equal(result.ok, true)
    assert.equal(result.suggestedBaseUrl, `${base}/v1`)
    assert.deepEqual(result.models, ['gpt-image-2.5-sunburst'])
  } finally {
    await close()
  }
})
