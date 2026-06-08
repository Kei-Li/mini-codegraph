import { readFileSync } from 'node:fs'
import type { ToolDefinition } from './shared.js'

export function createGraphTools(): ToolDefinition[] {
  return [
    {
      name: 'mini_cg_trace',
      description: 'Find call paths between two symbols',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Starting symbol name' },
          to: { type: 'string', description: 'Target symbol name' },
          maxPaths: { type: 'number', description: 'Max paths to return (default: 5, max: 20)' },
        },
        required: ['from', 'to'],
      },
      handler: async (args, graph) => {
        const from = typeof args.from === 'string' ? args.from.slice(0, 200) : ''
        const to = typeof args.to === 'string' ? args.to.slice(0, 200) : ''
        const rawPaths = typeof args.maxPaths === 'number' ? args.maxPaths : 5
        const maxPaths = Math.min(rawPaths, 20)
        if (!from || !to) return { error: 'Both from and to are required', fromFound: 0, toFound: 0 }

        const fromResults = graph.search(from, 5)
        const toResults = graph.search(to, 5)

        if (fromResults.length === 0 || toResults.length === 0) {
          return { error: 'Could not find one or both symbols', fromFound: fromResults.length, toFound: toResults.length }
        }

        const fromNode = fromResults[0].node
        const toNode = toResults[0].node

        const { paths: allPaths, truncated: bfsTruncated } = graph.findPath(fromNode.id, toNode.id)

        if (allPaths.length === 0) {
          const inlineSource = (node: typeof fromNode, maxLines = 60, maxChars = 1800) => {
            try {
              if (!node.filePath || node.filePath.includes('..') || node.filePath.startsWith('/')) return null
              const lines = readFileSync(node.filePath, 'utf-8').split('\n')
              const snippet = lines.slice(node.startLine - 1, node.startLine - 1 + maxLines).join('\n')
              return snippet.length > maxChars ? snippet.slice(0, maxChars) + '\n... (truncated)' : snippet
            } catch { return null }
          }

          const neighbors: { name: string; lines: string }[] = []
          try {
            if (toNode.filePath?.includes('..') || toNode.filePath?.startsWith('/')) throw new Error('invalid path')
            const lines = readFileSync(toNode.filePath, 'utf-8').split('\n')
            for (const n of graph.getContext(toNode.id).callers) {
              if (neighbors.length >= 3) break
              if (n.id === toNode.id || n.filePath !== toNode.filePath) continue
              const snippet = lines.slice(n.startLine - 1, n.endLine).join('\n')
              neighbors.push({ name: n.name, lines: snippet.length > 1200 ? snippet.slice(0, 1200) + '...' : snippet })
            }
          } catch { /* silent */ }

          return {
            from: { name: fromNode.name, filePath: fromNode.filePath },
            to: { name: toNode.name, filePath: toNode.filePath },
            paths: [],
            totalPaths: 0,
            note: 'No static call path found. Inlined source below for manual inspection.',
            fromSource: inlineSource(fromNode),
            toSource: inlineSource(toNode),
            toNeighbors: neighbors.length > 0 ? neighbors : undefined,
          }
        }

        const safeLimit = Math.min(Math.max(1, maxPaths), 500)
        const items = allPaths.slice(0, safeLimit)

        return {
          from: { name: fromNode.name, filePath: fromNode.filePath },
          to: { name: toNode.name, filePath: toNode.filePath },
          paths: items.map(path => path.map(n => ({
            name: n.node.name, kind: n.node.kind,
            filePath: n.node.filePath, lines: `${n.node.startLine}-${n.node.endLine}`,
          }))),
          totalPaths: allPaths.length, truncated: allPaths.length > safeLimit,
          bfsTruncated,
        }
      },
    },
    {
      name: 'mini_cg_callers',
      description: 'Find who calls a symbol (includes cross-service callers)',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to find callers for' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
          offset: { type: 'number', description: 'Number of results to skip (default: 0)' },
        },
        required: ['symbol'],
      },
      handler: async (args, graph) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const { limit: rawLimit, offset: rawOffset } = args
        if (!symbol) return { symbol, callers: [], total: 0, truncated: false }
        const results = graph.search(symbol, 5)

        const allCallers = graph.getCallersWithExternal(results[0].node.id)
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const safeOffset = Math.max(0, rawOffset ?? 0)
        const items = allCallers.slice(safeOffset, safeOffset + safeLimit)
        return {
          symbol,
          callers: items.map(c => ({
            id: c.node.id, name: c.node.name, kind: c.node.kind,
            filePath: c.node.filePath, lines: `${c.node.startLine}-${c.node.endLine}`,
            provenance: c.provenance,
          })),
          total: allCallers.length, truncated: allCallers.length > safeOffset + safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_callees',
      description: 'Find what a symbol calls (includes cross-service callees)',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to find callees for' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
          offset: { type: 'number', description: 'Number of results to skip (default: 0)' },
        },
        required: ['symbol'],
      },
      handler: async (args, graph) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const { limit: rawLimit, offset: rawOffset } = args
        if (!symbol) return { symbol, callees: [], total: 0, truncated: false }
        const results = graph.search(symbol, 5)

        const allCallees = graph.getCalleesWithExternal(results[0].node.id)
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const safeOffset = Math.max(0, rawOffset ?? 0)
        const items = allCallees.slice(safeOffset, safeOffset + safeLimit)
        return {
          symbol,
          callees: items.map(c => ({
            id: c.node.id, name: c.node.name, kind: c.node.kind,
            filePath: c.node.filePath, lines: `${c.node.startLine}-${c.node.endLine}`,
            provenance: c.provenance,
          })),
          total: allCallees.length, truncated: allCallees.length > safeOffset + safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_node',
      description: 'Get symbol details with optional source code',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to look up' },
          includeCode: { type: 'boolean', description: 'Include source code (default: false)' },
        },
        required: ['symbol'],
      },
      handler: async (args, graph) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const includeCode = args.includeCode === true
        if (!symbol) return { error: 'Symbol not found' }
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { error: 'Symbol not found' }

        const node = results[0].node
        return {
          id: node.id, name: node.name, kind: node.kind,
          qualifiedName: node.qualifiedName, filePath: node.filePath,
          lines: `${node.startLine}-${node.endLine}`,
          signature: node.signature, docstring: node.docstring,
          code: includeCode ? (results[0].snippets.join('\n').slice(0, 2000)) : undefined,
        }
      },
    },
    {
      name: 'mini_cg_impact',
      description: 'Analyze blast radius of changing a symbol',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to analyze' },
          depth: { type: 'number', description: 'Dependency depth (default: 2, max: 5)' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
        },
        required: ['symbol'],
      },
      handler: async (args, graph) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const rawDepth = typeof args.depth === 'number' ? args.depth : 2
        const { limit: rawLimit } = args
        if (!symbol) return { error: 'Symbol not found' }
        const depth = Math.min(rawDepth, 5)
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { error: 'Symbol not found' }

        const allImpacted = graph.getImpact(results[0].node.id, depth)
        const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
        const items = allImpacted.slice(0, safeLimit)
        return {
          symbol, depth,
          impacted: items.map(n => ({
            id: n.id, name: n.name, kind: n.kind,
            filePath: n.filePath, lines: `${n.startLine}-${n.endLine}`,
          })),
          total: allImpacted.length, truncated: allImpacted.length > safeLimit,
        }
      },
    },
    {
      name: 'mini_cg_backtrace',
      description: 'Backtrack any node to nearest entry point',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Node ID or symbol name to trace from' },
          depth: { type: 'number', description: 'Max backtrack depth (default: 15)' },
          maxPaths: { type: 'number', description: 'Max entry-point paths (default: 10)' },
        },
        required: ['symbol'],
      },
      handler: async (args, graph) => {
        const { symbol, depth = 15, maxPaths = 10 } = args
        const qm = graph.getQueries()
        let node = qm.getNode(symbol)
        if (!node) {
          const results = qm.searchNodes(symbol, 10)
          if (results.length > 0) node = results[0]
        }
        if (!node) return { error: `Node not found: ${symbol}`, foundEntry: false, paths: [] }
        const result = graph.getBacktrace(node.id, depth, maxPaths)
        return {
          foundEntry: result.foundEntry,
          rootNodeId: result.rootNodeId,
          rootNodeName: result.rootNodeName,
          totalPaths: result.paths.length,
          paths: result.paths.map((p) => ({
            entryPointKind: p.entryPointKind,
            entryPointPath: p.entryPointPath,
            hops: p.hops.map((h) => ({
              id: h.id, name: h.name, kind: h.kind, filePath: h.filePath, detail: h.detail,
            })),
          })),
        }
      },
    },
  ]
}
