/**
 * 项目提示词包（prompt pack）测试。
 *
 * 这个模块的价值是「统一画风」，而画风是主观的 —— 所以测试**不判断画风好不好**，
 * 只钉住三件确定的事：
 *   ① 组装顺序符合 OpenAI 官方指南（用途 → 主体 → 画风 → 构图 → 透明底 → 排除项）
 *   ② 没配包时**绝不改动**用户的提示词（纯加法，不能偷偷改行为）
 *   ③ 存/读/合并/校验的行为可预期（存进去什么样，读出来什么样）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  emptyPack, normalizePack, mergePacks, composePrompt, validatePack, starterPack,
  loadPromptPack, savePromptPack, listPacks, transparentClause, referenceClause,
  characterClause, describePack, packPath, globalPackPath, PACK_FILE,
} from '../lib/promptpack.js'

test('normalizePack：类型不对就丢掉，不抛异常（脏 JSON 不能把出图搞挂）', () => {
  const p = normalizePack({
    name: 123,
    use: '  game asset  ',
    style: 'pixel art',
    palette: ['#112233', '', '  #445566  ', null],
    negative: 'no text',              // 不是数组 → 丢弃
    transparent: 'yes',               // 不是布尔 → null
    characters: { hero: { desc: '  红发  ', ref: 42 }, bad: 'x' },
    kinds: { icon: { style: 'flat' }, broken: 7 },
  })
  assert.equal(p.name, '')            // 非字符串丢弃
  assert.equal(p.use, 'game asset')   // 去空白
  assert.equal(p.style, 'pixel art')
  assert.deepEqual(p.palette, ['#112233', '#445566']) // 空串/null 被过滤
  assert.deepEqual(p.negative, [])
  assert.equal(p.transparent, null)
  assert.deepEqual(p.characters.hero.desc, '红发')
  assert.equal(p.characters.hero.ref, '')
  assert.equal(p.characters.bad, undefined)
  assert.deepEqual(p.kinds.icon, { style: 'flat' })
  assert.equal(p.kinds.broken, undefined)
  // 完全垃圾输入也不炸
  assert.deepEqual(normalizePack(null), emptyPack())
  assert.deepEqual(normalizePack('nope'), emptyPack())
  assert.deepEqual(normalizePack([]), emptyPack())
})

test('mergePacks：标量后者覆盖，清单取并集，角色/种类按 key 合并', () => {
  const base = { style: 'base style', palette: ['#000000'], negative: ['no text'], characters: { a: { desc: 'A' } } }
  const over = { style: 'project style', palette: ['#ffffff'], transparent: true, characters: { b: { desc: 'B' } } }
  const merged = mergePacks(base, over)
  assert.equal(merged.style, 'project style')
  assert.deepEqual(merged.palette, ['#000000', '#ffffff'], '调色板取并集（默认包通用色 + 项目自己的）')
  assert.deepEqual(merged.negative, ['no text'], '项目没写就沿用默认')
  assert.equal(merged.transparent, true)
  assert.deepEqual(Object.keys(merged.characters).sort(), ['a', 'b'])
})

test('composePrompt：顺序符合官方指南（用途→主体→角色→画风→构图→透明底→约束）', () => {
  const pack = normalizePack({
    use: 'game asset',
    style: 'dark pixel art',
    composition: 'centered, top-down',
    palette: ['#101010', '#e0e0e0'],
    negative: ['no watermark', 'no text'],
    preserve: ['silhouette readability'],
    transparent: true,
    characters: { hero: { desc: 'red-haired knight in rusted armor' } },
  })
  const r = composePrompt({ pack, prompt: '火焰塔图标', kind: '', character: 'hero' })
  assert.equal(r.used, true)
  const idx = (needle) => r.prompt.indexOf(needle)
  const iUse = idx('Intended use: game asset')
  const iSubject = idx('火焰塔图标')
  const iChar = idx('red-haired knight')
  const iStyle = idx('Art style: dark pixel art')
  const iComp = idx('Composition: centered')
  const iTrans = idx('fully transparent background')
  const iKeep = idx('Keep unchanged')
  const iExcl = idx('Exclude: no watermark')
  for (const [name, v] of Object.entries({ iUse, iSubject, iChar, iStyle, iComp, iTrans, iKeep, iExcl })) {
    assert.ok(v >= 0, `${name} 应该出现在提示词里`)
  }
  assert.ok(iUse < iSubject, '用途在主体前')
  assert.ok(iSubject < iChar, '主体在角色锚点前')
  assert.ok(iChar < iStyle, '角色锚点在画风前')
  assert.ok(iStyle < iComp, '画风在构图前')
  assert.ok(iComp < iTrans, '构图在透明底前')
  assert.ok(iTrans < iExcl, '透明底在排除项前')
  assert.ok(iKeep < iExcl, '不变项在排除项前（约束放最后）')
  // 调色板与排除项以官方措辞出现
  assert.match(r.prompt, /Strictly limited palette: #101010, #e0e0e0/)
  assert.match(r.prompt, /no checkerboard pattern/)
  assert.equal(r.negative, 'no watermark, no text', 'negative 还要单独返回给有该字段的服务商')
})

test('composePrompt：**空包绝不改动词提示词**（纯加法，不能偷偷改行为）', () => {
  for (const pack of [null, undefined, emptyPack(), normalizePack({})]) {
    const r = composePrompt({ pack, prompt: '一把剑' })
    assert.equal(r.prompt, '一把剑', `空包（${JSON.stringify(pack)}）必须原样返回`)
    assert.equal(r.used, false)
    assert.equal(r.negative, '')
  }
  // 只有 palette 也算"配了东西"（调色板是画风的一部分）
  const withPalette = composePrompt({ pack: normalizePack({ palette: ['#000000'] }), prompt: '一把剑' })
  assert.equal(withPalette.used, true)
  assert.match(withPalette.prompt, /Strictly limited palette/)
})

test('composePrompt：kind 覆盖优先于顶层（不同素材类型要不同构图）', () => {
  const pack = normalizePack({
    style: 'global style',
    composition: 'global composition',
    kinds: { icon: { style: 'icon style', composition: 'icon composition' } },
  })
  const asIcon = composePrompt({ pack, prompt: 'x', kind: 'icon' })
  assert.match(asIcon.prompt, /Art style: icon style/)
  assert.match(asIcon.prompt, /Composition: icon composition/)
  const asCard = composePrompt({ pack, prompt: 'x', kind: 'card' })
  assert.match(asCard.prompt, /Art style: global style/, '没有该 kind 配置就退回顶层')
})

test('透明底措辞必须包含官方要求的全部排除项（少一项就会画出棋盘格/投影）', () => {
  const clause = transparentClause()
  for (const word of ['transparent background', 'no scenery', 'no backdrop', 'no checkerboard', 'no background shadow']) {
    assert.match(clause, new RegExp(word), `透明底措辞缺少「${word}」`)
  }
})

test('多图引用用「序号+描述」写法（官方推荐）', () => {
  assert.equal(referenceClause(0), '')
  assert.match(referenceClause(1), /Image 1 is the character\/style anchor/)
  const two = referenceClause(2)
  assert.match(two, /Image 1/)
  assert.match(two, /Image 2/)
  assert.match(two, /Match the anchor's palette/)
})

test('角色锚点：查不到就不说话（不编一个空角色）', () => {
  const pack = normalizePack({ characters: { hero: { desc: '红发骑士' } } })
  assert.match(characterClause(pack, 'hero'), /Character "hero": 红发骑士/)
  assert.equal(characterClause(pack, 'nobody'), '')
  assert.equal(characterClause(pack, ''), '')
  assert.equal(characterClause(null, 'hero'), '')
})

test('validatePack：能抓出非法颜色与相对路径，并对"没内容"给警告', () => {
  const bad = validatePack({ palette: ['#112233', 'red', '#GGGGGG'], references: ['relative.png', 'D:\\ok\\a.png'] })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('red')), JSON.stringify(bad.errors))
  assert.ok(bad.errors.some((e) => e.includes('relative.png')), '相对路径要报错')
  assert.ok(!bad.errors.some((e) => e.includes('D:\\ok\\a.png')), '绝对路径不该报错')

  const empty = validatePack({})
  assert.equal(empty.ok, true, '空包不算错误（只是没效果）')
  assert.ok(empty.warnings.some((w) => w.includes('style')), JSON.stringify(empty.warnings))

  const tooMuch = validatePack({ style: 'x'.repeat(700), negative: Array.from({ length: 20 }, (_, i) => `n${i}`) })
  assert.ok(tooMuch.warnings.some((w) => w.includes('style')))
  assert.ok(tooMuch.warnings.some((w) => w.includes('negative')))
})

test('starterPack：给的是「改了就能用」的模板，不是空壳', () => {
  const p = starterPack({ name: '末日余烬' })
  assert.equal(p.name, '末日余烬')
  assert.equal(p.use, 'game asset')
  assert.ok(p.style.length > 60, 'style 要够具体')
  assert.ok(p.composition.length > 20)
  assert.ok(p.negative.length >= 4)
  assert.ok(p.preserve.length >= 1)
  assert.equal(p.transparent, true)
  assert.equal(validatePack(p).ok, true)
})

test('存 / 读 / 列：项目包能存到 <输出目录>/<项目>/prompt-pack.json 并读回来', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pack-'))
  try {
    const outputDir = path.join(dir, 'out')
    const dataDir = path.join(dir, 'data')
    const project = 'mygame'
    const saved = await savePromptPack({
      outputDir, project, dataDir,
      pack: { name: '我的项目', style: 'flat vector', negative: ['no text'] },
    })
    assert.equal(saved.file, path.join(outputDir, project, PACK_FILE))
    const onDisk = JSON.parse(await readFile(saved.file, 'utf8'))
    assert.equal(onDisk.style, 'flat vector')
    assert.ok(onDisk.updatedAt, '要记更新时间')

    const loaded = await loadPromptPack({ outputDir, project, dataDir })
    assert.equal(loaded.style, 'flat vector')
    assert.equal(loaded.name, '我的项目')
    assert.equal(loaded.source.project, true)
    assert.equal(loaded.source.global, false)

    // 没配过的项目 → null（调用方据此保持原行为）
    assert.equal(await loadPromptPack({ outputDir, project: 'other', dataDir }), null)

    // 全局包：所有项目继承
    await savePromptPack({ outputDir, project: '', dataDir, pack: { style: 'global flat' } })
    assert.equal(globalPackPath({ dataDir }), path.join(dataDir, PACK_FILE))
    const inherited = await loadPromptPack({ outputDir, project: 'other', dataDir })
    assert.equal(inherited.style, 'global flat', '新项目继承全局包')
    // 项目包覆盖全局
    const own = await loadPromptPack({ outputDir, project, dataDir })
    assert.equal(own.style, 'flat vector')
    assert.equal(own.source.global, true)
    assert.equal(own.source.project, true)

    const all = await listPacks({ outputDir, dataDir })
    assert.ok(all.some((x) => x.scope === 'global'))
    assert.ok(all.some((x) => x.scope === 'project' && x.project === project))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('describePack：没配包时说清"会画风飘"并给出下一步', () => {
  const none = describePack(null)
  assert.equal(none.configured, false)
  assert.match(none.hint, /画风/)
  const some = describePack({ ...starterPack({ name: 'x' }), source: { file: 'f' } })
  assert.equal(some.configured, true)
  assert.ok(Array.isArray(some.negative))
  assert.equal(some.use, 'game asset')
})

test('packPath / globalPackPath：路径拼装可预期（换机器不会散落）', () => {
  assert.equal(packPath({ outputDir: 'D:\\out', project: 'p' }), path.join('D:\\out', 'p', PACK_FILE))
  assert.equal(packPath({ outputDir: 'D:\\out', project: '' }), path.join('D:\\out', 'default', PACK_FILE))
  assert.equal(globalPackPath({ dataDir: 'C:\\d' }), path.join('C:\\d', PACK_FILE))
})

/* ---------------- 集成：包真的进了发给上游的请求 ---------------- */

