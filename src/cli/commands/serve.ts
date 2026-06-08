import { resolve } from 'node:path'
import { MiniCodeGraph } from '../../index.js'
import { DaemonServer } from '../../daemon/server.js'
import { getDaemonInfo, startDaemon, connectToDaemon } from '../../daemon/client.js'
import { logInfo, logError } from '../../logger.js'

export async function handleServe(path: string, options: { daemon?: boolean; mcp?: boolean; shared?: boolean }): Promise<void> {
  options.daemon = options.daemon || options.mcp
  const resolvedPath = resolve(path)

  if (options.shared) {
    const { SharedDaemon } = await import('../../daemon/shared.js')
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error(`No index found for ${resolvedPath}. Run 'mini-codegraph init' and 'mini-codegraph index' first.`)
      process.exit(1)
    }

    const graph = cg.getGraph()
    graph.checkStaleFiles()
    const sharedDaemon = new SharedDaemon({ idleTimeoutMs: 300_000 })

    sharedDaemon.setCallbacks(
      (id) => { logInfo(`[shared] Client connected: ${id}`) },
      (id) => { logInfo(`[shared] Client disconnected: ${id}`) }
    )

    await sharedDaemon.start(resolvedPath, graph, () => cg.getPendingFiles())
    logInfo(`Shared daemon started. PID: ${process.pid}`)
    process.stdin.resume()
    return
  }

  if (options.daemon) {
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      logError(`No index found for ${resolvedPath}. Run 'mini-codegraph init' and 'mini-codegraph index' first.`)
      process.exit(1)
    }

    cg.enableDaemon()

    const graph = cg.getGraph()
    graph.checkStaleFiles()
    const daemon = new DaemonServer(resolvedPath, graph, () => cg.getPendingFiles())
    try {
      await daemon.start()
      process.stdin.resume()
    } catch (e) {
      logError(`Failed to start daemon: ${e}`)
      process.exit(1)
    }
    return
  }

  const info = getDaemonInfo(resolvedPath)
  if (info?.alive) {
    try {
      const socket = await connectToDaemon(info.port)
      logInfo(`Connected to existing daemon (pid ${info.pid})`)

      let buffer = ''
      process.stdin.on('data', (chunk: Buffer) => {
        const data = chunk.toString()
        buffer += data
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)
          if (line) socket.write(line + '\n')
        }
      })

      socket.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk)
      })

      socket.on('close', () => process.exit(0))
      socket.on('error', () => process.exit(1))
      process.stdin.on('end', () => socket.end())
      process.stdin.resume()
      return
    } catch {
      logError('Failed to connect to daemon, starting new one...')
    }
  }

  try {
    logInfo('Starting daemon...')
    const port = await startDaemon(resolvedPath)
    const socket = await connectToDaemon(port)
    logInfo(`Connected to daemon on port ${port}`)

    let buffer = ''
    process.stdin.on('data', (chunk: Buffer) => {
      const data = chunk.toString()
      buffer += data
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line) socket.write(line + '\n')
      }
    })
    socket.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    socket.on('close', () => process.exit(0))
    socket.on('error', () => process.exit(1))
    process.stdin.on('end', () => socket.end())
    process.stdin.resume()
  } catch (e) {
    logError(`Daemon error`, e)
    process.exit(1)
  }
}
