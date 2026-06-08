import type { QueryManager } from '../../db/queries.js'

export interface WebSocketEndpoint {
  classFile: string
  handlerMethod: string
  destination: string
  returnType: string
  kind: 'message_mapping' | 'subscribe_mapping' | 'send_to' | 'message_exception'
  line: number
  moduleId: string
}

const WS_ANNOTATIONS = ['MessageMapping', 'SubscribeMapping', 'SendTo', 'SendToUser', 'MessageExceptionHandler']

export function indexWebSocketEndpoints(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): WebSocketEndpoint[] {
  const results: WebSocketEndpoint[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    for (const ann of WS_ANNOTATIONS) {
      if (!line.startsWith(`@${ann}`)) continue

      const destMatch = line.match(/@${ann}\s*\(\s*["']([^"']+)["']/)
      const destination = destMatch?.[1] || ''

      let j = i + 1
      while (j < lines.length && !lines[j].trim().endsWith(')') && !lines[j].trim().startsWith('public')) j++
      const methodLine = lines[j] || ''

      const methodMatch = methodLine.match(/(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      const returnType = methodMatch?.[1] || 'void'
      const methodName = methodMatch?.[2] || ''

      let kind: WebSocketEndpoint['kind'] = 'message_mapping'
      if (ann === 'SubscribeMapping') kind = 'subscribe_mapping'
      else if (ann === 'SendTo' || ann === 'SendToUser') kind = 'send_to'
      else if (ann === 'MessageExceptionHandler') kind = 'message_exception'

      const ep: WebSocketEndpoint = {
        classFile: filePath,
        handlerMethod: methodName,
        destination,
        returnType,
        kind,
        line: i + 1,
        moduleId,
      }
      results.push(ep)

      const nodeId = `${filePath}:${methodName}`
      const parentNodes = queries.searchNodes(filePath.split('/').pop()?.replace('.java', '') || '', 3)
        .filter(n => n.moduleId === moduleId && n.filePath === filePath)
      for (const pn of parentNodes) {
        queries.insertAnnotation(nodeId, `WebSocket_${ann}`, JSON.stringify({ destination, returnType, kind }),
          i + 1, moduleId)
        queries.insertEdge(pn.id, nodeId, 'websocket_handler',
          JSON.stringify({ kind, destination }), i + 1, 0)
      }
    }
  }

  return results
}
