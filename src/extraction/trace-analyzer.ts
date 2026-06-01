import type { QueryManager } from '../db/queries.js'
import type { FullTrace, FullTraceHop } from '../types.js'

export function buildFullTraces(queries: QueryManager): FullTrace[] {
  const traces: FullTrace[] = []
  const allEdges = queries.getAllEdges()

  const apiMappingEdges = allEdges.filter(e => e.kind === 'api_mapping')
  for (const apiEdge of apiMappingEdges) {
    const trace: FullTraceHop[] = []
    let meta: any = {}
    try { meta = JSON.parse(apiEdge.metadata ?? '{}') } catch {}

    trace.push({
      kind: 'vue_api_call',
      id: apiEdge.sourceId,
      name: apiEdge.sourceId.split('/').pop() ?? apiEdge.sourceId,
      moduleId: queries.getNode(apiEdge.sourceId)?.moduleId,
      filePath: apiEdge.sourceId,
      detail: `API call → ${meta.path ?? ''}`,
    })

    const controllerNode = queries.getNode(apiEdge.targetId)
    if (controllerNode) {
      trace.push({
        kind: 'controller_endpoint',
        id: controllerNode.id,
        name: controllerNode.name,
        moduleId: controllerNode.moduleId,
        filePath: controllerNode.filePath,
        detail: `${meta.method ?? 'GET'} ${meta.path ?? ''}`,
      })

      const serviceEdges = allEdges.filter(e =>
        e.sourceId === controllerNode.id && e.kind === 'calls'
      )
      for (const svcEdge of serviceEdges) {
        const svcNode = queries.getNode(svcEdge.targetId)
        if (svcNode) {
          trace.push({
            kind: 'service_method',
            id: svcNode.id,
            name: svcNode.name,
            moduleId: svcNode.moduleId,
            filePath: svcNode.filePath,
            detail: `${controllerNode.name} → ${svcNode.name}`,
          })

          const mybatisEdges = allEdges.filter(e =>
            e.sourceId === svcNode.id && e.kind === 'mybatis_mapping'
          )
          for (const mbEdge of mybatisEdges) {
            trace.push({
              kind: 'mybatis_mapper',
              id: mbEdge.targetId,
              name: mbEdge.targetId.split(':').pop() ?? '',
              detail: `SQL: ${mbEdge.targetId}`,
            })

            const jpaEdges = allEdges.filter(e =>
              e.sourceId === svcNode.id && e.kind === 'jpa_entity'
            )
            for (const jpaEdge of jpaEdges) {
              const jpaNode = queries.getNode(jpaEdge.targetId)
              if (jpaNode) {
                trace.push({
                  kind: 'database_table',
                  id: jpaEdge.targetId,
                  name: jpaNode.name,
                  filePath: jpaNode.filePath,
                  detail: `Table: ${(JSON.parse(jpaNode.signature ?? '{}') as any).table ?? jpaNode.name}`,
                })
              }
            }
          }

          const feignEdges = allEdges.filter(e =>
            e.sourceId === svcNode.id && e.kind === 'feign_call'
          )
          for (const feEdge of feignEdges) {
            const feNode = queries.getNode(feEdge.targetId)
            if (feNode) {
              trace.push({
                kind: 'feign_call',
                id: feEdge.targetId,
                name: feNode.name,
                moduleId: feNode.moduleId,
                filePath: feNode.filePath,
                detail: `Feign → ${feNode.moduleId ?? ''}:${feNode.name}`,
              })
            }
          }

          const mqPubEdges = allEdges.filter(e =>
            e.sourceId === svcNode.id && e.kind === 'publishes_to'
          )
          for (const mqEdge of mqPubEdges) {
            trace.push({
              kind: 'mq_publish',
              id: mqEdge.targetId,
              name: mqEdge.targetId.replace('mq:', ''),
              detail: `MQ Publish: ${mqEdge.targetId}`,
            })
          }
        }
      }
    }

    if (trace.length > 1) {
      traces.push({
        id: `trace:${apiEdge.sourceId}:${apiEdge.targetId}`,
        hops: trace,
        entryPoint: apiEdge.sourceId,
        endpointPath: meta.path ?? '',
        httpMethod: meta.method ?? 'GET',
      })
    }
  }

  const gatewayEdges = allEdges.filter(e => e.kind === 'gateway_to_endpoint')
  for (const gwEdge of gatewayEdges) {
    const gwNode = queries.getNode(gwEdge.sourceId)
    if (!gwNode) continue

    const existingTrace = traces.find(t =>
      t.hops.some(h => h.id === gwEdge.targetId)
    )
    if (existingTrace) {
      existingTrace.hops.unshift({
        kind: 'gateway_route',
        id: gwEdge.sourceId,
        name: gwNode.name,
        detail: `Gateway route → ${gwNode.name}`,
      })
    }
  }

  return traces
}

export function findTraceByEndpoint(queries: QueryManager, path: string): FullTrace | undefined {
  const traces = buildFullTraces(queries)
  return traces.find(t => t.endpointPath.includes(path) || path.includes(t.endpointPath))
}

export function findTraceByService(queries: QueryManager, serviceName: string): FullTrace[] {
  const traces = buildFullTraces(queries)
  return traces.filter(t =>
    t.hops.some(h => h.moduleId?.toLowerCase().includes(serviceName.toLowerCase()))
  )
}

export function indexTraces(queries: QueryManager, moduleId: string): FullTrace[] {
  const traces = buildFullTraces(queries)
  for (const trace of traces) {
    for (let i = 0; i < trace.hops.length - 1; i++) {
      queries.insertEdge(trace.hops[i].id, trace.hops[i + 1].id, 'trace_step',
        JSON.stringify({ step: i, kind: trace.hops[i].kind }),
        0, 0)
    }
  }
  return traces
}
