#!/usr/bin/env node

import { Command } from 'commander'
import { resolve, join } from 'node:path'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { MiniCodeGraph } from './index.js'
import { StdioTransport } from './mcp/stdio-transport.js'
import { MCPServer } from './mcp/server.js'
import { DaemonServer } from './daemon/server.js'
import { getDaemonInfo, startDaemon, connectToDaemon } from './daemon/client.js'
import { findMulitModuleProjects, detectSpring } from './resolution/frameworks/java.js'
import { detectVue } from './resolution/frameworks/vue.js'

const program = new Command()

program
  .name('mini-cg')
  .description('mini-codegraph — lightweight code knowledge graph')
  .version('0.2.0')

program
  .command('init')
  .description('Initialize a mini-codegraph database for a project')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-i, --index', 'Also index after initialization')
  .option('-y, --yes', 'Non-interactive, accept defaults')
  .option('--multi-module', 'Discover and initialize sub-modules (Maven/Gradle multi-module)')
  .option('-e, --exclude <patterns>', 'Comma-separated glob patterns to exclude (e.g. "generated-sources/**,**/test/**")')
  .action(async (path: string, options: { index?: boolean; yes?: boolean; multiModule?: boolean; exclude?: string }) => {
    const resolvedPath = resolve(path)
    const excludePatterns = options.exclude?.split(',').map(s => s.trim()).filter(Boolean)

    if (options.multiModule) {
      const { cg, modules } = MiniCodeGraph.initMultiModule(resolvedPath)
      if (modules.length === 0) {
        console.error('No sub-modules found in', resolvedPath)
        process.exit(1)
      }

      console.error(`Initialized multi-module mini-codegraph for ${resolvedPath}`)
      console.error(`Found ${modules.length} sub-modules:`)
      for (const mod of modules) {
        console.error(`  [${mod.language}] ${mod.name} (${mod.buildSystem}) — ${mod.rootPath}`)
      }

      if (options.index) {
        console.error('\nIndexing all modules...')
        const result = await cg.indexMultiModule(excludePatterns)
        const stats = cg.getGraph().getStats()
        console.error(`\nIndexed ${stats.modules} modules, ${stats.files} files, ${stats.nodes} nodes, ${stats.edges} edges`)
        if (result.errors.length > 0) {
          console.error(`Errors: ${result.errors.length}`)
          for (const err of result.errors.slice(0, 5)) {
            console.error(`  ${err}`)
          }
        }
      }

      cg.close()
      return
    }

    const cg = MiniCodeGraph.init(resolvedPath)
    console.error(`Initialized mini-codegraph for ${resolvedPath}`)

    if (options.index) {
      console.error('Indexing...')
      const result = await cg.index(excludePatterns)
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
  .option('--changed', 'Only index git-changed files (incremental)')
  .option('--multi-module', 'Index as multi-module (Maven/Gradle multi-module parent)')
  .option('-e, --exclude <patterns>', 'Comma-separated glob patterns to exclude (e.g. "generated-sources/**,**/test/**")')
  .option('-j, --json', 'Output structured JSON summary')
  .action(async (path: string, options: { force?: boolean; changed?: boolean; multiModule?: boolean; exclude?: string; json?: boolean }) => {
    const resolvedPath = resolve(path)
    const excludePatterns = options.exclude?.split(',').map(s => s.trim()).filter(Boolean)

    if (options.changed) {
      const cg = MiniCodeGraph.open(resolvedPath)
      if (!cg) {
        console.error('No index found. Run full index first.')
        process.exit(1)
      }
      const result = await cg.sync()
      if (options.json) {
        console.log(JSON.stringify({
          new_nodes: result.nodes.length,
          new_edges: result.edges.length,
          errors: result.errors.length,
        }, null, 2))
      } else {
        console.error(`Synced ${result.nodes.length} new nodes, ${result.edges.length} new edges`)
      }
      cg.close()
      return
    }

    if (options.multiModule) {
      const cg = MiniCodeGraph.open(resolvedPath)
      if (!cg) {
        const { cg: newCg, modules } = MiniCodeGraph.initMultiModule(resolvedPath)
        if (modules.length === 0) {
          console.error('No sub-modules found.')
          process.exit(1)
        }
        const result = await newCg.indexMultiModule(excludePatterns)
        const stats = newCg.getGraph().getStats()
        console.log(JSON.stringify({
          modules: stats.modules,
          files_indexed: stats.files,
          nodes: stats.nodes,
          edges: stats.edges,
          errors: result.errors.length,
        }, null, 2))
        newCg.close()
        return
      }

      const result = await cg.indexMultiModule(excludePatterns)
      const stats = cg.getGraph().getStats()
      console.log(JSON.stringify({
        modules: stats.modules,
        files_indexed: stats.files,
        nodes: stats.nodes,
        edges: stats.edges,
        errors: result.errors.length,
      }, null, 2))
      cg.close()
      return
    }

    const cg = MiniCodeGraph.init(resolvedPath)
    const result = await cg.index(excludePatterns)

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
  .option('--git-hooks', 'Install git hooks for auto-sync on commit/merge/checkout')
  .action(async (path: string, options: { gitHooks?: boolean }) => {
    const resolvedPath = resolve(path)

    if (options.gitHooks) {
      const { installGitSyncHook } = await import('./sync/git-hooks.js')
      const result = installGitSyncHook(resolvedPath)
      if (result.installed.length > 0) {
        console.error(`Git sync hooks installed: ${result.installed.join(', ')}`)
      } else {
        console.error(result.skipped ?? 'No git repository found or hooks already installed.')
      }
      return
    }

    const cg = MiniCodeGraph.open(resolvedPath)
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
  .command('modules')
  .description('List indexed modules')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const modules = cg.getModules()
    console.log(JSON.stringify({ modules, count: modules.length }, null, 2))
    cg.close()
  })

program
  .command('export')
  .description('Export graph as JSON')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('--pretty', 'Pretty-print JSON')
  .action((path: string, options: { output?: string; pretty?: boolean }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const qm = graph.getQueries()
    const nodes = qm.getAllNodes()
    const edges = qm.getAllEdges()
    const exportData = { nodes, edges, exportedAt: new Date().toISOString() }
    const json = options.pretty ? JSON.stringify(exportData, null, 2) : JSON.stringify(exportData)

    if (options.output) {
      const outPath = resolve(options.output)
      writeFileSync(outPath, json, 'utf-8')
      console.error(`Exported ${nodes.length} nodes, ${edges.length} edges to ${outPath}`)
    } else {
      console.log(json)
    }

    cg.close()
  })

program
  .command('serve')
  .description('Start the MCP server over stdio')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--daemon', 'Run in daemon mode with file watching')
  .option('--shared', 'Run in shared daemon mode (multi-client over Unix socket)')
  .action(async (path: string, options: { daemon?: boolean; shared?: boolean }) => {
    const resolvedPath = resolve(path)

    if (options.shared) {
      const { SharedDaemon } = await import('./daemon/shared.js')
      const cg = MiniCodeGraph.open(resolvedPath)
      if (!cg) {
        console.error(`No index found for ${resolvedPath}. Run 'mini-cg init' and 'mini-cg index' first.`)
        process.exit(1)
      }

      const graph = cg.getGraph()
      graph.checkStaleFiles()
      const sharedDaemon = new SharedDaemon({ idleTimeoutMs: 300_000 })

      sharedDaemon.setCallbacks(
        (id) => { console.error(`[shared] Client connected: ${id}`) },
        (id) => { console.error(`[shared] Client disconnected: ${id}`) }
      )

      await sharedDaemon.start()
      console.error(`Shared daemon started. PID: ${process.pid}`)
      process.stdin.resume()
      return
    }

    if (options.daemon) {
      const cg = MiniCodeGraph.open(resolvedPath)
      if (!cg) {
        console.error(`No index found for ${resolvedPath}. Run 'mini-cg init' and 'mini-cg index' first.`)
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
        console.error(`Failed to start daemon: ${e}`)
        process.exit(1)
      }
      return
    }

    const info = getDaemonInfo(resolvedPath)
    if (info?.alive) {
      try {
        const socket = await connectToDaemon(info.port)
        console.error(`Connected to existing daemon (pid ${info.pid})`)

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
  .option('-m, --module <moduleId>', 'Filter by module')
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
    const modules = cg.getModules()
    const routes = cg.getRoutes()
    const frameworks = cg.getFrameworks()
    console.log(JSON.stringify({
      ...stats,
      modules: modules.map(m => ({ name: m.name, language: m.language, buildSystem: m.buildSystem })),
      frameworks: [...new Set([...frameworks, ...routes.map(r => r.framework)])],
      routeCount: routes.length,
    }, null, 2))
    cg.close()
  })

program
  .command('context')
  .description('Build context for a task description (15-step pipeline)')
  .argument('<task>', 'Task description')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--max-nodes <number>', 'Maximum symbols', '10')
  .option('--no-routes', 'Skip route detection')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action(async (task: string, path: string, options: any) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const result = await graph.buildContextWithRoutes(task)

    if (options.format === 'markdown') {
      const { ContextBuilder } = await import('./context/index.js')
      const builder = new ContextBuilder(graph.getQueries(), graph, resolvedPath)
      const markdown = builder.formatAsMarkdown(result.task, result.symbols, result.stats, result.routes)
      console.log(markdown)
    } else {
      if (options.routes === false) {
        delete result.routes
      }
      console.log(JSON.stringify(result, null, 2))
    }

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
        name: n.name, kind: n.kind, filePath: n.filePath, lines: `${n.startLine}-${n.endLine}`, moduleId: n.moduleId,
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
  .option('--manifest', 'Show full routing manifest (URL→handler mapping)')
  .action((path: string, options: { manifest?: boolean }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    if (options.manifest) {
      const manifest = cg.getGraph().getRoutingManifest()
      console.log(JSON.stringify({ routingManifest: manifest, count: manifest.length }, null, 2))
    } else {
      const routes = cg.getRoutes()
      console.log(JSON.stringify({ routes, frameworkCount: [...new Set(routes.map(r => r.framework))].length }, null, 2))
    }
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
        moduleId: info.node.moduleId,
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
  .command('feign')
  .description('Find FeignClient cross-service call mappings')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    try {
      const feignClients = cg.getGraph().getFeignClients()
      console.log(JSON.stringify({ feignClients, count: feignClients.length }, null, 2))
    } catch {
      console.log(JSON.stringify({ feignClients: [], count: 0 }))
    }
    cg.close()
  })

program
  .command('mybatis')
  .description('Show MyBatis mapper XML bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    try {
      const bindings = cg.getGraph().getMyBatisMappings()
      console.log(JSON.stringify({ mybatisBindings: bindings, count: bindings.length }, null, 2))
    } catch {
      console.log(JSON.stringify({ mybatisBindings: [], count: 0 }))
    }
    cg.close()
  })

program
  .command('gateway')
  .description('Show API Gateway routes')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const routes = cg.getGraph().getGatewayRoutes()
    console.log(JSON.stringify({ gatewayRoutes: routes, count: routes.length }, null, 2))
    cg.close()
  })

program
  .command('mq')
  .description('Show message queue bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const bindings = cg.getGraph().getMessageQueueBindings()
    console.log(JSON.stringify({ messageQueueBindings: bindings, count: bindings.length }, null, 2))
    cg.close()
  })

program
  .command('api-map')
  .description('Show Vue frontend to API controller mappings')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const mappings = cg.getGraph().getVueApiMappings()
    console.log(JSON.stringify({ apiMappings: mappings, count: mappings.length }, null, 2))
    cg.close()
  })

program
  .command('security')
  .description('Show security annotations')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const annotations = cg.getGraph().getSecurityAnnotations()
    console.log(JSON.stringify({ securityAnnotations: annotations, count: annotations.length }, null, 2))
    cg.close()
  })

