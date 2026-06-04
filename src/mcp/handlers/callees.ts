import type { ToolDefinition } from '../tools.js'

export function createCalleesHandler(): ToolDefinition {
  return {
    name: 'mini_cg_callees',
    description: 'Find all functions/methods that a specific symbol calls.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Name of the function, method, or symbol' },
        limit: { type: 'number', description: 'Maximum results (default: 50, max: 500)' },
        offset: { type: 'number', description: 'Number of results to skip (default: 0)' },
      },
      required: ['symbol'],
    },
    handler: async (args, graph) => {
      const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
      const { limit: rawLimit, offset = 0 } = args
      if (!symbol) return { symbol, callees: [], total: 0, truncated: false }
      const results = graph.search(symbol, 5)
      if (results.length === 0) return { symbol, callees: [], total: 0, truncated: false }

      const allCallees = graph.getCalleesWithExternal(results[0].node.id)
      const safeLimit = Math.min(Math.max(1, rawLimit ?? 50), 500)
      const p = {
        items: allCallees.slice(offset, offset + safeLimit),
        total: allCallees.length,
        truncated: allCallees.length > offset + safeLimit,
      }
      return {
        symbol,
        callees: p.items.map(c => ({
          id: c.node.id, name: c.node.name, kind: c.node.kind,
          filePath: c.node.filePath, lines: `${c.node.startLine}-${c.node.endLine}`,
          provenance: c.provenance,
        })),
        total: p.total, truncated: p.truncated,
      }
    },
  }
}
