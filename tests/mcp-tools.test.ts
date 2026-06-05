import { describe, it, expect, vi } from 'vitest'
import { createTools } from '../src/mcp/tools.js'
import type { GraphQueryManager } from '../src/graph/queries.js'

function createMockGraph(overrides: Partial<GraphQueryManager> = {}): GraphQueryManager {
  const mockQueries = {
    getAllNodes: vi.fn().mockReturnValue([]),
    getAllFiles: vi.fn().mockReturnValue([]),
    getAllModules: vi.fn().mockReturnValue([]),
    getAllEdges: vi.fn().mockReturnValue([]),
    getUnresolvedRefs: vi.fn().mockReturnValue([]),
    getAllExternalSymbols: vi.fn().mockReturnValue([]),
    getAllExternalReferences: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ files: 0, nodes: 0, edges: 0, modules: 0 }),
    getFilesByModule: vi.fn().mockReturnValue([]),
  }
  return {
    search: vi.fn().mockReturnValue([]),
    getCallers: vi.fn().mockReturnValue([]),
    getCallees: vi.fn().mockReturnValue([]),
    getCallersWithExternal: vi.fn().mockReturnValue([]),
    getCalleesWithExternal: vi.fn().mockReturnValue([]),
    getContext: vi.fn().mockReturnValue({ callers: [], callees: [] }),
    getImpact: vi.fn().mockReturnValue([]),
    findPath: vi.fn().mockReturnValue({ paths: [], truncated: false, exploredNodes: 0 }),
    findRelated: vi.fn().mockReturnValue(new Map()),
    findMicroserviceArchitecture: vi.fn().mockReturnValue({ modules: [], dependencies: [], entryPoints: [] }),
    getFeignClients: vi.fn().mockReturnValue([]),
    getMyBatisMappings: vi.fn().mockReturnValue([]),
    getFileListing: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ files: 0, nodes: 0, edges: 0, modules: 0 }),
    getReactComponents: vi.fn().mockReturnValue([]),
    getReactStores: vi.fn().mockReturnValue([]),
    getReactQueries: vi.fn().mockReturnValue([]),
    getMongoEntities: vi.fn().mockReturnValue([]),
    getRedisHashes: vi.fn().mockReturnValue([]),
    getRedisTemplates: vi.fn().mockReturnValue([]),
    getSqlTables: vi.fn().mockReturnValue([]),
    getSqlStatements: vi.fn().mockReturnValue([]),
    checkStaleFiles: vi.fn(),
    getNode: vi.fn(),
    getQueries: vi.fn().mockReturnValue(mockQueries),
    getQueryManager: vi.fn().mockReturnValue(mockQueries),
    getStalenessWarning: vi.fn().mockReturnValue(null),
    findAffectedTestFiles: vi.fn().mockReturnValue([]),
    getDispatchTargets: vi.fn().mockReturnValue([]),
    getDispatchChain: vi.fn().mockReturnValue([]),
    getActiveImplementations: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as GraphQueryManager
}

