/**
 * 预览图策略测试（*_labeled.png 的开关 / 缩小 / 关闭）。
 *
 * 为什么需要这个开关：预览图是插件「每张素材都配一张印着名字的图」这条硬规定的产物，
 * 但它一直是**原尺寸**的 —— 一张 1024×1024 素材的预览图也是完整 1024×1024 PNG（约 1MB）。
 * 实测攒了 535 张、吃掉 928MB，直接把磁盘塞满了。
 *
 * 所以现在有三档：
 *   'small'（默认）→ 缩到最长边 384px，名字照样看清，体积只剩 2~3%
 *   'on'           → 原尺寸（旧行为）
 *   'off'          → 完全不生成
 *
 * 这里钉住的是**策略判断逻辑**（不需要 PowerShell 也能测）；
 * 真正画图那一步在 Windows 上才跑，跑不了就跳过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_LABEL_POLICY, getLabelPolicy, setLabelPolicy, labelForAsset, labelImage,
} from '../lib/label.js'
import { encodePngRgba } from '../lib/pngcodec.js'

/** 造一张纯色小图。 */
async function makePng(dir, size = 64, color = [220, 90, 60]) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = 255
  }
  const file = path.join(dir, `a_${size}.png`)
  await writeFile(file, encodePngRgba(size, size, pixels))
  return file
}

test('默认策略是 small + 384（不是原尺寸 —— 原尺寸会吃磁盘）', async () => {
  const policy = setLabelPolicy({ ...DEFAULT_LABEL_POLICY })
  assert.equal(policy.mode, 'small')
  assert.equal(policy.maxSide, 384)
  assert.deepEqual(getLabelPolicy(), { mode: 'small', maxSide: 384 })
})

test('setLabelPolicy 只接受合法 mode，非法值不生效（不会把策略搞坏）', () => {
  setLabelPolicy({ mode: 'small', maxSide: 384 })
  const before = getLabelPolicy()
  // 非法 mode：保持原样
  const after = setLabelPolicy({ mode: 'banana' })
  assert.equal(after.mode, before.mode, '非法 mode 不应该改动当前策略')
  // 合法 mode 生效
  assert.equal(setLabelPolicy({ mode: 'off' }).mode, 'off')
  assert.equal(setLabelPolicy({ mode: 'on' }).mode, 'on')
  // maxSide 负数/非法值：保持原样
  setLabelPolicy({ mode: 'small', maxSide: 384 })
  assert.equal(setLabelPolicy({ maxSide: -5 }).maxSide, 384)
  assert.equal(setLabelPolicy({ maxSide: 512 }).maxSide, 512)
  setLabelPolicy({ ...DEFAULT_LABEL_POLICY })
})

test('mode=off：直接跳过，并且**标记 skipped**（不能算成失败）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'label-off-'))
  try {
    const file = await makePng(dir)
    setLabelPolicy({ mode: 'off' })
    const r = await labelForAsset({ file, name: 'unit', project: 'demo', size: '64x64' })
    assert.equal(r.ok, false)
    assert.equal(r.skipped, true, '关掉时必须是 skipped，不是 error —— 上层不能报"预览图失败"')
    assert.ok(r.reason.includes('off'))
    assert.equal(r.policy.mode, 'off')
    // 不该产生任何 _labeled 文件
    const target = file.replace(/\.png$/, '_labeled.png')
    assert.equal(await stat(target).then(() => true).catch(() => false), false)
  } finally {
    setLabelPolicy({ ...DEFAULT_LABEL_POLICY })
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有素材名时仍然拒绝（硬规定：每个素材必须有 name）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'label-noname-'))
  try {
    const file = await makePng(dir)
    setLabelPolicy({ ...DEFAULT_LABEL_POLICY })
    const r = await labelForAsset({ file, name: '' })
    assert.equal(r.ok, false)
    assert.match(r.error, /没有素材名/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('small 模式真的把预览图缩小了（尺寸必须被压下来）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'label-size-'))
  try {
    // 用一张大一点的图，差异才看得出来
    const file = await makePng(dir, 512, [180, 120, 60])

    // 原尺寸
    setLabelPolicy({ mode: 'on' })
    const big = await labelImage({ file, text: 'unit', maxSide: 0 })
    // 缩小
    const small = await labelImage({ file, text: 'unit', maxSide: 128 })

    if (!big.ok || !small.ok) {
      // 这台机器上没 PowerShell / 画不了字 → 跳过（不误报）
      console.log(`  （画不了预览图，跳过：${(big.error ?? small.error ?? '').slice(0, 80)}）`)
      return
    }
    /* 断言尺寸而不是字节数：纯色图压缩后两边都只有几百字节，比字节毫无意义
     * （第一版就是这么写错的 —— 512 和 128 都压到 894B）。尺寸才是这条策略的实质。 */
    assert.equal(big.width, 512, `on 模式不该缩：实际 ${big.width}x${big.height}`)
    assert.ok(small.width <= 128 && small.height <= 128,
      `small 的最长边应压到 128 以内，实际 ${small.width}x${small.height}`)
    assert.ok(small.width < big.width, '缩小的预览图必须比原尺寸小')
  } finally {
    setLabelPolicy({ ...DEFAULT_LABEL_POLICY })
    await rm(dir, { recursive: true, force: true })
  }
})
