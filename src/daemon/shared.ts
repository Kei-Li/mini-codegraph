import { DaemonServer } from './server.js'
import type { GraphQueryManager } from '../graph/queries.js'
import type { PendingFile } from '../sync/watcher.js'

interface SharedDaemonOptions {
  idleTimeoutMs?: number
}

export class SharedDaemon {
  private server: DaemonServer | null = null
  private readonly options: SharedDaemonOptions

  constructor(options: SharedDaemonOptions = {}) {
    this.options = options
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setCallbacks(_onConnect: (id: string) => void, _onDisconnect: (id: string) => void): void {
  }

  async start(projectRoot: string, graph: GraphQueryManager, getPendingFiles?: () => PendingFile[]): Promise<number> {
    if (this.options.idleTimeoutMs != null) {
      process.env.MINI_CG_DAEMON_IDLE_TIMEOUT_MS = String(this.options.idleTimeoutMs)
    }

    this.server = new DaemonServer(projectRoot, graph, getPendingFiles)
    const port = await this.server.start()
    return port
  }
}
