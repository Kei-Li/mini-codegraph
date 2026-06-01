import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode, UnresolvedReference } from '../types.js'
import { matchReference } from './name-matcher.js'
import { resolveViaImportChain, extractJavaImports, extractTypeScriptImports } from './import-resolver.js'
import {
  resolveSpringReference,
  detectSpring,
  extractSpringAnnotations,
  type SpringResolverContext,
} from './frameworks/java.js'
import {
  resolveVueReference,
  detectVue,
  parseVueTemplate,
  extractVueRouterRoutes,
  type VueTemplateInfo,
} from './frameworks/vue.js'
import { synthesizeCallbackEdges, synthesizeMyBatisEdges } from './callback-synthesizer.js'
import { readFileSync } from 'node:fs'
import { join, extname } from 'node:path'

export class ReferenceResolver {
  private queries: QueryManager
  private projectRoot: string
  private moduleId: string
  private allModules: string[]
  private resolvedCount = 0

  constructor(queries: QueryManager, projectRoot: string, moduleId: string, allModules: string[]) {
    this.queries = queries
    this.projectRoot = projectRoot
    this.moduleId = moduleId
    this.allModules = allModules
  }

  async resolveAll(unresolvedRefs: UnresolvedReference[]): Promise<number> {
    const batchSize = 500
    let totalResolved = 0

    const ctx: SpringResolverContext = {
      queries: this.queries,
      projectRoot: this.projectRoot,
      moduleId: this.moduleId,
      allModules: this.allModules,
    }

    for (let i = 0; i < unresolvedRefs.length; i += batchSize) {
      const batch = unresolvedRefs.slice(i, i + batchSize)
      for (const ref of batch) {
        const resolved = this.resolveOne(ref, ctx)
        if (resolved) {
          this.queries.insertEdge(ref.sourceNodeId, resolved.id, ref.kind, ref.metadata, ref.line, ref.col)
          totalResolved++
        }
      }

      if (totalResolved > 0 && i % (batchSize * 2) === 0) {
        this.queries.resolveCallEdges()
      }
    }

    if (totalResolved > 0) {
      this.queries.resolveCallEdges()
    }

    this.resolvedCount = totalResolved

    const synthesizedEdges = synthesizeCallbackEdges(this.queries, this.moduleId)
    for (const edge of synthesizedEdges) {
      this.queries.insertEdge(edge.source, edge.target, edge.kind, edge.metadata, edge.line, edge.col)
    }

    return totalResolved
  }

  private resolveOne(ref: UnresolvedReference, ctx: SpringResolverContext): CodeGraphNode | null {
    const node = this.queries.getNode(ref.sourceNodeId)
    if (!node) return null

    const annotations = this.queries.getAnnotationsByNode(ref.sourceNodeId)
    const hasSpringAnnotation = annotations.some(a =>
      ['Autowired', 'Resource', 'Inject', 'Value', 'FeignClient'].includes(a.annotationName)
    )

    if (hasSpringAnnotation) {
      const springResult = resolveSpringReference(ctx, ref)
      if (springResult) return springResult
    }

    const isVueFile = node.filePath.endsWith('.vue')
    if (isVueFile) {
      const vueResult = resolveVueReference(this.queries, ref, node.filePath, this.moduleId)
      if (vueResult) return vueResult
    }

    if (ref.referenceName.includes('/') || ref.referenceName.startsWith('.')) {
      const resolved = this.resolveImport(ref.referenceName, node)
      if (resolved) return resolved
    }

    const fileImports = this.getFileImports(node.filePath, node.language)
    const importResult = resolveViaImportChain(
      this.queries, ref.referenceName, node.filePath, fileImports, this.moduleId
    )
    if (importResult) return importResult

    const nameResults = matchReference(this.queries, ref.referenceName, node.filePath, this.moduleId)
    for (const r of nameResults) {
      if (r.confidence >= 0.5) return r.node
    }

    return null
  }

