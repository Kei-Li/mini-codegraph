import type { QueryManager } from '../db/queries.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CloudConfigBinding {
  className: string
  filePath: string
  hasRefreshScope: boolean
  configKey?: string
  configValue?: string
  line: number
  moduleId: string
}

export function indexCloudConfigBindings(
  queries: QueryManager,
  moduleId: string
): CloudConfigBinding[] {
  const results: CloudConfigBinding[] = []
  const refreshNodes = queries.getNodesByAnnotation('RefreshScope')
  const configPropNodes = queries.getNodesByAnnotation('ConfigurationProperties')
    .filter(n => n.moduleId === moduleId)

  const seen = new Set<string>()
  for (const node of refreshNodes) {
    if (node.moduleId !== moduleId || seen.has(node.id)) continue
    seen.add(node.id)

    const b: CloudConfigBinding = {
      className: node.name,
      filePath: node.filePath,
      hasRefreshScope: true,
      line: node.startLine,
      moduleId,
    }

    const match = configPropNodes.find(c => c.id === node.id)
    if (match) {
      const anns = queries.getAnnotationsByNode(match.id)
      const prefixAnn = anns.find(a => a.annotationName === 'ConfigurationProperties')
      if (prefixAnn) {
        b.configKey = prefixAnn.value
      }
    }

    results.push(b)
    queries.insertAnnotation(node.id, 'CloudConfigRef',
      JSON.stringify({ refreshScope: true, configKey: b.configKey }), node.startLine, moduleId)
  }

  return results
}

export function detectBootstrapConfig(projectRoot: string): {
  configServerUri?: string
  configLabel?: string
  enabled: boolean
} {
  const candidates = [
    join(projectRoot, 'bootstrap.yml'),
    join(projectRoot, 'bootstrap.yaml'),
    join(projectRoot, 'bootstrap.properties'),
  ]

  for (const bp of candidates) {
    if (existsSync(bp)) {
      const content = readFileSync(bp, 'utf-8')
      const seps = content.includes(':') ? ':' : '='
      const uriRe = new RegExp(`spring\\.cloud\\.config\\.uri\\s*${seps}\\s*["']?([^"'\\s]+)["']?`)
      const labelRe = new RegExp(`spring\\.cloud\\.config\\.label\\s*${seps}\\s*["']?([^"'\\s]+)["']?`)
      const uriMatch = uriRe.exec(content)
      const labelMatch = labelRe.exec(content)
      const enabled = content.includes('spring.cloud.config')
      return {
        configServerUri: uriMatch?.[1],
        configLabel: labelMatch?.[1],
        enabled,
      }
    }
  }

  const appYml = join(projectRoot, 'application.yml')
  if (existsSync(appYml)) {
    const content = readFileSync(appYml, 'utf-8')
    if (content.includes('spring.cloud.config')) {
      const uriRe = /spring\.cloud\.config\.uri\s*:\s*["']?([^"'\s]+)["']?/
      const uriMatch = uriRe.exec(content)
      return { configServerUri: uriMatch?.[1], enabled: true }
    }
  }

  return { enabled: false }
}
