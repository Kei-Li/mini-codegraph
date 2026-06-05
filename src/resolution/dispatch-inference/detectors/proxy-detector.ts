import type { QueryManager } from '../../../db/queries.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'

export class ProxyDetector implements IDispatchDetector {
  name = 'proxy-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const allEdges = queries.getAllEdges()

    const proxyNewInstanceNodes = allNodes.filter(n =>
      n.name === 'newProxyInstance' && n.language === 'java'
    )
    if (proxyNewInstanceNodes.length === 0) return patterns

    // Collect all InvocationHandler implementations in the module
    const invocationHandlers = allNodes.filter(n => {
      if (n.kind !== 'class' || n.moduleId !== moduleId) return false
      const impls = allEdges.filter(e =>
        e.kind === 'implements' && e.sourceId === n.id
      )
      return impls.some(e => {
        const iface = queries.getNode(e.targetId)
        return iface?.name === 'InvocationHandler'
      })
    })

    for (const method of proxyNewInstanceNodes) {
      const callers = queries.getCallers(method.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const callerParent = caller.parentId ? queries.getNode(caller.parentId) : null
        const className = callerParent?.name ?? caller.name

        let interfaceName = ''
        const children = queries.getChildren(caller.id)
        const ifaceChild = children.find(c =>
          c.kind === 'interface' || c.kind === 'type_alias' || c.kind === 'class'
        )
        if (ifaceChild) {
          interfaceName = ifaceChild.name
        }

        const targets: InferredTarget[] = []

        // Target 1: the caller class itself (original owner)
        if (callerParent) {
          targets.push({
            targetId: callerParent.id,
            targetName: callerParent.name,
            confidence: CONFIDENCE.PROXY_HANDLER,
            provenance: 'proxy_handler',
            provenanceDetail: `JDK Proxy.newProxyInstance in ${className}, interface: ${interfaceName || 'unknown'}`,
            condition: interfaceName ? {
              source: 'Proxy.newProxyInstance',
              value: interfaceName,
              expression: `proxy:${interfaceName}`,
            } : undefined,
          })
        }

        // Target 2: the newProxyInstance call itself
        targets.push({
          targetId: method.id,
          targetName: method.name,
          confidence: CONFIDENCE.PROXY_HANDLER,
          provenance: 'proxy_handler',
          provenanceDetail: `Direct newProxyInstance call in ${className}`,
        })

        // Target 3: all InvocationHandler implementations (runtime-determined handler)
        for (const handler of invocationHandlers) {
          targets.push({
            targetId: handler.id,
            targetName: handler.name,
            confidence: CONFIDENCE.PROXY_HANDLER * 0.5,
            provenance: 'proxy_handler',
            provenanceDetail: `InvocationHandler implementation ${handler.name} — may be used at runtime`,
            condition: {
              source: 'InvocationHandler',
              value: handler.name,
              expression: `handler:${handler.name}`,
            },
          })
        }

        // Find candidate proxied interfaces and their implementations
        const proxiedInterfaces = allNodes.filter(n =>
          (n.kind === 'interface' || n.kind === 'class') &&
          n.moduleId === moduleId &&
          (interfaceName ? n.name === interfaceName : true)
        )

        for (const iface of proxiedInterfaces) {
          const impls = allEdges
            .filter(e => e.kind === 'implements' && e.targetId === iface.id)
            .map(e => queries.getNode(e.sourceId))
            .filter((n): n is NonNullable<typeof n> => n != null)

          for (const impl of impls) {
            const existing = targets.some(t => t.targetId === impl.id)
            if (existing) continue
            targets.push({
              targetId: impl.id,
              targetName: impl.name,
              interfaceId: iface.id,
              interfaceName: iface.name,
              confidence: CONFIDENCE.PROXY_HANDLER * 0.6,
              provenance: 'proxy_handler',
              provenanceDetail: `Proxy candidate: ${impl.name} implements ${iface.name} — may be proxied at runtime`,
              condition: {
                source: 'proxy_impl',
                value: iface.name,
                expression: `proxy target: ${iface.name}`,
              },
            })
          }
        }

        if (targets.length > 0) {
          patterns.push({
            type: 'proxy_handler',
            sourceId: caller.id,
            sourceName: caller.name,
            interfaceName: interfaceName || undefined,
            possibleTargets: targets,
          })
        }
      }
    }

    // Also detect CGLIB proxies via Enhancer.create
    const enhancerNodes = allNodes.filter(n =>
      n.name === 'create' && n.language === 'java'
    )
    for (const enhancer of enhancerNodes) {
      const parent = enhancer.parentId ? queries.getNode(enhancer.parentId) : null
      if (!parent || parent.name !== 'Enhancer') continue

      const callers = queries.getCallers(enhancer.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const targets: InferredTarget[] = []

        // All classes in the module are CGLIB proxy candidates
        const classNodes = allNodes.filter(n =>
          n.kind === 'class' && n.moduleId === moduleId
        )
        for (const cls of classNodes) {
          targets.push({
            targetId: cls.id,
            targetName: cls.name,
            confidence: CONFIDENCE.PROXY_HANDLER * 0.4,
            provenance: 'proxy_handler',
            provenanceDetail: `CGLIB Enhancer.create in ${caller.name} — ${cls.name} may be proxied`,
            condition: {
              source: 'CGLIB_Enhancer',
              value: cls.name,
              expression: `cglib proxy:${cls.name}`,
            },
          })
        }

        if (targets.length > 0) {
          patterns.push({
            type: 'proxy_handler',
            sourceId: caller.id,
            sourceName: caller.name,
            possibleTargets: targets,
          })
        }
      }
    }

    return patterns
  }
}