program
  .command('jpa')
  .description('Show JPA entities')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const entities = cg.getGraph().getJpaEntities()
    console.log(JSON.stringify({ jpaEntities: entities, count: entities.length }, null, 2))
    cg.close()
  })

program
  .command('batch')
  .description('Show Spring Batch jobs')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const jobs = cg.getGraph().getBatchJobs()
    console.log(JSON.stringify({ batchJobs: jobs, count: jobs.length }, null, 2))
    cg.close()
  })

program
  .command('resilience')
  .description('Show resilience policies (CircuitBreaker, Retry, etc.)')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const policies = cg.getGraph().getResiliencePolicies()
    console.log(JSON.stringify({ resiliencePolicies: policies, count: policies.length }, null, 2))
    cg.close()
  })

program
  .command('pinia')
  .description('Show Pinia stores')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const stores = cg.getGraph().getPiniaStores()
    console.log(JSON.stringify({ piniaStores: stores, count: stores.length }, null, 2))
    cg.close()
  })

program
  .command('i18n')
  .description('Show i18n message usage')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const messages = cg.getGraph().getI18nMessages()
    console.log(JSON.stringify({ i18nMessages: messages, count: messages.length }, null, 2))
    cg.close()
  })

program
  .command('docker')
  .description('Show Docker deployment containers')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const containers = cg.getGraph().getDeployContainers()
    console.log(JSON.stringify({ dockerContainers: containers, count: containers.length }, null, 2))
    cg.close()
  })

