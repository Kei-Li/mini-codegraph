import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'

const DEFAULT_PPID_POLL_MS = 5000
const MAX_HELLO_LINE_BYTES = 4096

export interface ProxyResult {
  outcome: 'proxied' | 'fallback-needed'
  reason?: string
}

interface DaemonHello {
  miniCodegraph: string
  pid: number
}

export async function runProxy(socketPath: string, expectedVersion: string = '0.1.0'): Promise<ProxyResult> {
  if (process.platform !== 'win32' && !existsSync(socketPath)) {
    return { outcome: 'fallback-needed', reason: 'socket file missing' }
  }

  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')

  const hello = await readHelloLine(socket).catch((err: Error) => {
    socket.destroy()
    return err
  })
  if (hello instanceof Error) {
    return { outcome: 'fallback-needed', reason: hello.message }
  }

  if (hello.miniCodegraph !== expectedVersion) {
    process.stderr.write(
      `[mini-codegraph MCP] Found daemon on ${socketPath} but version (${hello.miniCodegraph}) ` +
      `differs from ours (${expectedVersion}); falling back to direct mode.\n`
    )
    socket.destroy()
    return { outcome: 'fallback-needed', reason: 'version mismatch' }
  }

  process.stderr.write(
    `[mini-codegraph MCP] Attached to shared daemon on ${socketPath} (pid ${hello.pid}, v${hello.miniCodegraph}).\n`
  )

  startPpidWatchdog(socket)
  await pipeUntilClose(socket)
  process.exit(0)
}

function readHelloLine(socket: Socket): Promise<DaemonHello> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      clearTimeout(timer)
    }
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx === -1) {
        if (buffer.length > MAX_HELLO_LINE_BYTES) {
          cleanup()
          reject(new Error('daemon hello line exceeded size limit'))
        }
        return
      }
      const line = buffer.slice(0, idx)
      const tail = buffer.slice(idx + 1)
      cleanup()
      if (tail.length > 0) socket.unshift(tail)
      try {
        const parsed = JSON.parse(line) as DaemonHello
        if (typeof parsed.miniCodegraph !== 'string' || typeof parsed.pid !== 'number') {
          reject(new Error('daemon hello missing required fields'))
          return
        }
        resolve(parsed)
      } catch {
        reject(new Error('daemon hello not JSON'))
      }
    }
    const onError = (err: Error) => { cleanup(); reject(err) }
    const onClose = () => { cleanup(); reject(new Error('daemon closed connection before hello')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for daemon hello')) }, 3000)
    timer.unref?.()
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

function pipeUntilClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    let stdinEnded = false
    let socketEnded = false

    const maybeDone = () => { if (stdinEnded && socketEnded) resolve() }

    process.stdin.on('data', (chunk: Buffer) => {
      if (socket.writable) socket.write(chunk)
    })
    process.stdin.on('end', () => {
      stdinEnded = true
      socket.end()
      maybeDone()
    })

    socket.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
    })
    socket.on('end', () => {
      socketEnded = true
      maybeDone()
    })
    socket.on('close', () => {
      socketEnded = true
      maybeDone()
      process.exit(0)
    })
    socket.on('error', () => {
      socketEnded = true
      maybeDone()
      process.exit(1)
    })
  })
}

function startPpidWatchdog(socket: Socket): void {
  setInterval(() => {
    try {
      process.kill(process.ppid, 0)
    } catch {
      socket.end()
      process.exit(0)
    }
  }, DEFAULT_PPID_POLL_MS).unref()
}
