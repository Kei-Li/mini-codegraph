import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { MCPServer } from '../mcp/server.js'
import type { Transport } from '../mcp/types.js'
import type { GraphQueryManager } from '../graph/queries.js'
import type { PendingFile } from '../sync/watcher.js'
import { logInfo, logWarn, logError, logDebug } from '../logger.js'

const PACKAGE_VERSION = '0.2.0'
const DAEMON_PROTOCOL_VERSION = 1

interface LockInfo {
  pid: number
  version: string
  socketPath: string
  startedAt: number
}

export class DaemonServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private dataDir: string
  private projectRoot: string
  private clients: Map<Socket, { socket: Socket; ppid?: number }> = new Map()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private ppidWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null
  private readonly idleTimeoutMs = parseInt(process.env.MINI_CG_DAEMON_IDLE_TIMEOUT_MS ?? '300000', 10)
  private readonly ppidCheckIntervalMs = 5000
  private readonly staleCheckIntervalMs = 30000
  private readonly socketPath: string
  private graph: GraphQueryManager
  private getPendingFiles: () => PendingFile[]

  constructor(projectRoot: string, graph: GraphQueryManager, getPendingFiles?: () => PendingFile[]) {
    this.projectRoot = projectRoot
    this.dataDir = join(projectRoot, '.mini-codegraph')
    this.graph = graph
    this.getPendingFiles = getPendingFiles ?? (() => [])
    this.socketPath = join(this.dataDir, 'daemon.sock')
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
  }

  async start(): Promise<number> {
    this.cleanupStaleSocket()

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket)
      })

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.writePortFile()
          this.writePidFile()
          this.acquireLock()
          this.startPpidWatchdog()
          this.startStaleCheck()
          this.resetIdleTimer()
          logInfo(`Daemon started on port ${this.port} (pid ${process.pid}, v${PACKAGE_VERSION})`)
          resolve(this.port)
        } else {
          reject(new Error('Failed to get port'))
        }
      })

      this.server.on('error', (err) => {
        logError('Daemon server error:', err)
        reject(err)
      })
    })
  }

  stop(reason?: string): void {
    logInfo(`Daemon stopping${reason ? `: ${reason}` : ''}`)
    this.clearTimers()
    for (const [socket] of this.clients) {
      try { socket.destroy() } catch {}
    }
    this.clients.clear()
    this.server?.close(() => {
      this.cleanupFiles()
    })
    setTimeout(() => process.exit(0), 1000)
  }

  getClientCount(): number {
    return this.clients.size
  }

  private handleConnection(socket: Socket): void {
    const ppid = process.ppid
    const conn: { socket: Socket; ppid?: number } = { socket, ppid }
    this.clients.set(socket, conn)

    this.sendHello(socket)

    const transport = new DaemonSocketTransport(socket)
    const mcp = new MCPServer(transport, this.graph, this.getPendingFiles)
    mcp.start()

    socket.on('close', () => {
      this.clients.delete(socket)
      logDebug(`Client disconnected (${this.clients.size} remaining)`)
      this.resetIdleTimer()
      if (this.clients.size === 0) {
        this.scheduleShutdown()
      }
    })

    socket.on('error', () => {
      this.clients.delete(socket)
    })

    this.resetIdleTimer()
  }

  private sendHello(socket: Socket): void {
    const hello = JSON.stringify({
      type: 'hello',
      version: PACKAGE_VERSION,
      pid: process.pid,
      protocol: DAEMON_PROTOCOL_VERSION,
    })
    try { socket.write(hello + '\n') } catch {}
  }

  private startPpidWatchdog(): void {
    this.ppidWatchdogTimer = setInterval(() => {
      try {
        if (process.ppid <= 1) {
          logWarn('Parent process exited, shutting down daemon')
          this.stop('Parent died')
        }
        process.kill(process.ppid, 0)
      } catch {
        logWarn('Parent process unreachable, shutting down daemon')
        this.stop('Parent died')
      }
    }, this.ppidCheckIntervalMs)
    this.ppidWatchdogTimer.unref()
  }

  private startStaleCheck(): void {
    this.staleCheckTimer = setInterval(() => {
      this.graph.checkStaleFiles()
      const warning = this.graph.getStalenessWarning()
      if (warning) {
        logDebug(`Stale files: ${warning}`)
      }
    }, this.staleCheckIntervalMs)
    this.staleCheckTimer.unref()
  }

  private scheduleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      logInfo('Idle timeout reached, shutting down daemon')
      this.stop('Idle timeout')
    }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.ppidWatchdogTimer) clearInterval(this.ppidWatchdogTimer)
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer)
    this.idleTimer = null
    this.ppidWatchdogTimer = null
    this.staleCheckTimer = null
  }

  private cleanupStaleSocket(): void {
    try { unlinkSync(this.socketPath) } catch {}
  }

  private cleanupFiles(): void {
    try { unlinkSync(join(this.dataDir, 'daemon.port')) } catch {}
    try { unlinkSync(join(this.dataDir, 'daemon.pid')) } catch {}
    try { unlinkSync(join(this.dataDir, 'daemon.lock')) } catch {}
    try { unlinkSync(this.socketPath) } catch {}
  }

  private writePortFile(): void {
    try {
      writeFileSync(join(this.dataDir, 'daemon.port'), String(this.port), 'utf-8')
    } catch (e) {
      logError('Failed to write port file:', e)
    }
  }

  private writePidFile(): void {
    try {
      writeFileSync(join(this.dataDir, 'daemon.pid'), `${process.pid}\n${PACKAGE_VERSION}`, 'utf-8')
    } catch (e) {
      logError('Failed to write pid file:', e)
    }
  }

  private acquireLock(): void {
    const lockPath = join(this.dataDir, 'daemon.lock')
    try {
      const lockInfo: LockInfo = {
        pid: process.pid,
        version: PACKAGE_VERSION,
        socketPath: this.socketPath,
        startedAt: Date.now(),
      }
      writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8')
    } catch (e) {
      logError('Failed to acquire lock:', e)
    }
  }
}

class DaemonSocketTransport implements Transport {
  private buffer = ''
  private onMessage: ((msg: any) => void) | null = null
  private onClose: (() => void) | null = null

  constructor(private socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      let newlineIdx: number
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim()
        this.buffer = this.buffer.slice(newlineIdx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'hello') continue
          this.onMessage?.(msg)
        } catch {}
      }
    })
    socket.on('close', () => this.onClose?.())
    socket.on('error', () => {})
  }

  start(onMessage: (msg: any) => void, onClose: () => void): void {
    this.onMessage = onMessage
    this.onClose = onClose
  }

  send(response: any): void {
    try {
      this.socket.write(JSON.stringify(response) + '\n')
    } catch {}
  }

  stop(): void {
    this.socket.end()
  }
}

export function readDaemonLock(projectRoot: string): LockInfo | null {
  const lockPath = join(projectRoot, '.mini-codegraph', 'daemon.lock')
  if (!existsSync(lockPath)) return null
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'))
  } catch {
    return null
  }
}