program
  .command('k8s')
  .description('Show K8s resources')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const resources = cg.getGraph().getK8sResources()
    console.log(JSON.stringify({ k8sResources: resources, count: resources.length }, null, 2))
    cg.close()
  })

program
  .command('openapi')
  .description('Show OpenAPI contracts')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const endpoints = cg.getGraph().getOpenApiEndpoints()
    console.log(JSON.stringify({ openApiEndpoints: endpoints, count: endpoints.length }, null, 2))
    cg.close()
  })

program
  .command('diagram')
  .description('Generate Mermaid architecture diagrams')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-t, --type <type>', 'Diagram type: architecture, dependencies, sequence, trace, cache, tx, all', 'all')
  .action(async (path: string, options: { type: string }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }

    const { generateArchitectureDiagram, generateServiceDependencyDiagram, generateSequenceDiagram, generateFullTraceDiagram, generateCacheTopologyDiagram, generateTxPropagationDiagram, getAllMermaidDiagrams } = await import('./visualization/mermaid.js')
    const queries = cg.getGraph().getQueries()

    switch (options.type) {
      case 'architecture':
        console.log(generateArchitectureDiagram(queries))
        break
      case 'dependencies':
        console.log(generateServiceDependencyDiagram(queries))
        break
      case 'sequence':
        console.log(generateSequenceDiagram(queries, ''))
        break
      case 'trace':
        console.log(generateFullTraceDiagram(queries))
        break
      case 'cache':
        console.log(generateCacheTopologyDiagram(queries))
        break
      case 'tx':
        console.log(generateTxPropagationDiagram(queries))
        break
      default: {
        const diagrams = getAllMermaidDiagrams(queries)
        console.log('--- Architecture ---')
        console.log(diagrams.architecture)
        console.log('\n--- Dependencies ---')
        console.log(diagrams.dependencies)
        console.log('\n--- Sequence ---')
        console.log(diagrams.sequence)
      }
    }
    cg.close()
  })

