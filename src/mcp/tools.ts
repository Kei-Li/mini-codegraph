import { readFileSync } from 'node:fs'
import type { GraphQueryManager } from '../graph/queries.js'
import type { JSONRPCRequest, JSONRPCResponse } from './server.js'
import { createWorkspaceStatusHandler } from './handlers/workspace-status.js'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, any>
  handler: (args: Record<string, any>, graph: GraphQueryManager) => Promise<any>
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

function paginate<T>(items: T[], limit: number = DEFAULT_LIMIT, offset: number = 0): { items: T[]; total: number; truncated: boolean } {
  const safeLimit = Math.min(Math.max(1, limit), MAX_LIMIT)
  const safeOffset = Math.max(0, offset)
  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    total: items.length,
    truncated: items.length > safeOffset + safeLimit,
  }
}

const DESCR_WITH_LIMIT = ' (default: 50, max: 500)'
const DESCR_WITH_OFFSET = 'Number of results to skip (default: 0)'

export function createTools(
  graph: GraphQueryManager,
  getPendingFiles?: () => { path: string; firstSeenMs: number; lastSeenMs: number; indexing: boolean }[]
): ToolDefinition[] {
  return [
    {
      name: 'mini_cg_search',
      description: `Search for symbols by name across the codebase. Returns matching nodes with their locations and snippets.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or partial name to search for' },
          kind: { type: 'string', description: 'Filter by node kind (function, method, class, interface, etc.)' },
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
          offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const rawQuery = typeof args.query === 'string' ? args.query.slice(0, 500) : ''
        const { kind, limit: rawLimit, offset = 0 } = args
        const query = rawQuery
        const limit = rawLimit ?? 20
        if (!query) return { query, results: [], total: 0, truncated: false, offset }
        const all = graph.search(query, 1000)
        const filtered = kind
          ? all.filter(r => r.node.kind === kind || kind.split(',').includes(r.node.kind))
          : all
        const p = paginate(filtered.slice(offset), limit)
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
    },
    {
      name: 'mini_cg_context',
      description: 'Build comprehensive context for a task — searches for relevant symbols, retrieves their definitions and relationships. Returns code snippets, callers, callees, and file locations.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Description of the task, bug, or feature to build context for' },
          maxNodes: { type: 'number', description: 'Maximum symbols to include (default: 10, max: 30)' },
          includeCode: { type: 'boolean', description: 'Include code snippets (default: true)' },
        },
        required: ['task'],
      },
      handler: async (args) => {
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
      name: 'mini_cg_trace',
      description: 'Find the call path between two symbols — how does <from> reach <to>?',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Starting symbol name' },
          to: { type: 'string', description: 'Target symbol name' },
          maxPaths: { type: 'number', description: 'Maximum number of paths to return (default: 5, max: 20)' },
        },
        required: ['from', 'to'],
      },
      handler: async (args) => {
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

        const allPaths = graph.findPath(fromNode.id, toNode.id)

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

        const p = paginate(allPaths, maxPaths)

        return {
          from: { name: fromNode.name, filePath: fromNode.filePath },
          to: { name: toNode.name, filePath: toNode.filePath },
          paths: p.items.map(path => path.map(n => ({
            name: n.node.name, kind: n.node.kind,
            filePath: n.node.filePath, lines: `${n.node.startLine}-${n.node.endLine}`,
          }))),
          totalPaths: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_callers',
      description: 'Find all functions/methods that call a specific symbol. Supports pagination via offset for large result sets.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the function, method, or symbol' },
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
          offset: { type: 'number', description: DESCR_WITH_OFFSET },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const { limit: rawLimit, offset: rawOffset } = args
        if (!symbol) return { symbol, callers: [], total: 0, truncated: false }
        const results = graph.search(symbol, 5)

        const allCallers = graph.getCallers(results[0].node.id)
        const p = paginate(allCallers, rawLimit, rawOffset)
        return {
          symbol,
          callers: p.items.map(c => ({
            id: c.id, name: c.name, kind: c.kind,
            filePath: c.filePath, lines: `${c.startLine}-${c.endLine}`,
          })),
          total: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_callees',
      description: 'Find all functions/methods that a specific symbol calls. Supports pagination via offset for large result sets.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the function, method, or symbol' },
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
          offset: { type: 'number', description: DESCR_WITH_OFFSET },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const { limit: rawLimit, offset: rawOffset } = args
        if (!symbol) return { symbol, callees: [], total: 0, truncated: false }
        const results = graph.search(symbol, 5)

        const allCallees = graph.getCallees(results[0].node.id)
        const p = paginate(allCallees, rawLimit, rawOffset)
        return {
          symbol,
          callees: p.items.map(c => ({
            id: c.id, name: c.name, kind: c.kind,
            filePath: c.filePath, lines: `${c.startLine}-${c.endLine}`,
          })),
          total: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_node',
      description: 'Get detailed information about a specific symbol, including its source code.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the symbol' },
          includeCode: { type: 'boolean', description: 'Include source code snippet (default: false, max 2000 chars)' },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
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
      description: 'Analyze what code is affected by changing a symbol. Returns callers and transitive dependencies.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the symbol to analyze' },
          depth: { type: 'number', description: 'How many levels of dependencies to traverse (default: 2, max: 5)' },
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const symbol = typeof args.symbol === 'string' ? args.symbol.slice(0, 200) : ''
        const rawDepth = typeof args.depth === 'number' ? args.depth : 2
        const { limit: rawLimit } = args
        if (!symbol) return { error: 'Symbol not found' }
        const depth = Math.min(rawDepth, 5)
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { error: 'Symbol not found' }

        const allImpacted = graph.getImpact(results[0].node.id, depth)
        const p = paginate(allImpacted, rawLimit)
        return {
          symbol, depth,
          impacted: p.items.map(n => ({
            id: n.id, name: n.name, kind: n.kind,
            filePath: n.filePath, lines: `${n.startLine}-${n.endLine}`,
          })),
          total: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_files',
      description: 'List indexed files, optionally filtered by glob pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Optional glob pattern (e.g. "src/**/*.ts")' },
          includeMetadata: { type: 'boolean', description: 'Include node count per file (default: false)' },
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const pattern = typeof args.pattern === 'string' ? args.pattern.slice(0, 200) : undefined
        const includeMetadata = args.includeMetadata === true
        const { limit: rawLimit } = args
        const p = paginate(graph.getFileListing(pattern, rawLimit), rawLimit)
        return {
          files: includeMetadata ? p.items : p.items.map(f => ({ path: f.path, language: f.language })),
          total: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_status',
      description: 'Show index health and statistics: number of files, nodes, and edges.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        return { stats: graph.getStats() }
      },
    },
    {
      name: 'mini_cg_explore',
      description: 'Return source for several related symbols grouped by file, plus a relationship map, in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of symbol names to explore (e.g. ["UserService", "login"])',
          },
          maxPerSymbol: { type: 'number', description: 'Max related symbols per query (default: 10, max: 30)' },
        },
        required: ['symbols'],
      },
      handler: async (args) => {
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
            name: info.node.name,
            kind: info.node.kind,
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
    },
    {
      name: 'mini_cg_architecture',
      description: 'Show the microservice architecture: modules, their dependencies (FeignClient calls), and entry points (REST endpoints).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const arch = graph.findMicroserviceArchitecture()
        return {
          modules: arch.modules.slice(0, 50),
          dependencies: arch.dependencies.slice(0, 100).map(d => `${d.from} → ${d.to}`),
          entryPoints: arch.entryPoints.slice(0, 50).map(ep => ({
            module: ep.module,
            endpoints: ep.endpoints,
          })),
          totalModules: arch.modules.length,
          totalDependencies: arch.dependencies.length,
          truncated: arch.modules.length > 50 || arch.dependencies.length > 100,
        }
      },
    },
    {
      name: 'mini_cg_feign',
      description: 'List all FeignClient interfaces and their microservice targets.',
      inputSchema: {
        type: 'object',
        properties: {
          includeMethods: { type: 'boolean', description: 'Include Feign method details (default: true)' },
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const { includeMethods = true, limit: rawLimit } = args
        const p = paginate(graph.getFeignClients(rawLimit), rawLimit)
        return {
          clients: p.items.map(c => ({
            name: c.feignClient.name, filePath: c.feignClient.filePath,
            annotations: c.annotations.map(a => `${a.annotationName}(${a.value})`),
            methods: includeMethods ? c.feignMethods.map(m => ({
              name: m.name, signature: m.signature, line: m.startLine,
            })) : undefined,
          })),
          total: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_mybatis',
      description: 'List MyBatis mapper XML bindings — maps Java interface methods to SQL statements.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const { limit: rawLimit } = args
        const p = paginate(graph.getMyBatisMappings(rawLimit), rawLimit)
        return {
          mappings: p.items.map(m => ({
            javaInterface: m.javaInterface, method: m.methodName,
            xmlFile: m.xmlPath, sqlId: m.sqlId,
          })),
          total: p.total, truncated: p.truncated,
        }
      },
    },
    {
      name: 'mini_cg_modules',
      description: 'List all indexed modules (microservices) in the project.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const stats = graph.getStats()
        return { modules: stats.modules ?? 0, files: stats.files ?? 0, nodes: stats.nodes ?? 0, edges: stats.edges ?? 0 }
      },
    },
    {
      name: 'mini_cg_react',
      description: 'List React components, hooks, stores (Redux/Zustand), and data queries (React Query).',
      inputSchema: {
        type: 'object',
        properties: {
          detail: { type: 'boolean', description: 'Include hooks, props, and children (default: false)' },
          limit: { type: 'number', description: `Max components${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const { detail = false, limit: rawLimit } = args
        const p = paginate(graph.getReactComponents(rawLimit), rawLimit)
        const ps = paginate(graph.getReactStores(rawLimit), rawLimit)
        const pq = paginate(graph.getReactQueries(rawLimit), rawLimit)
        return {
          components: detail ? p.items : p.items.map(c => ({ componentName: c.componentName, filePath: c.filePath, hookCount: c.hooks.length })),
          stores: ps.items,
          queries: pq.items,
          total: p.total, totalStores: ps.total, totalQueries: pq.total,
          truncated: p.truncated || ps.truncated || pq.truncated,
        }
      },
    },
    {
      name: 'mini_cg_mongo',
      description: 'List MongoDB entities — @Document collections, repositories, and MongoTemplate usage.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const { limit: rawLimit } = args
        const p = paginate(graph.getMongoEntities(rawLimit), rawLimit)
        return { mongoEntities: p.items, total: p.total, truncated: p.truncated }
      },
    },
    {
      name: 'mini_cg_redis',
      description: 'List Redis @RedisHash entities, repositories, and RedisTemplate/Redisson operations.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const { limit: rawLimit } = args
        const ph = paginate(graph.getRedisHashes(rawLimit), rawLimit)
        const pt = paginate(graph.getRedisTemplates(rawLimit), rawLimit)
        return {
          redisHashes: ph.items, redisHashesTotal: ph.total,
          redisTemplates: pt.items, redisTemplatesTotal: pt.total,
          truncated: ph.truncated || pt.truncated,
        }
      },
    },
    {
      name: 'mini_cg_sql',
      description: 'List SQL tables and statements — DDL from SQL files, MyBatis @Select/@Insert/@Update/@Delete, JPA @Query, JDBC strings.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `Maximum results${DESCR_WITH_LIMIT}` },
        },
      },
      handler: async (args) => {
        const { limit: rawLimit } = args
        const pt = paginate(graph.getSqlTables(rawLimit), rawLimit)
        const ps = paginate(graph.getSqlStatements(rawLimit), rawLimit)
        return {
          tables: pt.items, tablesTotal: pt.total,
          sqlStatements: ps.items, sqlStatementsTotal: ps.total,
          truncated: pt.truncated || ps.truncated,
        }
      },
    },
    createWorkspaceStatusHandler(),
  ]
}

