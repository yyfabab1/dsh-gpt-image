/**
 * 拆件傀儡管线测试。
 *
 * 这套逻辑里最容易**静默错**的是坐标数学：算错了不会报错，只是部件画在错的位置、
 * 或者关节转起来像拧麻花。所以测试重点：
 *   ① **positional 的核心性质**：所有变换归零时，部件必须回到它在图纸上的原始位置
 *      （这条成立，"位置即装配关系"才成立；不成立就说明骨架数学错了）
 *   ② 旋转 90° 后坐标必须落在该落的地方（手算可验）
 *   ③ 命名是启发式，但不能硬塞、不能重名、不能把没识别的悄悄丢掉
 *   ④ 校验能抓住真实的骨架事故（父级不存在 / 环 / pivot 跑出矩形）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  guessHumanoidNames, splitParts, packAtlas, buildSkeleton, autoAssemble,
  worldTransforms, drawList, validateRig, exportRig, buildPreviewHtml,
  partsPrompt, listTemplates, HUMANOID_SLOTS, RIG_VERSION,
} from '../lib/rig.js'
import { encodePngRgba, decodePngRgba } from '../lib/pngcodec.js'

const W = 320
const H = 320

/**
 * 造一张「炸开视图」的测试用角色：躯干 + 头 + 两条胳膊（横）+ 两条腿（竖，各两段）。
 * 每块互相不接触 —— 这样 alpha 连通域就会正好切出 10 块。
 */
function explodedFigure() {
  const px = new Uint8ClampedArray(W * H * 4)
  const fill = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const i = (y * W + x) * 4
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255
      }
    }
  }
  fill(140, 120, 40, 70, [90, 110, 160])   // torso（中央最大）
  fill(145, 60, 30, 52, [230, 200, 170])   // head（顶部居中）
  fill(96, 120, 32, 20, [200, 120, 90])    // upper_arm_R（画面左）
  fill(60, 124, 30, 16, [200, 120, 90])    // forearm_R（更左）
  fill(192, 120, 32, 20, [200, 120, 90])   // upper_arm_L（画面右）
  fill(228, 124, 30, 16, [200, 120, 90])   // forearm_L（更右）
  fill(140, 196, 16, 50, [120, 120, 140])  // thigh_R
  fill(164, 196, 16, 50, [120, 120, 140])  // thigh_L
  fill(140, 252, 16, 44, [120, 120, 140])  // shin_R
  fill(164, 252, 16, 44, [120, 120, 140])  // shin_L
  return encodePngRgba(W, H, px)
}

/** 造一张「4×4 零件盘」：每格一个方块，且故意留一个空格。 */
function gridSheet({ columns = 4, rows = 4, emptyCells = [7] } = {}) {
  const size = 400
  const px = new Uint8ClampedArray(size * size * 4)
  const cellW = size / columns
  const cellH = size / rows
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column
      if (emptyCells.includes(index)) continue
      const x0 = Math.round(column * cellW + cellW * 0.2)
      const y0 = Math.round(row * cellH + cellH * 0.2)
      const w = Math.round(cellW * 0.6)
      const h = Math.round(cellH * 0.6)
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const i = (y * size + x) * 4
          px[i] = 40 + index * 12; px[i + 1] = 90; px[i + 2] = 160; px[i + 3] = 255
        }
      }
    }
  }
  return encodePngRgba(size, size, px)
}

function pipe(buffer, options = {}) {
  const split = splitParts({ buffer, ...options })
  assert.equal(split.ok, true, split.error)
  const atlas = packAtlas({ buffer, parts: split.parts })
  assert.equal(atlas.ok, true, atlas.error)
  const built = buildSkeleton({ parts: split.parts, atlas, layout: options.layout ?? 'positional', name: 't' })
  assert.equal(built.ok, true, built.error)
  return { split, atlas, skeleton: built.skeleton }
}

/* ---------------- 命名 ---------------- */

