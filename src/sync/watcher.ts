import { relative } from 'node:path'
import { isSupportedFile } from '../utils.js'
import type { ExtractionOrchestrator } from '../extraction/orchestrator.js'
import { watch } from 'chokidar'

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink'
  filePath: string
}

type WatchCallback = (events: WatchEvent[]) => void

export class FileWatcher {
  private watcher: ReturnType<typeof watch> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingEvents: WatchEvent[] = []
  private callback: WatchCallback | null = null
  private projectRoot = ''
  private static instance: FileWatcher | null = null

  constructor() {
    if (FileWatcher.instance) return FileWatcher.instance
    FileWatcher.instance = this
  }

  static getInstance(): FileWatcher {
    if (!FileWatcher.instance) {
      FileWatcher.instance = new FileWatcher()
    }
    return FileWatcher.instance
  }

  start(projectRoot: string, orchestrator: ExtractionOrchestrator, callback: WatchCallback): void {
    this.projectRoot = projectRoot
    this.callback = callback

    this.watcher = watch(projectRoot, {
      ignored: /(^|[/\\])(node_modules|dist|build|\.git|target|\.codegraph|\.venv|__pycache__)[/\\]/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    })

    this.watcher
      .on('add', (path: string) => {
        if (isSupportedFile(path)) this.queueEvent('add', path)
      })
      .on('change', (path: string) => {
        if (isSupportedFile(path)) this.queueEvent('change', path)
      })
      .on('unlink', (path: string) => {
        if (isSupportedFile(path)) this.queueEvent('unlink', path)
      })
  }

  stop(): void {
    this.flush()
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  getPendingCount(): number {
    return this.pendingEvents.length
  }

  private queueEvent(type: WatchEvent['type'], fullPath: string): void {
    const filePath = relative(this.projectRoot, fullPath).replace(/\\/g, '/')

    this.pendingEvents = this.pendingEvents.filter(e => e.filePath !== filePath)
    this.pendingEvents.push({ type, filePath })

    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flush(), 2000)
  }

  private flush(): void {
    if (this.pendingEvents.length === 0) return
    const events = [...this.pendingEvents]
    this.pendingEvents = []
    this.callback?.(events)
  }
}
