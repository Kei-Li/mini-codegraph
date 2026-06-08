import type { QueryManager } from './db/queries.js'
import type { MiniCodeGraphNode } from './types.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ComplexityResult {
  name: string
  filePath: string
  lines: string
  complexity: number
  breakdown: string
}

export interface CircularDepResult {
  cycle: string[]
  files: string[]
}

export interface HotPathResult {
  name: string
  filePath: string
  transitiveCallers: number
}

export interface DeadImportResult {
  filePath: string
  importName: string
  line: number
}

export interface EntryPointResult {
  name: string
  filePath: string
  kind: string
  reason: string
}

export interface SimilarCodeResult {
  nodeA: { name: string; filePath: string }
  nodeB: { name: string; filePath: string }
  similarity: number
  reason: string
}

export class CodeAnalyzer {
  constructor(
    private queries: QueryManager,
    private projectRoot: string
  ) {}

  computeCyclomaticComplexity(functionNode: MiniCodeGraphNode): ComplexityResult | null {
    if (!['function', 'method', 'constructor'].includes(functionNode.kind)) return null

    try {
      const fullPath = join(this.projectRoot, functionNode.filePath)
      const source = readFileSync(fullPath, 'utf-8')
      const lines = source.split('\n')
      const body = lines.slice(functionNode.startLine - 1, functionNode.endLine).join('\n')

      const patterns = [
        { regex: /\bif\s*\(/g, label: 'if' },
        { regex: /\belse\s+if\b/g, label: 'else-if' },
        { regex: /\bcase\s+/g, label: 'case' },
        { regex: /\b(for|while)\s*\(/g, label: 'loop' },
        { regex: /\bcatch\s*\(/g, label: 'catch' },
        { regex: /\?\s+/g, label: 'ternary' },
        { regex: /\b&&\b|\b\|\|\b/g, label: 'logical' },
        { regex: /\bdefault\s*:/g, label: 'default' },
      ]

      let count = 1
      const details: string[] = []
      for (const { regex, label } of patterns) {
        const matches = body.match(regex)
        if (matches) {
          count += matches.length
          details.push(`${label}:${matches.length}`)
        }
      }

      return {
        name: functionNode.name,
        filePath: functionNode.filePath,
        lines: `${functionNode.startLine}-${functionNode.endLine}`,
        complexity: count,
        breakdown: details.join(', '),
      }
    } catch {
      return null
    }
  }

  findCircularDeps(): CircularDepResult[] {
    const allFiles = this.queries.getAllFiles()
    const importEdges = new Map<string, Set<string>>()

    for (const f of allFiles) {
      const deps = this.queries.getFileDependencies(f.path)
      importEdges.set(f.path, new Set(deps))
    }

    const cycles: CircularDepResult[] = []
    const visited = new Set<string>()
    const recStack = new Set<string>()
    const pathStack: string[] = []

    const dfs = (file: string) => {
      if (recStack.has(file)) {
        const idx = pathStack.indexOf(file)
        const cycle = pathStack.slice(idx)
        if (cycle.length >= 2 && !cycles.some(c =>
          c.cycle.length === cycle.length && c.cycle[0] === cycle[0]
        )) {
          cycles.push({ cycle, files: cycle })
        }
        return
      }
      if (visited.has(file)) return

      visited.add(file)
      recStack.add(file)
      pathStack.push(file)

      const deps = importEdges.get(file)
      if (deps) {
        for (const dep of deps) {
          dfs(dep)
        }
      }

      pathStack.pop()
      recStack.delete(file)
    }

    for (const [file] of importEdges) {
      if (!visited.has(file)) dfs(file)
    }

    return cycles
  }

  findHotPaths(topN = 20): HotPathResult[] {
    const allNodes = this.queries.getAllNodes()
    const callerCounts = new Map<string, { name: string; filePath: string; count: number }>()

    for (const node of allNodes) {
      const callers = this.queries.getCallers(node.id)
      if (callers.length > 0) {
        const transitive = new Set<string>()
        const queue = [...callers]
        while (queue.length > 0) {
          const c = queue.shift()!
          if (transitive.has(c.id)) continue
          transitive.add(c.id)
          const deeper = this.queries.getCallers(c.id)
          queue.push(...deeper)
        }
        callerCounts.set(node.id, {
          name: node.name,
          filePath: node.filePath,
          count: transitive.size,
        })
      }
    }

    return Array.from(callerCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, topN)
      .map(c => ({ name: c.name, filePath: c.filePath, transitiveCallers: c.count }))
  }

  findDeadImports(): DeadImportResult[] {
    const allNodes = this.queries.getAllNodes()
    const deadImports: DeadImportResult[] = []

    for (const node of allNodes) {
      if (node.kind !== 'import') continue
      const importName = node.name
      const fileNodes = this.queries.getNodesByFile(node.filePath)
      let referenced = false
      for (const fn of fileNodes) {
        if (fn.id === node.id) continue
        const callees = this.queries.getCallees(fn.id)
        for (const callee of callees) {
          if (callee.name === importName || callee.qualifiedName === importName) {
            referenced = true
            break
          }
        }
        if (referenced) break
      }
      if (!referenced) {
        deadImports.push({
          filePath: node.filePath,
          importName,
          line: node.startLine,
        })
      }
    }

    return deadImports
  }

  async findEntryPoints(): Promise<EntryPointResult[]> {
    const allNodes = this.queries.getAllNodes()
    const entries: EntryPointResult[] = []

    for (const node of allNodes) {
      if (node.kind === 'function' || node.kind === 'method') {
        if (node.name === 'main' && node.filePath.endsWith('.java')) {
          entries.push({ name: node.name, filePath: node.filePath, kind: node.kind, reason: 'Java main()' })
        }
        if (node.name === 'main' && (node.filePath.endsWith('.ts') || node.filePath.endsWith('.js'))) {
          entries.push({ name: node.name, filePath: node.filePath, kind: node.kind, reason: 'CLI entry point' })
        }
        if (node.name === 'handler' && node.filePath.includes('lambda')) {
          entries.push({ name: node.name, filePath: node.filePath, kind: node.kind, reason: 'Lambda handler' })
        }
      }
      if ((node.kind === 'variable' || node.kind === 'function') && node.isExported) {
        if (node.filePath === 'index.ts' || node.filePath === 'index.js' || node.filePath === 'index.mjs') {
          entries.push({ name: node.name, filePath: node.filePath, kind: node.kind, reason: 'Module entry point (index)' })
        }
      }
    }

    try {
      const { detectRoutes } = await import('./extraction/core/routes.js')
      const routes = detectRoutes(this.projectRoot, this.queries)
      for (const route of routes) {
        entries.push({
          name: route.handlerName,
          filePath: route.handlerFile,
          kind: 'route',
          reason: `${route.framework} ${route.path}`,
        })
      }
    } catch { /* silent */ }

    return entries
  }

  findSimilarCode(node: MiniCodeGraphNode, allNodes?: MiniCodeGraphNode[]): SimilarCodeResult[] {
    const results: SimilarCodeResult[] = []
    const candidates = allNodes ?? this.queries.getAllNodes()

    const nodeSig = this.normalizeSignature(node)
    if (!nodeSig) return results

    for (const candidate of candidates) {
      if (candidate.id === node.id) continue
      if (candidate.kind !== node.kind) continue

      const candSig = this.normalizeSignature(candidate)
      if (!candSig) continue

      const sim = this.tokenJaccardSimilarity(nodeSig, candSig)
      if (sim >= 0.5) {
        results.push({
          nodeA: { name: node.name, filePath: node.filePath },
          nodeB: { name: candidate.name, filePath: candidate.filePath },
          similarity: Math.round(sim * 100) / 100,
          reason: `Signature similarity (${node.kind} ${node.name} vs ${candidate.name})`,
        })
      }
    }

    results.sort((a, b) => b.similarity - a.similarity)
    return results.slice(0, 10)
  }

  private normalizeSignature(node: MiniCodeGraphNode): string[] | null {
    const text = [
      node.name,
      node.signature,
      node.docstring,
    ].join(' ').toLowerCase()

    const tokens = text.split(/[\s,();{}[\]<>]+/).filter(t => t.length > 1)
    const unique = [...new Set(tokens)]
    return unique.length > 0 ? unique : null
  }

  private tokenJaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a)
    const setB = new Set(b)
    let intersection = 0
    for (const t of setA) {
      if (setB.has(t)) intersection++
    }
    const union = new Set([...setA, ...setB]).size
    return union > 0 ? intersection / union : 0
  }
}
