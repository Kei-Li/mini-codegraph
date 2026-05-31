#!/usr/bin/env node

import { Command } from 'commander'
import { resolve, join } from 'node:path'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { MiniCodeGraph } from './index.js'
import { StdioTransport } from './mcp/stdio-transport.js'
import { MCPServer } from './mcp/server.js'
import { DaemonServer } from './daemon/server.js'
import { getDaemonInfo, startDaemon, connectToDaemon } from './daemon/client.js'

const program = new Command()

program
  .name('mini-cg')
  .description('mini-codegraph — lightweight code knowledge graph')
  .version('0.1.0')

program
  .command('init')
  .description('Initialize a codegraph database for a project')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-i, --index', 'Also index after initialization')
  .action(async (path: string, options: { index?: boolean }) => {
    const cg = MiniCodeGraph.init(path)
    console.error(`Initialized codegraph for ${path}`)

    if (options.index) {
      console.error('Indexing...')
      const result = await cg.index()
      const stats = cg.getGraph().getStats()
      console.error(`Indexed ${stats.files} files, ${stats.nodes} nodes, ${stats.edges} edges`)
    }

    cg.close()
  })

program
  .command('index')
  .description('Index all supported files in the project')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-f, --force', 'Force re-index all files')
  .action(async (path: string, options: { force?: boolean }) => {
    const cg = MiniCodeGraph.init(path)
    const result = await cg.index()

    const stats = cg.getGraph().getStats()
    console.log(JSON.stringify({
      files_indexed: stats.files,
      nodes: stats.nodes,
      edges: stats.edges,
      errors: result.errors.length,
    }, null, 2))

    if (result.errors.length > 0) {
      console.error('Errors:')
      for (const err of result.errors.slice(0, 10)) {
        console.error(`  ${err}`)
      }
    }

    cg.close()
  })

program
  .command('sync')
  .description('Incremental update — index only new/changed files')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (path: string) => {
    const cg = MiniCodeGraph.open(path)
    if (!cg) {
      console.error('No index found. Run init + index first.')
      process.exit(1)
    }

    const result = await cg.sync()
    console.log(JSON.stringify({
      new_nodes: result.nodes.length,
      new_edges: result.edges.length,
      errors: result.errors.length,
    }, null, 2))

    cg.close()
  })

program
  .command('serve')
  .description('Start the MCP server over stdio')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--daemon', 'Run in daemon mode with file watching')
  .action(async (path: string, options: { daemon?: boolean }) => {
    const resolvedPath = resolve(path)

    if (options.daemon) {
      // Start as daemon process — run TCP server
      const cg = MiniCodeGraph.open(resolvedPath)
      if (!cg) {
        console.error(`No index found for ${resolvedPath}. Run 'mini-cg init' and 'mini-cg index' first.`)
        process.exit(1)
      }

      cg.enableDaemon()

      const graph = cg.getGraph()
      graph.checkStaleFiles()
      const daemon = new DaemonServer(resolvedPath, graph)
      try {
        await daemon.start()
        // Keep alive — don't exit
        process.stdin.resume()
      } catch (e) {
        console.error(`Failed to start daemon: ${e}`)
        process.exit(1)
      }
      return
    }

    // Try connecting to existing daemon first
    const info = getDaemonInfo(resolvedPath)
    if (info?.alive) {
      try {
        const socket = await connectToDaemon(info.port)
        console.error(`Connected to existing daemon (pid ${info.pid})`)

        // Bridge: stdin → socket, socket → stdout
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
        console.error('Failed to connect to daemon, starting new one...')
      }
    }

    // Start a new daemon in background and connect
    try {
      console.error('Starting daemon...')
      const port = await startDaemon(resolvedPath)
      const socket = await connectToDaemon(port)
      console.error(`Connected to daemon on port ${port}`)

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
      console.error(`Daemon error: ${e}`)
      process.exit(1)
    }
  })

program
  .command('search')
  .description('Search for symbols in the index')
  .argument('<query>', 'Symbol name or search query')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, method, etc.)')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (query: string, path: string, options: any) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found. Run init + index first.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const results = graph.search(query, parseInt(options.limit, 10))
    console.log(JSON.stringify(results, null, 2))
    cg.close()
  })

program
  .command('status')
  .description('Show index statistics')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const stats = cg.getGraph().getStats()
    const routes = cg.getRoutes()
    console.log(JSON.stringify({
      ...stats,
      frameworks: [...new Set(routes.map(r => r.framework))],
      routeCount: routes.length,
    }, null, 2))
    cg.close()
  })

