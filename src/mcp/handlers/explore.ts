import type { ToolDefinition } from '../tools.js'

export function createExploreHandler(): ToolDefinition {
  return {
    name: 'mini_cg_explore',
    description: 'Return source for related symbols grouped by file, plus a relationship map.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array', items: { type: 'string' },
          description: 'Symbol names to explore (e.g. ["UserService", "login"])',
        },
        maxPerSymbol: { type: 'number', description: 'Max related symbols per query (default: 10, max: 30)' },
      },
      required: ['symbols'],
    },
    handler: async (args, graph) => {
      const rawSymbols = args.symbols
      const symbols: string[] = Array.isArray(rawSymbols)
        ? rawSymbols.map(s => String(s).slice(0, 200)).filter(Boolean)
        : typeof rawSymbols === 'string' ? [rawSymbols.slice(0, 200)] : []
      const maxPerSymbol = Math.min(typeof args.maxPerSymbol === 'number' ? args.maxPerSymbol : 10, 30)
      if (symbols.length === 0) return 'No symbols provided.'

      const nodeIds: string[] = []
      for (const name of symbols) {
        const results = graph.search(name, 3)
        for (const r of results) {
          if (!nodeIds.includes(r.node.id)) nodeIds.push(r.node.id)
        }
      }

      const related = graph.findRelated(nodeIds.slice(0, maxPerSymbol))
      const fileSections: string[] = []
      let totalRelationships = 0
      const fileMap = new Map<string, { name: string; kind: string; lines: string; relationships: string[] }[]>()
      for (const [, info] of related) {
        const fp = info.node.filePath
        if (!fileMap.has(fp)) fileMap.set(fp, [])
        const rels = info.relationships.slice(0, 10)
        totalRelationships += rels.length
        fileMap.get(fp)!.push({
          name: info.node.name, kind: info.node.kind,
          lines: `${info.node.startLine}-${info.node.endLine}`,
          relationships: rels,
        })
      }

      for (const [fp, nodes] of fileMap) {
        const symbolSections = nodes.map(n => {
          const s = [`### ${n.name} (${n.kind}, lines ${n.lines})`]
          if (n.relationships.length > 0) {
            s.push('**Relationships**:')
            s.push(...n.relationships.map(r => `- ${r}`))
          }
          return s.join('\n')
        })
        fileSections.push(`## ${fp}\n\n${symbolSections.join('\n\n')}`)
      }

      const header = `# Explore: ${symbols.join(', ')}\n\n*${fileMap.size} files, ${nodeIds.length} symbols, ${totalRelationships} relationships.*\n\n`
      if (fileSections.length === 0) return `${header}No related symbols found.`
      return header + fileSections.join('\n\n---\n\n')
    },
  }
}
