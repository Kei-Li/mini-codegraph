import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export interface EnterpriseFrameworkConfig {
  name: string
  detect: { dependencies?: string[]; files?: string[]; annotations?: string[] }
  annotations: { name: string; kind: string; description: string }[]
}

function loadConfig(miniCodegraphDir: string): EnterpriseFrameworkConfig[] {
  const configPath = join(miniCodegraphDir, 'enterprise-frameworks.yml')
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8')
      return parseYamlFrameworks(content)
    } catch { /* silent */ }
  }
  return DEFAULT_FRAMEWORKS
}

function parseYamlFrameworks(content: string): EnterpriseFrameworkConfig[] {
  const configs: EnterpriseFrameworkConfig[] = []
  const frameworkBlocks = content.split(/(?=^- name:)/m)
  for (const block of frameworkBlocks) {
    const nameMatch = block.match(/name:\s*"([^"]+)"|name:\s*(\S+)/)
    if (!nameMatch) continue
    const name = nameMatch[1] || nameMatch[2]
    const annotations: { name: string; kind: string; description: string }[] = []
    const annRe = /- name:\s*"([^"]+)"[\s\S]*?kind:\s*(\S+)[\s\S]*?description:\s*"([^"]+)"/g
    let am: RegExpExecArray | null
    while ((am = annRe.exec(block)) !== null) {
      annotations.push({ name: am[1], kind: am[2], description: am[3] })
    }
    configs.push({ name, detect: {}, annotations })
  }
  return configs
}

const DEFAULT_FRAMEWORKS: EnterpriseFrameworkConfig[] = [
  {
    name: 'myapp-core',
    detect: { dependencies: ['myapp-core'] },
    annotations: [
      { name: 'EnableCustomAudit', kind: 'feature_flag', description: '启用自定义审计' },
      { name: 'MyService', kind: 'service_annotation', description: '标记为业务服务' },
    ],
  },
]

export class EnterpriseFrameworksExtractor implements IExtractor {
  name = 'enterprise-frameworks'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const miniCodegraphDir = join(projectRoot, '.mini-codegraph')
    const configs = existsSync(miniCodegraphDir)
      ? loadConfig(miniCodegraphDir)
      : DEFAULT_FRAMEWORKS

    for (const framework of configs) {
      let detected = false

      if (framework.detect.dependencies) {
        const pomPath = join(projectRoot, 'pom.xml')
        if (existsSync(pomPath)) {
          try {
            const content = readFileSync(pomPath, 'utf-8')
            for (const dep of framework.detect.dependencies) {
              if (content.includes(dep.replace('*', ''))) {
                detected = true
                break
              }
            }
          } catch { /* silent */ }
        }
      }

      if (!detected) continue

      const moduleId = projectRoot.split(/[/\\]/).pop() || 'unknown'

      for (const ann of framework.annotations) {
        const nodes = queries.getNodesByAnnotation(ann.name)
        for (const node of nodes) {
          const id = `ent:${framework.name}:${ann.name}:${node.id}`
          queries.insertEnterpriseAnnotation(id, framework.name, ann.name, node.id, ann.kind, ann.description, node.filePath, moduleId)

          provides.push({
            id,
            name: `@${ann.name}`,
            kind: ann.kind,
            signature: `${framework.name}: ${ann.description}`,
          })
        }
      }
    }

    return { provides, consumes }
  }
}
