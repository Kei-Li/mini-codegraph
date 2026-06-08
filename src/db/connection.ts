import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SCHEMA_SQL } from './schema.js'

export class DatabaseConnection {
  private db: DatabaseSync | null = null
  private dbPath: string
  private _inTransaction = false

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  open(): void {
    if (this.db) return

    const dir = dirname(this.dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=NORMAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA cache_size=-65536')
    this.db.exec('PRAGMA mmap_size=268435456')
    this.db.exec('PRAGMA temp_store=FILE')
    this.db.exec('PRAGMA foreign_keys=ON')
    this.db.exec(SCHEMA_SQL)
    this._inTransaction = false
  }

  close(): void {
    if (this.db) {
      // Rollback any active transaction before closing
      if (this._inTransaction) {
        try { this.db.exec('ROLLBACK') } catch { /* best-effort */ }
        this._inTransaction = false
      }
      this.db.close()
      this.db = null
    }
  }

  get connection(): DatabaseSync {
    if (!this.db) throw new Error('Database not opened. Call open() first.')
    return this.db
  }

  get inTransaction(): boolean {
    return this._inTransaction
  }

  get dbFilePath(): string {
    return this.dbPath
  }

  /** Begin a new transaction. Safe to call even if already in a transaction (no-op). */
  beginTransaction(): void {
    if (this._inTransaction) return
    this.connection.exec('BEGIN')
    this._inTransaction = true
  }

  /** Commit the current transaction. Safe to call if not in a transaction (no-op). */
  commitTransaction(): void {
    if (!this._inTransaction) return
    this.connection.exec('COMMIT')
    this._inTransaction = false
  }

  /** Rollback the current transaction. Safe to call if not in a transaction (no-op). */
  rollbackTransaction(): void {
    if (!this._inTransaction) return
    this.connection.exec('ROLLBACK')
    this._inTransaction = false
  }

  /** Execute within an implicit transaction wrapper. */
  transaction<T>(fn: () => T): T {
    this.beginTransaction()
    try {
      const result = fn()
      this.commitTransaction()
      return result
    } catch (e) {
      this.rollbackTransaction()
      throw e
    }
  }

  exec(sql: string, retries = 5): void {
    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        this.connection.exec(sql)
        return
      } catch (e) {
        const err = e as Error & { code?: string; errcode?: number }
        const errcode = err.errcode || 0
        const isBusy = errcode === 517 /* SQLITE_BUSY_SNAPSHOT */ ||
                       errcode === 5 /* SQLITE_BUSY */ ||
                       err.message?.toLowerCase().includes('database is locked')
        if (!isBusy) throw e

        // SQLITE_BUSY_SNAPSHOT (517): another connection wrote since our
        // transaction began, making our snapshot stale.  Must rollback
        // and start a fresh transaction so the next retry gets a new
        // snapshot.  plain busy_timeout does NOT help with 517.
        if (errcode === 517 && this._inTransaction) {
          try { this.connection.exec('ROLLBACK') } catch { /* best-effort */ }
          try { this.connection.exec('BEGIN') } catch { /* best-effort */ }
        }

        lastErr = err
        if (attempt < retries) {
          const delay = Math.min(200 * Math.pow(2, attempt), 2000)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
        }
      }
    }

    // If we exhausted retries, provide diagnostic info before throwing
    const diagnostics = this.diagnostics()
    const err = lastErr!
    err.message = `${err.message}\n${diagnostics}`
    throw err
  }

  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.connection.prepare(sql)
  }

  /** P2: Tune SQLite for maximum bulk insert throughput */
  optimizeForBulkInsert(): void {
    this.exec('PRAGMA synchronous=OFF')
    this.exec('PRAGMA cache_size=-262144')
  }

  /** P2: Restore normal SQLite settings after bulk insert */
  restoreAfterBulkInsert(): void {
    this.exec('PRAGMA synchronous=NORMAL')
    this.exec('PRAGMA cache_size=-65536')
  }

  /** P3: Checkpoint WAL to keep file size bounded */
  checkpointWal(): void {
    try { this.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best-effort */ }
  }

  /** P3: Build an in-memory diagnostics string about the connection state */
  diagnostics(): string {
    const lines: string[] = [
      `Database: ${this.dbPath}`,
      `In transaction: ${this._inTransaction}`,
      `Connection open: ${this.db !== null}`,
    ]
    // Collect SQLite state if possible
    // Note: node:sqlite's exec() does NOT return results for PRAGMA.
    // Must use prepare().get() to read PRAGMA values.
    if (this.db) {
      try {
        const row = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined
        lines.push(`Journal mode: ${row ? row.journal_mode : 'unknown'}`)
      } catch { /* best-effort */ }
      try {
        const row = this.db.prepare('PRAGMA busy_timeout').get() as { busy_timeout?: number } | undefined
        lines.push(`Busy timeout: ${row ? row.busy_timeout : 'unknown'}`)
      } catch { /* best-effort */ }
      try {
        const row = this.db.prepare('PRAGMA wal_checkpoint').get() as Record<string, unknown> | undefined
        lines.push(`WAL checkpoint: ${JSON.stringify(row)}`)
      } catch { /* best-effort */ }
    }

    // Detect lock-holders on Windows
    lines.push(this.findLockHolders())

    return lines.join('\n')
  }

  // ── Lock holder detection ──────────────────────────────────────────

  /**
   * Use PowerShell (or `Handle` tool if available) to detect which process
   * is holding a lock on the SQLite database file. Works on Windows.
   *
   * Returns a human-readable string describing lock-holding processes,
   * or an empty string if detection is not possible / no lock found.
   */
  findLockHolders(): string {
    try {
      return DatabaseConnection.findLockHoldersForPath(this.dbPath)
    } catch {
      return '  Lock holder detection: unavailable'
    }
  }

  /**
   * Static method: detect which processes hold a handle on a given file path.
   * Uses tasklist (fast, built-in) to find node.exe processes, then checks
   * their command lines for the database path.
   */
  static findLockHoldersForPath(filePath: string): string {
    // Strategy 1: tasklist — always available on Windows, very fast
    try {
      const buf = execFileSync('tasklist', ['/fi', 'IMAGENAME eq node.exe', '/fo', 'csv', '/nh'], { encoding: 'utf-8', timeout: 3000, windowsHide: true })
      const lines = buf.trim().split('\n').filter(Boolean)
      if (lines.length > 0) {
        const currentPid = process.pid
        const others: string[] = []
        for (const line of lines) {
          // CSV format: "node.exe","1234","Console","1","2,300 K"
          const parts = line.split('","')
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, ''), 10)
            if (pid && pid !== currentPid) {
              others.push(`node.exe (PID ${pid})`)
            }
          }
        }
        if (others.length > 0) {
          return `  Lock detection: possible lock holders — ${others.join(', ')}`
        }
      }
    } catch { /* best-effort */ }

    // Strategy 2: lightweight PowerShell — CIM query for processes whose
    // command line mentions this db path, with aggressive timeout.
    try {
      const escaped = filePath.replace(/"/g, '\\"')
      const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { \\"$($_.Name) (PID $($_.ProcessId))\\" }`
      const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { encoding: 'utf-8', timeout: 3000, windowsHide: true }).trim()
      if (result) {
        return `  Lock detection: lock holders — ${result.split('\n').filter(Boolean).join(', ')}`
      }
    } catch { /* best-effort */ }

    return '  Lock detection: no other node.exe process found'
  }
}
