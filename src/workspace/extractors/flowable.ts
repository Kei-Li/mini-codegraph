import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'
import { detectFlowable, indexFlowableProcesses } from '../../extraction/middleware/flowable-extractor.js'

export class FlowableExtractor implements IExtractor {
  name = 'flowable'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    if (!detectFlowable(projectRoot)) return { provides, consumes }

    const moduleId = projectRoot.split(/[/\\]/).pop() || 'unknown'
    const processes = indexFlowableProcesses(queries, projectRoot, moduleId)

    // Build process ID lookup for callActivity linking
    const processIdMap = new Map<string, string>()
    for (const proc of processes) {
      processIdMap.set(proc.processId, proc.id)
    }

    for (const proc of processes) {
      provides.push({
        id: proc.id,
        name: proc.name,
        kind: 'bpmn_process',
        signature: `process: ${proc.processId}, nodes: ${proc.nodes.length}, flows: ${proc.flows.length}`,
      })

      for (const node of proc.nodes) {
        if (node.type === 'serviceTask' && node.implementation) {
          consumes.push({
            symbolId: node.implementation,
            referenceType: 'service_task',
            sourceLocation: `${queries.getDb()}`,
          })
        }
        if (node.type === 'callActivity' && node.implementation) {
          const targetId = processIdMap.get(node.implementation)
          if (targetId) {
            // Link callActivity node → called process definition
            try {
              queries.insertEdge(node.id, targetId, 'calls', JSON.stringify({ kind: 'subprocess_call' }))
            } catch { /* edge may already exist */ }
          }
          consumes.push({
            symbolId: `flowable:${node.implementation}`,
            referenceType: 'subprocess_call',
            sourceLocation: '',
          })
        }
      }
    }

    return { provides, consumes }
  }
}
