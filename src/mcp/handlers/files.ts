import type { ToolDefinition } from '../tools.js'

export function createFilesHandler(): ToolDefinition {
  return {
    name: 'mini_cg_files',
    description: 'List indexed files, optionally filtered by glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional glob pattern (e.g. "src/**/*.ts")' },
        includeMetadata: { type: 'boolean', description: 'Include node count per file (default: false)' },
        limit: { type: 'number', description: 'Maximum results (default: 50, max: 500)' },
      },
    },
    handler: async (args, graph) => {
      const pattern = typeof args.pattern === 'string' ? args.pattern.slice(0, 200) : undefined
      const includeMetadata = args.includeMetadata === true
      const rawLimit = args.limit ?? 50
      const safeLimit = Math.min(Math.max(1, rawLimit), 500)
      const files = graph.getFileListing(pattern, safeLimit)
      return {
        files: includeMetadata ? files : files.map(f => ({ path: f.path, language: f.language })),
        total: files.length, truncated: files.length > safeLimit,
      }
    },
  }
}