program
  .command('trace')
  .description('Show full request traces (Vue → Gateway → Service → DB)')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-p, --path <path>', 'Filter by endpoint path')
  .option('-s, --service <name>', 'Filter by service name')
  .action((path: string, options: { path?: string; service?: string }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const graph = cg.getGraph()
    let traces = graph.getFullTraces()
    if (options.path) traces = [graph.getFullTraceByEndpoint(options.path)].filter(Boolean) as any
    if (options.service) traces = graph.getFullTracesByService(options.service)
    console.log(JSON.stringify({ traces: traces.slice(0, 20), count: Math.min(traces.length, 20) }, null, 2))
    cg.close()
  })

program
  .command('config')
  .description('Show @ConfigurationProperties bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-p, --prefix <prefix>', 'Filter by config prefix')
  .action((path: string, options: { prefix?: string }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const bindings = cg.getGraph().getConfigBindings()
    const filtered = options.prefix ? bindings.filter(b => b.prefix.startsWith(options.prefix!)) : bindings
    console.log(JSON.stringify({ configBindings: filtered, count: filtered.length }, null, 2))
    cg.close()
  })

program
  .command('tx')
  .description('Show @Transactional annotations and propagation chains')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--conflicts', 'Show only boundary conflicts')
  .action((path: string, options: { conflicts?: boolean }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const graph = cg.getGraph()
    if (options.conflicts) {
      const conflicts = graph.getTxBoundaryConflicts()
      console.log(JSON.stringify({ txConflicts: conflicts, count: conflicts.length }, null, 2))
    } else {
      const txs = graph.getTxAnnotations()
      console.log(JSON.stringify({ txAnnotations: txs, count: txs.length }, null, 2))
    }
    cg.close()
  })

program
  .command('cache')
  .description('Show cache annotations and cache topology')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const topologies = cg.getGraph().getCacheTopologies()
    console.log(JSON.stringify({ cacheTopologies: topologies, count: topologies.length }, null, 2))
    cg.close()
  })

