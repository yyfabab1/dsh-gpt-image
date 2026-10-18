import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_PROVIDERS,
  buildRequest,
  extractImages,
  interpolate,
  normalizeProvider,
  providerCapabilities,
  resolvePath,
  resolveValue,
} from '../lib/protocol.js'
import { candidateBases } from '../lib/util.js'

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

test('占位符：整串占位保留原始类型，未定义则丢弃该字段', () => {
  const ctx = { prompt: '一只猫', profile: { model: 'gpt-image-2.5-sunburst' }, params: { n: 3, size: '1024x1024' } }
  assert.deepEqual(resolveValue('$prompt', ctx), '一只猫')
  assert.equal(resolveValue('$params.n', ctx), 3)
  assert.equal(resolveValue('$params.quality', ctx), undefined)
  assert.deepEqual(resolveValue({ model: '$profile.model', n: '$params.n', quality: '$params.quality', prompt: '$prompt' }, ctx), {
    model: 'gpt-image-2.5-sunburst',
    n: 3,
    prompt: '一只猫',
  })
})

test('路径插值：{task_id} 会替换，未知键原样保留', () => {
  assert.equal(interpolate('images/tasks/{task_id}', { task_id: 'abc' }), 'images/tasks/abc')
  assert.equal(interpolate('images/tasks/{unknown}', { task_id: 'abc' }), 'images/tasks/{unknown}')
})

test('路径表达式：通配 * 展开、数字下标、嵌套路径', () => {
  const payload = { data: [{ url: 'https://a/1.png' }, { b64_json: 'xx' }] }
  assert.deepEqual(resolvePath(payload, 'data.*.url'), ['https://a/1.png'])
  assert.deepEqual(resolvePath(payload, 'data.1.b64_json'), ['xx'])
  assert.deepEqual(resolvePath({ result: { data: [{ url: 'u' }] } }, 'result.data.*.url'), ['u'])
  assert.deepEqual(resolvePath(payload, 'nothing.here'), [])
})

test('结果提取：b64 优先于 url（与 Playground 一致）', () => {
  const payload = { data: [{ url: 'https://a/1.png', b64_json: TINY_PNG_B64 }] }
  const images = extractImages(payload, { imageUrlPaths: ['data.*.url'], b64JsonPaths: ['data.*.b64_json'] })
  assert.equal(images.length, 2)
  assert.ok(images[0].b64, 'b64 排在最前')
  assert.ok(images[1].url)
})

test('内置服务商：sb2api 异步的结果包在 result.data 里，且带轮询配置', () => {
  const provider = normalizeProvider({ id: 'sb2api-async' })
  assert.deepEqual(provider.result.b64JsonPaths, ['result.data.*.b64_json'])
  assert.deepEqual(provider.result.imageUrlPaths, ['result.data.*.url'])
  assert.equal(provider.submit.path, 'images/generations/async')
  assert.equal(provider.submit.taskIdPath, 'task_id')
  assert.equal(provider.editSubmit.contentType, 'multipart')
  assert.equal(provider.poll.path, 'images/tasks/{task_id}')
  assert.ok(providerCapabilities(provider).async)
})

test('内置服务商：能力矩阵正确（openai 同步支持改图，fal 不支持蒙版）', () => {
  const openai = providerCapabilities(normalizeProvider({ id: 'openai' }))
  assert.deepEqual(openai, { text2image: true, image2image: true, mask: true, async: false, responses: false })
  const fal = providerCapabilities(normalizeProvider({ id: 'fal' }))
  assert.equal(fal.mask, false)
  assert.equal(fal.image2image, false)
  const custom = providerCapabilities(normalizeProvider({ id: 'my-relay', submit: { path: 'v1/images/generations' }, editSubmit: { path: 'v1/images/edits', contentType: 'multipart' } }))
  assert.equal(custom.image2image, true)
})