test('几何命名：规范的炸开人形能全部认对（头/躯干/两臂/两腿）', () => {
  const { split } = pipe(explodedFigure())
  const names = split.parts.map((p) => p.slotName).sort()
  assert.deepEqual(names, [
    'forearm_L', 'forearm_R', 'head', 'shin_L', 'shin_R',
    'thigh_L', 'thigh_R', 'torso', 'upper_arm_L', 'upper_arm_R',
  ])
})

test('几何命名：匹配不上的部件保留原名并警告，**绝不硬塞一个看起来合理的名字**', () => {
  /* 直接构造部件数组测分类器（比造图更精准）。
     包围盒 0..100 × 5..100：
       A 顶部居中 → head
       B/C 中部左右 → 手臂
       D 正中     → torso
       E 底部正中 → nx 正好 0.5，(nx-0.5)*side 恒为 0，左右腿的规则都不成立 → 必须留原名 */
  const mk = (name, x, y, w = 10, h = 10) => ({ slotName: name, source: [x, y, w, h], area: w * h })
  const parts = [
    mk('p_A', 45, 5),
    mk('p_B', 0, 45),
    mk('p_C', 90, 45),
    mk('p_D', 45, 45),
    mk('p_E', 45, 90),
  ]
  const guessed = guessHumanoidNames(parts)
  assert.equal(guessed.names.length, parts.length, '每个部件都要有名字（不能丢）')
  assert.equal(new Set(guessed.names).size, guessed.names.length, `不能重名：${guessed.names.join(',')}`)
  // E 不该被硬塞成某条腿
  const eIndex = parts.findIndex((p) => p.slotName === 'p_E')
  assert.equal(guessed.names[eIndex], 'p_E', `底部正中那块不该被硬塞名字，实际被命名为 ${guessed.names[eIndex]}`)
  assert.ok(guessed.warnings.some((w) => w.includes('p_E')), `未识别的部件必须点名警告：${JSON.stringify(guessed.warnings)}`)
})

test('命名不会丢部件、不会重名（任何输入下这两条都不能破）', () => {
  for (const buffer of [explodedFigure(), gridSheet()]) {
    const split = splitParts({ buffer })
    const names = split.parts.map((p) => p.slotName)
    assert.equal(names.length, split.parts.length)
    assert.equal(new Set(names).size, names.length, `有重名：${names.join(',')}`)
  }
})

test('命名不会产生重名（重名会让骨骼重名、直接校验失败）', () => {
  const { split } = pipe(explodedFigure())
  const names = split.parts.map((p) => p.slotName)
  assert.equal(new Set(names).size, names.length, `有重名：${names.join(',')}`)
})

test('显式 names 优先级最高（最可靠的命名方式）', () => {
  const buffer = explodedFigure()
  const split = splitParts({ buffer, names: null })
  const explicit = ['head', 'torso', 'ua', 'la', 'ur', 'lr', 'tl', 'tr', 'sl', 'sr']
  const forced = splitParts({ buffer, names: explicit })
  assert.equal(forced.nameStrategy, 'explicit')
  assert.deepEqual(forced.parts.map((p) => p.slotName), explicit)
})

/* ---------------- 切分 ---------------- */

test('positional：按 alpha 连通域切出全部独立块', () => {
  const split = splitParts({ buffer: explodedFigure() })
  assert.equal(split.layout, 'positional')
  assert.equal(split.parts.length, 10, `应切出 10 块，实际 ${split.parts.length}`)
  for (const p of split.parts) {
    assert.equal(p.source.length, 4)
    assert.ok(p.source[2] > 0 && p.source[3] > 0, '包围盒不能是空的')
    assert.ok(p.area > 0)
  }
})

