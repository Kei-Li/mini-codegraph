import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MCPServer, type JSONRPCRequest } from '../src/mcp/server.js'
import type { Transport } from '../src/mcp/types.js'
import type { GraphQueryManager } from '../src/graph/queries.js'

function createMockTransport(): { transport: Transport; onMessage: any; onClose: any; sent: any[] } {
  const sent: any[] = []
  let onMessage: any = null
  let onClose: any = null
  const transport: Transport = {
    start: vi.fn((handler: any, closeHandler: any) => {
      onMessage = handler
      onClose = closeHandler
    }),
    send: vi.fn((msg: any) => { sent.push(msg) }),
    stop: vi.fn(),
  }
  return { transport, onMessage: () => onMessage, onClose: () => onClose, sent }
}

function createMockGraph(): GraphQueryManager {
  return {
    search: vi.fn().mockReturnValue([]),
    getCallers: vi.fn().mockReturnValue([]),
    getCallees: vi.fn().mockReturnValue([]),
    getContext: vi.fn().mockReturnValue({ callers: [], callees: [] }),
    getImpact: vi.fn().mockReturnValue([]),
    findPath: vi.fn().mockReturnValue([]),
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
    getRoutes: vi.fn().mockReturnValue([]),
    getFrameworks: vi.fn().mockReturnValue([]),
    getModules: vi.fn().mockReturnValue([]),
  } as unknown as GraphQueryManager
}

async function sendRequest(server: MCPServer, msg: JSONRPCRequest): Promise<void> {
  await (server as any).handleMessage(msg)
}

describe('MCPServer', () => {
  let mockTransport: ReturnType<typeof createMockTransport>
  let mockGraph: GraphQueryManager
  let server: MCPServer

  beforeEach(() => {
    mockTransport = createMockTransport()
    mockGraph = createMockGraph()
    server = new MCPServer(mockTransport.transport, mockGraph)
    server.start()
  })

  describe('initialization', () => {
    it('starts transport on construction', () => {
      expect(mockTransport.transport.start).toHaveBeenCalled()
    })

    it('responds to initialize with capabilities', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      })

      expect(mockTransport.sent.length).toBe(1)
      const response = mockTransport.sent[0]
      expect(response.id).toBe(1)
      expect(response.result).toBeDefined()
      expect(response.result.protocolVersion).toBe('2024-11-05')
      expect(response.result.capabilities.tools).toBeDefined()
      expect(response.result.serverInfo.name).toBe('mini-codegraph')
      expect(mockGraph.checkStaleFiles).toHaveBeenCalled()
    })
  })

  describe('tools/list', () => {
    it('returns list of available tools', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      })

      expect(mockTransport.sent.length).toBe(1)
      const response = mockTransport.sent[0]
      expect(response.id).toBe(2)
      expect(response.result.tools).toBeInstanceOf(Array)
      expect(response.result.tools.length).toBeGreaterThan(10)

      const toolNames = response.result.tools.map((t: any) => t.name)
      expect(toolNames).toContain('mini_codegraph_search')
      expect(toolNames).toContain('mini_codegraph_context')
      expect(toolNames).toContain('mini_codegraph_status')
      expect(toolNames).toContain('mini_codegraph_files')
    })
  })

  describe('tools/call', () => {
    it('calls tool by name', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'mini_codegraph_status', arguments: {} },
      })

      expect(mockTransport.sent.length).toBe(1)
      const response = mockTransport.sent[0]
      expect(response.id).toBe(3)
      expect(response.result.content[0].type).toBe('text')
    })

    it('returns error for unknown tool', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      })

      expect(mockTransport.sent.length).toBe(1)
      const response = mockTransport.sent[0]
      expect(response.error).toBeDefined()
      expect(response.error.code).toBe(-32601)
    })
  })

  describe('error handling', () => {
    it('returns error for unknown method', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 5,
        method: 'unknown_method',
      })

      expect(mockTransport.sent.length).toBe(1)
      const response = mockTransport.sent[0]
      expect(response.error).toBeDefined()
      expect(response.error.code).toBe(-32601)
    })

    it('handles missing id gracefully', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: null as any,
        method: 'tools/call',
        params: { name: 'mini_codegraph_status', arguments: {} },
      })

      expect(mockTransport.sent.length).toBe(1)
      const response = mockTransport.sent[0]
      expect(response.result).toBeDefined()
    })
  })

  describe('shutdown', () => {
    it('responds to shutdown', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 6,
        method: 'shutdown',
      })

      expect(mockTransport.sent.length).toBe(1)
      expect(mockTransport.sent[0].result).toBeNull()
    })
  })

  describe('notifications/initialized', () => {
    it('does not send response for notification', async () => {
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 7,
        method: 'notifications/initialized',
      })

      expect(mockTransport.sent.length).toBe(0)
    })
  })

  describe('pending files staleness', () => {
    it('includes _staleness when pending files exist', async () => {
      server = new MCPServer(mockTransport.transport, mockGraph, () => [
        { path: 'src/test.ts', firstSeenMs: 100, lastSeenMs: 200, indexing: false },
      ])
      server.start()

      mockTransport.sent.length = 0
      await sendRequest(server, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'mini_codegraph_status', arguments: {} },
      })

      const response = mockTransport.sent[0]
      expect(response.result.content[0].text).toContain('_staleness')
    })
  })
})