test('baseUrl 自动补 /v1（中转站最常见的坑）', () => {
  assert.deepEqual(candidateBases('https://sub-proxy-us.65535.space'), ['https://sub-proxy-us.65535.space', 'https://sub-proxy-us.65535.space/v1'])
  assert.deepEqual(candidateBases('https://x.example.com/v1/'), ['https://x.example.com/v1'])
  assert.deepEqual(candidateBases(''), [])
})

test('文生图请求体：n=1 不发 n，png 不发 output_compression', () => {
  const profile = { id: 'p', provider: 'openai', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5-sunburst' }
  const request = buildRequest({ provider: normalizeProvider({ id: 'openai' }), profile, prompt: '一只猫', params: { size: '1024x1024', quality: 'low', output_format: 'png', moderation: 'auto', n: 1, output_compression: 80 } })
  assert.equal(request.url, 'https://relay.example.com/v1/images/generations')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.authorization, 'Bearer sk-test')
  assert.equal(request.body.model, 'gpt-image-2.5-sunburst')
  assert.equal(request.body.prompt, '一只猫')
  assert.equal(request.body.size, '1024x1024')
  assert.equal(request.body.n, undefined, 'n=1 不该出现')
  assert.equal(request.body.output_compression, undefined, 'png 不该有压缩率')
})

test('文生图请求体：n>1 才发 n；非 png 才发压缩率', () => {
  const profile = { id: 'p', provider: 'openai', baseUrl: 'https://relay.example.com/v1', apiKey: 'k', model: 'm' }
  const request = buildRequest({ provider: normalizeProvider({ id: 'openai' }), profile, prompt: 'x', params: { output_format: 'webp', output_compression: 70, moderation: 'auto', n: 4 } })
  assert.equal(request.body.n, 4)
  assert.equal(request.body.output_compression, 70)
})

test('改图请求：multipart 字段 image[] + mask，文件名按 Playground 约定', () => {
  const profile = { id: 'p', provider: 'openai', baseUrl: 'https://relay.example.com/v1', apiKey: 'k', model: 'm' }
  const request = buildRequest({
    provider: normalizeProvider({ id: 'openai' }),
    profile,
    prompt: '把背景换成雪山',
    params: { output_format: 'png', moderation: 'auto', n: 1 },
    inputImages: [Buffer.from([1, 2, 3])],
    mask: Buffer.from([4, 5, 6]),
  })
  assert.equal(request.isEdit, true)
  assert.equal(request.url, 'https://relay.example.com/v1/images/edits')
  assert.ok(request.body instanceof FormData, '改图走 multipart')
  assert.equal(request.headers['content-type'], undefined, 'multipart 的 content-type 交给 fetch 自己生成')
  const fieldNames = [...request.body.keys()]
  assert.ok(fieldNames.includes('image[]'))
  assert.ok(fieldNames.includes('mask'))
  assert.equal(request.body.get('mask').name, 'mask.png')
  assert.equal(request.body.get('image[]').name, 'input-1.png')
  assert.equal(request.body.get('prompt'), '把背景换成雪山')
  assert.equal(request.body.get('n'), null, 'n=1 不放进表单')
})