test('positional：噪点会被丢掉并说明（不然会多出一堆 hand_3 之类）', () => {
  const size = 100
  const px = new Uint8ClampedArray(size * size * 4)
  for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) {
    const i = (y * size + x) * 4; px[i] = 200; px[i + 1] = 200; px[i + 2] = 200; px[i + 3] = 255
  }
  // 一个 2×2 的噪点（< minArea 24）
  for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) {
    const i = (y * size + x) * 4; px[i] = 255; px[i + 3] = 255
  }
  const split = splitParts({ buffer: encodePngRgba(size, size, px) })
  assert.equal(split.parts.length, 1, '噪点不该算部件')
  assert.ok(split.warnings.some((w) => w.includes('噪点')), JSON.stringify(split.warnings))
})

test('grid：格子序号 ↔ 槽位是硬对应（名字精确），空格会报出是哪一件没画', () => {
  const split = splitParts({ buffer: gridSheet(), layout: 'grid', grid: { columns: 4, rows: 4 } })
  assert.equal(split.layout, 'grid')
  assert.equal(split.nameStrategy, 'template-order')
  assert.equal(split.parts.length, 15, '16 格里空 1 格 → 15 个部件')
  assert.equal(split.parts[0].slotName, HUMANOID_SLOTS[0].name, '第一格应是对应模板第一个槽位')
  assert.ok(split.warnings.some((w) => w.includes('空的')), `空格要报出来：${JSON.stringify(split.warnings)}`)
})

test('全透明的图：明确报错，而不是返回 0 个部件的"成功"', () => {
  const empty = encodePngRgba(64, 64, new Uint8ClampedArray(64 * 64 * 4))
  const split = splitParts({ buffer: empty })
  assert.equal(split.ok, false)
  assert.match(split.error, /全透明|没切到/)
})

/* ---------------- 图集 ---------------- */

test('图集：部件像素被原样搬过去（不是空白图、不是错位）', () => {
  const buffer = explodedFigure()
  const { split, atlas } = pipe(buffer)
  const src = decodePngRgba(buffer)
  const out = decodePngRgba(atlas.buffer)
  assert.ok(out, '图集要是合法 PNG')
  assert.equal(out.width, atlas.width)
  assert.equal(out.height, atlas.height)
  // 逐个部件比对：源块 ↔ 图集块 必须逐像素相同
  let checked = 0
  for (const part of atlas.parts) {
    const [rx, ry, rw, rh] = part.rect
    const [sx, sy] = part.sourceRect
    for (let y = 0; y < rh; y += 3) {
      for (let x = 0; x < rw; x += 3) {
        const si = ((sy + y) * src.width + (sx + x)) * 4
        const di = ((ry + y) * out.width + (rx + x)) * 4
        assert.equal(out.pixels[di], src.pixels[si], `${part.name} (${x},${y}) 红色通道不符`)
        assert.equal(out.pixels[di + 3], src.pixels[si + 3], `${part.name} (${x},${y}) alpha 不符`)
        checked += 1
      }
    }
  }
  assert.ok(checked > 100, '比对样本太少')
})

/* ---------------- 骨架 + 核心性质 ---------------- */

test('★ 核心性质：所有变换归零时，部件回到它在图纸上的**原始相对位置**', () => {
  const buffer = explodedFigure()
  const { skeleton } = pipe(buffer)
  const list = drawList(skeleton)
  assert.equal(list.length, skeleton.parts.length)

  // 用"最小左上角"当基准，比较每个部件的相对偏移是否和图纸一致
  const minSrcX = Math.min(...skeleton.parts.map((p) => p.sourceRect[0]))
  const minSrcY = Math.min(...skeleton.parts.map((p) => p.sourceRect[1]))
  const minDrawX = Math.min(...list.map((d) => d.drawX))
  const minDrawY = Math.min(...list.map((d) => d.drawY))
  for (const draw of list) {
    const part = skeleton.parts.find((p) => p.name === draw.name)
    const srcOffX = part.sourceRect[0] - minSrcX
    const srcOffY = part.sourceRect[1] - minSrcY
    const drawOffX = draw.drawX - minDrawX
    const drawOffY = draw.drawY - minDrawY
    assert.ok(Math.abs(srcOffX - drawOffX) < 1.01, `${draw.name} 横向偏移错了：图纸 ${srcOffX} vs 绘制 ${drawOffX}`)
    assert.ok(Math.abs(srcOffY - drawOffY) < 1.01, `${draw.name} 纵向偏移错了：图纸 ${srcOffY} vs 绘制 ${drawOffY}`)
  }
})

