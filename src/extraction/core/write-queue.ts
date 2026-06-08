import type { DatabaseConnection } from '../../db/connection.js'
import type { QueryManager } from '../../db/queries.js'

const FLUSH_INTERVAL_MS = 1000
const FLUSH_BATCH_SIZE = 5000

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
    if (this.fileCount % FLUSH_BATCH_SIZE === 0) {
      this.tryFlush()
    }
  }

  private tryFlush(): void {
    // Guard against re-entrant calls (e.g. timer firing during a flush)
    if (this.flushing) return
    this.flushing = true
    try {
      // Only flush if we're actually in a transaction
      if (!this.db.inTransaction) return

      this.queries.flushBatch()
      this.db.commitTransaction()
      this.flushCount++
      if (this.flushCount % 10 === 0) {
        this.db.checkpointWal()
      }
      this.db.beginTransaction()
    } catch (e) {
      // Reset _inTransaction so the next tryFlush starts fresh.
      // exec() already handles SQLITE_BUSY_SNAPSHOT (517) internally
      // by rolling back and starting a new transaction; this catch
      // ensures _inTransaction flag is consistent regardless of what
      // happened inside exec/flushBatch.  We must then begin a new
      // transaction so future timer ticks can continue flushing.
      try { this.db.rollbackTransaction() } catch { /* best-effort */ }
      try { this.db.beginTransaction() } catch { /* best-effort */ }
      throw e
    } finally {
      this.flushing = false
    }
  }

  flushSync(): void {
    // Clear timer first to prevent concurrent flush
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flushing = true
    try {
      this.queries.flushBatch()
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
    return Math.min(1, this.fileCount % FLUSH_BATCH_SIZE / FLUSH_BATCH_SIZE)
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }
}