test('responseFormatB64Json 开关会把 response_format=b64_json 加进请求体', () => {
  const profile = { id: 'p', provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', responseFormatB64Json: true }
  const request = buildRequest({ provider: normalizeProvider({ id: 'openai' }), profile, prompt: 'x', params: { output_format: 'png', moderation: 'auto' } })
  assert.equal(request.body.response_format, 'b64_json')
})

test('自定义服务商模板可覆盖提交路径与结果路径', () => {
  const custom = normalizeProvider({
    id: 'my-relay',
    submit: { path: 'v1/images/generations', body: { model: '$profile.model', prompt: '$prompt', aspect_ratio: '$params.aspect_ratio' } },
    result: { imageUrlPaths: ['images.*.url'] },
  })
  const profile = { id: 'p', provider: 'my-relay', baseUrl: 'https://relay.example.com', apiKey: 'k', model: 'flux-x' }
  const request = buildRequest({ provider: custom, profile, prompt: '城堡', params: { aspect_ratio: '16:9' } })
  assert.equal(request.url, 'https://relay.example.com/v1/images/generations', 'baseUrl 自动补 /v1')
  assert.deepEqual(request.body, { model: 'flux-x', prompt: '城堡', aspect_ratio: '16:9' })
  assert.ok(BUILTIN_PROVIDERS.openai)
})

// Agnes（agnes-image-2.5-flash）模板：size 用档位 + ratio，response_format 必须嵌在 extra_body 里
const AGNES_PROVIDER = {
  id: 'agnes',
  submit: {
    path: 'images/generations',
    method: 'POST',
    contentType: 'json',
    body: { model: '$profile.model', prompt: '$prompt', size: '$params.size', ratio: '$params.ratio', extra_body: { response_format: 'url' } },
  },
  editSubmit: {
    path: 'images/generations',
    method: 'POST',
    contentType: 'json',
    body: { model: '$profile.model', prompt: '$prompt', size: '$params.size', ratio: '$params.ratio', extra_body: { image: '$inputImages.dataUrls', response_format: 'url' } },
  },
  result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: ['data.*.b64_json'] },
  supports: { text2image: true, image2image: true, mask: false, async: false, responses: false },
}

test('Agnes 文生图：size 档位 + ratio，response_format 嵌在 extra_body（顶层会报错）', () => {
  const provider = normalizeProvider(AGNES_PROVIDER)
  const profile = { id: 'p', provider: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'k', model: 'agnes-image-2.5-flash' }
  const request = buildRequest({ provider, profile, prompt: '一把金色长剑', params: { size: '1K', ratio: '9:16' } })
  assert.equal(request.url, 'https://apihub.agnes-ai.com/v1/images/generations')
  assert.equal(request.contentType, 'json')
  assert.deepEqual(request.body, {
    model: 'agnes-image-2.5-flash',
    prompt: '一把金色长剑',
    size: '1K',
    ratio: '9:16',
    extra_body: { response_format: 'url' },
  })
  assert.equal(request.body.response_format, undefined, 'response_format 不能在顶层')
})

test('Agnes 图生图：参考图以 Data URI 数组放进 extra_body.image', () => {
  const provider = normalizeProvider(AGNES_PROVIDER)
  const profile = { id: 'p', provider: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'k', model: 'agnes-image-2.5-flash' }
  const input = Buffer.from(TINY_PNG_B64, 'base64')
  const request = buildRequest({ provider, profile, prompt: '改成蓝调夜景', params: { size: '1K', ratio: '1:1' }, inputImages: [input] })
  assert.equal(request.url, 'https://apihub.agnes-ai.com/v1/images/generations', '图生图也走 generations')
  assert.deepEqual(request.body.extra_body.image, [`data:image/png;base64,${TINY_PNG_B64}`])
  assert.equal(request.body.extra_body.response_format, 'url')
})

test('$inputImages.dataUrls 在多图输入时保持顺序，并暴露 base64', () => {
  const provider = normalizeProvider({
    id: 'x',
    submit: { path: 'gen', body: { images: '$inputImages.dataUrls', first: '$inputImages.0.base64' } },
  })
  const profile = { id: 'p', provider: 'x', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }
  const a = Buffer.from(TINY_PNG_B64, 'base64')
  const b = Buffer.from(TINY_PNG_B64, 'base64')
  const request = buildRequest({ provider, profile, prompt: 'p', inputImages: [a, b] })
  assert.deepEqual(request.body.images, [`data:image/png;base64,${TINY_PNG_B64}`, `data:image/png;base64,${TINY_PNG_B64}`])
  assert.equal(request.body.first, TINY_PNG_B64)
})

test('没有输入图时 $inputImages.dataUrls 解析为空（字段被丢弃，而不是变成 undefined 字符串）', () => {
  const provider = normalizeProvider({
    id: 'x',
    submit: { path: 'gen', body: { prompt: '$prompt', images: '$inputImages.dataUrls' } },
  })
  const profile = { id: 'p', provider: 'x', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }
  const request = buildRequest({ provider, profile, prompt: 'p' })
  assert.deepEqual(request.body, { prompt: 'p' }, '空数组不应出现在请求体里')
})

