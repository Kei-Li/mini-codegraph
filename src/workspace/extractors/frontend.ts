import { readFileSync } from 'node:fs'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export class FrontendExtractor implements IExtractor {
  name = 'frontend'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const vueApiEdges = queries.getAllEdges().filter(e => e.kind === 'api_mapping')
    for (const edge of vueApiEdges) {
      try {
        const meta = JSON.parse(edge.metadata || '{}')
        consumes.push({
          symbolId: `http.${meta.path || edge.targetId}`,
          referenceType: 'http_request',
          sourceLocation: edge.sourceId,
        })
      } catch { /* silent */ }
    }

    return { provides, consumes }
  }
}
