import type { Transport } from './types.js'
import type { GraphQueryManager } from '../graph/queries.js'
import { createTools, type ToolDefinition } from './tools.js'

const MAX_OUTPUT_LENGTH = 15_000

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
              version: '0.1.0',
            },
            instructions: [
              'mini-codegraph provides code intelligence through a knowledge graph built from AST parsing. It pre-indexes your codebase — a search/grep/read loop repeats work it already did.',
              '',
              'Tool selection by intent:',
              '- mini_codegraph_context: map an area, understand a task, build comprehensive context (includes callers, callees, implementations, cross-service calls)',
              '- mini_codegraph_trace: "how does X reach Y?" — finds call paths between two symbols with dynamic-dispatch hops (interface→impl, callbacks, React re-render)',
              '- mini_codegraph_explore: survey several related symbols grouped by file, plus a relationship map',
              '- mini_codegraph_search: find symbols by name across the codebase',
              '- mini_codegraph_callers / mini_codegraph_callees: walk call flow one direction at a time',
              '- mini_codegraph_impact: check blast radius before editing (callers + transitive dependents)',
              '- mini_codegraph_node: get details about a single symbol (optionally with source code)',
              '- mini_codegraph_files: list indexed file structure (faster than filesystem ls)',
              '- mini_codegraph_status: check index health and statistics',
              '',
              'Usage rules:',
              '- Answer structural questions directly with these tools — do NOT fall back to grep/read exploration for things the graph already knows.',
              '- Treat returned source as already read; do not re-read files the graph returned.',
              '- For exploration questions ("how does X work?", "explain Y system"), delegate to an Explore sub-agent rather than calling mini_codegraph_context or mini_codegraph_explore directly in the main session.',
              '- For targeted lookups before editing, use lightweight tools directly in the main session: mini_codegraph_search, mini_codegraph_callers/callees, mini_codegraph_impact, mini_codegraph_node.',
              '- Results are from tree-sitter AST parsing — they are accurate for well-formed code.',
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
            const result = await tool.handler(toolArgs, this.graph)
            const pending = this.getPendingFiles()
            if (pending.length > 0) {
              result._staleness = {
                pendingFiles: pending.length,
                warning: `${pending.length} file(s) pending sync. Results may be stale. Run 'mini-cg sync' to update.`,
                sample: pending.slice(0, 5).map(f => f.path),
              }
            }
            const textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
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
