import type { ToolDefinition } from '../tools.js'

export function createImpactHandler(): ToolDefinition {
  return {
    name: 'mini_cg_impact',
    description: 'Analyze what code is affected by changing a symbol. Returns callers and transitive dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Name of the symbol to analyze' },
        depth: { type: 'number', description: 'How many levels to traverse (default: 2, max: 5)' },
        limit: { type: 'number', description: 'Maximum results (default: 50, max: 500)' },
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
      return {
        symbol, depth,
        impacted: allImpacted.slice(0, safeLimit).map(n => ({
          id: n.id, name: n.name, kind: n.kind,
          filePath: n.filePath, lines: `${n.startLine}-${n.endLine}`,
        })),
        total: allImpacted.length, truncated: allImpacted.length > safeLimit,
      }
    },
  }
}