program
  .command('lombok')
  .description('Show Lombok-synthesized getters, setters, constructors')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-c, --class <name>', 'Filter by class name')
  .action((path: string, options: { class?: string }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    let synthetics = cg.getGraph().getLombokSynthetics()
    if (options.class) synthetics = synthetics.filter(s => s.nodeId.includes(options.class!))
    console.log(JSON.stringify({ lombokSynthetics: synthetics, count: synthetics.length }, null, 2))
    cg.close()
  })

program
  .command('grpc')
  .description('Show gRPC services and proto messages')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const services = cg.getGraph().getGrpcServices()
    console.log(JSON.stringify({ grpcServices: services, count: services.length }, null, 2))
    cg.close()
  })

program
  .command('mapstruct')
  .description('Show MapStruct mappers with source→target DTO mappings')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const mappers = cg.getGraph().getMapStructMappers()
    console.log(JSON.stringify({ mapstructMappers: mappers, count: mappers.length }, null, 2))
    cg.close()
  })

program
  .command('autoconfig')
  .description('Show @ConditionalOn* / @AutoConfiguration conditional configuration')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const configs = cg.getGraph().getAutoConfigurations()
    console.log(JSON.stringify({ autoConfigurations: configs, count: configs.length }, null, 2))
    cg.close()
  })

program
  .command('maven')
  .description('Show Maven module dependency graph')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const modules = cg.getGraph().getMavenModules()
    const conflicts = cg.getGraph().getMavenScopeConflicts()
    console.log(JSON.stringify({ mavenModules: modules, scopeConflicts: conflicts }, null, 2))
    cg.close()
  })

program
  .command('gradle')
  .description('Show Gradle module dependency graph')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ gradleModules: cg.getGraph().getGradleModules() }, null, 2))
    cg.close()
  })

program
  .command('cloud-config')
  .description('Show @RefreshScope and Spring Cloud Config bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ cloudConfigs: cg.getGraph().getCloudConfigs() }, null, 2))
    cg.close()
  })

program
  .command('loadbalancer')
  .description('Show @LoadBalanced clients and lb:// URI targets')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ lbClients: cg.getGraph().getLoadBalancerClients(), lbUris: cg.getGraph().getLoadBalancerUris() }, null, 2))
    cg.close()
  })

program
  .command('graphql')
  .description('Show GraphQL @QueryMapping / @MutationMapping endpoints')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ graphqlEndpoints: cg.getGraph().getGraphQLEndpoints() }, null, 2))
    cg.close()
  })

program
  .command('websocket')
  .description('Show WebSocket @MessageMapping / @SendTo endpoints')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ websocketEndpoints: cg.getGraph().getWebSocketEndpoints() }, null, 2))
    cg.close()
  })

program
  .command('test')
  .description('Show test annotations (@SpringBootTest, @MockBean, etc.)')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ testAnnotations: cg.getGraph().getTestAnnotations() }, null, 2))
    cg.close()
  })

program
  .command('async')
  .description('Show @Async and @Scheduled methods')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ asyncMethods: cg.getGraph().getAsyncMethods() }, null, 2))
    cg.close()
  })

program
  .command('aop')
  .description('Show AOP @Aspect advices and pointcut weaving')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ aspects: cg.getGraph().getAspectAdvices() }, null, 2))
    cg.close()
  })

program
  .command('security-filter')
  .description('Show SecurityFilterChain / HttpSecurity authorization rules')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ securityFilters: cg.getGraph().getSecurityFilterRules() }, null, 2))
    cg.close()
  })

program
  .command('k8s-net')
  .description('Show K8s Ingress/Service/NetworkPolicy details')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({
      services: cg.getGraph().getK8sServiceDetails(),
      ingresses: cg.getGraph().getK8sIngressDetails(),
      networkPolicies: cg.getGraph().getK8sNetworkPolicies(),
    }, null, 2))
    cg.close()
  })

program
  .command('advice')
  .description('Show @ControllerAdvice / @ExceptionHandler global handlers')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ controllerAdvices: cg.getGraph().getControllerAdvices() }, null, 2))
    cg.close()
  })

program
  .command('interceptor')
  .description('Show HandlerInterceptor / Filter chain')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ interceptors: cg.getGraph().getInterceptors() }, null, 2))
    cg.close()
  })

