import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { QueryManager } from '../db/queries.js'
import { WorkspaceGraphBuilder } from './graph-builder.js'
import { WorkspaceScanner, type ScannedProject } from './scanner.js'
import { frameworkExtractor, type ExtractionOutput } from './extractors/frameworks.js'
import { SpringCloudExtractor } from './extractors/spring-cloud.js'
import { RabbitMQExtractor } from './extractors/rabbitmq.js'
import { RedisExtractor } from './extractors/redis.js'
import { DatabaseExtractor } from './extractors/database.js'
import { FrontendExtractor } from './extractors/frontend.js'

export class WorkspaceSync {
  private scanner: WorkspaceScanner
  private graphBuilder: WorkspaceGraphBuilder
  private queries: QueryManager
  private currentService: string
  private projects: ScannedProject[] = []
  private hashCache = new Map<string, string>()

  constructor(queries: QueryManager, workspaceRoot: string, currentService: string) {
    this.scanner = new WorkspaceScanner(workspaceRoot)
    this.graphBuilder = new WorkspaceGraphBuilder(queries, currentService)
    this.queries = queries
    this.currentService = currentService

    frameworkExtractor.register(new SpringCloudExtractor())
    frameworkExtractor.register(new RabbitMQExtractor())
    frameworkExtractor.register(new RedisExtractor())
    frameworkExtractor.register(new DatabaseExtractor())
    frameworkExtractor.register(new FrontendExtractor())
  }

  private computeFileHash(filePath: string): string {
    try {
      const content = readFileSync(filePath, 'utf-8')
      return createHash('md5').update(content).digest('hex')
    } catch {
      return ''
    }
  }

  private hasProjectChanged(project: ScannedProject): boolean {
    const configFiles = ['pom.xml', 'build.gradle', 'package.json', 'application.yml', 'application.yaml', 'bootstrap.yml']
    for (const cf of configFiles) {
      const fp = join(project.rootPath, cf)
      if (existsSync(fp)) {
        const h = this.computeFileHash(fp)
        const key = `${project.name}:${cf}`
        const cached = this.hashCache.get(key)
        if (h && h !== cached) {
          this.hashCache.set(key, h)
          return true
        }
      }
    }
    return false
  }

  async refresh(onProgress?: (msg: string) => void): Promise<{ symbolsAdded: number; refsAdded: number }> {
    this.projects = this.scanner.scan()
    onProgress?.(`Found ${this.projects.length} projects`)

    const allProvides = new Map<string, ExtractionOutput['provides']>()
    let currentConsumes: ExtractionOutput['consumes'] = []

    for (const project of this.projects) {
      if (!this.hasProjectChanged(project)) {
        onProgress?.(`Skipping unchanged: ${project.name}`)
        continue
      }

      onProgress?.(`Extracting interfaces from ${project.name}`)
      const results = await frameworkExtractor.extractAll(project.rootPath, this.queries)

      if (project.name === this.currentService) {
        for (const [, output] of results) {
          currentConsumes.push(...output.consumes)
        }
      }

      for (const [, output] of results) {
        const existing = allProvides.get(project.name) || []
        allProvides.set(project.name, [...existing, ...output.provides])
      }
    }

    onProgress?.('Building global graph...')
    await this.graphBuilder.refreshExternalTables(allProvides, currentConsumes)

    const stats = this.queries['db'].prepare('SELECT COUNT(*) as count FROM external_symbols').get() as any
    const refStats = this.queries['db'].prepare('SELECT COUNT(*) as count FROM external_references').get() as any

    return { symbolsAdded: stats?.count ?? 0, refsAdded: refStats?.count ?? 0 }
  }

  getProjects(): ScannedProject[] {
    return this.projects
  }

  getScanner(): WorkspaceScanner {
    return this.scanner
  }

  getGraphBuilder(): WorkspaceGraphBuilder {
    return this.graphBuilder
  }
}
