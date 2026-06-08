import { createConnection, type Socket } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface DaemonInfo {
  port: number
  pid: number
  version: string
  alive: boolean
}

export function getDaemonInfo(projectRoot: string): DaemonInfo | null {
  const dataDir = join(projectRoot, '.mini-codegraph')
  const portFile = join(dataDir, 'daemon.port')
  const pidFile = join(dataDir, 'daemon.pid')

  if (!existsSync(portFile) || !existsSync(pidFile)) return null

  try {
    const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
    const pidContent = readFileSync(pidFile, 'utf-8').trim().split('\n')
    const pid = parseInt(pidContent[0], 10)
    const version = pidContent[1] ?? 'unknown'

    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch { /* silent */ }

    return { port, pid, version, alive }
  } catch {
    return null
  }
}

export function startDaemon(projectRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const cliPath = findCliPath()
    if (!cliPath) {
      reject(new Error('Cannot find CLI entry point'))
      return
    }

    const child = spawn(process.execPath, [
      cliPath, 'serve', '--daemon', projectRoot,
    ], {
      stdio: 'ignore',
      detached: true,
      cwd: process.cwd(),
    })

    child.unref()

    const dataDir = join(projectRoot, '.mini-codegraph')
    const portFile = join(dataDir, 'daemon.port')
    let attempts = 0
    const maxAttempts = 50

    const check = setInterval(() => {
      attempts++
      try {
        if (existsSync(portFile)) {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
          clearInterval(check)
          resolve(port)
        }
      } catch { /* silent */ }

      if (attempts >= maxAttempts) {
        clearInterval(check)
        reject(new Error('Daemon failed to start within timeout'))
      }
    }, 100)
  })
}

export function connectToDaemon(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const host = process.env.MINI_CG_HOST || '127.0.0.1'
    const socket = createConnection({ host, port }, () => {
      resolve(socket)
    })
    socket.on('error', reject)
    socket.setTimeout(10000)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Connection timeout'))
    })
  })
}

export function connectToDaemonWithVersionCheck(port: number): Promise<{ socket: Socket; version: string }> {
  return new Promise((resolve, reject) => {
    const host = process.env.MINI_CG_HOST || '127.0.0.1'
    const socket = createConnection({ host, port }, () => {
      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        const newlineIdx = text.indexOf('\n')
        if (newlineIdx !== -1) {
          const line = text.slice(0, newlineIdx).trim()
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'hello') {
              socket.removeListener('data', onData)
              resolve({ socket, version: msg.version ?? 'unknown' })
              return
            }
          } catch { /* silent */ }
        }
      }
      socket.on('data', onData)
    })
    socket.on('error', reject)
    socket.setTimeout(10000)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Connection timeout'))
    })
  })
}

function findCliPath(): string | null {
  const candidates = [
    join(process.cwd(), 'dist', 'cli.js'),
    join(__dirname, '..', '..', 'dist', 'cli.js'),
    join(__dirname, '..', '..', '..', 'dist', 'cli.js'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}
