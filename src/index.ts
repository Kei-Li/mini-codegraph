import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseConnection } from './db/connection.js'
import { QueryManager } from './db/queries.js'
import { ExtractionOrchestrator } from './extraction/orchestrator.js'
import { GraphQueryManager } from './graph/queries.js'
import { FileWatcher } from './sync/watcher.js'
import type { ExtractionResult, IndexOptions } from './types.js'

export class MiniCodeGraph {
  private db: DatabaseConnection
  private queries: QueryManager
  private orchestrator: ExtractionOrchestrator
  private graphManager: GraphQueryManager
  private watcher: FileWatcher
  private projectRoot: string
  private dataDir: string

  constructor(projectRoot: string, dbPath?: string) {
    this.projectRoot = projectRoot
    this.dataDir = join(projectRoot, '.codegraph')
    const resolvedDbPath = dbPath ?? join(this.dataDir, 'codegraph.db')

    this.db = new DatabaseConnection(resolvedDbPath)
    this.db.open()
    this.queries = new QueryManager(this.db)
    this.orchestrator = new ExtractionOrchestrator(this.db, this.queries)
    this.graphManager = new GraphQueryManager(this.queries, projectRoot)
    this.watcher = new FileWatcher()
  }

  static init(projectRoot: string): MiniCodeGraph {
    const cg = new MiniCodeGraph(projectRoot)
    return cg
  }

  static open(projectRoot: string): MiniCodeGraph | null {
    const dbPath = join(projectRoot, '.codegraph', 'codegraph.db')
    if (!existsSync(dbPath)) return null
    return new MiniCodeGraph(projectRoot, dbPath)
  }

  async index(): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexProject(this.projectRoot)
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

  close(): void {
    this.watcher.stop()
    this.db.close()
  }
}
