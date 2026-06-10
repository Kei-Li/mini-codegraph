import type { Transport } from './transport/types.js'
import type { GraphQueryManager } from '../graph/queries.js'
import { createTools, type ToolDefinition } from './tools.js'
import { logError } from '../logger.js'

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
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class MCPServer {
  private transport: Transport
  private graph: GraphQueryManager
  private tools: ToolDefinition[] = []
  private getPendingFiles: () => { path: string; firstSeenMs: number; lastSeenMs: number; indexing: boolean }[]
  private cache = new Map<string, { result: string; ts: number }>()
  private cacheKeys: string[] = []

  constructor(
    transport: Transport,
    graph: GraphQueryManager,
    getPendingFiles?: () => { path: string; firstSeenMs: number; lastSeenMs: number; indexing: boolean }[]
  ) {
    this.transport = transport
    this.graph = graph
    this.getPendingFiles = getPendingFiles ?? (() => [])
    this.tools = createTools()
  }

  private cacheGet(key: string): string | undefined {
    const entry = this.cache.get(key)
    if (entry && Date.now() - entry.ts < 60_000) return entry.result
    this.cache.delete(key)
    const idx = this.cacheKeys.indexOf(key)
    if (idx >= 0) this.cacheKeys.splice(idx, 1)
    return undefined
  }

  private cacheSet(key: string, result: string): void {
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
              'You have access to 23+ structured query tools prefixed with mini_cg_. Use tools/list to discover available tools.',
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
          } catch (e) {
            logError('Tool execution error', e)
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
    } catch (e) {
      logError('Internal error', e)
      this.sendError(id, -32603, 'Internal server error')
    }
  }

  private sendResponse(id: number | string | null, result: unknown): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      result,
    })
  }

  private sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
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
