import { createConnection, type Socket } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface DaemonInfo {
  port: number
  pid: number
  alive: boolean
}

export function getDaemonInfo(projectRoot: string): DaemonInfo | null {
  const dataDir = join(projectRoot, '.codegraph')
  const portFile = join(dataDir, 'daemon.port')
  const pidFile = join(dataDir, 'daemon.pid')

  if (!existsSync(portFile) || !existsSync(pidFile)) return null

  try {
    const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)

    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {}

    return { port, pid, alive }
  } catch {
    return null
  }
}

export function startDaemon(projectRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(process.cwd(), 'dist', 'cli.js'),
      'serve',
      '--daemon',
      projectRoot,
    ], {
      stdio: 'ignore',
      detached: true,
      cwd: process.cwd(),
    })

    child.unref()

    // Wait for daemon to start and write port file
    const dataDir = join(projectRoot, '.codegraph')
    const portFile = join(dataDir, 'daemon.port')
    let attempts = 0
    const maxAttempts = 50 // 5 seconds

    const check = setInterval(() => {
      attempts++
      try {
        if (existsSync(portFile)) {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
          clearInterval(check)
          resolve(port)
        }
      } catch {}

      if (attempts >= maxAttempts) {
        clearInterval(check)
        reject(new Error('Daemon failed to start within timeout'))
      }
    }, 100)
  })
}

export function connectToDaemon(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      resolve(socket)
    })
    socket.on('error', reject)
    socket.setTimeout(5000)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Connection timeout'))
    })
  })
}