program
  .command('stream-func')
  .description('Show Spring Cloud Stream functional beans (Function/Consumer/Supplier)')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ streamFunctions: cg.getGraph().getStreamFunctions() }, null, 2))
    cg.close()
  })

program
  .command('jpa-query')
  .description('Show JPA @Query / @Modifying / @Procedure custom queries')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ jpaQueries: cg.getGraph().getJpaCustomQueries(), procedures: cg.getGraph().getJpaProcedures() }, null, 2))
    cg.close()
  })

program
  .command('profile')
  .description('Show @Profile annotations — which beans activate in which environments')
  .argument('[path]', 'Project root path', process.cwd())
  .action((path: string) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    console.log(JSON.stringify({ profiles: cg.getGraph().getProfileAnnotations() }, null, 2))
    cg.close()
  })

program
  .command('react')
  .description('Show React components, hooks, stores, and data queries')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--detail', 'Include hooks, props, and children details')
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action((path: string, options: { detail?: boolean; limit?: number }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const graph = cg.getGraph()
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
    const components = graph.getReactComponents(limit)
    const stores = graph.getReactStores(limit)
    const queries = graph.getReactQueries(limit)
    const result: any = {
      components: options.detail ? components : components.map((c: any) => ({ componentName: c.componentName, filePath: c.filePath, hookCount: c.hooks.length })),
      stores,
      queries,
      total: components.length, truncated: components.length >= limit,
    }
    console.log(JSON.stringify(result, null, 2))
    cg.close()
  })

program
  .command('mongo')
  .description('Show MongoDB entities — @Document collections, repositories, template usage')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action((path: string, options: { limit?: number }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
    const all = cg.getGraph().getMongoEntities(limit)
    console.log(JSON.stringify({ mongoEntities: all, total: all.length, truncated: all.length >= limit }, null, 2))
    cg.close()
  })

program
  .command('redis')
  .description('Show Redis hashes, repositories, and template operations')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action((path: string, options: { limit?: number }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
    const hashes = cg.getGraph().getRedisHashes(limit)
    const templates = cg.getGraph().getRedisTemplates(limit)
    console.log(JSON.stringify({
      redisHashes: hashes, redisHashesTotal: hashes.length,
      redisTemplates: templates, redisTemplatesTotal: templates.length,
      truncated: hashes.length >= limit || templates.length >= limit,
    }, null, 2))
    cg.close()
  })

program
  .command('sql')
  .description('Show SQL tables and statements — DDL, MyBatis SQL, JPA @Query, JDBC')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action((path: string, options: { limit?: number }) => {
    const resolvedPath = resolve(path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) { console.error('No index found.'); process.exit(1) }
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
    const tables = cg.getGraph().getSqlTables(limit)
    const stmts = cg.getGraph().getSqlStatements(limit)
    console.log(JSON.stringify({
      tables: tables.slice(0, limit), tablesTotal: tables.length,
      sqlStatements: stmts.slice(0, limit), sqlStatementsTotal: stmts.length,
      truncated: tables.length > limit || stmts.length > limit,
    }, null, 2))
    cg.close()
  })