test('世界变换：转 90° 后子骨骼坐标落在该落的地方（手算可验）', () => {
  // 两根骨骼：a 在原点，b 在 a 的 (10,0)；a 转 90° → b 的世界坐标应是 (0,10)
  const skeleton = {
    version: RIG_VERSION, name: 't', atlas: { image: 'a.png' },
    bones: [
      { name: 'a', parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      { name: 'b', parent: 'a', x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    ],
    parts: [
      { name: 'a', rect: [0, 0, 4, 4], pivot: [0, 0], zOrder: 0 },
      { name: 'b', rect: [4, 0, 4, 4], pivot: [0, 0], zOrder: 1 },
    ],
    drawOrder: ['a', 'b'],
  }
  const world = worldTransforms(skeleton, { a: { rotation: 90 } })
  const b = world.get('b')
  assert.ok(Math.abs(b.x - 0) < 1e-6, `b.x 应为 0，实际 ${b.x}`)
  assert.ok(Math.abs(b.y - 10) < 1e-6, `b.y 应为 10，实际 ${b.y}`)
  assert.ok(Math.abs(b.rotation - 90) < 1e-6, '子骨骼要继承父级旋转')
})

test('层级：子骨骼的 x/y 是**相对父级**的（不是绝对坐标）', () => {
  const { skeleton } = pipe(explodedFigure())
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]))
  const forearmL = byName.get('forearm_L')
  const upperArmL = byName.get('upper_arm_L')
  assert.equal(forearmL.parent, 'upper_arm_L', '前臂的父级应是上臂')
  // 相对偏移应该小（相邻关节），而绝对位置不会小 —— 这里只验证"相对"这一点
  assert.ok(Math.abs(forearmL.x) < 300 && Math.abs(forearmL.y) < 300)
  assert.ok(upperArmL, '上臂要在')
})

test('绘制顺序：drawOrder 一定覆盖全部部件，且按 zOrder 升序', () => {
  const { skeleton } = pipe(explodedFigure())
  const names = new Set(skeleton.parts.map((p) => p.name))
  assert.equal(skeleton.drawOrder.length, names.size)
  assert.equal(new Set(skeleton.drawOrder).size, names.size, 'drawOrder 不能重复')
  const zOf = new Map(skeleton.parts.map((p) => [p.name, p.zOrder]))
  for (let i = 1; i < skeleton.drawOrder.length; i++) {
    assert.ok(zOf.get(skeleton.drawOrder[i - 1]) <= zOf.get(skeleton.drawOrder[i]), 'drawOrder 必须按 zOrder 升序')
  }
})

/* ---------------- 自动装配 ---------------- */

test('自动合拢关节：缝隙会收，且单件位移不超过限幅（防止"手被吸到躯干上"）', () => {
  const buffer = explodedFigure()
  const { skeleton, atlas } = pipe(buffer)
  const before = skeleton.bones.map((b) => ({ name: b.name, x: b.x, y: b.y }))
  const result = autoAssemble({ skeleton, buffer: atlas.buffer, maxShift: 0.04 })
  assert.equal(result.ok, true, result.error)
  const charH = skeleton.meta.charHeight
  const limit = charH * 0.04 + 0.01
  for (const move of result.moves) {
    assert.ok(Math.hypot(move.dx, move.dy) <= limit + 1e-6, `${move.bone} 位移 ${Math.hypot(move.dx, move.dy)} 超过限幅 ${limit}`)
  }
  // 动过的骨骼总得真的变了
  const changed = skeleton.bones.filter((b) => {
    const old = before.find((o) => o.name === b.name)
    return old && (Math.abs(old.x - b.x) > 1e-6 || Math.abs(old.y - b.y) > 1e-6)
  })
  assert.equal(changed.length, result.moved)
})

