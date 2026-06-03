import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_SOCKET_PATH = join(homedir(), '.mini-codegraph', 'daemon.sock')
const DEFAULT_LOCK_PATH = join(homedir(), '.mini-codegraph', 'daemon.lock')
const HELLO_TIMEOUT = 5000
const WATCHDOG_INTERVAL = 5000

export interface SharedDaemonConfig {
  socketPath?: string
  lockPath?: string
  idleTimeoutMs?: number
}

export class SharedDaemon {
  private server: Server | null = null
  private clients = new Map<string, { socket: Socket; ppid: number; connectedAt: number }>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private lastActivity = Date.now()
  private config: Required<SharedDaemonConfig>
  private onClientConnect?: (clientId: string) => void
  private onClientDisconnect?: (clientId: string) => void

  constructor(config: SharedDaemonConfig = {}) {
    this.config = {
      socketPath: config.socketPath ?? DEFAULT_SOCKET_PATH,
      lockPath: config.lockPath ?? DEFAULT_LOCK_PATH,
      idleTimeoutMs: config.idleTimeoutMs ?? 300_000,
    }
  }

  setCallbacks(onConnect: (id: string) => void, onDisconnect: (id: string) => void): void {
    this.onClientConnect = onConnect
    this.onClientDisconnect = onDisconnect
  }

  async start(): Promise<void> {
    const socketPath = this.config.socketPath
    const dir = socketPath.substring(0, socketPath.lastIndexOf(/[/\\]/.test(socketPath) ? socketPath.match(/[/\\]/g)!.pop()! : '/'))

    try {
      if (existsSync(socketPath)) unlinkSync(socketPath)
    } catch { /* silent */ }

    this.server = createServer((socket) => {
      const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      let helloReceived = false
      let ppid = 0

      const helloTimer = setTimeout(() => {
        if (!helloReceived) {
          socket.end('ERROR: Hello timeout\n')
          socket.destroy()
        }
      }, HELLO_TIMEOUT)

      socket.on('data', (data) => {
        const msg = data.toString().trim()
        this.lastActivity = Date.now()

        if (!helloReceived) {
          const helloMatch = msg.match(/^HELLO\s+(\d+)\s+(\d+\.\d+\.\d+)/)
          if (helloMatch) {
            helloReceived = true
            ppid = parseInt(helloMatch[1])
            clearTimeout(helloTimer)
            socket.write(`HELLO_ACK ${process.pid} ${process.version}\n`)
            this.clients.set(clientId, { socket, ppid, connectedAt: Date.now() })
            this.onClientConnect?.(clientId)
            this.resetIdleTimer()
            return
          }
          socket.end('ERROR: Expected HELLO\n')
          return
        }

        const command = msg.match(/^(\w+)\s*(.*)/)
        if (command) {
          switch (command[1]) {
            case 'PING':
              socket.write('PONG\n')
              break
            case 'STATUS':
              socket.write(JSON.stringify({
                clients: this.clients.size,
                uptime: process.uptime(),
                pid: process.pid,
              }) + '\n')
              break
            case 'RAW':
              socket.emit('raw_command', command[2], (response: string) => {
                socket.write(response + '\n')
              })
              break
            default:
              socket.write(`ERROR: Unknown command ${command[1]}\n`)
          }
        }
      })

      socket.on('close', () => {
        clearTimeout(helloTimer)
        this.clients.delete(clientId)
        this.onClientDisconnect?.(clientId)
      })

      socket.on('error', () => {
        clearTimeout(helloTimer)
        this.clients.delete(clientId)
      })
    })

    this.server.on('error', (err) => {
      console.error('Shared daemon server error:', err)
    })

    return new Promise((resolve, reject) => {
      this.server!.listen(socketPath, () => {
        writeFileSync(this.config.lockPath, JSON.stringify({
          pid: process.pid,
          socket: socketPath,
          startedAt: Date.now(),
          version: '0.2.0',
          protocol: '1.0',
        }, null, 2))
        this.startWatchdog()
        resolve()
      })
      this.server!.on('error', reject)
    })
  }

  getClientCount(): number {
    return this.clients.size
  }

  broadcast(message: string): void {
    for (const [, client] of this.clients) {
      try {
        client.socket.write(message + '\n')
      } catch { /* silent */ }
    }
  }

  stop(): void {
    for (const [, client] of this.clients) {
      try {
        client.socket.end('SHUTDOWN\n')
      } catch { /* silent */ }
    }
    this.clients.clear()
    this.server?.close()
    this.stopWatchdog()
    try {
      if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
    } catch { /* silent */ }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      const elapsed = Date.now() - this.lastActivity
      if (elapsed >= this.config.idleTimeoutMs && this.clients.size === 0) {
        this.stop()
        process.exit(0)
      }
    }, this.config.idleTimeoutMs)
  }

  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      for (const [id, client] of this.clients) {
        try {
          if (client.ppid > 0) {
            try {
              process.kill(client.ppid, 0)
            } catch {
              client.socket.end('PARENT_DEAD\n')
              this.clients.delete(id)
            }
          }
        } catch { /* silent */ }
      }
    }, WATCHDOG_INTERVAL)
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }
}

export interface SharedDaemonClient {
  sendCommand(command: string): Promise<string>
  close(): void
}

export async function connectToSharedDaemon(
  socketPath = DEFAULT_SOCKET_PATH,
  version = '0.2.0'
): Promise<SharedDaemonClient | null> {
  const net = await import('node:net')
  if (!existsSync(socketPath)) return null

  return new Promise((resolve) => {
    const socket = new net.Socket()
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, 3000)

    socket.connect(socketPath, () => {
      clearTimeout(timeout)
      const ppid = process.ppid
      socket.write(`HELLO ${ppid} ${version}\n`)
    })

    let helloAckReceived = false
    const buffer: string[] = []

    socket.on('data', (data) => {
      const msg = data.toString().trim()
      if (!helloAckReceived) {
        if (msg.startsWith('HELLO_ACK')) {
          helloAckReceived = true
          resolve({
            sendCommand: (cmd: string): Promise<string> => {
              return new Promise((res) => {
                const handler = (d: Buffer) => {
                  socket.off('data', handler)
                  res(d.toString().trim())
                }
                socket.on('data', handler)
                socket.write(cmd + '\n')
              })
            },
            close: () => socket.destroy(),
          })
        } else {
          socket.destroy()
          resolve(null)
        }
        return
      }
      buffer.push(msg)
    })

    socket.on('error', () => {
      clearTimeout(timeout)
      resolve(null)
    })

    socket.on('close', () => {
      clearTimeout(timeout)
      if (!helloAckReceived) resolve(null)
    })
  })
}
