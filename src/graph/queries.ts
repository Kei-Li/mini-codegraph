import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode, SearchResult } from '../types.js'
import { GraphTraverser } from './traversal.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class GraphQueryManager {
  private queries: QueryManager
  private traverser: GraphTraverser
  private projectRoot: string

  constructor(queries: QueryManager, projectRoot: string) {
    this.queries = queries
    this.traverser = new GraphTraverser(queries)
    this.projectRoot = projectRoot
  }

  search(query: string, limit = 20): SearchResult[] {
    const nodes = this.queries.searchNodes(query, limit)
    return nodes.map(node => {
      const snippets = this.getSnippets(node, 3)
      return { node, snippets, score: 1 }
    })
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
  } {
    return {
      node: this.queries.getNode(nodeId),
      parent: this.queries.getParent(nodeId),
      children: this.queries.getChildren(nodeId),
      callers: this.queries.getCallers(nodeId),
      callees: this.queries.getCallees(nodeId),
    }
  }

  getFileNodes(filePath: string): CodeGraphNode[] {
    return this.queries.getNodesByFile(filePath)
  }

  findPath(from: string, to: string): CodeGraphNode[][] {
    return this.traverser.findPath(from, to)
  }

  getImpact(nodeId: string, depth = 2): CodeGraphNode[] {
    const impacted = this.traverser.findImpactedNodes(nodeId, depth)
    return Array.from(impacted.values())
  }

  findDeadCode(): CodeGraphNode[] {
    return this.traverser.findDeadCode()
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

  private getSnippets(node: CodeGraphNode, contextLines: number): string[] {
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
}
