import { relative } from 'node:path'
import type { Stats } from 'node:fs'
import chokidar, { FSWatcher } from 'chokidar'
import type { Ignore } from 'ignore'
import { isSupportedFile, buildDefaultIgnore } from '../utils.js'
import { logDebug, logWarn } from '../logger.js'
import { watchDisabledReason } from './watch-policy.js'

export interface WatchOptions {
  debounceMs?: number
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void
  onSyncError?: (error: Error) => void
}

export class LockUnavailableError extends Error {
  constructor(message = 'mini-codegraph file lock unavailable; another process is writing') {
    super(message)
    this.name = 'LockUnavailableError'
  }
}

export interface PendingFile {
  path: string
  firstSeenMs: number
  lastSeenMs: number
  indexing: boolean
}

export class FileWatcher {
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingFiles = new Map<string, { firstSeenMs: number; lastSeenMs: number }>()
  private syncStartedMs = 0
  private syncing = false
  private stopped = false
  private chokidarReady = false
  private readyWaiters: Array<() => void> = []
  private ignoreMatcher: Ignore | null = null

  private readonly projectRoot: string
  private readonly debounceMs: number
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>
  private readonly onSyncComplete?: WatchOptions['onSyncComplete']
  private readonly onSyncError?: WatchOptions['onSyncError']

  constructor(
    projectRoot: string,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot
    this.syncFn = syncFn
    this.debounceMs = options.debounceMs ?? 2000
    this.onSyncComplete = options.onSyncComplete
    this.onSyncError = options.onSyncError
  }

  start(): boolean {
    if (this.watcher) return true
    this.stopped = false

    const disabledReason = watchDisabledReason(this.projectRoot)
    if (disabledReason) {
      logDebug('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot })
      return false
    }

    this.ignoreMatcher = buildDefaultIgnore(this.projectRoot)

    try {
      this.watcher = chokidar.watch(this.projectRoot, {
        ignored: (testPath: string, stats?: Stats) => this.shouldIgnore(testPath, stats),
      })

      this.watcher.on('ready', () => {
        this.chokidarReady = true
        this.pendingFiles.clear()
        for (const cb of this.readyWaiters) cb()
        this.readyWaiters.length = 0
      })

      this.watcher.on('all', (_event: string, filePath: string) => {
        if (this.stopped) return

        const normalized = relative(this.projectRoot, filePath).replace(/\\/g, '/')

        if (this.isAlwaysIgnored(normalized)) return
        if (!isSupportedFile(normalized)) return

        logDebug('File change detected', { file: normalized })
        if (this.chokidarReady) {
          const now = Date.now()
          const existing = this.pendingFiles.get(normalized)
          this.pendingFiles.set(normalized, {
            firstSeenMs: existing?.firstSeenMs ?? now,
            lastSeenMs: now,
          })
        }
        this.scheduleSync()
      })

      this.watcher.on('error', (err: unknown) => {
        logWarn('File watcher error', { error: String(err) })
      })

      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs })
      return true
    } catch (err) {
      logWarn('Could not start file watcher', { error: String(err) })
      return false
    }
  }

  private isAlwaysIgnored(rel: string): boolean {
    return (
      rel === '.mini-codegraph' || rel.startsWith('.mini-codegraph/') ||
      rel === '.git' || rel.startsWith('.git/')
    )
  }

  private shouldIgnore(testPath: string, stats?: Stats): boolean {
    const rel = relative(this.projectRoot, testPath).replace(/\\/g, '/')
    if (!rel || rel === '.' || rel.startsWith('..')) return false
    if (this.isAlwaysIgnored(rel)) return true
    if (!this.ignoreMatcher) return false
    if (stats) {
      return this.ignoreMatcher.ignores(stats.isDirectory() ? rel + '/' : rel)
    }
    return this.ignoreMatcher.ignores(rel) || this.ignoreMatcher.ignores(rel + '/')
  }

  stop(): void {
    this.stopped = true

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    this.pendingFiles.clear()
    this.chokidarReady = false
    this.ignoreMatcher = null
    logDebug('File watcher stopped')
  }

  isActive(): boolean {
    return this.watcher !== null && !this.stopped
  }

  waitUntilReady(timeoutMs = 10000): Promise<void> {
    if (this.chokidarReady) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(handler)
        if (idx >= 0) this.readyWaiters.splice(idx, 1)
        reject(new Error(`FileWatcher.waitUntilReady timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const handler = () => { clearTimeout(t); resolve() }
      this.readyWaiters.push(handler)
    })
  }

  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flush()
    }, this.debounceMs)
  }

  private async flush(): Promise<void> {
    if (this.syncing || this.stopped) return

    this.syncStartedMs = Date.now()
    this.syncing = true

    try {
      const result = await this.syncFn()
      for (const [filePath, info] of this.pendingFiles) {
        if (info.lastSeenMs <= this.syncStartedMs) {
          this.pendingFiles.delete(filePath)
        }
      }
      this.onSyncComplete?.(result)
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        logDebug('Watch sync skipped: file lock unavailable', {
          pendingFiles: this.pendingFiles.size,
        })
      } else {
        const error = err instanceof Error ? err : new Error(String(err))
        logWarn('Watch sync failed', { error: error.message })
        this.onSyncError?.(error)
      }
    } finally {
      this.syncing = false
      if (this.pendingFiles.size > 0 && !this.stopped) {
        this.scheduleSync()
      }
    }
  }

  getPendingFiles(): PendingFile[] {
    const result: PendingFile[] = []
    for (const [filePath, info] of this.pendingFiles) {
      result.push({
        path: filePath,
        firstSeenMs: info.firstSeenMs,
        lastSeenMs: info.lastSeenMs,
        indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
      })
    }
    return result
  }
}


