import type { QueryManager } from '../../db/queries.js'

export interface IExtractor {
  name: string
  extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput>
}

export interface ExtractionOutput {
  provides: { id: string; name: string; kind: string; signature: string }[]
  consumes: { symbolId: string; referenceType: string; sourceLocation: string }[]
}

export class FrameworkExtractor {
  private extractors: Map<string, IExtractor> = new Map()

  register(extractor: IExtractor): void {
    this.extractors.set(extractor.name, extractor)
  }

  get(name: string): IExtractor | undefined {
    return this.extractors.get(name)
  }

  getAll(): IExtractor[] {
    return Array.from(this.extractors.values())
  }

  async extractAll(projectRoot: string, queries: QueryManager): Promise<Map<string, ExtractionOutput>> {
    const results = new Map<string, ExtractionOutput>()
    for (const [name, extractor] of this.extractors) {
      try {
        results.set(name, await extractor.extract(projectRoot, queries))
      } catch (e) {
        results.set(name, { provides: [], consumes: [] })
      }
    }
    return results
  }
}

export const frameworkExtractor = new FrameworkExtractor()