  private resolveImport(importPath: string, node: CodeGraphNode): CodeGraphNode | null {
    const ext = extname(node.filePath)
    const sourceDir = node.filePath.substring(0, node.filePath.lastIndexOf('/'))

    let resolvedPath: string | null = null

    if (importPath.startsWith('.')) {
      const parts = importPath.split('/')
      const base = parts[parts.length - 1].replace(/['"]/g, '')
      const dirDepth = importPath.split('/').filter(p => p === '..').length
      let searchDir = sourceDir
      for (let i = 0; i < dirDepth; i++) {
        const idx = searchDir.lastIndexOf('/')
        if (idx > 0) searchDir = searchDir.substring(0, idx)
      }

      const searchExtensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.java']
      for (const searchExt of searchExtensions) {
        const candidate = `${join(this.projectRoot, searchDir, base).replace(/\\/g, '/')}${searchExt}`
        const relCandidate = candidate.replace(this.projectRoot.replace(/\\/g, '/'), '').replace(/^[/\\]/, '')
        const nodes = this.queries.getNodesByFile(relCandidate)
        if (nodes.length > 0) {
          const mainNode = nodes.find(n => ['class', 'interface', 'function', 'module'].includes(n.kind))
          if (mainNode) return mainNode
        }
      }

      const indexFiles = ['index.ts', 'index.js', 'index.tsx', 'index.jsx']
      for (const idxFile of indexFiles) {
        const idxPath = `${join(this.projectRoot, searchDir, base).replace(/\\/g, '/')}/${idxFile}`
        const relIdxPath = idxPath.replace(this.projectRoot.replace(/\\/g, '/'), '').replace(/^[/\\]/, '')
        const idxNodes = this.queries.getNodesByFile(relIdxPath)
        if (idxNodes.length > 0) {
          const mainNode = idxNodes.find(n => n.kind === 'module' || n.isExported)
          if (mainNode) return mainNode
        }
      }
    }

    if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
      const prefix = importPath.startsWith('@/') ? 'src/' : ''
      const basePath = importPath.replace(/^@\//, '').replace(/^~\//, prefix)
      const searchExtensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.java']
      for (const searchExt of searchExtensions) {
        const candidate = `${join(this.projectRoot, basePath).replace(/\\/g, '/')}${searchExt}`
        const relCandidate = candidate.replace(this.projectRoot.replace(/\\/g, '/'), '').replace(/^[/\\]/, '')
        const nodes = this.queries.getNodesByFile(relCandidate)
        if (nodes.length > 0) {
          const mainNode = nodes.find(n => ['class', 'interface', 'function', 'module'].includes(n.kind))
          if (mainNode) return mainNode
        }
      }
    }

    return null
  }

  private getFileImports(filePath: string, language: string): { localName: string; moduleName: string; isDefault: boolean; isNamespace: boolean }[] {
    try {
      const fullPath = join(this.projectRoot, filePath)
      const content = readFileSync(fullPath, 'utf-8')

      if (language === 'java') {
        return extractJavaImports(content)
      }

      if (['typescript', 'vue'].includes(language)) {
        return extractTypeScriptImports(content, filePath)
      }
    } catch {}

    return []
  }

  getResolvedCount(): number {
    return this.resolvedCount
  }
}

export async function runResolutionPipeline(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string,
  allModuleIds: string[]
): Promise<number> {
  const unresolvedRefs = queries.getUnresolvedRefs()
  if (unresolvedRefs.length === 0) return 0

  const resolver = new ReferenceResolver(queries, projectRoot, moduleId, allModuleIds)
  return resolver.resolveAll(unresolvedRefs)
}

export function detectFrameworks(projectRoot: string): string[] {
  const frameworks: string[] = []

  const spring = detectSpring(projectRoot)
  if (spring) frameworks.push(spring.name)

  const vue = detectVue(projectRoot)
  if (vue) frameworks.push(vue.name)

  return frameworks
}

export function extractFileAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): void {
  const lines = source.split('\n')
  const annotationPattern = /@(\w+)\s*(?:\(([^)]*)\))?/g

  let m: RegExpExecArray | null
  while ((m = annotationPattern.exec(source)) !== null) {
    const annName = m[1]
    const annValue = m[2]?.trim() ?? ''
    const lineNum = source.substring(0, m.index).split('\n').length + 1

    for (let j = lineNum - 1; j < Math.min(lineNum + 2, lines.length); j++) {
      const declLine = lines[j]?.trim() ?? ''
      if (declLine && !declLine.startsWith('@') && !declLine.startsWith('import') && !declLine.startsWith('package')) {
        const idMatch = declLine.match(/(?:class|interface|enum|void|\w+)\s+(\w+)/)
        if (idMatch) {
          const nodeCandidates = queries.searchNodes(idMatch[1], 5)
          for (const candidate of nodeCandidates) {
            if (candidate.filePath === filePath) {
              queries.insertAnnotation(candidate.id, annName, annValue, lineNum, moduleId)
            }
          }
        }
        break
      }
    }
  }
}

export function parseAndStoreVueTemplates(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): void {
  const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/)
  if (!templateMatch) return

  const templateContent = templateMatch[1]
  const templateInfo = parseVueTemplate(templateContent)

  queries.upsertTemplate(filePath, 'vue', templateInfo, moduleId)
}

export function extractAndStoreVueRouterRoutes(
  queries: QueryManager,
  projectRoot: string
): void {
  const routes = extractVueRouterRoutes(projectRoot)
  for (const route of routes) {
    const routeId = `route:${route.path}`
    const existingRoute = queries.getNode(routeId)
    if (!existingRoute) {
      queries.searchNodes(route.component, 10)
    }
  }
}
