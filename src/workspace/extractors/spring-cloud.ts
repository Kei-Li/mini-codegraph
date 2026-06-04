import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export class SpringCloudExtractor implements IExtractor {
  name = 'spring-cloud'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const appName = this.detectApplicationName(projectRoot)
    if (!appName) return { provides, consumes }

    const controllerNodes = queries.getNodesByAnnotation('RequestMapping')
    for (const node of controllerNodes) {
      const anns = queries.getAnnotationsByNode(node.id)
      for (const a of anns) {
        if (['RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping'].includes(a.annotationName)) {
          provides.push({
            id: `http.${appName}.${node.name}`,
            name: node.name,
            kind: 'http_endpoint',
            signature: `${a.annotationName} ${a.value}`,
          })
        }
      }
    }

    const feignNodes = queries.getNodesByAnnotation('FeignClient')
    for (const node of feignNodes) {
      const anns = queries.getAnnotationsByNode(node.id)
      for (const a of anns) {
        if (a.annotationName === 'FeignClient') {
          const nameMatch = a.value.match(/name\s*=\s*["'](\w[\w-]*)["']/)
          const targetService = nameMatch?.[1] || ''
          consumes.push({
            symbolId: `feign.${targetService}.${node.name}`,
            referenceType: 'rpc_call',
            sourceLocation: `${node.filePath}:${node.startLine}:${node.startColumn}`,
          })
        }
      }
    }

    const routeNodes = queries.getNodesByAnnotation('Bean')
    for (const node of routeNodes) {
      const anns = queries.getAnnotationsByNode(node.id)
      for (const a of anns) {
        if (a.annotationName === 'Bean' && a.value.includes('RouteLocator')) {
          consumes.push({
            symbolId: `gateway.route.${node.name}`,
            referenceType: 'http_request',
            sourceLocation: `${node.filePath}:${node.startLine}:${node.startColumn}`,
          })
        }
      }
    }

    return { provides, consumes }
  }

  private detectApplicationName(projectRoot: string): string | null {
    for (const fileName of ['application.yml', 'application.yaml', 'application.properties', 'bootstrap.yml', 'bootstrap.yaml']) {
      const filePath = join(projectRoot, 'src', 'main', 'resources', fileName)
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          const nameMatch = content.match(/spring\.application\.name\s*[=:]\s*["']?([\w-]+)["']?/)
          if (nameMatch) return nameMatch[1]
        } catch { /* silent */ }
      }
    }

    const altPaths = [projectRoot]
    for (const dir of altPaths) {
      try {
        const entries = readdirSync(dir)
        for (const e of entries) {
          if (e === 'application.yml' || e === 'application.yaml' || e === 'bootstrap.yml' || e === 'bootstrap.yaml') {
            const content = readFileSync(join(dir, e), 'utf-8')
            const nameMatch = content.match(/spring\.application\.name\s*[=:]\s*["']?([\w-]+)["']?/)
            if (nameMatch) return nameMatch[1]
          }
        }
      } catch { /* silent */ }
    }

    return null
  }
}
