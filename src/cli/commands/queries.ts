import { resolve } from 'node:path'
import { MiniCodeGraph } from '../../index.js'
import { logInfo, logError } from '../../logger.js'

export async function handleSearch(query: string, path: string, options: any): Promise<void> {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found. Run init + index first.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const results = graph.search(query, parseInt(options.limit, 10))
  logInfo(JSON.stringify(results, null, 2))
  cg.close()
}

export function handleStatus(path: string): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const stats = cg.getGraph().getStats()
  const modules = cg.getModules()
  const routes = cg.getRoutes()
  const frameworks = cg.getFrameworks()
  logInfo(JSON.stringify({
    ...stats,
    modules: modules.map(m => ({ name: m.name, language: m.language, buildSystem: m.buildSystem })),
    frameworks: [...new Set([...frameworks, ...routes.map(r => r.framework)])],
    routeCount: routes.length,
  }, null, 2))
  cg.close()
}

export async function handleContext(task: string, path: string, options: any): Promise<void> {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const { ContextBuilder } = await import('../../context/index.js')
  const builder = new ContextBuilder(graph.getQueryManager(), graph, resolvedPath)
  const result = await builder.buildContext(task)

  if (options.format === 'markdown') {
    const markdown = builder.formatAsMarkdown(result.task, result.symbols, result.stats, result.routes)
    logInfo(markdown)
  } else {
    if (options.routes === false) {
      delete result.routes
    }
    logInfo(JSON.stringify(result, null, 2))
  }

  cg.close()
}

export function handleCallers(symbol: string, path: string): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const results = graph.search(symbol, 5)
  if (results.length === 0) {
    logInfo(JSON.stringify({ callers: [] }))
    cg.close()
    return
  }

  const callers = graph.getCallers(results[0].node.id)
  logInfo(JSON.stringify({ callers }))
  cg.close()
}

export function handleCallees(symbol: string, path: string): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const results = graph.search(symbol, 5)
  if (results.length === 0) {
    logInfo(JSON.stringify({ callees: [] }))
    cg.close()
    return
  }

  const callees = graph.getCallees(results[0].node.id)
  logInfo(JSON.stringify({ callees }))
  cg.close()
}

export function handleImpact(symbol: string, path: string, options: any): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const results = graph.search(symbol, 5)
  if (results.length === 0) {
    logInfo(JSON.stringify({ error: 'Symbol not found' }))
    cg.close()
    return
  }

  const depth = Math.min(parseInt(options.depth, 10), 5)
  const impacted = graph.getImpact(results[0].node.id, depth)
  logInfo(JSON.stringify({
    target: results[0].node,
    impacted: impacted.map(n => ({
      name: n.name, kind: n.kind, filePath: n.filePath, lines: `${n.startLine}-${n.endLine}`, moduleId: n.moduleId,
    })),
  }, null, 2))
  cg.close()
}

export function handleFiles(path: string, options: any): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const files = cg.getGraph().getFileListing(options.pattern)
  logInfo(JSON.stringify({ files }))
  cg.close()
}

export function handleRoutes(path: string, options: { manifest?: boolean }): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  if (options.manifest) {
    const manifest = cg.getGraph().getRoutingManifest()
    logInfo(JSON.stringify({ routingManifest: manifest, count: manifest.length }, null, 2))
  } else {
    const routes = cg.getRoutes()
    logInfo(JSON.stringify({ routes, frameworkCount: [...new Set(routes.map(r => r.framework))].length }, null, 2))
  }
  cg.close()
}

export function handleAffected(path: string, files: string[]): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const graph = cg.getGraph()
  const affected = graph.findAffectedTestFiles(files)
  logInfo(JSON.stringify({ affected }, null, 2))
  cg.close()
}

export function handleExplore(symbols: string, path: string): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
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

  logInfo(JSON.stringify({ files: Array.from(files.entries()).map(([fp, nodes]) => ({ filePath: fp, nodes })) }, null, 2))
  cg.close()
}

export function handleDeadCode(path: string): void {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) {
    logError('No index found.')
    process.exit(1)
  }

  const deadCode = cg.getGraph().findDeadCode()
  logInfo(JSON.stringify({
    count: deadCode.length,
    symbols: deadCode.map(n => ({ name: n.name, kind: n.kind, filePath: n.filePath, lines: `${n.startLine}-${n.endLine}` })),
  }, null, 2))
  cg.close()
}
