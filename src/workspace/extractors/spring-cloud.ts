import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

function safeJsonParse(text: string): any {
  try { return JSON.parse(text) } catch { return {} }
}

const HTTP_VERBS = ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping']

export class SpringCloudExtractor implements IExtractor {
  name = 'spring-cloud'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const appName = this.detectApplicationName(projectRoot)
    if (!appName) return { provides, consumes }

    // F2: Controller endpoints → provides (with security metadata)
    const controllerNodes = queries.getNodesByAnnotation('RequestMapping')
    for (const node of controllerNodes) {
      const anns = queries.getAnnotationsByNode(node.id)
      for (const a of anns) {
        if (['RequestMapping', ...HTTP_VERBS].includes(a.annotationName)) {
          const secAnns = queries.getAnnotationsByNode(node.id)
            .filter(s => ['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed', 'PreFilter', 'PostFilter', 'PermitAll', 'DenyAll'].includes(s.annotationName))
          const secMeta = secAnns.map(s => `${s.annotationName}(${s.value})`).join('; ')
          provides.push({
            id: `http.${appName}.${node.name}`,
            name: node.name,
            kind: 'http_endpoint',
            signature: secMeta ? `${a.annotationName} ${a.value} | secured: ${secMeta}` : `${a.annotationName} ${a.value}`,
          })
        }
      }
    }

    // FeignClient → consumes
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
          const children = queries.getChildren(node.id)
          for (const child of children) {
            const methodAnns = queries.getAnnotationsByNode(child.id)
            for (const ma of methodAnns) {
              if ([...HTTP_VERBS, 'RequestMapping'].includes(ma.annotationName)) {
                const httpMethod = ma.annotationName === 'RequestMapping' ? 'ANY'
                  : ma.annotationName.replace('Mapping', '').toUpperCase()
                const path = ma.value.replace(/["']/g, '')
                consumes.push({
                  symbolId: `feign.${targetService}.${child.name}${path}`,
                  referenceType: 'rpc_call',
                  sourceLocation: `${child.filePath}:${child.startLine}:${child.startColumn}`,
                })
              }
            }
          }
        }
      }
    }

    // @LoadBalancedClient → consumes
    const lbNodes = queries.getNodesByAnnotation('LoadBalancedClient')
    for (const node of lbNodes) {
      const anns = queries.getAnnotationsByNode(node.id)
      for (const a of anns) {
        if (a.annotationName === 'LoadBalancedClient') {
          try {
            const meta = safeJsonParse(a.value)
            if (meta.serviceName) {
              consumes.push({
                symbolId: `resttemplate.${meta.serviceName}.${meta.fieldName || node.name}`,
                referenceType: 'rpc_call',
                sourceLocation: `${node.filePath}:${node.startLine}:${node.startColumn}`,
              })
            }
          } catch { /* silent */ }
        }
      }
    }

    // F3: Plain RestTemplate calls via URL → consumes (http://SERVICE_NAME/...)
    const restTemplateCalls = this.detectPlainRestTemplateCalls(projectRoot)
    for (const call of restTemplateCalls) {
      consumes.push(call)
    }

    // F3: WebClient builder calls → consumes
    const webClientCalls = this.detectWebClientCalls(projectRoot)
    for (const call of webClientCalls) {
      consumes.push(call)
    }

    // RouteLocator Bean → consumes
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

  private detectPlainRestTemplateCalls(projectRoot: string): ExtractionOutput['consumes'] {
    const calls: ExtractionOutput['consumes'] = []
    const srcDir = join(projectRoot, 'src')
    if (!existsSync(srcDir)) return calls

    const files = this.collectJavaFiles(srcDir)
    const serviceUrlPattern = /(?:restTemplate|restOps|this\.restTemplate)\s*\.\s*(?:getForObject|getForEntity|postForObject|postForEntity|put|delete|exchange|execute)\(\s*["'](https?:\/\/([\w-]+)\/[^"']*)["']/gi
    const directUrlPattern = /["'](https?:\/\/([\w-]+)\/[^"']*)["']/g

    for (const f of files) {
      try {
        const content = readFileSync(f, 'utf-8')
        let m: RegExpExecArray | null
        while ((m = serviceUrlPattern.exec(content)) !== null) {
          const serviceName = m[2]
          const fullUrl = m[1]
          calls.push({
            symbolId: `resttemplate.${serviceName}.${fullUrl}`,
            referenceType: 'rpc_call',
            sourceLocation: `${f}:${content.substring(0, m.index).split('\n').length}:1`,
          })
        }
      } catch { /* silent */ }
    }

    return calls
  }

  private detectWebClientCalls(projectRoot: string): ExtractionOutput['consumes'] {
    const calls: ExtractionOutput['consumes'] = []
    const srcDir = join(projectRoot, 'src')
    if (!existsSync(srcDir)) return calls

    const files = this.collectJavaFiles(srcDir)
    const webClientPattern = /(?:webClient|this\.webClient|WebClient\.create)\s*\.\s*(?:get|post|put|delete)\s*\(\s*\)\s*\.\s*uri\s*\(\s*["'](https?:\/\/([\w-]+)\/[^"']*)["']/gi

    for (const f of files) {
      try {
        const content = readFileSync(f, 'utf-8')
        let m: RegExpExecArray | null
        while ((m = webClientPattern.exec(content)) !== null) {
          const serviceName = m[2]
          const fullUrl = m[1]
          calls.push({
            symbolId: `webclient.${serviceName}.${fullUrl}`,
            referenceType: 'rpc_call',
            sourceLocation: `${f}:${content.substring(0, m.index).split('\n').length}:1`,
          })
        }
      } catch { /* silent */ }
    }

    return calls
  }

  private collectJavaFiles(dir: string): string[] {
    const files: string[] = []
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) files.push(...this.collectJavaFiles(full))
        else if (e.name.endsWith('.java')) files.push(full)
      }
    } catch { /* silent */ }
    return files
  }

  private detectApplicationName(projectRoot: string): string | null {
    for (const fileName of ['application.yml', 'application.yaml', 'application.properties', 'bootstrap.yml', 'bootstrap.yaml']) {
      const filePath = join(projectRoot, 'src', 'main', 'resources', fileName)
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          const nameMatch = content.match(/spring\.application\.name\s*[=:]\s*["']?([\w-]+)["']?/)
          if (nameMatch) return nameMatch[1]
          const yamlMatch = content.match(/^spring:\s*\n\s+application:\s*\n\s+name:\s*["']?([\w-]+)["']?/m)
          if (yamlMatch) return yamlMatch[1]
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
            const yamlMatch = content.match(/^spring:\s*\n\s+application:\s*\n\s+name:\s*["']?([\w-]+)["']?/m)
            if (yamlMatch) return yamlMatch[1]
          }
        }
      } catch { /* silent */ }
    }

    return null
  }
}
