import { createServer, type Socket } from 'node:net'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { MCPServer } from '../mcp/server.js'
import type { Transport } from '../mcp/types.js'
import type { GraphQueryManager } from '../graph/queries.js'

interface ClientConnection {
  socket: Socket
}

export class DaemonServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private dataDir: string
  private clients: Map<Socket, ClientConnection> = new Map()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null
  private readonly idleTimeoutMs = 300_000 // 5 minutes
  private readonly staleCheckIntervalMs = 30_000 // 30 seconds
  private graph: GraphQueryManager

  constructor(projectRoot: string, graph: GraphQueryManager) {
    this.dataDir = join(projectRoot, '.codegraph')
    this.graph = graph
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket)
      })

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          const portFile = join(this.dataDir, 'daemon.port')
          const pidFile = join(this.dataDir, 'daemon.pid')
          writeFileSync(portFile, String(this.port), 'utf-8')
          writeFileSync(pidFile, String(process.pid), 'utf-8')
          console.error(`Daemon started on port ${this.port} (pid ${process.pid})`)
          this.startStaleCheck()
          this.resetIdleTimer()
          resolve(this.port)
        } else {
          reject(new Error('Failed to get port'))
        }
      })

      this.server.on('error', reject)
    })
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer)
    for (const [socket] of this.clients) {
      socket.destroy()
    }
    this.clients.clear()
    this.server?.close()

    try {
      unlinkSync(join(this.dataDir, 'daemon.port'))
    } catch {}
    try {
      unlinkSync(join(this.dataDir, 'daemon.pid'))
    } catch {}
  }

  private handleConnection(socket: Socket): void {
    const conn: ClientConnection = { socket }
    this.clients.set(socket, conn)

    const transport = new SocketTransport(socket)
    const mcp = new MCPServer(transport, this.graph)
    mcp.start()

    socket.on('close', () => {
      this.clients.delete(socket)
      console.error(`Client disconnected (${this.clients.size} remaining)`)
      this.resetIdleTimer()
      if (this.clients.size === 0) {
        this.scheduleShutdown()
      }
    })

    socket.on('error', () => {
      this.clients.delete(socket)
    })

    this.resetIdleTimer()
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private scheduleShutdown(): void {
    this.idleTimer = setTimeout(() => {
      console.error('Idle timeout reached, shutting down daemon')
      this.stop()
      process.exit(0)
    }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  getClientCount(): number {
    return this.clients.size
  }

  private startStaleCheck(): void {
    this.staleCheckTimer = setInterval(() => {
      const staleBefore = this.graph.getStalenessWarning()
      this.graph.checkStaleFiles()
      const staleAfter = this.graph.getStalenessWarning()
      if (staleAfter && staleAfter !== staleBefore) {
        console.error(`Stale files detected: ${staleAfter}`)
      }
    }, this.staleCheckIntervalMs)
    this.staleCheckTimer.unref()
  }
}

class SocketTransport implements Transport {
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
    const json = JSON.stringify(response)
    try {
      this.socket.write(json + '\n')
    } catch {}
  }

  stop(): void {
    this.socket.end()
  }
}
