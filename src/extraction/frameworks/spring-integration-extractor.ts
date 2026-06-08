import type { QueryManager } from '../../db/queries.js'

export interface IntegrationEndpoint {
  annotation: string
  className: string
  methodName: string
  inputChannel?: string
  outputChannel?: string
  expression?: string
  payloadType?: string
  filePath: string
  line: number
  moduleId: string
}

const INTEGRATION_ANNOTATIONS = [
  '@MessageEndpoint', '@ServiceActivator', '@Router', '@Splitter',
  '@Aggregator', '@Transformer', '@Filter',
  '@InboundChannelAdapter', '@OutboundChannelAdapter',
  '@BridgeFrom', '@BridgeTo', '@Publisher',
]

export function indexSpringIntegration(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): IntegrationEndpoint[] {
  const results: IntegrationEndpoint[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()

    const ann = INTEGRATION_ANNOTATIONS.find(a => trim.startsWith(a))
    if (!ann) continue

    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith('public') &&
           !lines[j].trim().startsWith('private') && !lines[j].trim().startsWith('protected') &&
           !lines[j].trim().startsWith('@')) j++
    const methodLine = lines[j] || ''

    const methodMatch = methodLine.match(/(?:public\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
    const methodName = methodMatch ? methodMatch[2] : ''

    const fullAnnSrc = lines.slice(i, j + 1).join(' ')
    const inputChannel = fullAnnSrc.match(/inputChannel\s*=\s*["']([^"']+)["']/)?.[1]
    const outputChannel = fullAnnSrc.match(/outputChannel\s*=\s*["']([^"']+)["']/)?.[1]
    const expression = fullAnnSrc.match(/expression\s*=\s*["']([^"']+)["']/)?.[1]
    const payloadType = fullAnnSrc.match(/payloadType\s*=\s*["']([^"']+)["']/)?.[1]

    const ep: IntegrationEndpoint = {
      annotation: ann,
      className: filePath.split('/').pop()?.replace('.java', '') || '',
      methodName,
      inputChannel, outputChannel, expression, payloadType,
      filePath, line: i + 1, moduleId,
    }
    results.push(ep)

    const nodeId = `${filePath}:${methodName || ann}`
    queries.insertAnnotation(nodeId, ann,
      JSON.stringify({ inputChannel, outputChannel, expression, payloadType }),
      i + 1, moduleId)

    const parentNodes = queries.searchNodes(ep.className, 3)
      .filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertEdge(pn.id, nodeId, 'integration_endpoint',
        JSON.stringify({
          annotation: ann, inputChannel, outputChannel,
          expression, payloadType,
        }), i + 1, 0)
    }

    if (inputChannel) {
      const channelNodeId = `channel:${inputChannel}`
      queries.insertAnnotation(channelNodeId, 'MessageChannel',
        JSON.stringify({ channel: inputChannel }), 0, moduleId)
      queries.insertEdge(nodeId, channelNodeId, 'integration_channel_input',
        JSON.stringify({ channel: inputChannel }), i + 1, 0)
    }
    if (outputChannel) {
      const channelNodeId = `channel:${outputChannel}`
      queries.insertEdge(channelNodeId, nodeId, 'integration_channel_output',
        JSON.stringify({ channel: outputChannel }), i + 1, 0)
    }
  }

  return results
}
