import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { CodeGraphNode, UnresolvedReference, AnnotationInfo, FrameworkDetectionResult } from '../../types.js'
import { matchReference } from '../name-matcher.js'

export interface SpringResolverContext {
  queries: QueryManager
  projectRoot: string
  moduleId: string
  allModules: string[]
}

const SPRING_ANNOTATIONS = [
  'Autowired', 'Resource', 'Inject', 'Value',
  'FeignClient', 'RestController', 'Controller', 'Service',
  'Repository', 'Component', 'Configuration',
  'ConfigurationProperties', 'RequestMapping',
  'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
  'Bean', 'Qualifier', 'Primary',
  'Transactional', 'Cacheable', 'CacheEvict', 'Async',
  'Scheduled', 'EventListener',
  'SpringBootApplication', 'EnableAutoConfiguration',
  'RequestBody', 'RequestParam', 'PathVariable',
  'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
]

export function detectSpring(projectRoot: string): FrameworkDetectionResult | null {
  const pomPath = join(projectRoot, 'pom.xml')
  const buildGradlePath = join(projectRoot, 'build.gradle')
  const buildGradleKtsPath = join(projectRoot, 'build.gradle.kts')

  if (existsSync(pomPath)) {
    try {
      const content = readFileSync(pomPath, 'utf-8')
      if (content.includes('spring-boot') || content.includes('springframework')) {
        return { name: 'spring-boot', version: 'detected', confidence: 0.9 }
      }
    } catch {}
  }

  if (existsSync(buildGradlePath)) {
    try {
      const content = readFileSync(buildGradlePath, 'utf-8')
      if (content.includes('spring-boot') || content.includes('springframework')) {
        return { name: 'spring-boot', version: 'detected', confidence: 0.9 }
      }
    } catch {}
  }

  if (existsSync(buildGradleKtsPath)) {
    try {
      const content = readFileSync(buildGradleKtsPath, 'utf-8')
      if (content.includes('spring-boot') || content.includes('springframework')) {
        return { name: 'spring-boot', version: 'detected', confidence: 0.9 }
      }
    } catch {}
  }

  const srcDir = join(projectRoot, 'src')
  if (existsSync(srcDir)) {
    try {
      const entries = readdirSync(srcDir, { recursive: true }) as string[]
      const sampleFiles = entries.filter(e => e.endsWith('.java')).slice(0, 20)
      for (const f of sampleFiles) {
        try {
          const content = readFileSync(join(srcDir, f), 'utf-8')
          if (content.includes('@SpringBootApplication') || content.includes('@RestController')) {
            return { name: 'spring-boot', version: 'detected', confidence: 0.8 }
          }
        } catch {}
      }
    } catch {}
  }

  return null
}

export function resolveSpringReference(
  ctx: SpringResolverContext,
  ref: UnresolvedReference
): CodeGraphNode | null {
  const refName = ref.referenceName
  const node = ctx.queries.getNode(ref.sourceNodeId)
  if (!node) return null

  const annotations = ctx.queries.getAnnotationsByNode(ref.sourceNodeId)
  const annotationNames = annotations.map(a => a.annotationName)

  if (annotationNames.includes('Autowired') || annotationNames.includes('Resource') || annotationNames.includes('Inject')) {
    return resolveAutowiredBean(ctx, refName, node)
  }

  if (annotationNames.includes('Value') && refName.startsWith('$')) {
    return resolveConfigValue(ctx, refName)
  }

  if (annotationNames.includes('FeignClient')) {
    return resolveFeignClientTarget(ctx, refName, node)
  }

  if (node.kind === 'interface' && node.name.endsWith('Client')) {
    const feignAnn = annotations.find(a => a.annotationName === 'FeignClient')
    if (feignAnn || annotationNames.includes('FeignClient')) {
      return resolveFeignClientTarget(ctx, refName, node)
    }
  }

  if (node.kind === 'interface' && (node.name.endsWith('Service') || node.name.endsWith('Repository'))) {
    return resolveServiceInterface(ctx, node)
  }

  if (node.kind === 'class') {
    if (node.name.endsWith('ServiceImpl') || node.name.endsWith('RepositoryImpl')) {
      return resolveServiceImpl(ctx, node)
    }
  }

  if (refName.includes('.')) {
    const parts = refName.split('.')
    const parentName = parts[0]
    const parentCandidates = ctx.queries.searchNodes(parentName, 10)
    for (const parent of parentCandidates) {
      if (['class', 'interface'].includes(parent.kind)) {
        const children = ctx.queries.getChildren(parent.id)
        const child = children.find(c => c.name === parts.slice(1).join('.'))
        if (child) return child
      }
    }
  }

  return null
}

function resolveAutowiredBean(
  ctx: SpringResolverContext,
  refName: string,
  node: CodeGraphNode
): CodeGraphNode | null {
  const matches = matchReference(ctx.queries, refName, node.filePath, ctx.moduleId, 'class')
  for (const m of matches) {
    if (m.node.moduleId === ctx.moduleId || ctx.allModules.includes(m.node.moduleId ?? '')) {
      return m.node
    }
  }

  const implSearch = ctx.queries.searchNodes(`${refName}Impl`, 10)
  for (const impl of implSearch) {
    if (impl.kind === 'class') return impl
  }

  if (refName.startsWith('I') && /^I[A-Z]/.test(refName)) {
    const baseName = refName.slice(1)
    const baseResults = ctx.queries.searchNodes(baseName, 10)
    for (const b of baseResults) {
      if (b.kind === 'class') return b
    }
  }

  return null
}