program
  .command('context')
  .description('Build context for a task description')
  .argument('<task>', 'Task description')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--max-nodes <number>', 'Maximum symbols', '10')
  .option('--no-routes', 'Skip route detection')
  .action(async (task: string, path: string, options: any) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const searchTerms = task.split(/\s+/).filter((t: string) => t.length > 2)
    const allResults: any[] = []
    const maxNodes = parseInt(options.maxNodes, 10)

    for (const term of searchTerms.slice(0, 5)) {
      const results = graph.search(term, maxNodes)
      for (const r of results) {
        if (allResults.length >= maxNodes) break
        const existingIds = new Set(allResults.map((x: any) => x.id))
        if (!existingIds.has(r.node.id)) {
          const ctx = graph.getContext(r.node.id)
          allResults.push({
            id: r.node.id,
            name: r.node.name,
            kind: r.node.kind,
            qualifiedName: r.node.qualifiedName,
            filePath: r.node.filePath,
            lines: `${r.node.startLine}-${r.node.endLine}`,
            signature: r.node.signature,
            docstring: r.node.docstring,
            callers: ctx.callers.map(c => ({ name: c.name, filePath: c.filePath })),
            callees: ctx.callees.map(c => ({ name: c.name, filePath: c.filePath })),
            implementations: ctx.implementations.map(i => ({ name: i.name, filePath: i.filePath })),
            code: r.snippets.join('\n'),
          })
        }
      }
      if (allResults.length >= maxNodes) break
    }

    const result: any = { task, symbols: allResults }

    if (options.routes !== false) {
      const routes = cg.getRoutes()
      if (routes.length > 0) result.routes = routes
    }

    console.log(JSON.stringify(result, null, 2))
    cg.close()
  })

program
  .command('callers')
  .description('Find callers of a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .action((symbol: string, path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const results = graph.search(symbol, 5)
    if (results.length === 0) {
      console.log(JSON.stringify({ callers: [] }))
      cg.close()
      return
    }

    const callers = graph.getCallers(results[0].node.id)
    console.log(JSON.stringify({ callers }))
    cg.close()
  })

program
  .command('callees')
  .description('Find callees of a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .action((symbol: string, path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const results = graph.search(symbol, 5)
    if (results.length === 0) {
      console.log(JSON.stringify({ callees: [] }))
      cg.close()
      return
    }

    const callees = graph.getCallees(results[0].node.id)
    console.log(JSON.stringify({ callees }))
    cg.close()
  })

program
  .command('impact')
  .description('Analyze what code is affected by changing a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .action((symbol: string, path: string, options: any) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const results = graph.search(symbol, 5)
    if (results.length === 0) {
      console.log(JSON.stringify({ error: 'Symbol not found' }))
      cg.close()
      return
    }

    const depth = Math.min(parseInt(options.depth, 10), 5)
    const impacted = graph.getImpact(results[0].node.id, depth)
    console.log(JSON.stringify({
      target: results[0].node,
      impacted: impacted.map(n => ({
        name: n.name, kind: n.kind, filePath: n.filePath, lines: `${n.startLine}-${n.endLine}`,
      })),
    }, null, 2))
    cg.close()
  })

program
  .command('files')
  .description('List indexed files')
  .option('-p, --pattern <pattern>', 'Glob pattern filter')
  .option('--json', 'Output as JSON')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string, options: any) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const files = cg.getGraph().getFileListing(options.pattern)
    console.log(JSON.stringify({ files }))
    cg.close()
  })

program
  .command('routes')
  .description('Detect web framework routes in the project')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const routes = cg.getRoutes()
    console.log(JSON.stringify({ routes, frameworkCount: [...new Set(routes.map(r => r.framework))].length }, null, 2))
    cg.close()
  })

program
  .command('affected')
  .description('Find test files affected by changes to source files')
  .argument('[path]', 'Project root path', process.cwd())
  .argument('<files...>', 'Source file paths (relative to project root)')
  .action((path: string, files: string[]) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const affected = graph.findAffectedTestFiles(files)
    console.log(JSON.stringify({ affected }, null, 2))
    cg.close()
  })

