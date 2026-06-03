import { readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { GraphQueryManager } from '../graph/queries.js'
import type { MiniCodeGraphNode } from '../types.js'
import { OutputBudget, classifyFilePath } from './budget.js'
import { formatContextAsMarkdown } from './formatter.js'
import { collapsePolymorphicSiblings, formatPolymorphGroup, type CollapsedGroup } from './polymorph.js'
import { computePathRelevance } from '../generated.js'

type QM = QueryManager

export interface ContextSymbol {
  id: string
  name: string
  kind: string
  qualifiedName: string
  filePath: string
  lines: string
  startLine: number
  signature: string
  docstring: string
  moduleId?: string
  code: string
  callers: { name: string; filePath: string }[]
  callees: { name: string; filePath: string }[]
  implementations: { name: string; filePath: string }[]
  relatedRoutes?: { path: string; method: string }[]
  collapsedSiblings?: { name: string; filePath: string }[]
}

export class ContextBuilder {
  private queries: QM
  private graph: GraphQueryManager
  private projectRoot: string
  private budget: OutputBudget

  constructor(queries: QM, graph: GraphQueryManager, projectRoot: string) {
    this.queries = queries
    this.graph = graph
    this.projectRoot = projectRoot
    this.budget = new OutputBudget(queries.getAllFiles().length)
  }

  getBudget(): OutputBudget {
    return this.budget
  }

  async buildContext(task: string): Promise<{
    task: string
    symbols: ContextSymbol[]
    stats: { totalFiles: number; modules: number; nodes: number; edges: number }
    routes?: { path: string; method: string; handler: string }[]
    collapseNotes?: string[]
    _session?: { budget: string; projectFiles: number; sufficient: boolean; suggestion: string }
  }> {
    const stats = this.queries.getStats()
    const allFiles = this.queries.getAllFiles()

    // Step 1: Parse task → extract candidate symbol names
    const searchTerms = this.extractSearchTerms(task)

    // Step 2: FTS5 full-text search for each term
    const candidates = new Map<string, { node: MiniCodeGraphNode; rank: number }>()
    for (const term of searchTerms.slice(0, 5)) {
      const results = this.queries.searchNodesWithRank(term, 10)
      for (const r of results) {
        const existing = candidates.get(r.node.id)
        if (!existing || existing.rank < r.rank) {
          candidates.set(r.node.id, r)
        }
      }
    }

    // Step 3: CamelCase / snake_case / SCREAMING_SNAKE pattern matching
    this.addPatternMatches(task, candidates)

    // Step 4: Prefix-based definition search (class/interface/struct prefixes)
    this.addDefinitionSearches(task, candidates)

    // Step 5: Multi-term compound matching
    if (searchTerms.length >= 2) {
      const compound = this.queries.searchNodesWithRank(searchTerms.join(' '), 10)
      for (const r of compound) {
        if (!candidates.has(r.node.id)) candidates.set(r.node.id, r)
      }
    }

    // Step 6: Sort by rank, cap by budget
    const sorted = Array.from(candidates.values())
      .sort((a, b) => b.rank - a.rank)
      .slice(0, this.budget.totalBudget)

    // Step 7: Graph expansion (BFS from entry points)
    const expanded = this.expandGraph(sorted.map(r => r.node), searchTerms)

    // Step 8: Type hierarchy expansion (ancestors + descendants)
    const withHierarchy = this.expandTypeHierarchy(expanded)

    // Step 9: Edge recovery between selected nodes
    const withEdges = this.recoverEdges(withHierarchy)

    // Step 10: Per-file diversity cap
    const capped = this.applyDiversityCap(withEdges)

    // Step 11: Non-production file cap
    const finalNodes = this.applyNonProductionCap(capped)

    // Step 11.5: Polymorphic sibling collapsing (for large projects)
    let collapseNotes: string[] = []
    const collapsedOrNodes = this.budget.shouldCollapse()
      ? collapsePolymorphicSiblings(finalNodes, this.queries, 3)
      : finalNodes

    // Step 12: Code block extraction
    const symbols = await this.extractCodeBlocks(
      collapsedOrNodes.filter((n): n is MiniCodeGraphNode => !('collapsedCount' in n))
    )

    // Step 12.5: Append collapse info as context notes
    const collapsedGroups = collapsedOrNodes
      .filter((n): n is CollapsedGroup => 'collapsedCount' in n)
    collapseNotes = collapsedGroups.map(g => formatPolymorphGroup(g))

    // Attach collapsed siblings to their representative symbols
    for (const group of collapsedGroups) {
      const sym = symbols.find(s => s.id === group.representative.id)
      if (sym) {
        sym.collapsedSiblings = group.siblings.filter(
          s => s.name !== group.representative.name || s.filePath !== group.representative.filePath
        )
      }
    }

    // Step 13: Co-location boosting + core-directory boosting (sorting)
    const dominantFile = this.findDominantFile(symbols)
    symbols.sort((a, b) => {
      if (a.filePath === dominantFile && b.filePath !== dominantFile) return -1
      if (b.filePath === dominantFile && a.filePath !== dominantFile) return 1
      return 0
    })

    // Step 14: Auto-trace for flow-related questions
    const flowTerms = ['flow', 'call', 'path', 'trace', 'chain', 'sequence', '从.*到', '怎么.*调用']
    const needsTrace = flowTerms.some(t => new RegExp(t, 'i').test(task))
    if (needsTrace && symbols.length >= 2) {
      const traces = await this.autoTrace(symbols)
      for (const t of traces) {
        for (const s of symbols) {
          if (t.sourceId === s.id) {
            s.callees.push(...t.callees.filter(c => !s.callees.find(cc => cc.name === c.name)))
          }
        }
      }
    }

    // Step 15: Routing manifest inline for small repos
    let routes: { path: string; method: string; handler: string }[] | undefined
    if (this.budget.isSufficientForRouting()) {
      routes = this.extractRoutes(symbols)
    }

    return {
      task,
      symbols,
      stats: {
        totalFiles: allFiles.length,
        modules: stats.modules,
        nodes: stats.nodes,
        edges: stats.edges,
      },
      routes,
      collapseNotes: collapseNotes.length > 0 ? collapseNotes : undefined,
      _session: {
        budget: this.budget.getTier(),
        projectFiles: allFiles.length,
        sufficient: this.budget.isSufficientForRouting(),
        suggestion: 'Use Grep/Glob/Bash tools for further exploration beyond this context.',
      },
    }
  }

  private extractSearchTerms(task: string): string[] {
    const terms = task
      .split(/\s+/)
      .map(t => t.replace(/[^a-zA-Z0-9_]/g, ''))
      .filter(t => t.length > 2 && !['the', 'and', 'for', 'this', 'that', 'with', 'from', 'what', 'how', 'why', 'when', 'which', 'where', 'does', 'can', 'will'].includes(t.toLowerCase()))
    return terms
  }

  private addPatternMatches(task: string, candidates: Map<string, { node: MiniCodeGraphNode; rank: number }>): void {
    const patterns = task.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)*/g)
    if (!patterns) return
    for (const p of patterns) {
      const results = this.queries.searchNodesWithRank(p, 5)
      for (const r of results) {
        if (!candidates.has(r.node.id)) candidates.set(r.node.id, r)
      }
    }
  }

  private addDefinitionSearches(task: string, candidates: Map<string, { node: MiniCodeGraphNode; rank: number }>): void {
    const prefixes = ['class ', 'interface ', 'struct ', 'trait ', 'enum ', 'function ', 'type ']
    for (const prefix of prefixes) {
      const match = task.match(new RegExp(`${prefix}(\\w+)`, 'i'))
      if (match) {
        const results = this.queries.searchNodesWithRank(match[1], 5)
        for (const r of results) {
          if (!candidates.has(r.node.id)) candidates.set(r.node.id, r)
        }
      }
    }
  }

  private expandGraph(nodes: MiniCodeGraphNode[], terms: string[]): MiniCodeGraphNode[] {
    const expanded = new Map<string, MiniCodeGraphNode>()
    for (const n of nodes) expanded.set(n.id, n)

    for (const n of nodes) {
      const callers = this.queries.getCallers(n.id)
      for (const c of callers) {
        if (!expanded.has(c.id) && expanded.size < this.budget.totalBudget * 2) {
          const callerScore = terms.some(t => c.name.toLowerCase().includes(t.toLowerCase())) ? 0.5 : 0.1
          expanded.set(c.id, c)
        }
      }
      const callees = this.queries.getCallees(n.id)
      for (const c of callees) {
        if (!expanded.has(c.id) && expanded.size < this.budget.totalBudget * 2) {
          expanded.set(c.id, c)
        }
      }
    }

    return Array.from(expanded.values())
  }

  private expandTypeHierarchy(nodes: MiniCodeGraphNode[]): MiniCodeGraphNode[] {
    const result = new Map<string, MiniCodeGraphNode>()
    for (const n of nodes) result.set(n.id, n)

    for (const n of nodes) {
      if (['interface', 'class', 'type_alias', 'struct'].includes(n.kind)) {
        const callees = this.queries.getCallees(n.id)
        for (const c of callees) {
          if (c.kind === 'class' || c.kind === 'interface') {
            if (!result.has(c.id)) result.set(c.id, c)
          }
        }
        const callers = this.queries.getCallers(n.id)
        for (const c of callers) {
          if (c.kind === 'class' || c.kind === 'interface') {
            if (!result.has(c.id)) result.set(c.id, c)
          }
        }
      }
    }

    return Array.from(result.values())
  }

  private recoverEdges(nodes: MiniCodeGraphNode[]): MiniCodeGraphNode[] {
    const nodeIds = new Set(nodes.map(n => n.id))
    const allEdges = this.queries.getAllEdges()
    const recovered = new Map<string, MiniCodeGraphNode>()

    for (const n of nodes) recovered.set(n.id, n)

    for (const e of allEdges) {
      if (nodeIds.has(e.sourceId) && !nodeIds.has(e.targetId)) {
        const targetNode = this.queries.getNode(e.targetId)
        if (targetNode && !recovered.has(targetNode.id) && recovered.size < this.budget.totalBudget * 1.5) {
          recovered.set(targetNode.id, targetNode)
        }
      }
      if (nodeIds.has(e.targetId) && !nodeIds.has(e.sourceId)) {
        const sourceNode = this.queries.getNode(e.sourceId)
        if (sourceNode && !recovered.has(sourceNode.id) && recovered.size < this.budget.totalBudget * 1.5) {
          recovered.set(sourceNode.id, sourceNode)
        }
      }
    }

    return Array.from(recovered.values()).slice(0, this.budget.totalBudget)
  }

  private applyDiversityCap(nodes: MiniCodeGraphNode[]): MiniCodeGraphNode[] {
    const perFile = new Map<string, MiniCodeGraphNode[]>()
    for (const n of nodes) {
      if (!perFile.has(n.filePath)) perFile.set(n.filePath, [])
      perFile.get(n.filePath)!.push(n)
    }

    const result: MiniCodeGraphNode[] = []
    for (const [, fileNodes] of perFile) {
      const capped = fileNodes.slice(0, this.budget.perFileCap)
      result.push(...capped)
    }

    result.sort((a, b) => a.filePath.localeCompare(b.filePath))
    return result
  }

  private applyNonProductionCap(nodes: MiniCodeGraphNode[]): MiniCodeGraphNode[] {
    let nonProdCount = 0
    const result: MiniCodeGraphNode[] = []
    for (const n of nodes) {
      const classification = classifyFilePath(n.filePath)
      if (classification !== 'production') {
        if (nonProdCount >= this.budget.nonProductionCap) continue
        nonProdCount++
      }
      result.push(n)
    }
    return result
  }

  private async extractCodeBlocks(nodes: MiniCodeGraphNode[]): Promise<ContextSymbol[]> {
    const result: ContextSymbol[] = []
    for (const n of nodes) {
      let code = ''
      try {
        const absPath = join(this.projectRoot, n.filePath)
        if (n.endLine > 0 && n.startLine > 0) {
          const content = readFileSync(absPath, 'utf-8')
          const lines = content.split('\n')
          const end = Math.min(n.endLine, lines.length)
          code = lines.slice(n.startLine - 1, end).join('\n')
        }
      } catch { /* silent */ }

      const callers = this.queries.getCallers(n.id)
      const callees = this.queries.getCallees(n.id)
      const annotations = this.queries.getAnnotationsByNode(n.id)

      let implementations: { name: string; filePath: string }[] = []
      try {
        implLoop: for (const c of callees) {
          if (c.kind === 'class' || c.kind === 'method') {
            implementations.push({ name: c.name, filePath: c.filePath })
            if (implementations.length >= 5) break implLoop
          }
        }
      } catch { /* silent */ }

      const relatedRoutes = annotations
        .filter(a => ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'].includes(a.annotationName))
        .map(a => ({ path: a.value.replace(/"/g, ''), method: a.annotationName.replace('Mapping', '').toUpperCase() || 'ANY' }))

      result.push({
        id: n.id,
        name: n.name,
        kind: n.kind,
        qualifiedName: n.qualifiedName,
        filePath: n.filePath,
        lines: `${n.startLine}-${n.endLine}`,
        startLine: n.startLine,
        signature: n.signature,
        docstring: n.docstring,
        moduleId: n.moduleId,
        code,
        callers: callers.slice(0, 5).map(c => ({ name: c.name, filePath: c.filePath })),
        callees: callees.slice(0, 5).map(c => ({ name: c.name, filePath: c.filePath })),
        implementations,
        relatedRoutes,
      })
    }
    return result
  }

  private findDominantFile(symbols: ContextSymbol[]): string | undefined {
    const fileCount = new Map<string, number>()
    for (const s of symbols) {
      fileCount.set(s.filePath, (fileCount.get(s.filePath) || 0) + 1)
    }
    let max = 0
    let dominant: string | undefined
    for (const [file, count] of fileCount) {
      if (count > max) { max = count; dominant = file }
    }
    return dominant
  }

  private async autoTrace(symbols: ContextSymbol[]): Promise<{ sourceId: string; callees: { name: string; filePath: string }[] }[]> {
    const traces: { sourceId: string; callees: { name: string; filePath: string }[] }[] = []
    for (let i = 0; i < Math.min(symbols.length, 3); i++) {
      for (let j = i + 1; j < Math.min(symbols.length, 3); j++) {
        try {
          const paths = this.graph.findPath(symbols[i].id, symbols[j].id, 8)
          if (paths.length > 0) {
            for (const hop of paths[0]) {
              const calleesEntry: { name: string; filePath: string } = { name: hop.node.name, filePath: hop.node.filePath }
              const existing = traces.find(t => t.sourceId === symbols[i].id)
              if (existing) {
                if (!existing.callees.find(c => c.name === hop.node.name)) existing.callees.push(calleesEntry)
              } else {
                traces.push({ sourceId: symbols[i].id, callees: [calleesEntry] })
              }
            }
          }
        } catch { /* silent */ }
      }
    }
    return traces
  }

  private extractRoutes(symbols: ContextSymbol[]): { path: string; method: string; handler: string }[] {
    const routes: { path: string; method: string; handler: string }[] = []
    for (const s of symbols) {
      if (s.relatedRoutes && s.relatedRoutes.length > 0) {
        for (const r of s.relatedRoutes) {
          routes.push({ path: r.path, method: r.method, handler: `${s.filePath}:${s.lines}` })
        }
      }
    }
    return routes.slice(0, 20)
  }

  formatAsMarkdown(
    task: string,
    symbols: ContextSymbol[],
    stats: { totalFiles: number; modules: number; nodes: number; edges: number },
    routes?: { path: string; method: string; handler: string }[]
  ): string {
    return formatContextAsMarkdown(task, symbols, stats, routes)
  }
}