function resolveConfigValue(
  ctx: SpringResolverContext,
  refName: string
): CodeGraphNode | null {
  const key = refName.replace(/\$\{([^}]+)\}.*/, '$1').trim()
  const configDir = join(ctx.projectRoot, 'src', 'main', 'resources')
  const configFiles = ['application.yml', 'application.yaml', 'application.properties']

  for (const cf of configFiles) {
    const configPath = join(configDir, cf)
    if (!existsSync(configPath)) continue
    try {
      const content = readFileSync(configPath, 'utf-8')
      if (content.includes(key)) {
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(key)) {
            const configKey = `config:${key}`
            const existingNodes = ctx.queries.searchNodes(configKey, 5)
            if (existingNodes.length > 0) return existingNodes[0]
          }
        }
      }
    } catch {}
  }

  return null
}

function resolveFeignClientTarget(
  ctx: SpringResolverContext,
  refName: string,
  feignInterface: CodeGraphNode
): CodeGraphNode | null {
  const feignName = feignInterface.name.replace('Client', '')
  const targetService = refName.replace('Client', '')

  for (const moduleId of ctx.allModules) {
    if (moduleId === ctx.moduleId) continue
    const controllers = ctx.queries.getNodesByAnnotation('RestController')
    for (const ctrl of controllers) {
      if (ctrl.moduleId === moduleId &&
          (ctrl.name.toLowerCase().includes(targetService.toLowerCase()) ||
           ctrl.name.toLowerCase().includes(feignName.toLowerCase()))) {
        const children = ctx.queries.getChildren(ctrl.id)
        for (const child of children) {
          const childAnns = ctx.queries.getAnnotationsByNode(child.id)
          for (const ann of childAnns) {
            if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(ann.annotationName)) {
              return child
            }
          }
        }
        return ctrl
      }
    }
  }

  const nonLocal = ctx.queries.searchNodes(feignInterface.name, 50)
    .filter(n => n.moduleId && n.moduleId !== ctx.moduleId)
  if (nonLocal.length > 0) return nonLocal[0]

  return null
}

function resolveServiceInterface(ctx: SpringResolverContext, iface: CodeGraphNode): CodeGraphNode | null {
  const implName = iface.name.endsWith('Service') ? `${iface.name}Impl` : iface.name
  const impls = ctx.queries.searchNodes(implName, 10)
  for (const impl of impls) {
    if (impl.kind === 'class') return impl
  }

  if (iface.name.startsWith('I') && /^I[A-Z]/.test(iface.name)) {
    const baseName = iface.name.slice(1)
    const baseImpls = ctx.queries.searchNodes(`${baseName}Impl`, 10)
    for (const impl of baseImpls) {
      if (impl.kind === 'class') return impl
    }
  }

  return null
}

function resolveServiceImpl(ctx: SpringResolverContext, impl: CodeGraphNode): CodeGraphNode | null {
  const ifaceName = impl.name.replace('Impl', '')
  const ifaces = ctx.queries.searchNodes(ifaceName, 10)
  for (const iface of ifaces) {
    if (iface.kind === 'interface') return iface
  }

  return null
}

export function extractSpringAnnotations(
  source: string,
  filePath: string,
  moduleId: string
): AnnotationInfo[] {
  const annotations: AnnotationInfo[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const annotationMatch = line.match(/@(\w+)\s*(?:\(([^)]*)\))?/)
    if (annotationMatch) {
      const annName = annotationMatch[1]
      if (SPRING_ANNOTATIONS.includes(annName)) {
        const value = annotationMatch[2]?.trim() ?? ''
        let targetNodeLine = i + 1
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim()
          if (nextLine && !nextLine.startsWith('@') && !nextLine.startsWith('import') && !nextLine.startsWith('package')) {
            const declMatch = nextLine.match(/(?:public|private|protected|static|\s)*(?:class|interface|enum|void|\w+)\s+(\w+)/)
            if (declMatch) targetNodeLine = j + 1
            break
          }
        }
        annotations.push({
          annotationName: annName,
          value,
          line: targetNodeLine,
          nodeId: `${filePath}:@${annName}:${targetNodeLine}`,
        })
      }
    }
  }

  return annotations
}

export function isSpringProject(projectRoot: string): boolean {
  return detectSpring(projectRoot) !== null
}

export function findMulitModuleProjects(parentDir: string): string[] {
  const modules: string[] = []

  const pomPath = join(parentDir, 'pom.xml')
  if (existsSync(pomPath)) {
    try {
      const content = readFileSync(pomPath, 'utf-8')
      const moduleRegex = /<module>([^<]+)<\/module>/g
      let m: RegExpExecArray | null
      while ((m = moduleRegex.exec(content)) !== null) {
        modules.push(join(parentDir, m[1].trim()))
      }
    } catch {}
  }

  const settingsGradle = join(parentDir, 'settings.gradle')
  if (existsSync(settingsGradle)) {
    try {
      const content = readFileSync(settingsGradle, 'utf-8')
      const includeRegex = /include\s+['"]([^'"]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = includeRegex.exec(content)) !== null) {
        modules.push(join(parentDir, m[1].trim().replace(':', '/')))
      }
    } catch {}
  }

  const entries = readdirSync(parentDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const subPath = join(parentDir, entry.name)
    if (existsSync(join(subPath, 'pom.xml')) || existsSync(join(subPath, 'build.gradle')) ||
        existsSync(join(subPath, 'package.json')) && !modules.includes(subPath)) {
      modules.push(subPath)
    }
  }

  return [...new Set(modules)]
}
