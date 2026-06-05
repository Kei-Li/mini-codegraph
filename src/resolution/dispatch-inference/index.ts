import type { QueryManager } from '../../db/queries.js'
import type { DispatchPattern, DispatchResult, IDispatchDetector } from './types.js'
import { mergeInferredEdges } from './resolver.js'
import { ProxyDetector } from './detectors/proxy-detector.js'
import { AopDetector } from './detectors/aop-detector.js'
import { StrategyDetector } from './detectors/strategy-detector.js'
import { FactoryDetector } from './detectors/factory-detector.js'
import { ReflectionDetector } from './detectors/reflection-detector.js'
import { SpiDetector } from './detectors/spi-detector.js'
import { ConditionalBeanDetector } from './detectors/conditional-bean-detector.js'

export class DispatchInferenceEngine {
  private queries: QueryManager
  private detectors: IDispatchDetector[] = []
  private moduleId: string
  private allModuleIds: string[]

  constructor(
    queries: QueryManager,
    _projectRoot: string,
    moduleId: string,
    allModuleIds: string[],
  ) {
    this.queries = queries
    this.moduleId = moduleId
    this.allModuleIds = allModuleIds
    this.registerDefaultDetectors()
  }

  private registerDefaultDetectors(): void {
    this.detectors = [
      new ProxyDetector(),
      new AopDetector(),
      new StrategyDetector(),
      new FactoryDetector(),
      new ReflectionDetector(),
      new SpiDetector(),
      new ConditionalBeanDetector(),
    ]
  }

  registerDetector(detector: IDispatchDetector): void {
    this.detectors.push(detector)
  }

  async run(): Promise<DispatchResult> {
    const allPatterns: DispatchPattern[] = []

    for (const detector of this.detectors) {
      try {
        const patterns = await detector.detect(
          this.queries,
          this.moduleId,
          this.allModuleIds,
        )
        allPatterns.push(...patterns)
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        process.stderr.write(`Dispatch detector ${detector.name} error: ${errMsg}\n`)
      }
    }

    return mergeInferredEdges(this.queries, allPatterns, this.moduleId)
  }

  getDetectorNames(): string[] {
    return this.detectors.map(d => d.name)
  }
}
