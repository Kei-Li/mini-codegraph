import type { ToolDefinition } from '../tools.js'

export function createNodeHandler(): ToolDefinition {
  return {
    name: 'mini_cg_node',
    description: 'Get detailed information about a specific symbol, including its source code.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Name of the symbol' },
        includeCode: { type: 'boolean', description: 'Include source code snippet (default: false)' },
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
  }
}