program
  .command('explore')
  .description('Explore related symbols grouped by file')
  .argument('<symbols>', 'Comma-separated symbol names')
  .argument('[path]', 'Project root path', process.cwd())
  .action((symbols: string, path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const names = symbols.split(',').map((s: string) => s.trim()).filter(Boolean)
    const nodeIds: string[] = []

    for (const name of names) {
      const results = graph.search(name, 3)
      for (const r of results) {
        if (!nodeIds.includes(r.node.id)) nodeIds.push(r.node.id)
      }
    }

    const related = graph.findRelated(nodeIds.slice(0, 20))
    const files = new Map<string, any[]>()

    for (const [id, info] of related) {
      const fp = info.node.filePath
      if (!files.has(fp)) files.set(fp, [])
      files.get(fp)!.push({
        id,
        name: info.node.name,
        kind: info.node.kind,
        lines: `${info.node.startLine}-${info.node.endLine}`,
        relationships: info.relationships,
      })
    }

    console.log(JSON.stringify({ files: Array.from(files.entries()).map(([fp, nodes]) => ({ filePath: fp, nodes })) }, null, 2))
    cg.close()
  })

program
  .command('dead-code')
  .description('Find symbols with no callers (potential dead code)')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const deadCode = cg.getGraph().findDeadCode()
    console.log(JSON.stringify({
      count: deadCode.length,
      symbols: deadCode.map(n => ({ name: n.name, kind: n.kind, filePath: n.filePath, lines: `${n.startLine}-${n.endLine}` })),
    }, null, 2))
    cg.close()
  })

program
  .command('install')
  .description('Install and configure mini-codegraph for AI agents')
  .option('--target <agents>', 'Comma-separated agent targets (opencode, claude, cursor, codex)')
  .option('--yes', 'Non-interactive, accept defaults')
  .option('--location <type>', 'Install location: global or local (default: global)')
  .action(async (options: { target?: string; yes?: boolean; location?: string }) => {
    const targets = (options.target || 'opencode').split(',').map((t: string) => t.trim())
    const location = options.location || 'global'
    const yes = options.yes || false

    // Phase 1: Ensure CLI is on PATH
    const cliPath = ensureCliOnPath()
    if (cliPath) {
      console.error(`CLI available at: ${cliPath}`)
    } else {
      console.error('Warning: mini-cg not found on PATH. Agents may not be able to launch the server.')
      console.error('Add the dist/ directory to your PATH or run: npm link')
    }

    const configs: { agent: string; configPath: string; config: any }[] = []

    for (const target of targets) {
      switch (target) {
        case 'opencode': {
          const configDir = join(homedir(), '.config', 'opencode')
          const configPath = join(configDir, 'opencode.json')
          const projectRoot = process.cwd()

          if (!existsSync(configDir) && !yes) {
            console.error(`opencode config directory not found at ${configDir}`)
            continue
          }

          let opencodeConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try {
              opencodeConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
            } catch {}
          }

          opencodeConfig.mcpServers = opencodeConfig.mcpServers || {}
          opencodeConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve', location === 'local' ? projectRoot : ''],
          }

          if (!existsSync(configDir)) {
            const { mkdirSync } = await import('node:fs')
            mkdirSync(configDir, { recursive: true })
          }

          configs.push({ agent: 'opencode', configPath, config: opencodeConfig })
          break
        }

        case 'claude': {
          const configPath = join(homedir(), '.claude.json')
          let claudeConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try {
              claudeConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
            } catch {}
          }

          claudeConfig.mcpServers = claudeConfig.mcpServers || {}
          claudeConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }

          configs.push({ agent: 'claude', configPath, config: claudeConfig })
          break
        }

        default:
          console.error(`Unknown agent target: ${target}`)
      }
    }

    for (const { agent, configPath, config } of configs) {
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      console.error(`Configured ${agent} at ${configPath}`)
    }

    if (configs.length > 0) {
      const projectRoot = process.cwd()
      if (!existsSync(join(projectRoot, '.codegraph', 'codegraph.db'))) {
        console.error('Note: project not initialized. Run "mini-cg init" and "mini-cg index" first.')
      }
      console.error('Done!')
    }
  })

function ensureCliOnPath(): string | null {
  try {
    execSync('mini-cg --version', { stdio: 'pipe' })
    return 'mini-cg'
  } catch {}

  const distCli = join(process.cwd(), 'dist', 'cli.js')
  if (existsSync(distCli)) {
    return `node ${distCli}`
  }

  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim()
    const npmCli = join(npmRoot, 'mini-codegraph', 'dist', 'cli.js')
    if (existsSync(npmCli)) {
      return `node ${npmCli}`
    }
  } catch {}

  return null
}

program.parse(process.argv)
