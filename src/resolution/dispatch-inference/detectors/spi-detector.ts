import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../../db/queries.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'

export class SpiDetector implements IDispatchDetector {
  name = 'spi-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()

    const serviceLoaderNodes = allNodes.filter(n =>
      n.name === 'load' && n.language === 'java'
    )

    for (const sl of serviceLoaderNodes) {
      const callers = queries.getCallers(sl.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const calleeEdges = queries.getAllEdges().filter(e =>
          e.sourceId === caller.id && e.kind === 'references'
        )

        const targets: InferredTarget[] = calleeEdges.map(ce => {
          const target = queries.getNode(ce.targetId)
          return {
            targetId: ce.targetId,
            targetName: target?.name ?? ce.targetId,
            confidence: CONFIDENCE.FACTORY_PRODUCT,
            provenance: 'spi_loaded',
            provenanceDetail: `ServiceLoader.load() in ${caller.name}, references: ${target?.name ?? ce.targetId}`,
            condition: {
              source: 'ServiceLoader',
              value: target?.name ?? '',
              expression: `ServiceLoader<${target?.name ?? ''}>`,
            },
          }
        })

        if (targets.length > 0) {
          patterns.push({
            type: 'spi_loaded',
            sourceId: caller.id,
            sourceName: caller.name,
            possibleTargets: targets,
          })
        }
      }
    }

    const moduleNodes = allNodes.filter(n => n.moduleId === moduleId && n.filePath)
    const seenServicesDirs = new Set<string>()
    for (const node of moduleNodes) {
      if (!node.filePath) continue
      const parts = node.filePath.replace(/\\/g, '/').split('/')
      const srcIdx = parts.indexOf('src')
      if (srcIdx === -1) continue

      const baseDir = parts.slice(0, srcIdx + 1).join('/')
      const servicesDir = join(baseDir, 'main', 'resources', 'META-INF', 'services')
      if (seenServicesDirs.has(servicesDir)) continue
      seenServicesDirs.add(servicesDir)

      if (!existsSync(servicesDir)) continue

      try {
        const { readdirSync } = await import('node:fs')
        const serviceFiles = readdirSync(servicesDir)
        for (const sf of serviceFiles) {
          const content = readFileSync(join(servicesDir, sf), 'utf-8')
          const implClasses = content.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))

          const interfaceNodes = allNodes.filter(n =>
            (n.name === sf || n.qualifiedName === sf) &&
            (n.kind === 'interface' || n.kind === 'class')
          )

          for (const iface of interfaceNodes) {
            const targets: InferredTarget[] = implClasses.map(ic => ({
              targetId: iface.id,
              targetName: ic,
              confidence: CONFIDENCE.STRATEGY_MAP_ENUMERATED,
              provenance: 'spi_loaded',
              provenanceDetail: `SPI service: ${sf} → implementation: ${ic}`,
              condition: {
                source: 'META-INF/services',
                value: sf,
                expression: `SPI: ${sf}`,
              },
            }))

            if (targets.length > 0) {
              patterns.push({
                type: 'spi_loaded',
                sourceId: iface.id,
                sourceName: iface.name,
                interfaceName: sf,
                possibleTargets: targets,
              })
            }
          }
        }
      } catch {
        continue
      }
    }

    return patterns
  }
}