test('Agnes 出图结果按 data[].url / data[].b64_json 解析', () => {
  const provider = normalizeProvider(AGNES_PROVIDER)
  const urlShaped = { created: 1, data: [{ url: 'https://platform-outputs.agnes-ai.space/x.png', b64_json: '', revised_prompt: '' }] }
  assert.deepEqual(extractImages(urlShaped, provider.result), [{ url: 'https://platform-outputs.agnes-ai.space/x.png' }])
  const b64Shaped = { created: 1, data: [{ url: '', b64_json: TINY_PNG_B64.repeat(2) }] }
  assert.deepEqual(extractImages(b64Shaped, provider.result), [{ b64: TINY_PNG_B64.repeat(2) }])
})

test('Agnes 不支持蒙版：能力表里 mask 为 false，但仍声明支持图生图', () => {
  const caps = providerCapabilities(normalizeProvider(AGNES_PROVIDER))
  assert.equal(caps.text2image, true)
  assert.equal(caps.image2image, true)
  assert.equal(caps.mask, false, 'Agnes 没有 mask 参数')
  assert.equal(caps.async, false)
})

test('自定义服务商若不声明 supports.mask，仍按默认 files 推断为支持蒙版（不回归）', () => {
  const provider = normalizeProvider({
    id: 'no-declare',
    editSubmit: { path: 'images/edits', contentType: 'multipart' },
  })
  assert.equal(providerCapabilities(provider).mask, true)
})

test('空数组字段被剔除：文生图不会发出 extra_body.image = []', () => {
  const provider = normalizeProvider({
    id: 'x',
    submit: { path: 'gen', body: { prompt: '$prompt', extra_body: { image: '$inputImages.dataUrls' } } },
  })
  const profile = { id: 'p', provider: 'x', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }
  const request = buildRequest({ provider, profile, prompt: 'p' })
  assert.equal(request.body.extra_body.image, undefined)
  assert.deepEqual(request.body.extra_body, {})
})

// 花钱闸门：免费档（pricePerImage: 0）不该被日预算/确认锁拦住
test('免费档单价 0：不触发确认锁，也不吃日预算', async () => {
  const { SpendLedger } = await import('../lib/spend.js')
  const ledger = new SpendLedger('', '', { locks: { dailyBudget: 1, confirmAboveImages: 1, perRunMaxImages: 12 } })
  ledger.data.activePricePerImage = 0
  const gate = ledger.check({ images: 8, action: 'batch' })
  assert.equal(gate.price_per_image, 0)
  assert.equal(gate.estimate, 0)
  assert.equal(gate.needConfirm, false, '0 元没有可防的，不该要确认')
  assert.equal(gate.allow, true, `免费档应放行，实际被拦：${gate.refusals.join('; ')}`)
})

test('未声明免费时沿用全局单价，确认锁照旧生效（不回归）', async () => {
  const { SpendLedger } = await import('../lib/spend.js')
  const ledger = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 100, confirmAboveImages: 1, perRunMaxImages: 12 } })
  const gate = ledger.check({ images: 4, action: 'batch' })
  assert.equal(gate.price_per_image, 0.04)
  assert.equal(gate.estimate, 0.16)
  assert.equal(gate.needConfirm, true, '付费档超过确认阈值仍要 confirm')
})

test('付费档仍会被日预算拦下', async () => {
  const { SpendLedger } = await import('../lib/spend.js')
  const ledger = new SpendLedger('', '', { pricePerImage: 0.04, locks: { dailyBudget: 0.1, confirmAboveImages: 1, perRunMaxImages: 12 } })
  const gate = ledger.check({ images: 10, action: 'batch', confirm: true })
  assert.equal(gate.allow, false)
  assert.ok(gate.refusals.some((text) => text.includes('日预算')), '超预算必须给出日预算拒绝理由')
})

