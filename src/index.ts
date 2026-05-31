import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseConnection } from './db/connection.js'
import { QueryManager } from './db/queries.js'
import { ExtractionOrchestrator } from './extraction/orchestrator.js'
import { GraphQueryManager } from './graph/queries.js'
import { FileWatcher } from './sync/watcher.js'
import type { ExtractionResult, IndexOptions } from './types.js'
import { findFiles, loadGitignore, computeContentHash } from './utils.js'
import { detectRoutes } from './extraction/routes.js'

export class MiniCodeGraph {
  private db: DatabaseConnection
  private queries: QueryManager
  private orchestrator: ExtractionOrchestrator
  private graphManager: GraphQueryManager
  private watcher: FileWatcher
  private projectRoot: string
  private dataDir: string
  private daemonMode = false

  constructor(projectRoot: string, dbPath?: string) {
    this.projectRoot = projectRoot
    this.dataDir = join(projectRoot, '.codegraph')
    const resolvedDbPath = dbPath ?? join(this.dataDir, 'codegraph.db')

    this.db = new DatabaseConnection(resolvedDbPath)
    this.db.open()
    this.queries = new QueryManager(this.db)
    this.orchestrator = new ExtractionOrchestrator(this.db, this.queries)
    this.graphManager = new GraphQueryManager(this.queries, projectRoot)
    this.watcher = FileWatcher.getInstance()
  }

  static init(projectRoot: string, indexNow = false): MiniCodeGraph {
    const cg = new MiniCodeGraph(projectRoot)
    return cg
  }

  static open(projectRoot: string): MiniCodeGraph | null {
    const dbPath = join(projectRoot, '.codegraph', 'codegraph.db')
    if (!existsSync(dbPath)) return null
    return new MiniCodeGraph(projectRoot, dbPath)
  }

  static findProjectRoot(startPath: string): string | null {
    let current = startPath
    while (true) {
      if (existsSync(join(current, '.codegraph', 'codegraph.db'))) return current
      const parent = join(current, '..')
      if (parent === current) return null
      current = parent
    }
  }

  async index(): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexProject(this.projectRoot)
  }

  async sync(): Promise<ExtractionResult> {
    await this.orchestrator.init()

    const allFiles = findFiles(this.projectRoot, loadGitignore(this.projectRoot))
    const indexedFiles = this.queries.getAllFiles()
    const indexedMap = new Map(indexedFiles.map(f => [f.path, f]))

    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }

    for (const filePath of allFiles) {
      const relPath = filePath.replace(this.projectRoot, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
      const existing = indexedMap.get(relPath)
      if (!existing) {
        try {
          const fileResult = await this.orchestrator.indexFile(filePath, this.projectRoot)
          result.nodes.push(...fileResult.nodes)
          result.edges.push(...fileResult.edges)
        } catch (e) {
          result.errors.push(`Error indexing ${filePath}: ${e}`)
        }
      } else {
        try {
          const source = readFileSync(filePath, 'utf-8')
          const currentHash = computeContentHash(source)
          if (currentHash !== existing.contentHash) {
            const fileResult = await this.orchestrator.indexFile(filePath, this.projectRoot)
            result.nodes.push(...fileResult.nodes)
            result.edges.push(...fileResult.edges)
          }
        } catch (e) {
          result.errors.push(`Error checking ${filePath}: ${e}`)
        }
      }
    }

    return result
  }

  async indexFile(filePath: string): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexFile(filePath, this.projectRoot)
  }

  getGraph(): GraphQueryManager {
    return this.graphManager
  }

  getWatcher(): FileWatcher {
    return this.watcher
  }

  getProjectRoot(): string {
    return this.projectRoot
  }

  getRoutes() {
    return detectRoutes(this.projectRoot, this.queries, this.graphManager)
  }

  enableDaemon(): void {
    this.daemonMode = true
    this.watcher.start(this.projectRoot, this.orchestrator, (events) => {
      for (const event of events) {
        if (event.type === 'unlink') {
          this.queries.deleteNodesForFile(event.filePath)
        } else {
          this.graphManager.markFilePending(event.filePath)
          const fullPath = join(this.projectRoot, event.filePath)
          this.indexFile(fullPath).then(() => {
            this.graphManager.markSyncComplete()
          }).catch(() => {})
        }
      }
    })
  }

  close(): void {
    this.watcher.stop()
    this.db.close()
  }
}
