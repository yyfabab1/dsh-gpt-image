/**
 * 尺寸守卫测试。
 *
 * 依据是 OpenAI 官方 gpt-image-2 约束（cookbook 原文）：
 *   最长边 < 3840 · 两边都是 16 的倍数 · 比例 ≤ 3:1 · 总像素 655,360~8,294,400
 *
 * 为什么值得单独测：尺寸不合法时上游要么 400（白花一次），要么**默默给你裁过的图**。
 * 后者最坑 —— 你以为出的是 2048×2048，其实是别的尺寸，而且没人告诉你。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SIZE_RULES, isPixelSize, parsePixelSize, snapEdge, snapSize, checkImageSize, popularSizes, minSquareEdge,
} from '../lib/sizeguard.js'

test('解析：只认「宽x高」像素写法，档位写法不算像素尺寸', () => {
  assert.deepEqual(parsePixelSize('1024x1024'), { width: 1024, height: 1024 })
  assert.deepEqual(parsePixelSize('1536 × 1024'), { width: 1536, height: 1024 })
  assert.deepEqual(parsePixelSize('1024*768'), { width: 1024, height: 768 })
  assert.equal(parsePixelSize('1K'), null)
  assert.equal(parsePixelSize('auto'), null)
  assert.equal(parsePixelSize(''), null)
  assert.equal(isPixelSize('1024x1024'), true)
  assert.equal(isPixelSize('2K'), false)
})

test('snapEdge：吸附到最近的 16 的倍数', () => {
  assert.equal(snapEdge(1000), 1008)
  assert.equal(snapEdge(1024), 1024)
  assert.equal(snapEdge(1), 16)
  assert.equal(snapEdge(0), 16)
})

test('合法尺寸直接通过，不做任何改动', () => {
  for (const size of ['1024x1024', '1536x1024', '1024x1536', '2560x1440']) {
    const r = checkImageSize(size)
    assert.equal(r.ok, true, `${size} 应该合法：${r.errors.join('；')}`)
    assert.equal(r.kind, 'pixel')
    assert.equal(r.fixed, null, '合法尺寸不该被改')
  }
})

test('非 16 倍数 → 吸附（1000x1000 → 1008x1008）', () => {
  const r = checkImageSize('1000x1000')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('16')), JSON.stringify(r.errors))
  assert.equal(r.fixed, '1008x1008')
})

test('低于总像素下限 → 放大（512x512 是做不到的，这点很多人不知道）', () => {
  const r = checkImageSize('512x512')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('低于')), JSON.stringify(r.errors))
  const fixed = parsePixelSize(r.fixed)
  assert.ok(fixed.width * fixed.height >= SIZE_RULES.minPixels, `吸附后仍低于下限：${r.fixed}`)
  // 最小可用方图应该是 816（sqrt(655360)=809.6 → 吸附到 816）
  assert.equal(minSquareEdge(), 816)
})

test('超上限：最长边 ≥3840、总像素超限 → 缩小', () => {
  const edge = checkImageSize('3840x2160')
  assert.equal(edge.ok, false)
  assert.ok(edge.errors.some((e) => e.includes('最长边')), JSON.stringify(edge.errors))
  assert.ok(parsePixelSize(edge.fixed).width < 3840)

  const huge = checkImageSize('4096x4096')
  assert.equal(huge.ok, false)
  assert.ok(huge.errors.some((e) => e.includes('总像素')))
  const f = parsePixelSize(huge.fixed)
  assert.ok(f.width * f.height <= SIZE_RULES.maxPixels, `吸附后仍超上限：${huge.fixed}`)
})

test('比例超 3:1 → 把长边压到 3 倍', () => {
  const r = checkImageSize('500x2000')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('比例') || e.includes('3:1')), JSON.stringify(r.errors))
  const f = parsePixelSize(r.fixed)
  const ratio = Math.max(f.width, f.height) / Math.min(f.width, f.height)
  assert.ok(ratio <= SIZE_RULES.maxRatio + 1e-9, `吸附后比例仍超：${r.fixed} (${ratio})`)
  assert.equal(f.width % 16, 0)
  assert.equal(f.height % 16, 0)
})

test('超过 2K 只是**警告**不是错误（官方标注为实验性）', () => {
  const r = checkImageSize('2048x2048') // 4,194,304 > 3,686,400
  assert.equal(r.ok, true, '2048² 在硬约束内，应当合法')
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /实验性/)
  assert.equal(r.fixed, null, '只是警告，不该改尺寸')
})

test('档位写法（1K/2K/auto）原样放过 —— 交给各服务商模板处理', () => {
  for (const size of ['1K', '2K', '3K', '4K', 'auto']) {
    const r = checkImageSize(size)
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'tier')
    assert.equal(r.size, size)
    assert.equal(r.fixed, null)
  }
  assert.equal(checkImageSize('').kind, 'unknown')
})

test('吸附结果必须**总是**满足全部硬约束（回归：手写过一版会越界）', () => {
  const bad = ['1000x1000', '512x512', '4096x4096', '3840x2160', '500x2000', '17x9999', '1023x769']
  for (const size of bad) {
    const r = checkImageSize(size)
    if (r.ok) continue
    const f = parsePixelSize(r.fixed)
    assert.ok(f, `${size} 的吸附结果解不开：${r.fixed}`)
    assert.equal(f.width % SIZE_RULES.edgeMultiple, 0, `${size} → ${r.fixed} 宽度不是 16 倍数`)
    assert.equal(f.height % SIZE_RULES.edgeMultiple, 0, `${size} → ${r.fixed} 高度不是 16 倍数`)
    assert.ok(Math.max(f.width, f.height) < SIZE_RULES.maxEdge, `${size} → ${r.fixed} 最长边越界`)
    assert.ok(Math.max(f.width, f.height) / Math.min(f.width, f.height) <= SIZE_RULES.maxRatio + 1e-9,
      `${size} → ${r.fixed} 比例越界`)
    assert.ok(f.width * f.height >= SIZE_RULES.minPixels, `${size} → ${r.fixed} 总像素低于下限`)
    assert.ok(f.width * f.height <= SIZE_RULES.maxPixels, `${size} → ${r.fixed} 总像素超上限`)
  }
})

test('popularSizes 里每一项都真的合法（文档不能写错尺寸）', () => {
  for (const item of popularSizes()) {
    const r = checkImageSize(item.size)
    assert.equal(r.ok, true, `popularSizes 里的「${item.label} ${item.size}」其实不合法：${r.errors.join('；')}`)
  }
})
