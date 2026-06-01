import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../db/queries.js'

export interface ConditionalConfig {
  configClass: string
  filePath: string
  conditions: { type: string; value: string; matchIfMissing: boolean }[]
  autoConfigureAfter: string[]
  autoConfigureBefore: string[]
  order: number
  moduleId: string
}

function scanSourceForAnnotations(
  source: string,
): { annName: string; annBody: string; lineNum: number }[] {
  const results: { annName: string; annBody: string; lineNum: number }[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const annMatch = line.match(/^@(ConditionalOnProperty|ConditionalOnClass|ConditionalOnMissingBean|ConditionalOnBean|ConditionalOnExpression|ConditionalOnMissingClass|ConditionalOnWebApplication|ConditionalOnNotWebApplication|AutoConfigureAfter|AutoConfigureBefore|AutoConfigureOrder|Configuration|AutoConfiguration)\s*(?:\(([^)]*)\))?/)
    if (annMatch) {
      results.push({ annName: annMatch[1], annBody: annMatch[2]?.trim() ?? '', lineNum: i + 1 })
    }
  }
  return results
}

export function indexSpringAutoConfiguration(
  queries: QueryManager,
  moduleId: string,
  projectRoot?: string,
): ConditionalConfig[] {
  const results: ConditionalConfig[] = []
  const allNodes = queries.getAllNodes()
  const seen = new Set<string>()

  for (const node of allNodes) {
    if (node.moduleId !== moduleId || node.kind !== 'class') continue
    if (seen.has(node.id)) continue
    seen.add(node.id)

    if (!node.filePath) continue
    const filePath = projectRoot ? join(projectRoot, node.filePath) : node.filePath
    let source: string
    try {
      source = readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const anns = scanSourceForAnnotations(source)
    const hasConfig = anns.some(a => a.annName === 'Configuration' || a.annName === 'AutoConfiguration')
    if (!hasConfig && anns.length === 0) continue

    const config: ConditionalConfig = {
      configClass: node.name,
      filePath: node.filePath,
      conditions: [],
      autoConfigureAfter: [],
      autoConfigureBefore: [],
      order: 0,
      moduleId,
    }

    for (const ann of anns) {
      switch (ann.annName) {
        case 'ConditionalOnProperty': {
          const match = ann.annBody.match(/name\s*=\s*["']([^"']+)["']/)
          const matchIfMissing = ann.annBody.includes('matchIfMissing = true')
          config.conditions.push({
            type: 'property',
            value: match?.[1] ?? ann.annBody,
            matchIfMissing,
          })
          break
        }
        case 'ConditionalOnClass':
          config.conditions.push({ type: 'class', value: ann.annBody, matchIfMissing: false })
          break
        case 'ConditionalOnMissingBean':
          config.conditions.push({ type: 'missingBean', value: ann.annBody, matchIfMissing: false })
          break
        case 'ConditionalOnBean':
          config.conditions.push({ type: 'bean', value: ann.annBody, matchIfMissing: false })
          break
        case 'ConditionalOnExpression':
          config.conditions.push({ type: 'expression', value: ann.annBody, matchIfMissing: false })
          break
        case 'ConditionalOnMissingClass':
          config.conditions.push({ type: 'missingClass', value: ann.annBody, matchIfMissing: false })
          break
        case 'ConditionalOnWebApplication':
          config.conditions.push({ type: 'webApplication', value: ann.annBody, matchIfMissing: false })
          break
        case 'ConditionalOnNotWebApplication':
          config.conditions.push({ type: 'notWebApplication', value: ann.annBody, matchIfMissing: false })
          break
        case 'AutoConfigureAfter': {
          const afterClass = ann.annBody.match(/["']([^"']+)["']/)?.[1] || ann.annBody
          config.autoConfigureAfter.push(afterClass)
          break
        }
        case 'AutoConfigureBefore': {
          const beforeClass = ann.annBody.match(/["']([^"']+)["']/)?.[1] || ann.annBody
          config.autoConfigureBefore.push(beforeClass)
          break
        }
        case 'AutoConfigureOrder':
          config.order = parseInt(ann.annBody, 10) || 0
          break
      }
    }

    if (config.conditions.length > 0 || config.autoConfigureAfter.length > 0 || config.autoConfigureBefore.length > 0) {
      queries.insertAnnotation(node.id, 'ConditionalConfig',
        JSON.stringify(config.conditions), node.startLine, moduleId)

      for (const after of config.autoConfigureAfter) {
        const afterNodes = queries.searchNodes(after, 5)
        for (const an of afterNodes) {
          if (an.moduleId === moduleId && an.kind === 'class') {
            queries.insertEdge(node.id, an.id, 'auto_configure_after', JSON.stringify({ order: config.order }), node.startLine, 0)
          }
        }
      }

      for (const before of config.autoConfigureBefore) {
        const beforeNodes = queries.searchNodes(before, 5)
        for (const bn of beforeNodes) {
          if (bn.moduleId === moduleId && bn.kind === 'class') {
            queries.insertEdge(node.id, bn.id, 'auto_configure_before', JSON.stringify({ order: config.order }), node.startLine, 0)
          }
        }
      }

      results.push(config)
    }
  }

  return results
}
