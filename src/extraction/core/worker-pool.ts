import { Worker } from 'node:worker_threads'
import { logError } from '../../logger.js'
import type { WorkerResponse } from './worker-types.js'

const HEARTBEAT_TIMEOUT_MS = 300_000
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000
const MAX_TASKS_PER_WORKER = 200
const MAX_GLOBAL_RESTARTS = 20
const MAX_RESTARTS_PER_SLOT = 3

export interface WorkerHandle {
  worker: Worker
  index: number
}

interface QueuedTask {
  filePath: string
  absolutePath: string
  grammarName: string
  language: string
  resolve: (value: WorkerResponse) => void
  reject: (reason: any) => void
}

export class WorkerPool {
  private workers: Worker[] = []
  private heartbeats = new Map<number, number>()
  private restartCount = new Map<number, number>()
  private globalRestarts = 0
  private stopped = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private inflightCount = new Map<number, number>()
  private taskQueue: QueuedTask[] = []
  private processing = false
  private maxQueueSize = 10000
  private taskCountPerWorker = new Map<number, number>()
  private inflightMap = new Map<number, Map<number, { task: { filePath: string; absolutePath: string; grammarName: string; language: string }; resolve: (value: WorkerResponse) => void; reject: (reason: any) => void }>>()

  get size(): number {
    return this.workers.length
  }

  get pending(): number {
    return this.taskQueue.length
  }

  get pressure(): number {
    return Math.min(1, (this.inflightTotal + this.taskQueue.length) / (this.workers.length * 10))
  }

  private get inflightTotal(): number {
    let total = 0
    for (const c of this.inflightCount.values()) total += c
    return total
  }

  setMaxQueueSize(size: number): void {
    this.maxQueueSize = size
  }

