import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { DatabaseConnection } from './db/connection.js'
import { QueryManager } from './db/queries.js'
import { ExtractionOrchestrator } from './extraction/orchestrator.js'
import { GraphQueryManager } from './graph/queries.js'
import { FileWatcher } from './sync/watcher.js'
import type { ExtractionResult, ModuleInfo } from './types.js'
import { findFiles, loadGitignore, computeContentHash } from './utils.js'
import { detectRoutes } from './extraction/routes.js'
import { detectSpring } from './resolution/frameworks/java.js'
import { detectVue } from './resolution/frameworks/vue.js'
import { findMulitModuleProjects } from './resolution/frameworks/java.js'

export class MiniCodeGraph {
  private db: DatabaseConnection
  private queries: QueryManager
  private orchestrator: ExtractionOrchestrator
  private graphManager: GraphQueryManager
  private watcher: FileWatcher
  private projectRoot: string
  private dataDir: string
  private daemonMode = false
  private multiModule = false
  private moduleIds: string[] = []

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

  static initMultiModule(parentDir: string): { cg: MiniCodeGraph; modules: ModuleInfo[] } {
    const cg = new MiniCodeGraph(parentDir)
    const moduleDirs = findMulitModuleProjects(parentDir)

    const modules: ModuleInfo[] = moduleDirs.map((dir: string) => {
      const name = dir.split(/[/\\]/).pop() || 'unknown'
      let language = 'java'
      let buildSystem = 'unknown'

      if (existsSync(join(dir, 'pom.xml'))) buildSystem = 'maven'
      else if (existsSync(join(dir, 'build.gradle'))) buildSystem = 'gradle'
      else if (existsSync(join(dir, 'package.json'))) {
        buildSystem = 'npm'
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
          const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
          if (deps.vue || deps.nuxt) language = 'vue'
          else language = 'typescript'
        } catch {}
      }

      return { id: name, name, rootPath: dir, buildSystem, language, indexedAt: 0 }
    })

    if (modules.length === 0) {
      console.error('No sub-projects found. Use init() for single project.')
      return { cg, modules: [] }
    }

    for (const mod of modules) {
      cg.queries.insertModule(mod)
    }

    cg.multiModule = true
    cg.moduleIds = modules.map(m => m.id)

    return { cg, modules }
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

  async indexMultiModule(): Promise<ExtractionResult> {
    await this.orchestrator.init()
    return this.orchestrator.indexMultiModule(this.projectRoot)
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

  getModules(): ModuleInfo[] {
    return this.queries.getAllModules()
  }

  getRoutes() {
    return detectRoutes(this.projectRoot, this.queries, this.graphManager)
  }

  getFrameworks(): string[] {
    const frameworks: string[] = []
    const spring = detectSpring(this.projectRoot)
    if (spring) frameworks.push(spring.name)

    const parentDir = this.projectRoot
    const moduleDirs = findMulitModuleProjects(parentDir)
    for (const dir of moduleDirs) {
      const subSpring = detectSpring(dir)
      if (subSpring && !frameworks.includes(subSpring.name)) frameworks.push(subSpring.name)
      const subVue = detectVue(dir)
      if (subVue && !frameworks.includes(subVue.name)) frameworks.push(subVue.name)
    }

    const vue = detectVue(this.projectRoot)
    if (vue) frameworks.push(vue.name)

    return frameworks
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
