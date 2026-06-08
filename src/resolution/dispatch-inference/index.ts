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

class TimeoutError extends Error {
  constructor() {
    super('Dispatch detector timed out')
    this.name = 'TimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new TimeoutError())
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError()), ms) }),
  ])
}

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

  async run(minConfidence = 0, timeoutMs = 120_000): Promise<DispatchResult> {
    // Enable read cache so detectors/variable-tracer do not repeatedly
    // query getAllNodes()/getAllEdges() from SQLite (can be 1000+ calls
    // on large codebases).
    this.queries.enableReadCache()

    const allPatterns: DispatchPattern[] = []

    for (const detector of this.detectors) {
      const memUsed = process.memoryUsage().heapUsed
      const memTotal = process.memoryUsage().heapTotal
      if (memTotal > 0 && memUsed / memTotal > 0.7) {
        process.stderr.write(`  SKIP ${detector.name}: memory usage ${((memUsed / memTotal) * 100).toFixed(0)}% of limit\n`)
        continue
      }

      process.stderr.write(`  · ${detector.name}... `)
      const deadline = Date.now() + timeoutMs
      try {
        const patterns = await withTimeout(
          detector.detect(this.queries, this.moduleId, this.allModuleIds),
          deadline - Date.now(),
        )
        allPatterns.push(...patterns)
        process.stderr.write(`${patterns.length} patterns\n`)
      } catch (e) {
        if (e instanceof TimeoutError) {
          process.stderr.write(`TIMEOUT (${timeoutMs / 1000}s), skipped\n`)
        } else {
          const errMsg = e instanceof Error ? e.message : String(e)
          process.stderr.write(`error: ${errMsg.slice(0, 120)}\n`)
        }
      }
    }

    process.stderr.write(`  Merging ${allPatterns.length} patterns... `)
    const result = mergeInferredEdges(this.queries, allPatterns, this.moduleId, minConfidence)
    process.stderr.write(`${result.stats.totalEdges} edges\n`)
    this.queries.flushReadCache()
    return result
  }

  getDetectorNames(): string[] {
    return this.detectors.map(d => d.name)
  }
}
