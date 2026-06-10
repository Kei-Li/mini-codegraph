import type { ToolDefinition } from './shared.js'

export function createSearchTools(): ToolDefinition[] {
  return [
    {
      name: 'mini_cg_search',
      description: 'Search symbols by name across the codebase',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name to search' },
          kind: { type: 'string', description: 'Filter by node kind' },
          limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
          offset: { type: 'number', description: 'Number of results to skip (default: 0)' },
        },
        required: ['query'],
      },
      handler: async (args, graph) => {
        const rawQuery = typeof args.query === 'string' ? args.query.slice(0, 500) : ''
        const { kind, limit: rawLimit, offset = 0 } = args
        const query = rawQuery
        const limit = rawLimit ?? 20
        if (!query) return { query, results: [], total: 0, truncated: false, offset }
        const all = graph.search(query, 1000)
        const filtered = kind
          ? all.filter(r => r.node.kind === kind || kind.split(',').includes(r.node.kind))
          : all
        const safeLimit = Math.min(Math.max(1, limit), 500)
        const safeOffset = Math.max(0, offset)
        const items = filtered.slice(safeOffset, safeOffset + safeLimit)
        return {
          query,
          results: items.map(r => ({
            id: r.node.id, name: r.node.name, kind: r.node.kind,
            qualifiedName: r.node.qualifiedName, filePath: r.node.filePath,
            lines: `${r.node.startLine}-${r.node.endLine}`,
            snippet: r.snippets.slice(0, 5).join('\n'),
          })),
          total: filtered.length, truncated: filtered.length > safeOffset + safeLimit, offset,
        }
      },
    },
    {
      name: 'mini_cg_context',
      description: 'Build task context: search + callers + callees + code snippets',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description to build context for' },
          maxNodes: { type: 'number', description: 'Max symbols to include (default: 10, max: 30)' },
          includeCode: { type: 'boolean', description: 'Include code snippets (default: true)' },
        },
        required: ['task'],
      },
      handler: async (args, graph) => {
        const task = typeof args.task === 'string' ? args.task.slice(0, 2000) : ''
        const rawMax = typeof args.maxNodes === 'number' ? args.maxNodes : 10
        const includeCode = args.includeCode !== false
        const maxNodes = Math.min(rawMax, 30)
        if (!task) return '# Context: (empty task)\n\nNo task provided.'
        const searchTerms = task.split(/\s+/).filter((t: string) => t.length > 2)
        const sections: string[] = []
        const seenIds = new Set<string>()

        for (const term of searchTerms.slice(0, 5)) {
          if (sections.length >= maxNodes) break
          const results = graph.search(term, maxNodes)
          for (const r of results) {
            if (sections.length >= maxNodes) break
            if (seenIds.has(r.node.id)) continue
            seenIds.add(r.node.id)

            const MAX_PER_SYMBOL = 30
            const ctx = graph.getContext(r.node.id)
            const lines = [`## ${r.node.name} (${r.node.filePath}:${r.node.startLine}-${r.node.endLine})`]

            if (r.node.qualifiedName && r.node.qualifiedName !== r.node.name) {
              lines.push(`**Qualified**: \`${r.node.qualifiedName}\``)
            }
            if (r.node.kind) lines.push(`**Kind**: ${r.node.kind}`)
            if (r.node.signature) lines.push(`**Signature**: \`${r.node.signature}\``)
            if (r.node.docstring) lines.push(`**Docstring**: ${r.node.docstring}`)

            const callerLines = ctx.callers.slice(0, MAX_PER_SYMBOL).map(c => `- ${c.name} (${c.filePath}:${c.startLine}-${c.endLine})`)
            if (callerLines.length > 0) {
              const total = ctx.callers.length
              lines.push(`**Callers** (${total} total${total > MAX_PER_SYMBOL ? `, showing ${MAX_PER_SYMBOL}` : ''}):`)
              lines.push(...callerLines)
            }

            const calleeLines = ctx.callees.slice(0, MAX_PER_SYMBOL).map(c => `- ${c.name} (${c.kind}, ${c.filePath})`)
            if (calleeLines.length > 0) {
              const total = ctx.callees.length
              lines.push(`**Callees** (${total} total${total > MAX_PER_SYMBOL ? `, showing ${MAX_PER_SYMBOL}` : ''}):`)
              lines.push(...calleeLines)
            }

            if (includeCode && r.snippets.length > 0) {
              const code = r.snippets.join('\n').slice(0, 2000)
              const lang = r.node.language || ''
              lines.push(`**Code**:\n\`\`\`${lang}\n${code}\n\`\`\``)
            }

            sections.push(lines.join('\n'))
          }
        }

        const header = `# Context: ${task}\n\n*Searched ${seenIds.size} symbols, ${sections.length} returned.*\n\n`
        if (sections.length === 0) return `${header}No relevant symbols found.`
        return header + sections.join('\n\n---\n\n')
      },
    },
    {
      name: 'mini_cg_explore',
      description: 'Explore workspace structure by project/module/layer. Use this when you need to understand the overall project layout before making changes.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Area or module to explore' },
        },
      },
      handler: async (args, graph) => {
        const query = typeof args.query === 'string' ? args.query.slice(0, 200) : ''
        if (!query) {
          const qm = graph.getQueries()
          const stats = qm.getStats()
          const modules = qm.getAllModules()
          return {
            query,
            stats,
            modules: modules.map(m => ({ id: m.id, name: m.name, language: m.language, buildSystem: m.buildSystem })),
            tip: 'Use a specific module name or area to explore deeper',
          }
        }
        const results = graph.search(query, 30)
        return {
          query,
          totalResults: results.length,
          results: results.map(r => ({
            name: r.node.name,
            kind: r.node.kind,
            filePath: r.node.filePath,
            lines: `${r.node.startLine}-${r.node.endLine}`,
            qualifiedName: r.node.qualifiedName,
          })),
        }
      },
    },
    {
      name: 'mini_cg_semantic_search',
      description: 'Semantic search across codebase using natural language queries. (Feature coming in future release)',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query' },
        },
        required: ['query'],
      },
      handler: async () => {
        return { supported: false, note: 'Use mini_cg_search with regex patterns instead' }
      },
    },
  ]
}
