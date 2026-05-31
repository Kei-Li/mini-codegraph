#!/usr/bin/env node

import { Command } from 'commander'
import { join } from 'node:path'
import { MiniCodeGraph } from './index.js'
import { StdioTransport } from './mcp/transport.js'
import { MCPServer } from './mcp/server.js'
import { readFileSync } from 'node:fs'

const program = new Command()

program
  .name('mini-cg')
  .description('mini-codegraph — lightweight code knowledge graph')
  .version('0.1.0')

program
  .command('init')
  .description('Initialize a codegraph database for a project')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (path: string) => {
    const cg = MiniCodeGraph.init(path)
    console.error(`Initialized codegraph for ${path}`)
    cg.close()
  })

program
  .command('index')
  .description('Index all supported files in the project')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (path: string) => {
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
  .command('serve')
  .description('Start the MCP server over stdio')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (path: string) => {
    const resolvedPath = join(process.cwd(), path)
    const cg = MiniCodeGraph.open(resolvedPath)

    if (!cg) {
      console.error(`No index found for ${resolvedPath}. Run 'mini-cg init' and 'mini-cg index' first.`)
      process.exit(1)
    }

    const graph = cg.getGraph()
    const transport = new StdioTransport()
    const server = new MCPServer(transport, graph)
    server.start()

    // Keep alive
    process.stdin.resume()
  })

program
  .command('search')
  .description('Search for symbols in the index')
  .argument('<query>', 'Symbol name or search query')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, method, etc.)')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (query: string, options: any, path: string) => {
    const resolvedPath = join(process.cwd(), path)
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
    const resolvedPath = join(process.cwd(), path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const stats = cg.getGraph().getStats()
    console.log(JSON.stringify(stats, null, 2))
    cg.close()
  })

program
  .command('context')
  .description('Build context for a task description')
  .argument('<task>', 'Task description')
  .argument('[path]', 'Project root path', process.cwd())
  .action(async (task: string, path: string) => {
    const resolvedPath = join(process.cwd(), path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const graph = cg.getGraph()
    const results = graph.search(task, 10)
    console.log(JSON.stringify({ task, symbols: results }))
    cg.close()
  })

program
  .command('callers')
  .description('Find callers of a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .action((symbol: string, path: string) => {
    const resolvedPath = join(process.cwd(), path)
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
    const resolvedPath = join(process.cwd(), path)
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
  .command('files')
  .description('List indexed files')
  .option('-p, --pattern <pattern>', 'Glob pattern filter')
  .argument('[path]', 'Project root path', process.cwd())
  .action((options: any, path: string) => {
    const resolvedPath = join(process.cwd(), path)
    const cg = MiniCodeGraph.open(resolvedPath)
    if (!cg) {
      console.error('No index found.')
      process.exit(1)
    }

    const files = cg.getGraph().getFileListing(options.pattern)
    console.log(JSON.stringify({ files }))
    cg.close()
  })

program.parse(process.argv)
