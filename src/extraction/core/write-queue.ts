import type { DatabaseConnection } from '../../db/connection.js'
import type { QueryManager } from '../../db/queries.js'

const FLUSH_INTERVAL_MS = 5000
const MAX_PENDING_NODES = 50_000

export interface PendingWrite {
  nodes: number
  edges: number
}

export class WriteQueue {
  private fileCount = 0
  private nodeCount = 0
  private edgeCount = 0
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushCount = 0
  private flushing = false

  constructor(
    private db: DatabaseConnection,
    private queries: QueryManager,
  ) {}

  startAutoFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => this.tryFlush(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
  }

  push(write: PendingWrite): void {
    this.fileCount++
    this.nodeCount += write.nodes
    this.edgeCount += write.edges
    if (this.nodeCount >= MAX_PENDING_NODES) {
      this.tryFlush()
    }
  }

  private tryFlush(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      if (!this.db.inTransaction) return

      this.queries.flushBatch()
      this.nodeCount = 0
      this.db.commitTransaction()
      this.flushCount++
      if (this.flushCount % 10 === 0) {
        this.db.checkpointWal()
      }
      this.db.beginTransaction()
    } catch (e) {
      try { this.db.rollbackTransaction() } catch { /* best-effort */ }
      try { this.db.beginTransaction() } catch { /* best-effort */ }
      throw e
    } finally {
      this.flushing = false
    }
  }

  flushSync(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flushing = true
    try {
      this.queries.flushBatch()
      this.nodeCount = 0
      if (this.db.inTransaction) {
        this.db.commitTransaction()
      }
      this.db.checkpointWal()
    } finally {
      this.flushing = false
    }
  }

  get fileCountSoFar(): number {
    return this.fileCount
  }

  get nodeCountSoFar(): number {
    return this.nodeCount
  }

  get edgeCountSoFar(): number {
    return this.edgeCount
  }

  get pressure(): number {
    return Math.min(1, this.nodeCount / MAX_PENDING_NODES)
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }
}
