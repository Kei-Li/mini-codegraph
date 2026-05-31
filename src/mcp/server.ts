import type { StdioTransport } from './transport.js'
import type { GraphQueryManager } from '../graph/queries.js'
import { createTools, type ToolDefinition } from './tools.js'

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
  private transport: StdioTransport
  private graph: GraphQueryManager
  private tools: ToolDefinition[] = []
  private initialized = false

  constructor(transport: StdioTransport, graph: GraphQueryManager) {
    this.transport = transport
    this.graph = graph
    this.tools = createTools(graph)
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
              'mini-codegraph provides code intelligence through a knowledge graph built from AST parsing.',
              '',
              'Key guidelines:',
              '- Use codegraph_context FIRST when asked about code structure or understanding a feature',
              '- Use codegraph_search to find symbols by name across the codebase',
              '- Use codegraph_trace to find call paths between two functions',
              '- Use codegraph_callers/codegraph_callees for direct call relationships',
              '- Results are from tree-sitter AST parsing — they are accurate for well-formed code',
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
            this.sendResponse(id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            })
          } catch (e: any) {
            this.sendError(id, -32603, `Tool execution error: ${e.message ?? e}`)
          }
          break
        }

        case 'notifications/initialized':
          // Client is ready
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
      this.sendError(id, -32603, `Internal error: ${e.message ?? e}`)
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