program
  .command('install')
  .description('Install and configure mini-codegraph for AI agents')
  .option('--target <agents>', 'Comma-separated agent targets (opencode, claude, cursor, codex, gemini, hermes, antigravity, kiro)')
  .option('--yes', 'Non-interactive, accept defaults')
  .option('--location <type>', 'Install location: global or local (default: global)')
  .action(async (options: { target?: string; yes?: boolean; location?: string }) => {
    const targets = (options.target || 'opencode').split(',').map((t: string) => t.trim())
    const location = options.location || 'global'
    const yes = options.yes || false

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
            } catch { /* silent */ }
          }

          opencodeConfig.mcpServers = opencodeConfig.mcpServers || {}
          opencodeConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve', location === 'local' ? projectRoot : ''],
          }

          if (!existsSync(configDir)) {
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
            } catch { /* silent */ }
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

        case 'cursor': {
          const configDir = join(homedir(), '.cursor')
          const configPath = join(configDir, 'mcp.json')
          let cursorConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try {
              cursorConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
            } catch { /* silent */ }
          }
          cursorConfig.mcpServers = cursorConfig.mcpServers || {}
          cursorConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
          configs.push({ agent: 'cursor', configPath, config: cursorConfig })
          break
        }

        case 'codex': {
          const cliPath = ensureCliOnPath()
          const configPath = join(process.cwd(), '.codex.json')
          let codexConfig: any = {}
          if (existsSync(configPath)) {
            try { codexConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
          }
          codexConfig.mcpServers = codexConfig.mcpServers || {}
          codexConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }
          configs.push({ agent: 'codex', configPath, config: codexConfig })
          break
        }

        case 'gemini': {
          const configPath = join(homedir(), '.gemini', 'mcp.json')
          let geminiConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try { geminiConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
          }
          geminiConfig.mcpServers = geminiConfig.mcpServers || {}
          geminiConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }
          const configDir = join(homedir(), '.gemini')
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
          configs.push({ agent: 'gemini', configPath, config: geminiConfig })
          break
        }

        case 'hermes': {
          const configDir = join(homedir(), '.config', 'hermes')
          const configPath = join(configDir, 'config.json')
          let hermesConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try { hermesConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
          }
          hermesConfig.mcpServers = hermesConfig.mcpServers || {}
          hermesConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
          configs.push({ agent: 'hermes', configPath, config: hermesConfig })
          break
        }

        case 'antigravity': {
          const configDir = join(homedir(), '.antigravity')
          const configPath = join(configDir, 'mcp.json')
          let agConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try { agConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
          }
          agConfig.mcpServers = agConfig.mcpServers || {}
          agConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
          configs.push({ agent: 'antigravity', configPath, config: agConfig })
          break
        }

        case 'kiro': {
          const configPath = join(homedir(), '.kiro', 'mcp.json')
          let kiroConfig: any = { mcpServers: {} }
          if (existsSync(configPath)) {
            try { kiroConfig = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* silent */ }
          }
          kiroConfig.mcpServers = kiroConfig.mcpServers || {}
          kiroConfig.mcpServers['mini-codegraph'] = {
            type: 'stdio',
            command: 'mini-cg',
            args: ['serve'],
          }
          const configDir = join(homedir(), '.kiro')
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
          configs.push({ agent: 'kiro', configPath, config: kiroConfig })
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
      if (!existsSync(join(projectRoot, '.mini-codegraph', 'mini-cg.db'))) {
        console.error('Note: project not initialized. Run "mini-cg init" and "mini-cg index" first.')
      }
      console.error('Done!')
    }
  })

program
  .command('exclude')
  .description('Manage file/directory exclusion patterns for indexing')
  .argument('<action>', 'add, remove, or list')
  .argument('[pattern]', 'Glob pattern to exclude (e.g. "generated-sources/**" or "**/*.gen.*")')
  .action(async (action: string, pattern: string) => {
    const projectRoot = process.cwd()
    const cg = MiniCodeGraph.open(projectRoot)
    if (!cg) {
      console.error('No mini-codegraph database found. Run "mini-cg init" first.')
      process.exit(1)
    }

    switch (action) {
      case 'add':
        if (!pattern) { console.error('Usage: mini-cg exclude add <pattern>'); process.exit(1) }
        cg.addExclude(pattern)
        console.error(`Added exclude pattern: ${pattern}`)
        break
      case 'remove':
        if (!pattern) { console.error('Usage: mini-cg exclude remove <pattern>'); process.exit(1) }
        cg.removeExclude(pattern)
        console.error(`Removed exclude pattern: ${pattern}`)
        break
      case 'list':
        const excludes = cg.listExcludes()
        if (excludes.length === 0) {
          console.log('No exclude patterns configured.')
        } else {
          console.log('Exclude patterns:')
          for (const e of excludes) console.log(`  ${e}`)
        }
        break
      default:
        console.error('Unknown action. Use: add, remove, or list')
        process.exit(1)
    }

    cg.close()
  })

function ensureCliOnPath(): string | null {
  try {
    execFileSync('mini-cg', ['--version'], { stdio: 'pipe' })
    return 'mini-cg'
  } catch { /* silent */ }

  const distCli = join(process.cwd(), 'dist', 'cli.js')
  if (existsSync(distCli)) {
    return `node ${distCli}`
  }

  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8' }).trim()
    const npmCli = join(npmRoot, 'mini-codegraph', 'dist', 'cli.js')
    if (existsSync(npmCli)) {
      return `node ${npmCli}`
    }
  } catch { /* silent */ }

  return null
}

program.parse(process.argv)
