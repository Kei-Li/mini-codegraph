import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'
import { findOpenApiFiles, parseOpenApiFile } from '../../extraction/openapi-parser.js'

export class OpenApiExtractor implements IExtractor {
  name = 'openapi'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const files = findOpenApiFiles(projectRoot)
    if (files.length === 0) {
      const apiDocDir = join(projectRoot, 'src', 'main', 'resources', 'static', 'api-docs')
      if (existsSync(apiDocDir)) {
        for (const f of readdirSync(apiDocDir)) {
          if (/openapi|swagger|api-docs/i.test(f) && (f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json'))) {
            files.push(join(apiDocDir, f))
          }
        }
      }
    }

    for (const f of files) {
      const endpoints = parseOpenApiFile(f)
      for (const ep of endpoints) {
        provides.push({
          id: `openapi:${ep.method}:${ep.path}`,
          name: ep.operationId || `${ep.method} ${ep.path}`,
          kind: 'http_endpoint',
          signature: `${ep.method} ${ep.path}`,
        })
      }
    }

    return { provides, consumes }
  }
}
