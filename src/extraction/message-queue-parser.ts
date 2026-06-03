import { readFileSync } from 'node:fs'
import type { QueryManager } from '../db/queries.js'
import type { MessageQueueBinding } from '../types.js'

export function extractQueueBindings(source: string, filePath: string): MessageQueueBinding[] {
  const bindings: MessageQueueBinding[] = []

  const kafkaListeners = source.matchAll(/@KafkaListener\s*\([^)]*topics\s*=\s*["']([^"']+)["'][^)]*\)/g)
  for (const m of kafkaListeners) {
    const groupMatch = m[0].match(/groupId\s*=\s*["']([^"']+)["']/)
    bindings.push({
      type: 'kafka', direction: 'subscribe', topic: m[1],
      group: groupMatch?.[1] ?? undefined, handlerClass: filePath,
    })
  }

  const kafkaTemplates = source.matchAll(/@KafkaListener\s*\([^)]*topics\s*=\s*["']([^"']+)["'][^)]*\)/g)
  for (const _ of kafkaTemplates) {}

  const kafkaSends = source.matchAll(/(kafkaTemplate|KafkaTemplate)\s*<[^>]*>\s*(\w+)\s*\.\s*send\s*\(\s*["']([^"']+)["']/g)
  for (const m of kafkaSends) {
    bindings.push({ type: 'kafka', direction: 'publish', topic: m[3], handlerClass: filePath })
  }

  const rabbitListeners = source.matchAll(/@RabbitListener\s*\([^)]*queues\s*=\s*["']([^"']+)["'][^)]*\)/g)
  for (const m of rabbitListeners) {
    bindings.push({ type: 'rabbitmq', direction: 'subscribe', topic: m[1], handlerClass: filePath })
  }

  const rabbitSends = source.matchAll(/(rabbitTemplate|RabbitTemplate|amqpTemplate|AmqpTemplate)\s*\w*\s*\.\s*(convertAndSend|send)\s*\(\s*["']([^"']+)["']/g)
  for (const m of rabbitSends) {
    bindings.push({ type: 'rabbitmq', direction: 'publish', topic: m[3], handlerClass: filePath })
  }

  const streamOutputs = source.matchAll(/@Output\s*\(\s*["'](\w+)["']\s*\)/g)
  for (const m of streamOutputs) {
    bindings.push({ type: 'stream', direction: 'publish', topic: m[1], handlerClass: filePath })
  }

  const streamInputs = source.matchAll(/@Input\s*\(\s*["'](\w+)["']\s*\)/g)
  for (const m of streamInputs) {
    bindings.push({ type: 'stream', direction: 'subscribe', topic: m[1], handlerClass: filePath })
  }

  const streamListeners = source.matchAll(/@StreamListener\s*\(\s*["']?(\w+)["']?\s*\)/g)
  for (const m of streamListeners) {
    bindings.push({ type: 'stream', direction: 'subscribe', topic: m[1], handlerClass: filePath })
  }

  const enableBindings = source.matchAll(/@EnableBinding\s*\(\s*(\w+\.class\s*(?:,\s*\w+\.class\s*)*)\s*\)/g)
  for (const m of enableBindings) {
    const classes = m[1].match(/\w+(?=\.class)/g) ?? []
    for (const cls of classes) {
      bindings.push({ type: 'stream', direction: 'publish', topic: cls, handlerClass: filePath })
    }
  }

  return bindings
}

export function indexQueueBindings(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): MessageQueueBinding[] {
  const bindings = extractQueueBindings(source, filePath)
  if (bindings.length === 0) return bindings

  const moduleNodes = queries.getAllNodes()
  for (const b of bindings) {
    const bindingId = `mq:${b.type}:${b.topic}:${b.direction}:${filePath}`
    const topicId = `topic:${b.topic}`

    const existingTopic = queries.searchNodes(b.topic, 5)
      .find(n => n.kind === 'topic')

    if (b.direction === 'subscribe') {
      const subscribers = bindings.filter(x =>
        x.topic === b.topic && x.direction === 'publish' && x.handlerClass !== filePath
      )
      for (const sub of subscribers) {
        const handler = sub.handlerClass ?? filePath
        queries.insertEdge(bindingId, handler, 'subscribes_to',
          JSON.stringify({ topic: b.topic, type: b.type }), 0, 0)
      }
    }

    if (b.direction === 'publish') {
      const consumsers = bindings.filter(x =>
        x.topic === b.topic && x.direction === 'subscribe' && x.handlerClass !== filePath
      )
      for (const con of consumsers) {
        const handler = con.handlerClass ?? filePath
        queries.insertEdge(bindingId, handler, 'publishes_to',
          JSON.stringify({ topic: b.topic, type: b.type }), 0, 0)
      }
    }

    for (const n of moduleNodes) {
      if (n.moduleId && n.moduleId !== moduleId) {
        if (n.name.toLowerCase().includes(b.topic.toLowerCase())) {
          queries.insertEdge(topicId, n.id, 'topic_related',
            JSON.stringify({ topic: b.topic, type: b.type }), 0, 0)
        }
      }
    }
  }

  return bindings
}
