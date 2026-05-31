import { readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import type { DatabaseConnection } from '../db/connection.js'
import type { QueryManager } from '../db/queries.js'
import { GrammarLoader } from './grammar-loader.js'
import { parseJavaFile } from './languages/java.js'
import { parseTypeScriptFile } from './languages/typescript.js'
import { parsePythonFile } from './languages/python.js'
import { parseVueFile } from './languages/vue.js'
import { findFiles, loadGitignore, computeContentHash, languageForFile } from '../utils.js'
import type { CodeGraphNode, CodeGraphEdge, FileRecord, ExtractionResult } from '../types.js'

export class ExtractionOrchestrator {
  private grammarLoader: GrammarLoader
  private db: DatabaseConnection
  private queries: QueryManager

  constructor(db: DatabaseConnection, queries: QueryManager) {
    this.db = db
    this.queries = queries
    this.grammarLoader = new GrammarLoader()
  }

  async init(): Promise<void> {
    await this.grammarLoader.init()
  }

  async indexProject(projectRoot: string): Promise<ExtractionResult> {
    const isIgnored = loadGitignore(projectRoot)
    const files = findFiles(projectRoot, isIgnored)

    console.error(`Found ${files.length} supported files to index`)

    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }
    let indexedCount = 0
    const startTime = Date.now()

    const updateProgress = () => {
      const pct = ((indexedCount / files.length) * 100).toFixed(1)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const barLen = 20
      const filled = Math.round((indexedCount / files.length) * barLen)
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
      process.stderr.write(`\r[${bar}] ${pct}% (${indexedCount}/${files.length}) ${elapsed}s`)
    }

    for (const filePath of files) {
      try {
        const fileResult = await this.indexFile(filePath, projectRoot)
        result.nodes.push(...fileResult.nodes)
        result.edges.push(...fileResult.edges)
        result.errors.push(...fileResult.errors)
        indexedCount++
        updateProgress()
      } catch (e) {
        result.errors.push(`Error indexing ${filePath}: ${e}`)
        indexedCount++
        updateProgress()
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
    process.stderr.write(`\nIndexed ${indexedCount}/${files.length} files in ${totalTime}s\n`)

    const resolved = this.queries.resolveCallEdges()
    if (resolved > 0) {
      process.stderr.write(`Resolved ${resolved} call edges\n`)
    }

    return result
  }

  async indexFile(filePath: string, projectRoot: string): Promise<ExtractionResult> {
    const lang = languageForFile(filePath)
    if (!lang) return { nodes: [], edges: [], errors: [`Unsupported language: ${filePath}`] }

    try {
      const source = readFileSync(filePath, 'utf-8')
      const stat = statSync(filePath)
      const contentHash = computeContentHash(source)
      const relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
      const lines = source.split('\n')

      const parser = await this.grammarLoader.loadGrammar(lang.grammarName)
      const tree = parser.parse(source)

      if (!tree || !tree.rootNode) {
        return { nodes: [], edges: [], errors: [`Failed to parse: ${filePath}`] }
      }

      const parseResult = lang.name === 'java'
        ? parseJavaFile(tree, source, relPath, lang.name)
        : lang.name === 'python'
          ? parsePythonFile(tree, source, relPath, lang.name)
          : lang.name === 'vue'
            ? parseVueFile(parser, source, relPath, lang.name)
            : parseTypeScriptFile(tree, source, relPath, lang.name)

      // Store in transaction
      this.db.transaction(() => {
        // Remove old data for this file
        this.queries.deleteNodesForFile(relPath)

        // Insert nodes
        const nodeMap = new Map<string, CodeGraphNode>()
        for (const ni of parseResult.nodes) {
          const node: CodeGraphNode = {
            id: `${relPath}:${ni.name}:${ni.startLine}`,
            kind: ni.kind,
            name: ni.name,
            qualifiedName: ni.qualifiedName,
            filePath: relPath,
            language: lang.name,
            startLine: ni.startLine,
            endLine: ni.endLine,
            startColumn: ni.startColumn,
            endColumn: ni.endColumn,
            docstring: ni.docstring,
            signature: ni.signature,
            visibility: ni.visibility,
            isExported: ni.isExported,
            parentId: ni.parentId,
          }
          nodeMap.set(node.id, node)
          this.queries.insertNode(node)
        }

        // Insert edges
        for (const ei of parseResult.edges) {
          this.queries.insertEdge(ei.source, ei.target, ei.kind, ei.metadata, ei.line, ei.col)
        }

        // Update file record
        this.queries.upsertFile({
          path: relPath,
          contentHash,
          language: lang.name,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          indexedAt: Date.now(),
          nodeCount: parseResult.nodes.length,
        })
      })

      return {
        nodes: parseResult.nodes.map(ni => ({
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          kind: ni.kind,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
          language: lang.name,
          startLine: ni.startLine,
          endLine: ni.endLine,
          startColumn: ni.startColumn,
          endColumn: ni.endColumn,
          docstring: ni.docstring,
          signature: ni.signature,
          visibility: ni.visibility,
          isExported: ni.isExported,
          parentId: ni.parentId,
        })),
        edges: parseResult.edges,
        errors: [],
      }
    } catch (e) {
      return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${e}`] }
    }
  }
}