describe('MCP tools', () => {
  describe('tool registration', () => {
    it('creates all expected tools', () => {
      const graph = createMockGraph()
      const tools = createTools(graph)
      const names = tools.map(t => t.name)

      expect(names).toContain('mini_cg_search')
      expect(names).toContain('mini_cg_context')
      expect(names).toContain('mini_cg_trace')
      expect(names).toContain('mini_cg_callers')
      expect(names).toContain('mini_cg_callees')
      expect(names).toContain('mini_cg_node')
      expect(names).toContain('mini_cg_impact')
      expect(names).toContain('mini_cg_files')
      expect(names).toContain('mini_cg_status')
      expect(names).toContain('mini_cg_explore')
      expect(names).toContain('mini_cg_architecture')
      expect(names).toContain('mini_cg_feign')
      expect(names).toContain('mini_cg_mybatis')
      expect(names).toContain('mini_cg_module')
      expect(names).toContain('mini_cg_react')
      expect(names).toContain('mini_cg_mongo')
      expect(names).toContain('mini_cg_redis')
      expect(names).toContain('mini_cg_sql')
    })

    it('every tool has name, description, inputSchema, and handler', () => {
      const graph = createMockGraph()
      const tools = createTools(graph)

      for (const tool of tools) {
        expect(typeof tool.name).toBe('string')
        expect(tool.name).toMatch(/^mini_cg_/)
        expect(typeof tool.description).toBe('string')
        expect(tool.description.length).toBeGreaterThan(0)
        expect(typeof tool.inputSchema).toBe('object')
        expect(typeof tool.handler).toBe('function')
      }
    })
  })

  describe('mini_cg_search', () => {
    it('returns empty results when no query', async () => {
      const graph = createMockGraph()
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_search')!

      const result = await tool.handler({ query: '' }, graph)
      expect(result.results).toEqual([])
      expect(result.total).toBe(0)
    })

    it('filters by kind', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockReturnValue([
          { node: { id: '1', name: 'Foo', kind: 'class', qualifiedName: 'Foo', filePath: 'a.ts', startLine: 1, endLine: 10 }, snippets: [], score: 1 },
          { node: { id: '2', name: 'bar', kind: 'function', qualifiedName: 'bar', filePath: 'b.ts', startLine: 1, endLine: 5 }, snippets: [], score: 1 },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_search')!

      const result = await tool.handler({ query: 'Foo', kind: 'class', limit: 10, offset: 0 }, graph)
      expect(result.total).toBe(1)
      expect(result.results[0].kind).toBe('class')
    })

    it('paginates results', async () => {
      const items = Array.from({ length: 20 }, (_, i) => ({
        node: { id: String(i), name: `sym${i}`, kind: 'function', qualifiedName: `sym${i}`, filePath: 'a.ts', startLine: 1, endLine: 5 },
        snippets: [],
        score: 1,
      }))
      const graph = createMockGraph({ search: vi.fn().mockReturnValue(items) })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_search')!

      const result = await tool.handler({ query: 'sym', limit: 5, offset: 0 }, graph)
      expect(result.results.length).toBe(5)
      expect(result.total).toBe(20)
      expect(result.truncated).toBe(true)
    })
  })

  describe('mini_cg_status', () => {
    it('returns stats from graph', async () => {
      const graph = createMockGraph({
        getStats: vi.fn().mockReturnValue({ files: 42, nodes: 100, edges: 200, modules: 3 }),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_status')!

      const result = await tool.handler({}, graph)
      expect(result.stats.files).toBe(42)
      expect(result.stats.nodes).toBe(100)
      expect(result.stats.edges).toBe(200)
    })
  })

  describe('mini_cg_node', () => {
    it('returns error when symbol not found', async () => {
      const graph = createMockGraph({ search: vi.fn().mockReturnValue([]) })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_node')!

      const result = await tool.handler({ symbol: 'NonExistent' }, graph)
      expect(result.error).toBe('Symbol not found')
    })

    it('returns node details', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockReturnValue([{
          node: { id: '1', name: 'UserService', kind: 'class', qualifiedName: 'com.app.UserService', filePath: 'src/UserService.ts', startLine: 1, endLine: 50, signature: 'class UserService', docstring: 'Service for users' },
          snippets: [],
          score: 1,
        }]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_node')!

      const result = await tool.handler({ symbol: 'UserService', includeCode: false }, graph)
      expect(result.name).toBe('UserService')
      expect(result.kind).toBe('class')
      expect(result.qualifiedName).toBe('com.app.UserService')
    })
  })

  describe('mini_cg_callers', () => {
    it('returns empty when no symbol', async () => {
      const graph = createMockGraph()
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_callers')!

      const result = await tool.handler({ symbol: '' }, graph)
      expect(result.callers).toEqual([])
    })

    it('returns callers for symbol', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockReturnValue([{ node: { id: '1', name: 'foo', kind: 'function' }, snippets: [], score: 1 }]),
        getCallersWithExternal: vi.fn().mockReturnValue([
          { node: { id: '2', name: 'caller1', kind: 'function', filePath: 'a.ts', startLine: 10, endLine: 20 }, provenance: 'internal' },
          { node: { id: '3', name: 'caller2', kind: 'method', filePath: 'b.ts', startLine: 5, endLine: 15 }, provenance: 'internal' },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_callers')!

      const result = await tool.handler({ symbol: 'foo', limit: 10, offset: 0 }, graph)
      expect(result.callers).toHaveLength(2)
      expect(result.callers[0].name).toBe('caller1')
    })
  })

  describe('mini_cg_impact', () => {
    it('returns impacted nodes', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockReturnValue([{ node: { id: '1', name: 'foo', kind: 'function' }, snippets: [], score: 1 }]),
        getImpact: vi.fn().mockReturnValue([
          { id: '2', name: 'dep1', kind: 'function', filePath: 'a.ts', startLine: 1, endLine: 5 },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_impact')!

      const result = await tool.handler({ symbol: 'foo', depth: 2, limit: 10 }, graph)
      expect(result.impacted).toHaveLength(1)
      expect(result.depth).toBe(2)
    })
  })

  describe('mini_cg_files', () => {
    it('returns file listing', async () => {
      const graph = createMockGraph({
        getFileListing: vi.fn().mockReturnValue([
          { path: 'src/a.ts', language: 'typescript' },
          { path: 'src/b.ts', language: 'typescript' },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_files')!

      const result = await tool.handler({ pattern: 'src/**/*.ts', limit: 10 }, graph)
      expect(result.files).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('includes metadata when requested', async () => {
      const graph = createMockGraph({
        getFileListing: vi.fn().mockReturnValue([
          { path: 'src/a.ts', language: 'typescript', nodeCount: 5 },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_files')!

      const result = await tool.handler({ pattern: '', includeMetadata: true, limit: 10 }, graph)
      expect(result.files[0].nodeCount).toBe(5)
    })
  })

  describe('mini_cg_module', () => {
    it('returns module stats', async () => {
      const queriesMock = {
        getAllNodes: vi.fn().mockReturnValue([]),
        getAllFiles: vi.fn().mockReturnValue([]),
        getAllModules: vi.fn().mockReturnValue([
          { id: 'mod1', name: 'order-service', language: 'java', buildSystem: 'maven', rootPath: '/test/order', indexedAt: 0 },
          { id: 'mod2', name: 'payment-service', language: 'java', buildSystem: 'maven', rootPath: '/test/payment', indexedAt: 0 },
        ]),
        getAllEdges: vi.fn().mockReturnValue([]),
        getUnresolvedRefs: vi.fn().mockReturnValue([]),
        getAllExternalSymbols: vi.fn().mockReturnValue([]),
        getAllExternalReferences: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({ files: 10, nodes: 50, edges: 100, modules: 2 }),
        getFilesByModule: vi.fn().mockReturnValue([]),
      }
      const graph = createMockGraph({
        getQueries: vi.fn().mockReturnValue(queriesMock),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_module')!

      const result = await tool.handler({ detail: false }, graph)
      expect(result.moduleCount).toBe(2)
    })
  })

  describe('mini_cg_explore', () => {
    it('returns message when no symbols', async () => {
      const graph = createMockGraph()
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_explore')!

      const result = await tool.handler({ symbols: [] }, graph)
      expect(result).toBe('No symbols provided.')
    })

    it('searches and groups by file', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockReturnValue([{
          node: { id: '1', name: 'UserService', kind: 'class', filePath: 'src/UserService.ts', startLine: 1, endLine: 50 },
          snippets: [],
          score: 1,
        }]),
        findRelated: vi.fn().mockReturnValue(new Map([
          ['1', {
            node: { id: '1', name: 'UserService', kind: 'class', filePath: 'src/UserService.ts', startLine: 1, endLine: 50 },
            relationships: ['calledBy → AuthService', 'calls → UserRepository'],
          }],
        ])),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_explore')!

      const result = await tool.handler({ symbols: ['UserService'], maxPerSymbol: 10 }, graph)
      expect(result).toContain('UserService')
      expect(result).toContain('src/UserService.ts')
      expect(result).toContain('calledBy')
    })
  })

  describe('mini_cg_architecture', () => {
    it('returns architecture info', async () => {
      const graph = createMockGraph({
        findMicroserviceArchitecture: vi.fn().mockReturnValue({
          modules: [{ name: 'user-service', language: 'java' }],
          dependencies: [{ from: 'user-service', to: 'order-service' }],
          entryPoints: [{ module: 'user-service', endpoints: ['/api/users'] }],
        }),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_architecture')!

      const result = await tool.handler({}, graph)
      expect(result.modules).toHaveLength(1)
      expect(result.dependencies).toContain('user-service → order-service')
    })
  })

  describe('mini_cg_context', () => {
    it('returns no task message when empty task', async () => {
      const graph = createMockGraph()
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_context')!

      const result = await tool.handler({ task: '' }, graph)
      expect(result).toContain('(empty task)')
    })

    it('searches for symbols related to task', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockReturnValue([{
          node: { id: '1', name: 'UserService', kind: 'class', filePath: 'UserService.ts', startLine: 1, endLine: 50, language: 'typescript' },
          snippets: ['class UserService { }'],
          score: 1,
        }]),
        getContext: vi.fn().mockReturnValue({ callers: [], callees: [] }),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_context')!

      const result = await tool.handler({ task: 'user service', maxNodes: 5, includeCode: true }, graph)
      expect(result).toContain('UserService')
      expect(result).toContain('class UserService')
    })

    it('respects maxNodes limit', async () => {
      const mockSearch = vi.fn().mockReturnValue(
        Array.from({ length: 10 }, (_, i) => ({
          node: { id: String(i), name: `sym${i}`, kind: 'function', filePath: `f${i}.ts`, startLine: 1, endLine: 5, language: 'ts' },
          snippets: [`code${i}`],
          score: 1,
        }))
      )
      const graph = createMockGraph({
        search: mockSearch,
        getContext: vi.fn().mockReturnValue({ callers: [], callees: [] }),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_context')!

      const result = await tool.handler({ task: 'sym', maxNodes: 3 }, graph)
      const symbolCount = (result.match(/## sym/g) || []).length
      expect(symbolCount).toBeLessThanOrEqual(3)
    })
  })

  describe('mini_cg_trace', () => {
    it('returns error when from/to missing', async () => {
      const graph = createMockGraph()
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_trace')!

      const result = await tool.handler({ from: '', to: '' }, graph)
      expect(result.error).toBeDefined()
    })

    it('returns call paths between symbols', async () => {
      const graph = createMockGraph({
        search: vi.fn().mockImplementation((q: string) => {
          if (q === 'start') return [{ node: { id: '1', name: 'start', kind: 'function', filePath: 'a.ts', startLine: 1, endLine: 5 }, snippets: [], score: 1 }]
          if (q === 'end') return [{ node: { id: '2', name: 'end', kind: 'function', filePath: 'b.ts', startLine: 1, endLine: 5 }, snippets: [], score: 1 }]
          return []
        }),
        findPath: vi.fn().mockReturnValue({
          paths: [
            [{ node: { id: '1', name: 'start', kind: 'function', filePath: 'a.ts', startLine: 1, endLine: 5 } },
             { node: { id: '2', name: 'end', kind: 'function', filePath: 'b.ts', startLine: 1, endLine: 5 } }],
          ],
          truncated: false,
          exploredNodes: 2,
        }),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_trace')!

      const result = await tool.handler({ from: 'start', to: 'end', maxPaths: 5 }, graph)
      expect(result.paths).toHaveLength(1)
      expect(result.from.name).toBe('start')
      expect(result.to.name).toBe('end')
    })
  })

  describe('mini_cg_feign', () => {
    it('returns feign clients', async () => {
      const graph = createMockGraph({
        getFeignClients: vi.fn().mockReturnValue([
          {
            feignClient: { name: 'UserServiceClient', filePath: 'src/client.ts' },
            annotations: [{ annotationName: '@FeignClient', value: 'user-service' }],
            feignMethods: [{ name: 'getUser', signature: 'getUser(id)', startLine: 10 }],
          },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_feign')!

      const result = await tool.handler({ includeMethods: true, limit: 10 }, graph)
      expect(result.clients).toHaveLength(1)
      expect(result.clients[0].name).toBe('UserServiceClient')
      expect(result.clients[0].methods).toHaveLength(1)
    })
  })

  describe('mini_cg_mybatis', () => {
    it('returns mybatis mappings', async () => {
      const graph = createMockGraph({
        getMyBatisMappings: vi.fn().mockReturnValue([
          { javaInterface: 'UserMapper', methodName: 'findById', xmlPath: 'src/UserMapper.xml', sqlId: 'findById' },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_mybatis')!

      const result = await tool.handler({ limit: 10 }, graph)
      expect(result.mappings).toHaveLength(1)
      expect(result.mappings[0].javaInterface).toBe('UserMapper')
    })
  })

  describe('mini_cg_mongo', () => {
    it('returns mongo entities', async () => {
      const graph = createMockGraph({
        getMongoEntities: vi.fn().mockReturnValue([
          { entityName: 'User', collection: 'users', filePath: 'User.java' },
        ]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_mongo')!

      const result = await tool.handler({ limit: 10 }, graph)
      expect(result.mongoEntities).toHaveLength(1)
    })
  })

  describe('mini_cg_redis', () => {
    it('returns redis hashes and templates', async () => {
      const graph = createMockGraph({
        getRedisHashes: vi.fn().mockReturnValue([{ hashName: 'UserHash', filePath: 'a.java' }]),
        getRedisTemplates: vi.fn().mockReturnValue([{ templateName: 'redisTemplate', filePath: 'b.java' }]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_redis')!

      const result = await tool.handler({ limit: 10 }, graph)
      expect(result.redisHashes).toHaveLength(1)
      expect(result.redisTemplates).toHaveLength(1)
    })
  })

  describe('mini_cg_sql', () => {
    it('returns tables and statements', async () => {
      const graph = createMockGraph({
        getSqlTables: vi.fn().mockReturnValue([{ tableName: 'users', filePath: 'ddl.sql' }]),
        getSqlStatements: vi.fn().mockReturnValue([{ statement: 'SELECT * FROM users', filePath: 'mapper.xml' }]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_sql')!

      const result = await tool.handler({ limit: 10 }, graph)
      expect(result.tables).toHaveLength(1)
      expect(result.sqlStatements).toHaveLength(1)
    })
  })

  describe('mini_cg_react', () => {
    it('returns components, stores, and queries', async () => {
      const graph = createMockGraph({
        getReactComponents: vi.fn().mockReturnValue([
          { componentName: 'App', filePath: 'App.tsx', hooks: ['useState'] },
        ]),
        getReactStores: vi.fn().mockReturnValue([{ storeName: 'userStore', filePath: 'store.ts' }]),
        getReactQueries: vi.fn().mockReturnValue([{ queryName: 'useUsers', filePath: 'queries.ts' }]),
      })
      const tools = createTools(graph)
      const tool = tools.find(t => t.name === 'mini_cg_react')!

      const result = await tool.handler({ detail: false, limit: 10 }, graph)
      expect(result.components).toHaveLength(1)
      expect(result.stores).toHaveLength(1)
      expect(result.queries).toHaveLength(1)
    })
  })
})
