import type { Transport } from './types.js'
import type { GraphQueryManager } from '../graph/queries.js'
import { createTools, type ToolDefinition } from './tools.js'

const MAX_OUTPUT_LENGTH = 15_000
const CACHE_SIZE = 500

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text

  const truncated = text.slice(0, MAX_OUTPUT_LENGTH)
  const lastNewline = truncated.lastIndexOf('\n')
  const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH
  return truncated.slice(0, cutPoint) + '\n... (output truncated)'
}

export interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, any>
}

export interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: any
  error?: { code: number; message: string; data?: any }
}

export class MCPServer {
  private transport: Transport
  private graph: GraphQueryManager
  private tools: ToolDefinition[] = []
  private initialized = false
  private getPendingFiles: () => { path: string; firstSeenMs: number; lastSeenMs: number; indexing: boolean }[]
  private cache = new Map<string, { result: any; ts: number }>()
  private cacheKeys: string[] = []

  constructor(
    transport: Transport,
    graph: GraphQueryManager,
    getPendingFiles?: () => { path: string; firstSeenMs: number; lastSeenMs: number; indexing: boolean }[]
  ) {
    this.transport = transport
    this.graph = graph
    this.getPendingFiles = getPendingFiles ?? (() => [])
    this.tools = createTools(graph, getPendingFiles)
  }

  private cacheGet(key: string): any | undefined {
    const entry = this.cache.get(key)
    if (entry && Date.now() - entry.ts < 60_000) return entry.result
    this.cache.delete(key)
    const idx = this.cacheKeys.indexOf(key)
    if (idx >= 0) this.cacheKeys.splice(idx, 1)
    return undefined
  }

  private cacheSet(key: string, result: any): void {
    if (this.cacheKeys.length >= CACHE_SIZE) {
      const oldest = this.cacheKeys.shift()
      if (oldest) this.cache.delete(oldest)
    }
    if (!this.cache.has(key)) this.cacheKeys.push(key)
    this.cache.set(key, { result, ts: Date.now() })
  }

  start(): void {
    this.transport.start(
      (msg: JSONRPCRequest) => this.handleMessage(msg),
      () => this.handleClose()
    )
  }

  private async handleMessage(request: JSONRPCRequest): Promise<void> {
    const { id, method, params = {} } = request

    try {
      switch (method) {
        case 'initialize':
          this.initialized = true
          this.graph.checkStaleFiles()
          this.sendResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {
                listChanged: false,
              },
              roots: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: 'mini-codegraph',
              version: '0.2.0',
            },
            instructions: [
              'mini-codegraph provides code intelligence through a knowledge graph built from AST parsing.',
              '',
              'Tool selection by intent:',
              '- mini_cg_context: map an area, understand a task, build comprehensive context',
              '- mini_cg_trace: "how does X reach Y?" — finds call paths between two symbols',
              '- mini_cg_explore: survey related symbols grouped by file, plus a relationship map',
              '- mini_cg_search: find symbols by name across the codebase',
              '- mini_cg_callers / mini_cg_callees: walk call flow one direction at a time (includes cross-service via Feign/RestTemplate/WebClient)',
              '- mini_cg_impact: check blast radius before editing (includes external callers)',
              '- mini_cg_node: get details about a single symbol',
              '- mini_cg_files: list indexed file structure',
              '- mini_cg_status: check index health and statistics',
              '- mini_cg_workspace_status: view all workspace projects',
              '- mini_cg_architecture: show microservice architecture overview',
              '- mini_cg_feign: list FeignClient interfaces and targets',
              '- mini_cg_mybatis: list MyBatis mapper XML bindings',
              '- mini_cg_modules: list indexed modules (microservices)',
              '- mini_cg_react: list React components, hooks, stores, queries',
              '- mini_cg_mongo: list MongoDB entities and repositories',
              '- mini_cg_redis: list Redis hashes and templates',
              '- mini_cg_sql: list SQL tables and statements',
              '- mini_cg_dispatch: analyze dispatch patterns (proxy/AOP/strategy/reflection)',
              '- mini_cg_config: evaluate active @Profile/@ConditionalOnProperty implementations',
              '',
              'Usage rules:',
              '- Answer structural questions with these tools — do NOT fall back to grep/read.',
              '- Treat returned source as already read; do not re-read files the graph returned.',
              '- For exploration ("how does X work?"), use mini_cg_explore or mini_cg_context.',
              '- For targeted lookups before editing: mini_cg_search, mini_cg_callers/callees, mini_cg_impact.',
              '- Results are from tree-sitter AST parsing — accurate for well-formed code.',
            ].join('\n'),
          })
          break

        case 'tools/list':
          this.sendResponse(id, {
            tools: this.tools.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
          break

        case 'tools/call': {
          const toolName = params.name
          const toolArgs = params.arguments ?? {}

          const tool = this.tools.find(t => t.name === toolName)
          if (!tool) {
            this.sendError(id, -32601, `Tool not found: ${toolName}`)
            break
          }

          try {
            const cacheKey = `${toolName}:${JSON.stringify(toolArgs)}`
            const cached = this.cacheGet(cacheKey)
            if (cached) {
              this.sendResponse(id, { content: [{ type: 'text', text: truncateOutput(cached) }] })
              break
            }
            const result = await tool.handler(toolArgs, this.graph)
            const pending = this.getPendingFiles()
            if (pending.length > 0) {
              result._staleness = {
                pendingFiles: pending.length,
                    warning: `${pending.length} file(s) pending sync. Results may be stale. Run 'mini-codegraph sync' to update.`,
                sample: pending.slice(0, 5).map(f => f.path),
              }
            }
            const textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            this.cacheSet(cacheKey, textContent)
            this.sendResponse(id, {
              content: [{ type: 'text', text: truncateOutput(textContent) }],
            })
          } catch (e: any) {
            console.error('Tool execution error:', e)
            this.sendError(id, -32603, 'Internal server error')
          }
          break
        }

        case 'notifications/initialized':
          break

        case 'shutdown':
          this.sendResponse(id, null)
          break

        case 'exit':
          process.exit(0)
          break

        default:
          this.sendError(id, -32601, `Method not found: ${method}`)
      }
    } catch (e: any) {
      console.error('Internal error:', e)
      this.sendError(id, -32603, 'Internal server error')
    }
  }

  private sendResponse(id: number | string | null, result: any): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      result,
    })
  }

  private sendError(id: number | string | null, code: number, message: string, data?: any): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    })
  }

  private handleClose(): void {
    process.exit(0)
  }
}
