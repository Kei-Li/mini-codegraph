import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode, SearchResult, FileRecord } from '../types.js'
import { GraphTraverser } from './traversal.js'
import type { PathHop } from './traversal.js'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { detectRoutes, type RouteInfo } from '../extraction/routes.js'
import { isGeneratedFile, rankBoost } from '../generated.js'
import { CodeAnalyzer } from '../analysis/index.js'
import type {
  ComplexityResult, CircularDepResult, HotPathResult,
  DeadImportResult, EntryPointResult, SimilarCodeResult,
} from '../analysis/index.js'

export class GraphQueryManager {
  private queries: QueryManager
  private traverser: GraphTraverser
  private analyzer: CodeAnalyzer
  private projectRoot: string
  private lastSyncTime = 0
  private pendingFiles: Set<string> = new Set()

  constructor(queries: QueryManager, projectRoot: string) {
    this.queries = queries
    this.traverser = new GraphTraverser(queries)
    this.analyzer = new CodeAnalyzer(queries, projectRoot)
    this.projectRoot = projectRoot
  }

  search(query: string, limit = 20): SearchResult[] {
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
      'through', 'during', 'before', 'after', 'above', 'below', 'between', 'and',
      'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
      'this', 'that', 'these', 'those', 'it', 'its', 'get', 'set', 'find', 'put',
      'all', 'each', 'every', 'some', 'any', 'no', 'none', 'if', 'then', 'else',
      'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'why'])

    const queryTerms = query.toLowerCase().split(/[\s_]+/).filter(t =>
      t.length > 1 && !stopWords.has(t)
    )
    const querySet = new Set(queryTerms)

    function semanticScore(node: CodeGraphNode): number {
      let matches = 0
      const text = [
        node.name, node.qualifiedName,
        node.docstring, node.signature,
      ].join(' ').toLowerCase()

      for (const term of queryTerms) {
        if (text.includes(term)) matches++
      }
      return queryTerms.length > 0 ? matches / queryTerms.length : 0
    }

    const results = this.queries.searchNodesWithRank(query, limit * 5)
    const scored = results.map(({ node, rank }) => {
      const snippets = this.getSnippets(node, 3)
      const boost = rankBoost(node.filePath)
      const semantic = semanticScore(node)
      // BM25 rank is in negative-log form (lower = better), convert to 0-1 score
      const bm25Score = Math.max(0, 1 - Math.abs(rank) / 100)
      const score = bm25Score * 0.5 + semantic * 0.3 + (1 + boost) * 0.2
      return { node, snippets, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  getNode(id: string): CodeGraphNode | undefined {
    return this.queries.getNode(id)
  }

  getCallers(nodeId: string): CodeGraphNode[] {
    return this.queries.getCallers(nodeId)
  }

  getCallees(nodeId: string): CodeGraphNode[] {
    return this.queries.getCallees(nodeId)
  }

  getChildren(nodeId: string): CodeGraphNode[] {
    return this.queries.getChildren(nodeId)
  }

  getParent(nodeId: string): CodeGraphNode | undefined {
    return this.queries.getParent(nodeId)
  }

  getContext(nodeId: string): {
    node: CodeGraphNode | undefined
    parent: CodeGraphNode | undefined
    children: CodeGraphNode[]
    callers: CodeGraphNode[]
    callees: CodeGraphNode[]
    implementations: CodeGraphNode[]
    crossServiceCallees: { node: CodeGraphNode; detail: string }[]
  } {
    const node = this.queries.getNode(nodeId)
    return {
      node,
      parent: this.queries.getParent(nodeId),
      children: this.queries.getChildren(nodeId),
      callers: this.queries.getCallers(nodeId),
      callees: this.queries.getCallees(nodeId),
      implementations: node ? this.traverser.findImplementations(node) : [],
      crossServiceCallees: node ? this.traverser.findCrossServiceCallees(node) : [],
    }
  }

  getFileNodes(filePath: string): CodeGraphNode[] {
    return this.queries.getNodesByFile(filePath)
  }

  findPath(from: string, to: string): PathHop[][] {
    return this.traverser.findPath(from, to)
  }

  findDynamicDispatch(fromNode: CodeGraphNode): { node: CodeGraphNode; detail: string }[] {
    const results: { node: CodeGraphNode; detail: string }[] = []

    const implCallers = this.traverser.findInterfaceCallers(fromNode)
    for (const ic of implCallers) {
      results.push({ node: ic, detail: `implements ${fromNode.name}` })
    }

    const ifaces = this.traverser.findInterfaceForImpl(fromNode)
    for (const iface of ifaces) {
      const ifaceCallers = this.getCallers(iface.id)
      for (const caller of ifaceCallers) {
        results.push({ node: caller, detail: `via ${iface.name}` })
      }
    }

    return results
  }

  findCallbackTargets(node: CodeGraphNode): { node: CodeGraphNode; detail: string }[] {
    return this.traverser.findCallbackTargets(node)
  }

  findReactTargets(node: CodeGraphNode): { node: CodeGraphNode; detail: string }[] {
    return this.traverser.findReactTargets(node)
  }

  getImpact(nodeId: string, depth = 2): CodeGraphNode[] {
    const impacted = this.traverser.findImpactedNodes(nodeId, depth)
    const filtered = Array.from(impacted.values()).filter(n => !isGeneratedFile(n.filePath))
    return filtered
  }

  findRelated(nodeIds: string[]): Map<string, { node: CodeGraphNode; relationships: string[] }> {
    return this.traverser.findRelated(nodeIds)
  }

  findDeadCode(): CodeGraphNode[] {
    return this.traverser.findDeadCode()
  }

  findAffectedTestFiles(sourceFiles: string[]): {
    testFile: string
    matchedSymbols: string[]
    confidence: number
  }[] {
    return this.traverser.findAffectedTestFiles(sourceFiles)
  }

  getRoutes(): RouteInfo[] {
    return detectRoutes(this.projectRoot, this.queries, this)
  }

  getStats(): { files: number; nodes: number; edges: number } {
    return this.queries.getStats()
  }

  getFileListing(pattern?: string): { path: string; language: string; nodeCount: number }[] {
    const files = this.queries.getAllFiles()
    if (!pattern) {
      return files.map(f => ({ path: f.path, language: f.language, nodeCount: f.nodeCount }))
    }

    const picomatch = require('picomatch')
    const matcher = picomatch(pattern)
    return files
      .filter(f => matcher(f.path))
      .map(f => ({ path: f.path, language: f.language, nodeCount: f.nodeCount }))
  }

  getSnippets(node: CodeGraphNode, contextLines: number): string[] {
    try {
      const fullPath = join(this.projectRoot, node.filePath)
      const content = readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')

      const start = Math.max(0, node.startLine - 1 - contextLines)
      const end = Math.min(lines.length, node.endLine + contextLines)
      return lines.slice(start, end)
    } catch {
      return []
    }
  }

  getProjectRoot(): string {
    return this.projectRoot
  }

  getCyclomaticComplexity(nodeId: string): ComplexityResult | null {
    const node = this.queries.getNode(nodeId)
    if (!node) return null
    return this.analyzer.computeCyclomaticComplexity(node)
  }

  findCircularDeps(): CircularDepResult[] {
    return this.analyzer.findCircularDeps()
  }

  findHotPaths(topN = 20): HotPathResult[] {
    return this.analyzer.findHotPaths(topN)
  }

  findDeadImports(): DeadImportResult[] {
    return this.analyzer.findDeadImports()
  }

  findEntryPoints(): EntryPointResult[] {
    return this.analyzer.findEntryPoints()
  }

  findSimilarCode(nodeId: string): SimilarCodeResult[] {
    const node = this.queries.getNode(nodeId)
    if (!node) return []
    return this.analyzer.findSimilarCode(node)
  }

  markSyncComplete(): void {
    this.lastSyncTime = Date.now()
    this.pendingFiles.clear()
  }

  markFilePending(filePath: string): void {
    this.pendingFiles.add(filePath)
  }

  getStalenessWarning(): string | null {
    if (this.pendingFiles.size === 0) return null

    const files = Array.from(this.pendingFiles).slice(0, 5)
    const more = this.pendingFiles.size > 5 ? ` and ${this.pendingFiles.size - 5} more` : ''
    return `Index stale: ${files.join(', ')}${more} changed but not re-indexed`
  }

  checkStaleFiles(): void {
    const allFiles = this.queries.getAllFiles()
    for (const f of allFiles) {
      try {
        const fullPath = join(this.projectRoot, f.path)
        const st = statSync(fullPath)
        if (st.mtimeMs > f.modifiedAt) {
          this.pendingFiles.add(f.path)
        }
      } catch {}
    }
  }
}
