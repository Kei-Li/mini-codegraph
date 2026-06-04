import { FileWatcher } from '../../sync/watcher.js'
import type { PendingFile } from '../../sync/watcher.js'

export class FileWatcherManager {
  private watcher: FileWatcher | null = null

  start(projectRoot: string, onSync: () => Promise<{ filesChanged: number; durationMs: number }>): void {
    this.watcher = new FileWatcher(projectRoot, onSync)
    this.watcher.start()
  }

  stop(): void {
    this.watcher?.stop()
    this.watcher = null
  }

  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? []
  }

  isRunning(): boolean {
    return this.watcher !== null
  }
}

export { FileWatcher } from '../../sync/watcher.js'
export type { PendingFile } from '../../sync/watcher.js'
