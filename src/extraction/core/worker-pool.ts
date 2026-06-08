import { Worker } from 'node:worker_threads'
import { logError } from '../../logger.js'
import type { WorkerResponse } from './worker-types.js'

const HEARTBEAT_TIMEOUT_MS = 300_000
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private inflightCount = new Map<number, number>()
  private taskQueue: QueuedTask[] = []
  private processing = false
  private maxQueueSize = 10000

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
        const now = Date.now()
        for (let i = 0; i < this.workers.length; i++) {
          const last = this.heartbeats.get(i) ?? 0
          if (now - last > HEARTBEAT_TIMEOUT_MS) {
            const prevRestarts = this.restartCount.get(i) ?? 0
            if (prevRestarts >= 3) {
              logError(`Worker ${i} unresponsive >${HEARTBEAT_TIMEOUT_MS / 1000}s (restarted ${prevRestarts} times), removing from pool`)
              const dead = this.workers[i]
              dead.terminate()
              this.workers[i] = null as unknown as Worker
              continue
            }
            logError(`Worker ${i} unresponsive >${HEARTBEAT_TIMEOUT_MS / 1000}s, restarting... (attempt ${prevRestarts + 1})`)
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
    this.workers.push(worker)
    this.heartbeats.set(index, Date.now())
    this.inflightCount.set(index, 0)
    worker.on('message', (msg: WorkerResponse) => {
      if (msg?.type === 'heartbeat' || msg?.type === 'parse-result') this.heartbeats.set(index, Date.now())
    })
  }

  private restartWorker(index: number, restartAttempt: number): void {
    const old = this.workers[index]
    old.terminate()
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
      // Direct dispatch if a worker is available
      const handle = this.acquireWorker()
      if (handle) {
        this.dispatchWithTimeout(handle, { filePath, absolutePath, grammarName, language }, resolve, reject, timeout)
        return
      }

      // Queue if no worker available
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

    const handler = (msg: WorkerResponse) => {
      if (msg.type !== 'parse-result' || msg.id !== id) return
      if (timeoutId) clearTimeout(timeoutId)
      handle.worker.off('message', handler)
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
        this.releaseWorker(handle.index)
        reject(new Error(`Worker timeout after ${timeout / 1000}s`))
      }, timeout)
    }

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
  }

  stop(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    for (const worker of this.workers) {
      worker.postMessage({ type: 'shutdown' })
    }
    this.workers = []
    this.heartbeats.clear()
    this.inflightCount.clear()
    this.taskQueue = []
  }
}