test('配置档自定义字段（pricePerImage 等）在 import 往返后不被丢弃', async () => {
  const { ProfileStore } = await import('../lib/store.js')
  const store = new ProfileStore('', '', {
    version: 1,
    activeProfileId: 'free-1',
    customProviders: [],
    profiles: [{ id: 'free-1', name: '免费档', provider: 'agnes', baseUrl: 'https://a/v1', apiKey: 'k', model: 'm', apiMode: 'images', pricePerImage: 0, isDefault: true }],
  })
  store.importPlaygroundConfig(store.exportPlaygroundConfig(), { merge: true })
  assert.equal(store.get('free-1').pricePerImage, 0, 'pricePerImage 必须保留（0 不能被当成缺失）')
  assert.equal(store.active.id, 'free-1')
})

// ---- ratio：档位式 size 的构图方向，必须一路带到请求体 ----

test('ratio 参与指纹：同 size 不同 ratio 不是同一张图（否则会被错误去重跳过）', async () => {
  const { assetFingerprint } = await import('../lib/fingerprint.js')
  const base = { profileId: 'p', model: 'm', prompt: '一把剑', size: '2K', quality: 'low', kind: 'generate' }
  const wide = assetFingerprint({ ...base, ratio: '16:9' })
  const tall = assetFingerprint({ ...base, ratio: '9:16' })
  assert.notEqual(wide, tall, '16:9 与 9:16 必须算出不同指纹')
})

test('ratio 透传到请求体：size 档位 + ratio 一起发出', async () => {
  const { collectParams } = await import('../lib/run.js')
  const params = collectParams({ profile: { id: 'p' }, args: { size: '2K', ratio: '16:9' } })
  assert.equal(params.size, '2K')
  assert.equal(params.ratio, '16:9')
})

test('ratio 非法值被剔除，不会把脏参数发给上游', async () => {
  const { collectParams } = await import('../lib/run.js')
  assert.equal(collectParams({ profile: {}, args: { size: '1K', ratio: 'wide' } }).ratio, undefined)
  assert.equal(collectParams({ profile: {}, args: { size: '1K' } }).ratio, undefined)
})

test('池子保留 ratio，flush 时才不会丢构图方向', async () => {
  const { DemandPool } = await import('../lib/pool.js')
  const pool = new DemandPool('', '', {})
  const { added } = pool.enqueue({
    project: 'g',
    suggestions: [{ name: 'card_frame', prompt: 'card frame', size: '2K', ratio: '9:16' }],
  })
  assert.equal(added[0].ratio, '9:16')
  assert.equal(pool.report({}).items[0].ratio, '9:16')
})

test('池子入池去重仍按 name+prompt，ratio 不同也不会重复入池', async () => {
  const { DemandPool } = await import('../lib/pool.js')
  const pool = new DemandPool('', '', {})
  const first = pool.enqueue({ project: 'g', suggestions: [{ name: 'x', prompt: 'p', ratio: '1:1' }] })
  // 实际调用方（tools.js 的 pool add）会从池子现状构造 existingKeys 再传入
  const existingKeys = new Set(pool.data.items.map((item) => `${item.project}/${item.name}`))
  const second = pool.enqueue({ project: 'g', suggestions: [{ name: 'x', prompt: 'p', ratio: '16:9' }], existingKeys })
  assert.equal(first.added.length, 1)
  assert.equal(second.added.length, 0, '同名同提示词视为同一需求')
  assert.equal(second.skipped[0].why, '已在池子里')
})

test('批量的素材对象保留 ratio', async () => {
  const { normalizeBatchAssets } = await import('../lib/batch/run.js')
  const specs = normalizeBatchAssets({ assets: [{ name: 'a', prompt: 'p', size: '2K', ratio: '9:16' }] }, { id: 'p', model: 'm' })
  assert.equal(specs[0].ratio, '9:16')
  const inherited = normalizeBatchAssets({ assets: [{ name: 'b', prompt: 'p' }], ratio: '4:3' }, { id: 'p', model: 'm' })
  assert.equal(inherited[0].ratio, '4:3', '素材没写 ratio 时继承批次默认值')
})
