/**
 * 极小的 worker 池（只为换色这种纯 CPU 任务）。
 *
 * 设计原则（都来自这次实测的教训）：
 *   ① **必须有降级**：worker 起不来（权限/环境/资源限制）就退回主线程跑，
 *      功能绝不能因为"想快一点"而变坏。
 *   ② **常驻池**：worker 启动约 30~50ms，一次批量里反复新建就白花了。池子模块级常驻，
 *      `unref()` 掉，不阻止进程退出。
 *   ③ **单任务不走 worker**：1 个变体时 IPC + 序列化的开销比省下的还多，直接主线程做。
 *   ④ **超时保护**：worker 卡住不能把整个调用拖死。
 */
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import { Buffer } from 'node:buffer'
import { recolorSheet } from './variant.js'

const WORKER_URL = new URL('./recolor-worker.mjs', import.meta.url)

/** 默认并行度：留一个核给主线程，最多 4 个（再多收益递减，而且每线程要拷一份源图）。 */
export function defaultPoolSize() {
  const cores = (() => {
    try { return os.availableParallelism?.() ?? os.cpus().length } catch { return 4 }
  })()
  return Math.max(1, Math.min(4, cores - 1))
}

let pool = null
let poolBroken = false

class RecolorPool {
  constructor(size) {
    this.size = Math.max(1, size)
    this.workers = []
    this.idle = []
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
  }

  async init() {
    if (this.ready) return true
    try {
      for (let i = 0; i < this.size; i += 1) {
        const worker = this.#spawn()
        this.workers.push(worker)
        /* ★ 新建的 worker 必须立刻进空闲池。
         * 第二版就是这样死锁的：worker 建好了但没人记成"可用"，
         * drain 看到 idle 为空就一个任务都不派 —— 每个任务干等到超时。
         * （postMessage 在 worker 还没 online 时会排队，所以提前标记空闲是安全的。） */
        this.idle.push(worker)
      }
      this.ready = true
      return true
    } catch {
      this.close()
      return false
    }
  }

  #spawn() {
    const worker = new Worker(WORKER_URL, { type: 'module' })
    worker.unref()          // 不该因为池子存在而让进程活不下来
    worker.on('message', (message) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message)
      else entry.reject(new Error(message.error ?? 'worker 失败'))
      this.idle.push(worker)
      this.#drain()
    })
    worker.on('error', (error) => {
      // 某个 worker 崩了：把它手上所有任务 reject，并标记池子不可用（上层会降级）
      for (const [id, entry] of this.pending) {
        if (entry.worker === worker) {
          this.pending.delete(id)
          entry.reject(new Error(`worker 崩溃：${error?.message ?? error}`))
        }
      }
      this.idle = this.idle.filter((item) => item !== worker)
      poolBroken = true
    })
    return worker
  }

  #queue = []

  #drain() {
    while (this.idle.length > 0 && this.#queue.length > 0) {
      const task = this.#queue.shift()
      const worker = this.idle.pop()
      const id = this.nextId
      this.nextId += 1
      this.pending.set(id, { resolve: task.resolve, reject: task.reject, worker })
      try {
        // 传进 worker 的必须是独立副本（transfer 会把主线程这份交出去，后面还要用）
        const copy = new Uint8Array(task.buffer)
        worker.postMessage({ id, buffer: copy, params: task.params }, [copy.buffer])
      } catch (error) {
        this.pending.delete(id)
        this.idle.push(worker)
        task.reject(error)
        continue
      }
    }
  }

  /**
   * 跑一批（保持顺序）。
   * @param {{buffer:Buffer, params:object}[]} jobs
   * @param {number} timeoutMs
   */
  async runAll(jobs, timeoutMs = 30000) {
    const results = new Array(jobs.length)
    const all = jobs.map((job, index) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`换色超时（${timeoutMs}ms）`)), timeoutMs)
      const done = (value) => { clearTimeout(timer); resolve(value) }
      const failed = (error) => { clearTimeout(timer); reject(error) }
      this.#queue.push({
        buffer: job.buffer,
        params: job.params,
        resolve: (message) => { results[index] = message; done() },
        reject: failed,
      })
    }))
    /* ★ 入队之后必须主动 drain 一次。
     * 只在"worker 完成时"drain 是死锁：池子刚建好所有 worker 都空闲，
     * 但没有任务能派给他们 —— 结果每个任务等到超时（实测 30 秒后才降级）。
     * 这个 bug 只在"第一次跑批量"时出现，单任务走 inline 分支碰不到。 */
    this.#drain()
    await Promise.all(all)
    return results
  }

  close() {
    for (const worker of this.workers) {
      try { worker.terminate() } catch { /* 忽略 */ }
    }
    this.workers = []
    this.idle = []
    this.ready = false
  }
}

/** 拿（并初始化）常驻池；环境不支持就返回 null。 */
async function getPool(size = defaultPoolSize()) {
  if (poolBroken) return null
  if (!pool || pool.size !== size) {
    pool?.close?.()
    pool = new RecolorPool(size)
    const ok = await pool.init()
    if (!ok) { pool = null; poolBroken = true; return null }
  }
  return pool
}

/**
 * 批量换色：多任务走 worker 池，单任务/worker 不可用则退回主线程。
 *
 * @param {{jobs:{buffer:Buffer, params:object}[], size?:number, timeoutMs?:number}} options
 * @returns {Promise<{ok:boolean, mode:'worker'|'inline', results:Array, error?:string}>}
 */
export async function recolorBatch({ jobs, size = defaultPoolSize(), timeoutMs = 30000 } = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { ok: true, mode: 'inline', results: [] }

  // 单任务不值得走 IPC
  if (jobs.length === 1 || size <= 1) {
    return { ok: true, mode: 'inline', results: jobs.map((job) => recolorSheet({ buffer: job.buffer, ...job.params })) }
  }

  const usePool = await getPool(size)
  if (!usePool) {
    // 降级：主线程顺序跑。功能不受影响，只是没那么快。
    return {
      ok: true, mode: 'inline', degraded: true,
      error: 'worker 池不可用，已退回主线程',
      results: jobs.map((job) => recolorSheet({ buffer: job.buffer, ...job.params })),
    }
  }

  try {
    const messages = await usePool.runAll(jobs, timeoutMs)
    const results = messages.map((message) => ({
      ok: message.ok,
      buffer: message.ok ? Buffer.from(message.buffer) : undefined,
      changed: message.changed,
      note: message.note,
      total: message.total,
      error: message.ok ? undefined : message.error,
    }))
    return { ok: true, mode: 'worker', results }
  } catch (error) {
    // 池子中途出事（崩了/超时）→ 退回主线程，别让用户看到失败
    return {
      ok: true, mode: 'inline', degraded: true,
      error: `worker 执行失败，已退回主线程：${String(error?.message ?? error)}`,
      results: jobs.map((job) => recolorSheet({ buffer: job.buffer, ...job.params })),
    }
  }
}

/** 测试/收尾用：关掉常驻池。 */
export function closeRecolorPool() {
  pool?.close?.()
  pool = null
  poolBroken = false
}