/* ---------------- 校验 ---------------- */

test('校验：能抓住父级不存在 / 层级成环 / pivot 跑出矩形 / drawOrder 不一致', () => {
  const base = () => ({
    version: RIG_VERSION, name: 't', atlas: { image: 'a.png' },
    bones: [
      { name: 'a', parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      { name: 'b', parent: 'a', x: 1, y: 1, rotation: 0, scaleX: 1, scaleY: 1 },
    ],
    parts: [
      { name: 'a', rect: [0, 0, 10, 10], pivot: [5, 5], zOrder: 0 },
      { name: 'b', rect: [10, 0, 10, 10], pivot: [5, 5], zOrder: 1 },
    ],
    drawOrder: ['a', 'b'],
  })
  assert.equal(validateRig(base()).ok, true, '干净的骨架要能过')

  const missingParent = base()
  missingParent.bones[1].parent = '不存在'
  assert.ok(validateRig(missingParent).errors.some((e) => e.includes('不存在')))

  const cycle = base()
  cycle.bones[0].parent = 'b'
  assert.ok(validateRig(cycle).errors.some((e) => e.includes('环')))

  const badPivot = base()
  badPivot.parts[0].pivot = [99, 99]
  assert.ok(validateRig(badPivot).errors.some((e) => e.includes('pivot')), '枢轴跑出 rect 要报错（旋转会绕空气转）')

  const badDraw = base()
  badDraw.drawOrder = ['a', '不存在的']
  assert.ok(validateRig(badDraw).errors.some((e) => e.includes('drawOrder')))

  const dup = base()
  dup.bones[1].name = 'a'
  assert.ok(validateRig(dup).errors.some((e) => e.includes('重名')))
})

test('校验：真实管线的产物必须直接通过', () => {
  for (const layout of ['positional', 'grid']) {
    const buffer = layout === 'positional' ? explodedFigure() : gridSheet()
    const { skeleton } = pipe(buffer, { layout, grid: layout === 'grid' ? { columns: 4, rows: 4 } : undefined })
    const check = validateRig(skeleton)
    assert.equal(check.ok, true, `${layout} 的产物校验失败：${check.errors.join('；')}`)
  }
})

/* ---------------- 导出 ---------------- */

test('导出：generic / spine / dragonbones 都能出，结构关键字段齐全', () => {
  const { skeleton } = pipe(explodedFigure())

  const generic = exportRig({ skeleton, format: 'generic' })
  assert.equal(generic.ok, true, generic.error)
  const g = JSON.parse(generic.files[0].content)
  assert.equal(g.format, 'generic')
  assert.equal(g.bones.length, skeleton.bones.length)
  assert.ok(g.drawOrder.length > 0)

  const spine = exportRig({ skeleton, format: 'spine' })
  assert.equal(spine.ok, true, spine.error)
  const s = JSON.parse(spine.files[0].content)
  assert.ok(s.skeleton.spine, 'Spine 要有 spine 版本号')
  assert.equal(s.bones.length, skeleton.bones.length)
  assert.equal(s.slots.length, skeleton.drawOrder.length)
  assert.ok(s.skins[0].attachments, 'Spine 要有 skins.attachments')

  const db = exportRig({ skeleton, format: 'dragonbones' })
  assert.equal(db.ok, true, db.error)
  const d = JSON.parse(db.files[0].content)
  assert.equal(d.format, 'dragonbones')
  assert.equal(d.armature[0].bone.length, skeleton.bones.length)
  assert.equal(d.armature[0].slot.length, skeleton.drawOrder.length)
})

test('导出：骨架有问题时**拒绝导出**（不产出半成品去祸害引擎）', () => {
  const bad = { version: RIG_VERSION, name: 'x', atlas: {}, bones: [], parts: [], drawOrder: [] }
  const out = exportRig({ skeleton: bad, format: 'generic' })
  assert.equal(out.ok, false)
  assert.match(out.error, /骨架有问题/)
})

test('导出：不认识的格式给出可选项，而不是抛异常', () => {
  const { skeleton } = pipe(explodedFigure())
  const out = exportRig({ skeleton, format: 'unity-psb' })
  assert.equal(out.ok, false)
  assert.match(out.error, /generic/)
})

/* ---------------- 预览器 ---------------- */

test('预览器：单文件自包含（图集内联成 data URL + 骨架内联 JSON）', () => {
  const { atlas, skeleton } = pipe(explodedFigure())
  const html = buildPreviewHtml({ skeleton, atlasPng: atlas.buffer })
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.match(html, /data:image\/png;base64,/, '图集要内联（不然单文件发出去打不开）')
  assert.match(html, /const sk = /, '骨架要内联')
  for (const keyword of ['renamePart', 'assemble', 'pointerdown', 'drawOrder']) {
    assert.ok(html.includes(keyword), `预览器缺少「${keyword}」（拖关节/改名/合拢是实现的关键交互）`)
  }
  // 骨架里的名字要能出现在 HTML 里（说明真的内联进去了）
  assert.ok(html.includes(skeleton.parts[0].name))
})

test('预览器：骨架里有 < 号时不会破坏 HTML（转义过）', () => {
  const skeleton = {
    version: RIG_VERSION, name: 'a<b>c', atlas: { image: 'x.png' },
    bones: [{ name: 'a', parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }],
    parts: [{ name: 'a', rect: [0, 0, 4, 4], pivot: [2, 2], zOrder: 0 }],
    drawOrder: ['a'],
  }
  const html = buildPreviewHtml({ skeleton, atlasPng: null })
  assert.ok(!html.includes('<b>c'), '骨架里的尖括号必须转义，否则会注入/破坏页面')
})

/* ---------------- 提示词 ---------------- */

test('拆件提示词：两种版面都把"可切分"的关键约束写进去了', () => {
  const positional = partsPrompt({ layout: 'positional' })
  const grid = partsPrompt({ layout: 'grid' })
  for (const [text, label] of [[positional, 'positional'], [grid, 'grid']]) {
    assert.match(text, /transparent background/i, `${label} 必须要求透明底`)
    assert.match(text, /no (scenery|checkerboard|text)/i, `${label} 必须排除干扰`)
    assert.match(text, /down/i, `${label} 必须约定四肢朝向（否则默认 pivot 全错）`)
  }
  assert.match(positional, /gap|pulled apart/i, 'positional 要说明"拉开一小段"')
  assert.match(grid, /4x4/i, 'grid 要说明网格')
  // extra 要能拼进去
  assert.match(partsPrompt({ layout: 'positional', extra: 'a red-haired knight' }), /red-haired knight/)
})

test('模板：人形 16 件，父子关系都指向存在的槽位', () => {
  const list = listTemplates()
  assert.ok(list.length >= 2, `现在有侧视人形和正俯视两套模板，实际 ${list.length}`)
  assert.ok(list.some((t) => t.id === 'humanoid'))
  assert.equal(HUMANOID_SLOTS.length, 16)
  const names = new Set(HUMANOID_SLOTS.map((s) => s.name))
  for (const slot of HUMANOID_SLOTS) {
    if (slot.parent) assert.ok(names.has(slot.parent), `${slot.name} 的父级 ${slot.parent} 不在槽位表里`)
  }
  assert.equal(HUMANOID_SLOTS.filter((s) => !s.parent).length, 1, '只能有一个根（hip）')
  const zs = HUMANOID_SLOTS.map((s) => s.z)
  assert.equal(new Set(zs).size, zs.length, 'z 不能重复（否则绘制顺序不确定）')
})
