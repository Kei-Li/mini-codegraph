import { ExtractionOrchestrator } from '../../extraction/orchestrator.js'
import type { ExtractionResult } from '../../types.js'

export class FullIndexer {
  private orchestrator: ExtractionOrchestrator

  constructor(orchestrator: ExtractionOrchestrator) {
    this.orchestrator = orchestrator
  }

  async init(): Promise<void> {
    await this.orchestrator.init()
  }

  async indexProject(projectRoot: string, excludePatterns?: string[]): Promise<ExtractionResult> {
    return this.orchestrator.indexProject(projectRoot, undefined, excludePatterns)
  }

  async indexMultiModule(projectRoot: string, excludePatterns?: string[]): Promise<ExtractionResult> {
    return this.orchestrator.indexMultiModule(projectRoot, excludePatterns)
  }

  async indexFile(filePath: string, projectRoot: string): Promise<ExtractionResult> {
    return this.orchestrator.indexFile(filePath, projectRoot)
  }

  stopWorkers(): void {
    this.orchestrator.stopWorkers()
  }
}

export { ExtractionOrchestrator } from '../../extraction/orchestrator.js'