test('集成：配了包的项目出图时，请求里的 prompt 自动带画风；没配的项目一字不改', async () => {
  const http = await import('node:http')
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { apply } = await import('../lib/index.js')
  const { encodePngRgba } = await import('../lib/pngcodec.js')

  const PNG = encodePngRgba(1, 1, new Uint8ClampedArray([255, 0, 0, 255]))
  const seen = []
  const upstream = await new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      }
      res.writeHead(404); res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'packint-'))
  const outputDir = path.join(dataDir, 'out')
  const registry = new Map()
  const ctx = {
    tools: { register: (t) => { registry.set(t.name, t); return () => {} } },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject() {}, get() { return undefined },
  }
  apply(ctx, { dataDir, outputDir })
  const call = async (name, args) => JSON.parse(await registry.get(name).execute(args))
  try {
    const T = (name) => `_dsh_external_dsh_gpt_image_${name}`
    await call(T('config'), {
      action: 'set_profile',
      profile: { id: 'px', provider: 'openai', baseUrl: `${upstream.base}/v1`, apiKey: 'sk-t', model: 'gpt-image-2', pricePerImage: 0 },
    })
    await call(T('config'), { action: 'set_active', profile_id: 'px' })

    // 给 game 项目存一套包
    const saved = await call(T('prompts'), {
      action: 'pack-save',
      project: 'game',
      pack: {
        use: 'game asset',
        style: '统一的暗色像素画风',
        composition: '俯视 45 度',
        palette: ['#101010', '#e8e8e8'],
        negative: ['no watermark'],
        transparent: true,
      },
    })
    assert.equal(saved.ok, true, JSON.stringify(saved).slice(0, 200))

    // 1) 有包的项目 → 提示词被补上
    const withPack = await call(T('generate'), { prompt: '火焰塔', project: 'game', name: 'tower', n: 1, size: '1024x1024', quality: 'low', confirm: true })
    assert.equal(withPack.ok, true, withPack.error)
    assert.equal(seen.length, 1)
    const sent = seen[0].prompt
    assert.match(sent, /火焰塔/)
    assert.match(sent, /Intended use: game asset/)
    assert.match(sent, /统一的暗色像素画风/)
    assert.match(sent, /俯视 45 度/)
    assert.match(sent, /#101010/)
    assert.match(sent, /no watermark/)
    assert.match(sent, /transparent background/)

    // 2) 没包的项目 → 一字不改
    const noPack = await call(T('generate'), { prompt: '另一个项目的图', project: 'other', name: 'x', n: 1, size: '1024x1024', quality: 'low', confirm: true })
    assert.equal(noPack.ok, true, noPack.error)
    assert.equal(seen[1].prompt, '另一个项目的图', '没配包的项目提示词必须原样')

    // 3) prompt_pack=false → 即使有包也不加
    const optedOut = await call(T('generate'), { prompt: '临时不要包', project: 'game', name: 'y', n: 1, size: '1024x1024', quality: 'low', confirm: true, prompt_pack: false })
    assert.equal(optedOut.ok, true, optedOut.error)
    assert.equal(seen[2].prompt, '临时不要包', 'prompt_pack=false 必须能关掉')

    // 4) 非法尺寸被自动吸附（而不是发出去白等一次 400）
    const badSize = await call(T('generate'), { prompt: '尺寸测试', project: 'other', name: 'z', n: 1, size: '1000x1000', quality: 'low', confirm: true })
    assert.equal(badSize.ok, true, badSize.error)
    assert.equal(seen[3].size, '1008x1008', '尺寸守卫要把它吸附成合法值再发')
  } finally {
    await new Promise((done) => upstream.server.close(done))
    await rm(dataDir, { recursive: true, force: true })
  }
})
