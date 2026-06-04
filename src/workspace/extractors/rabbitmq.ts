import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export class RabbitMQExtractor implements IExtractor {
  name = 'rabbitmq'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const queueNodes = queries.getNodesByAnnotation('RabbitListener')
    for (const node of queueNodes) {
      const anns = queries.getAnnotationsByNode(node.id)
      for (const a of anns) {
        if (a.annotationName === 'RabbitListener') {
          const queueMatch = a.value.match(/queues\s*=\s*["']([^"']+)["']/)
          const queueName = queueMatch?.[1] || a.value
          provides.push({
            id: `mq.rabbitmq.${queueName}`,
            name: queueName,
            kind: 'mq_queue',
            signature: `queue:${queueName}`,
          })
        }
      }
    }

    const convertAndSendNodes = queries.getNodesByAnnotation('ConvertAndSend')
    if (convertAndSendNodes.length === 0) {
      const allNodes = queries.getAllNodes()
      for (const node of allNodes) {
        if (node.qualifiedName.includes('convertAndSend') || node.name === 'convertAndSend') {
          const anns = queries.getAnnotationsByNode(node.id)
          const exchange = anns.find(a => a.annotationName === 'exchange')?.value || ''
          const routingKey = anns.find(a => a.annotationName === 'routingKey')?.value || ''
          const topic = exchange || routingKey || node.qualifiedName
          const parent = node.parentId ? queries.getNode(node.parentId) : null
          consumes.push({
            symbolId: `mq.rabbitmq.producer.${topic}`,
            referenceType: 'mq_publish',
            sourceLocation: `${node.filePath}:${node.startLine}:${node.startColumn}`,
          })
          provides.push({
            id: `mq.rabbitmq.producer.${topic}`,
            name: topic,
            kind: 'mq_exchange',
            signature: `exchange:${exchange}, routingKey:${routingKey}`,
          })
        }
      }
    }

    const ymlPath = join(projectRoot, 'src', 'main', 'resources', 'application.yml')
    if (existsSync(ymlPath)) {
      try {
        const content = readFileSync(ymlPath, 'utf-8')
        const queuePattern = /queues:\s*(.+?)(?=\n\S|\n\n|$)/gs
        let match
        while ((match = queuePattern.exec(content)) !== null) {
          const queues = match[1].split('\n').map(l => l.trim().replace(/^- /, '')).filter(Boolean)
          for (const q of queues) {
            if (!provides.some(p => p.name === q)) {
              provides.push({ id: `mq.rabbitmq.${q}`, name: q, kind: 'mq_queue', signature: `queue:${q}` })
            }
          }
        }
      } catch { /* silent */ }
    }

    return { provides, consumes }
  }
}
