import type { ToolDefinition } from '../tools.js'

export function createSearchHandler(): ToolDefinition {
  return {
    name: 'mini_cg_search',
    description: 'Search for symbols by name across the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or partial name' },
        kind: { type: 'string', description: 'Filter by node kind (function, class, etc.)' },
        limit: { type: 'number', description: 'Maximum results (default: 20, max: 500)' },
        offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
      },
      required: ['query'],
    },
    handler: async (args, graph) => {
      const query = typeof args.query === 'string' ? args.query.slice(0, 500) : ''
      const { kind, limit: rawLimit = 20, offset = 0 } = args
      if (!query) return { query, results: [], total: 0, truncated: false, offset }
      const all = graph.search(query, 1000)
      const filtered = kind ? all.filter(r => r.node.kind === kind) : all
      const p = paginate(filtered.slice(offset), rawLimit)
      return {
        query,
        results: p.items.map(r => ({
          id: r.node.id, name: r.node.name, kind: r.node.kind,
          qualifiedName: r.node.qualifiedName, filePath: r.node.filePath,
          lines: `${r.node.startLine}-${r.node.endLine}`,
          snippet: r.snippets.slice(0, 5).join('\n'),
        })),
        total: p.total, truncated: p.truncated, offset,
      }
    },
  }
}

function paginate<T>(items: T[], limit: number = 50): { items: T[]; total: number; truncated: boolean } {
  const safeLimit = Math.min(Math.max(1, limit as number), 500)
  return {
    items: items.slice(0, safeLimit),
    total: items.length,
    truncated: items.length > safeLimit,
  }
}
