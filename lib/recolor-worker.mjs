/**
 * 换色 worker：在独立线程里跑 recolorSheet。
 *
 * 为什么要单开线程：`recolorSheet` 是纯 CPU 的逐像素运算。Node 主线程是单线程的，
 * 所以在主线程里"并发 4 路"只是把 4 个 CPU 任务排成一队 —— 实测只快约 20%（只重叠了 I/O）。
 * 真要吃满多核，就得把计算搬到 worker_threads。
 *
 * 协议：
 *   收 { id, buffer:Uint8Array, params:object }
 *   发 { id, ok:true, buffer:Uint8Array, changed, note } | { id, ok:false, error }
 */
import { parentPort } from 'node:worker_threads'
import { Buffer } from 'node:buffer'
import { recolorSheet } from './variant.js'

parentPort?.on('message', (message) => {
  const { id, buffer, params } = message ?? {}
  try {
    const result = recolorSheet({ buffer: Buffer.from(buffer), ...(params ?? {}) })
    if (!result.ok) {
      parentPort.postMessage({ id, ok: false, error: result.error ?? '换色失败' })
      return
    }
    /* 拷成独立的 Uint8Array 再 transfer：Node 的 Buffer 可能是共享内存池的切片，
     * 直接 transfer 它底下的 ArrayBuffer 会波及别的 Buffer（非常隐蔽的脏数据）。 */
    const out = new Uint8Array(result.buffer)
    parentPort.postMessage(
      { id, ok: true, buffer: out, changed: result.changed, note: result.note, total: result.total },
      [out.buffer],
    )
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) })
  }
})