  start(size: number): void {
    if (this.workers.length > 0) return
    for (let i = 0; i < size; i++) {
      this.createWorker(i)
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.stopped) return
        const now = Date.now()
        for (let i = 0; i < this.workers.length; i++) {
          if (this.workers[i] === null) continue
          const last = this.heartbeats.get(i) ?? 0
          if (now - last > HEARTBEAT_TIMEOUT_MS) {
            const prevRestarts = this.restartCount.get(i) ?? 0
            if (prevRestarts >= MAX_RESTARTS_PER_SLOT) {
              logError(`Worker ${i} unresponsive >${HEARTBEAT_TIMEOUT_MS / 1000}s (restarted ${prevRestarts} times), removing from pool`)
              const dead = this.workers[i]
              if (dead) dead.terminate()
              this.workers[i] = null as unknown as Worker
              continue
            }
            if (this.globalRestarts >= MAX_GLOBAL_RESTARTS) {
              logError(`Worker ${i} unresponsive >${HEARTBEAT_TIMEOUT_MS / 1000}s — global restart limit (${MAX_GLOBAL_RESTARTS}) reached, stopping pool`)
              this.stop()
              return
            }
            logError(`Worker ${i} unresponsive >${HEARTBEAT_TIMEOUT_MS / 1000}s, restarting... (attempt ${prevRestarts + 1})`)
            this.drainWorker(i)
            this.restartWorker(i, prevRestarts + 1)
          }
        }
      }, HEARTBEAT_CHECK_INTERVAL_MS)
    }
  }

  private createWorker(index: number): void {
    const worker = new Worker(new URL('./parse-worker.js', import.meta.url))
    worker.setMaxListeners(Infinity)
    worker.postMessage({ type: 'init' })

    if (index < this.workers.length) this.workers[index] = worker
    else this.workers.push(worker)
    this.heartbeats.set(index, Date.now())
    this.inflightCount.set(index, 0)
    this.taskCountPerWorker.set(index, 0)
    this.inflightMap.set(index, new Map())

    worker.on('message', (msg: WorkerResponse) => {
      if (msg?.type === 'heartbeat' || msg?.type === 'parse-result') this.heartbeats.set(index, Date.now())
      if (msg?.type === 'worker-error') logError(`Worker ${index} ${msg.error}`)
    })

    worker.on('error', (err) => {
      if (this.workers[index] !== worker) return
      logError(`Worker ${index} error: ${err.message}`)
      this.drainWorker(index)
      this.restartWorker(index, (this.restartCount.get(index) ?? 0) + 1)
      this.processQueue()
    })

    worker.on('exit', (code) => {
      if (this.workers[index] !== worker) return
      if (code !== 0) {
        logError(`Worker ${index} exited with code ${code}`)
        this.drainWorker(index)
        this.restartWorker(index, (this.restartCount.get(index) ?? 0) + 1)
        this.processQueue()
      }
    })
  }

  private drainWorker(index: number): void {
    const entries = this.inflightMap.get(index)
    if (!entries || entries.size === 0) return
    for (const [, entry] of entries) {
      this.taskQueue.unshift({
        filePath: entry.task.filePath,
        absolutePath: entry.task.absolutePath,
        grammarName: entry.task.grammarName,
        language: entry.task.language,
        resolve: entry.resolve,
        reject: entry.reject,
      })
    }
    entries.clear()
    this.inflightCount.set(index, 0)
  }

  private restartWorker(index: number, restartAttempt: number, countAgainstLimit = true): void {
    if (this.stopped) return
    if (countAgainstLimit) {
      this.globalRestarts++
      if (this.globalRestarts > MAX_GLOBAL_RESTARTS) {
        logError(`Global restart limit (${MAX_GLOBAL_RESTARTS}) exceeded, stopping pool`)
        this.stop()
        return
      }
    }
    const old = this.workers[index]
    this.workers[index] = null as unknown as Worker
    if (old) {
      try { old.terminate() } catch { /* best-effort */ }
    }
    this.createWorker(index)
    this.restartCount.set(index, restartAttempt)
  }

  submit(
    filePath: string,
    absolutePath: string,
    grammarName: string,
    language: string,
    timeout: number,
  ): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('Worker pool is stopped'))
        return
      }
      const handle = this.acquireWorker()
      if (handle) {
        this.dispatchWithTimeout(handle, { filePath, absolutePath, grammarName, language }, resolve, reject, timeout)
        return
      }

      if (this.taskQueue.length >= this.maxQueueSize) {
        reject(new Error('Worker pool queue is full'))
        return
      }
      this.taskQueue.push({ filePath, absolutePath, grammarName, language, resolve, reject })
      this.processQueue()
    })
  }

  private processQueue(): void {
    if (this.processing) return
    this.processing = true

    const loop = () => {
      if (this.taskQueue.length === 0) {
        this.processing = false
        return
      }
      const handle = this.acquireWorker()
      if (!handle) {
        this.processing = false
        return
      }
      const task = this.taskQueue.shift()!
      this.dispatchWithTimeout(handle, task, task.resolve, task.reject, undefined)
      setImmediate(loop)
    }
    loop()
  }

  private dispatchWithTimeout(
    handle: WorkerHandle,
    task: { filePath: string; absolutePath: string; grammarName: string; language: string },
    resolve: (value: WorkerResponse) => void,
    reject: (reason: any) => void,
    timeout: number | undefined,
  ): void {
    const id = Math.random()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const taskCount = this.taskCountPerWorker.get(handle.index) ?? 0
    this.taskCountPerWorker.set(handle.index, taskCount + 1)
    if (taskCount > 0 && taskCount % MAX_TASKS_PER_WORKER === 0) {
      this.drainWorker(handle.index)
      this.restartWorker(handle.index, (this.restartCount.get(handle.index) ?? 0) + 1, false)
      this.taskQueue.unshift({ ...task, resolve, reject })
      this.releaseWorker(handle.index)
      return
    }

    this.inflightMap.get(handle.index)?.set(id, { task: { filePath: task.filePath, absolutePath: task.absolutePath, grammarName: task.grammarName, language: task.language }, resolve, reject })

    const handler = (msg: WorkerResponse) => {
      if (msg.type !== 'parse-result' || msg.id !== id) return
      if (timeoutId) clearTimeout(timeoutId)
      handle.worker.off('message', handler)
      this.inflightMap.get(handle.index)?.delete(id)
      this.releaseWorker(handle.index)
      if (msg.error && msg.fatal) {
        reject(new Error(msg.error))
      } else {
        resolve(msg)
      }
    }

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        handle.worker.off('message', handler)
        this.inflightMap.get(handle.index)?.delete(id)
        this.releaseWorker(handle.index)
        reject(new Error(`Worker ${handle.index} timeout after ${timeout / 1000}s`))
        this.restartWorker(handle.index, (this.restartCount.get(handle.index) ?? 0) + 1)
      }, timeout)
    }

    this.heartbeats.set(handle.index, Date.now())
    handle.worker.on('message', handler)
    handle.worker.postMessage({
      type: 'parse',
      id,
      filePath: task.filePath,
      absolutePath: task.absolutePath,
      grammarName: task.grammarName,
      language: task.language,
    })
  }

  acquireWorker(): WorkerHandle | null {
    let bestIdx = -1
    let bestCount = Infinity
    for (let i = 0; i < this.workers.length; i++) {
      if (this.workers[i] === null) continue
      const count = this.inflightCount.get(i) ?? 0
      if (count < bestCount) { bestCount = count; bestIdx = i }
    }
    if (bestIdx === -1) return null
    this.inflightCount.set(bestIdx, bestCount + 1)
    return { worker: this.workers[bestIdx]!, index: bestIdx }
  }

  releaseWorker(index: number): void {
    const count = this.inflightCount.get(index) ?? 0
    if (count > 0) this.inflightCount.set(index, count - 1)
    this.processQueue()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    for (const [_, inflight] of this.inflightMap) {
      for (const [, entry] of inflight) {
        entry.reject(new Error('Worker pool stopped'))
      }
    }
    for (const worker of this.workers) {
      try { worker.postMessage({ type: 'shutdown' }) } catch { /* best-effort */ }
      try { worker.terminate() } catch { /* best-effort */ }
    }
    this.workers = []
    this.heartbeats.clear()
    this.restartCount.clear()
    this.inflightCount.clear()
    this.taskCountPerWorker.clear()
    this.inflightMap.clear()
    this.taskQueue = []
  }
}
