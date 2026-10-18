/**
 * 客户端半边的「装配」测试：不靠浏览器，直接模拟 DSH 客户端模块系统与 slots 服务，
 * 跑一遍 apply()，再按 ui-sidebar 自己的消费方式（entriesOfSlot → id/order/label）
 * 复算侧栏面板列表 —— 保证重启后侧栏真的会出现「生图」图标。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 极简 React：apply() 阶段只用 createElement，渲染阶段才会碰 hooks。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial ?? null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/** 模拟 window.__ModuleLoader__.load 与 require。 */
async function loadClientModule() {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  let registered = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => { registered = registration },
      },
    },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'require', source)
  run(sandbox.window, (name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected require(${name})`)
  })
  assert.ok(registered, 'client.js 必须调用 window.__ModuleLoader__.load')
  return { registration: registered, exports: registered.factory((name) => (name === 'react' ? reactStub() : null)) }
}

/** 模拟 slots 服务：inject 立即回调，register 记账。 */
function fakeCtx() {
  const entries = new Map()
  const add = (name, options, component) => {
    const list = entries.get(name) ?? []
    list.push({ options, component })
    entries.set(name, list)
    return () => {}
  }
  return {
    entries,
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => add(options.name, options, component),
      entriesOfSlot: (name) => entries.get(name) ?? [],
    },
    effect: (run) => {
      run()
      return () => {}
    },
  }
}

test('客户端模块装配：id / apply / inject 齐全', async () => {
  const { registration, exports } = await loadClientModule()
  assert.equal(registration.id, '@dsh-external/dsh-gpt-image')
  assert.equal(typeof registration.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('侧栏图标按 ui-sidebar 的算法能列出来（id/order/label 都齐）', async () => {
  const { exports } = await loadClientModule()
  const ctx = fakeCtx()
  exports.apply(ctx)

  const panelEntries = ctx.slots.entriesOfSlot('sidebar.panellist')
  // 曾经是「正好 1 个」，但用户要求把余额/生视频/自动化/生音频也放进侧栏 —— 断言要跟着意图走：
  // 这几个页面都要在，而且每个 id 都得有对应的 main 面板（见下面那条与 e2e 里的契约测试）。
  assert.equal(panelEntries.length, 5, `侧栏应有 5 个面板（余额/生图/生视频/自动化/生音频），实际 ${panelEntries.length}`)

  // 复刻 ui-sidebar：syncPanels() 的映射 + 排序
  const panels = panelEntries.map(({ options }) => ({
    id: options.id,
    order: options.order ?? 0,
    label: (typeof options.label === 'function' ? options.label() : options.label) ?? options.id,
  })).sort((a, b) => a.order - b.order)

  assert.deepEqual(panels, [
    { id: 'balance', order: 29, label: '余额' },
    { id: 'gallery', order: 30, label: '生图' },
    { id: 'video', order: 31, label: '生视频' },
    { id: 'auto', order: 32, label: '自动化' },
    { id: 'audio', order: 33, label: '生音频' },
  ])
  for (const entry of panelEntries) {
    assert.equal(typeof entry.component, 'function', `侧栏「${entry.options.id}」的图标必须是组件`)
  }
  // 图标组件要能按侧栏给的 props 渲染（size / active）
  const gallery = panelEntries.find((entry) => entry.options.id === 'gallery')
  const icon = gallery.component({ size: 20, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 20)
})

test('主区域整页面板与侧栏一一对应（否则侧栏点了没反应）', async () => {
  const { exports } = await loadClientModule()
  const ctx = fakeCtx()
  exports.apply(ctx)

  const sideIds = ctx.slots.entriesOfSlot('sidebar.panellist').map((entry) => entry.options.id)
  const mainKeys = ctx.slots.entriesOfSlot('main').map((entry) => entry.options.key)
  assert.deepEqual([...mainKeys].sort(), [...sideIds].sort(), '侧栏 id 与 main key 必须完全一致')
  for (const entry of ctx.slots.entriesOfSlot('main')) {
    assert.equal(entry.options.name, 'main')
    assert.equal(typeof entry.component, 'function')
  }
  assert.ok(mainKeys.includes('gallery'))
  assert.ok(mainKeys.includes('video'))
})

test('对话/轨迹那一行的按钮也注册着（同一个插件，不是第二个程序）', async () => {
  const { exports } = await loadClientModule()
  const ctx = fakeCtx()
  exports.apply(ctx)
  const headers = ctx.slots.entriesOfSlot('conversation.session.header.actions')
  // 余额徽章 + 生图 + 生视频：三个入口都挂在同一个插件上
  assert.equal(headers.length, 3)
  const byId = new Map(headers.map((entry) => [entry.options.id, entry]))
  assert.ok(byId.has('dsh-gpt-image'))
  assert.ok(byId.has('dsh-gpt-image-video'))
  assert.ok(byId.has('dsh-gpt-image-balance'))
  assert.equal(byId.get('dsh-gpt-image').options.label(), '生图')
  assert.equal(byId.get('dsh-gpt-image-video').options.label(), '生视频')
})

test('侧栏/面板组件读的是本插件接口（/gpt-image/api + 核对）', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  assert.match(source, /const API = '\/gpt-image\/api'/)
  assert.match(source, /API \+ '\/images'/)
  assert.match(source, /API \+ '\/check'/)
  assert.match(source, /API \+ '\/file\?path='/)
})
