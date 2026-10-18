/**
 * worker 池测试（换色真多核并行）。
 *
 * 背景：`recolorSheet` 是纯 CPU 的逐像素运算。Node 主线程单线程，
 * 在主线程里"并发"只是把任务排队 —— 实测只快约 20%。搬到 worker_threads 才真吃多核：
 * 6 个变体 2.53x、12 个 3.39x（4 核接近上限）。
 *
 * 这里钉住三件最容易坏的事：
 *   ① worker 算出来的结果必须和主线程**逐字节一致**（并行不能改变语义）
 *   ② 单任务/worker 不可用时必须**降级**而不是失败（功能不能因为"想快"而变坏）
 *   ③ 池子能复用，也能干净关闭（不留下让进程挂住的线程）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePngRgba } from '../lib/pngcodec.js'
import { recolorSheet } from '../lib/variant.js'
import { recolorBatch, closeRecolorPool, defaultPoolSize } from '../lib/workerpool.js'

/** 造一张有渐变的图（纯色图会掩盖坐标/采样错误）。 */
function makePng(width = 240, height = 120) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      pixels[i] = (x * 255) / width
      pixels[i + 1] = (y * 255) / height
      pixels[i + 2] = 128
      pixels[i + 3] = x < 8 && y < 8 ? 0 : 255
    }
  }
  return encodePngRgba(width, height, pixels)
}

test('defaultPoolSize 在合理范围（留一个核给主线程，最多 4）', () => {
  const size = defaultPoolSize()
  assert.ok(size >= 1 && size <= 4, `并行度应在 1~4，实际 ${size}`)
})

test('单任务走 inline（IPC 开销比省下的还多，没必要开线程）', async () => {
  const buffer = makePng()
  const r = await recolorBatch({ jobs: [{ buffer, params: { preset: 'blue' } }] })
  assert.equal(r.mode, 'inline', '单任务应走主线程')
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].ok, true)
})

test('★ 多任务走 worker，且结果与主线程**逐字节一致**', async () => {
  const buffer = makePng()
  const params = [{ preset: 'blue' }, { hue: 90 }, { grayscale: 1 }, { saturation: 0.4, brightness: 1.2 }]

  const inline = params.map((p) => recolorSheet({ buffer, ...p }))
  const pooled = await recolorBatch({ jobs: params.map((p) => ({ buffer, params: p })) })

  assert.equal(pooled.mode, 'worker', `多任务应走 worker，实际 ${pooled.mode}`)
  assert.equal(pooled.results.length, params.length)
  for (let i = 0; i < params.length; i += 1) {
    assert.equal(pooled.results[i].ok, true, `第 ${i + 1} 个换色失败：${pooled.results[i].error}`)
    assert.ok(
      Buffer.from(pooled.results[i].buffer).equals(Buffer.from(inline[i].buffer)),
      `第 ${i + 1} 个变体的 worker 结果必须和主线程一致（并行不能改变语义）`,
    )
    assert.equal(pooled.results[i].changed, inline[i].changed, `第 ${i + 1} 个 changed 数也应一致`)
  }
})

test('★ 池子可复用：连续两批都成功（不会用一次就坏）', async () => {
  const buffer = makePng()
  const batch = (tag) => recolorBatch({ jobs: [{ buffer, params: { preset: 'red', hue: 10 } }, { buffer, params: { preset: 'blue', hue: 200 } }] })
  const first = await batch('a')
  assert.equal(first.mode, 'worker')
  const second = await batch('b')
  assert.equal(second.mode, 'worker', '第二次仍应走 worker')
  assert.ok(second.results.every((r) => r.ok))
  // 两批结果应一致（同样的输入 → 同样的输出，缓存/状态不能污染）
  assert.ok(Buffer.from(first.results[0].buffer).equals(Buffer.from(second.results[0].buffer)),
    '同样的输入两批结果必须一致')
})

test('★ 降级：size=1 时退回主线程，结果照样正确', async () => {
  const buffer = makePng()
  const r = await recolorBatch({ jobs: [{ buffer, params: { preset: 'blue' } }, { buffer, params: { preset: 'red' } }], size: 1 })
  assert.equal(r.mode, 'inline', 'size=1 应退回 inline')
  assert.equal(r.results.length, 2)
  assert.ok(r.results.every((x) => x.ok))
})

test('空任务列表返回空结果，不炸', async () => {
  const r = await recolorBatch({ jobs: [] })
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 0)
})

test('closeRecolorPool 之后还能继续用（重新建池）', async () => {
  const buffer = makePng()
  closeRecolorPool()
  const r = await recolorBatch({ jobs: [{ buffer, params: { preset: 'blue' } }, { buffer, params: { preset: 'blue', hue: 30 } }] })
  assert.ok(r.results.every((x) => x.ok), '关掉池子后再调用应能重建')
  closeRecolorPool()
})
