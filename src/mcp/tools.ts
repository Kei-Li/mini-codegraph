import type { GraphQueryManager } from '../graph/queries.js'
import type { JSONRPCRequest, JSONRPCResponse } from './server.js'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, any>
  handler: (args: Record<string, any>, graph: GraphQueryManager) => Promise<any>
}

export function createTools(graph: GraphQueryManager): ToolDefinition[] {
  return [
    {
      name: 'codegraph_search',
      description: 'Search for symbols by name across the codebase. Returns matching nodes with their locations and snippets.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or partial name to search for' },
          kind: { type: 'string', description: 'Filter by node kind (function, method, class, interface, etc.)' },
          limit: { type: 'number', description: 'Maximum results (default: 10)' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const { query, kind, limit = 10 } = args
        const results = graph.search(query, limit)
        if (kind) {
          const { filterNodesByKind } = await import('../search/index.js')
          return {
            results: filterNodesByKind(
              results.map(r => r.node),
              kind
            ).map(n => ({
              id: n.id,
              name: n.name,
              kind: n.kind,
              qualifiedName: n.qualifiedName,
              filePath: n.filePath,
              lines: `${n.startLine}-${n.endLine}`,
            })),
          }
        }
        return {
          results: results.map(r => ({
            id: r.node.id,
            name: r.node.name,
            kind: r.node.kind,
            qualifiedName: r.node.qualifiedName,
            filePath: r.node.filePath,
            lines: `${r.node.startLine}-${r.node.endLine}`,
            snippet: r.snippets.slice(0, 5).join('\n'),
          })),
        }
      },
    },
    {
      name: 'codegraph_context',
      description: 'Build comprehensive context for a task — searches for relevant symbols, retrieves their definitions and relationships. Returns code snippets, callers, callees, and file locations.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Description of the task, bug, or feature to build context for' },
          maxNodes: { type: 'number', description: 'Maximum symbols to include (default: 10)' },
          includeCode: { type: 'boolean', description: 'Include code snippets (default: true)' },
        },
        required: ['task'],
      },
      handler: async (args) => {
        const { task, maxNodes = 10 } = args

        // Search for relevant symbols
        const searchTerms = task.split(/\s+/).filter((t: string) => t.length > 2)
        const allResults: any[] = []

        for (const term of searchTerms.slice(0, 5)) {
          const results = graph.search(term, maxNodes)
          for (const r of results) {
            if (allResults.length >= maxNodes) break

            const existingIds = new Set(allResults.map(x => x.id))
            if (!existingIds.has(r.node.id)) {
              const ctx = graph.getContext(r.node.id)
              allResults.push({
                id: r.node.id,
                name: r.node.name,
                kind: r.node.kind,
                qualifiedName: r.node.qualifiedName,
                filePath: r.node.filePath,
                lines: `${r.node.startLine}-${r.node.endLine}`,
                signature: r.node.signature,
                docstring: r.node.docstring,
                callers: ctx.callers.map(c => ({ name: c.name, filePath: c.filePath, lines: `${c.startLine}-${c.endLine}` })),
                callees: ctx.callees.map(c => ({ name: c.name, kind: c.kind, filePath: c.filePath })),
                code: r.snippets.join('\n'),
              })
            }
          }
          if (allResults.length >= maxNodes) break
        }

        return { task, symbols: allResults }
      },
    },
    {
      name: 'codegraph_trace',
      description: 'Find the call path between two symbols — how does <from> reach <to>?',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Starting symbol name' },
          to: { type: 'string', description: 'Target symbol name' },
        },
        required: ['from', 'to'],
      },
      handler: async (args) => {
        const { from, to } = args

        // Search for the nodes
        const fromResults = graph.search(from, 5)
        const toResults = graph.search(to, 5)

        if (fromResults.length === 0 || toResults.length === 0) {
          return { error: 'Could not find one or both symbols', from: fromResults.length, to: toResults.length }
        }

        const fromNode = fromResults[0].node
        const toNode = toResults[0].node

        const paths = graph.findPath(fromNode.id, toNode.id)

        return {
          from: { name: fromNode.name, filePath: fromNode.filePath },
          to: { name: toNode.name, filePath: toNode.filePath },
          paths: paths.map(path => path.map(n => ({
            name: n.node.name,
            kind: n.node.kind,
            filePath: n.node.filePath,
            lines: `${n.node.startLine}-${n.node.endLine}`,
          }))),
        }
      },
    },
    {
      name: 'codegraph_callers',
      description: 'Find all functions/methods that call a specific symbol.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the function, method, or symbol' },
          limit: { type: 'number', description: 'Maximum results (default: 20)' },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const { symbol, limit = 20 } = args
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { callers: [] }

        const callers = graph.getCallers(results[0].node.id).slice(0, limit)
        return {
          callers: callers.map(c => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            filePath: c.filePath,
            lines: `${c.startLine}-${c.endLine}`,
          })),
        }
      },
    },
    {
      name: 'codegraph_callees',
      description: 'Find all functions/methods that a specific symbol calls.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the function, method, or symbol' },
          limit: { type: 'number', description: 'Maximum results (default: 20)' },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const { symbol, limit = 20 } = args
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { callees: [] }

        const callees = graph.getCallees(results[0].node.id).slice(0, limit)
        return {
          callees: callees.map(c => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            filePath: c.filePath,
            lines: `${c.startLine}-${c.endLine}`,
          })),
        }
      },
    },
    {
      name: 'codegraph_node',
      description: 'Get detailed information about a specific symbol, including its source code.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the symbol' },
          includeCode: { type: 'boolean', description: 'Include full source code (default: false)' },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const { symbol, includeCode = false } = args
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { error: 'Symbol not found' }

        const node = results[0].node
        return {
          id: node.id,
          name: node.name,
          kind: node.kind,
          qualifiedName: node.qualifiedName,
          filePath: node.filePath,
          lines: `${node.startLine}-${node.endLine}`,
          signature: node.signature,
          docstring: node.docstring,
          code: includeCode ? results[0].snippets.join('\n') : undefined,
        }
      },
    },
    {
      name: 'codegraph_impact',
      description: 'Analyze what code is affected by changing a symbol. Returns callers and transitive dependencies.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Name of the symbol to analyze' },
          depth: { type: 'number', description: 'How many levels of dependencies to traverse (default: 2)' },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const { symbol, depth = 2 } = args
        const results = graph.search(symbol, 5)
        if (results.length === 0) return { error: 'Symbol not found' }

        const impacted = graph.getImpact(results[0].node.id, depth)
        return {
          impacted: impacted.map(n => ({
            id: n.id,
            name: n.name,
            kind: n.kind,
            filePath: n.filePath,
            lines: `${n.startLine}-${n.endLine}`,
          })),
        }
      },
    },
    {
      name: 'codegraph_files',
      description: 'List all indexed files in the project, optionally filtered by glob pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Optional glob pattern to filter files (e.g. "src/**/*.ts")' },
          includeMetadata: { type: 'boolean', description: 'Include node count per file (default: false)' },
        },
      },
      handler: async (args) => {
        const { pattern, includeMetadata = false } = args
        const files = graph.getFileListing(pattern)
        return {
          files: includeMetadata ? files : files.map(f => ({ path: f.path, language: f.language })),
        }
      },
    },
    {
      name: 'codegraph_status',
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
      name: 'codegraph_explore',
      description: 'Return source for several related symbols grouped by file, plus a relationship map, in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of symbol names to explore (e.g. ["UserService", "login"])',
          },
        },
        required: ['symbols'],
      },
      handler: async (args) => {
        const symbols: string[] = args.symbols ?? []
        if (symbols.length === 0) return { files: [] }

        const nodeIds: string[] = []
        for (const name of symbols) {
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
            relationships: info.relationships,
          })
        }

        return {
          files: Array.from(files.entries()).map(([fp, nodes]) => ({ filePath: fp, nodes })),
        }
      },
    },
    {
      name: 'codegraph_architecture',
      description: 'Show the microservice architecture: modules, their dependencies (FeignClient calls), and entry points (REST endpoints).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const arch = graph.findMicroserviceArchitecture()
        return {
          modules: arch.modules,
          dependencies: arch.dependencies.map(d => `${d.from} → ${d.to}`),
          entryPoints: arch.entryPoints.map(ep => ({
            module: ep.module,
            endpoints: ep.endpoints,
          })),
        }
      },
    },
    {
      name: 'codegraph_feign',
      description: 'List all FeignClient interfaces and their microservice targets.',
      inputSchema: {
        type: 'object',
        properties: {
          includeMethods: { type: 'boolean', description: 'Include Feign method details (default: true)' },
        },
      },
      handler: async (args) => {
        const { includeMethods = true } = args
        const clients = graph.getFeignClients()
        return {
          clients: clients.map(c => ({
            name: c.feignClient.name,
            filePath: c.feignClient.filePath,
            annotations: c.annotations.map(a => `${a.annotationName}(${a.value})`),
            methods: includeMethods ? c.feignMethods.map(m => ({
              name: m.name,
              signature: m.signature,
              line: m.startLine,
            })) : undefined,
          })),
        }
      },
    },
    {
      name: 'codegraph_mybatis',
      description: 'List MyBatis mapper XML bindings — maps Java interface methods to SQL statements.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const mappings = graph.getMyBatisMappings()
        return {
          mappings: mappings.map(m => ({
            javaInterface: m.javaInterface,
            method: m.methodName,
            xmlFile: m.xmlPath,
            sqlId: m.sqlId,
          })),
        }
      },
    },
    {
      name: 'codegraph_modules',
      description: 'List all indexed modules (microservices) in the project.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const stats = graph.getStats()
        const modules = []
        if ('modules' in stats && typeof stats.modules === 'number') {
          modules.push({ totalModules: stats.modules })
        }
        return { modules }
      },
    },
  ]
}
