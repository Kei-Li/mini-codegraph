import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'
import { detectLiquibase, findLiquibaseFiles, parseLiquibaseChangelog } from '../../extraction/infra/liquibase-extractor.js'

export class LiquibaseExtractor implements IExtractor {
  name = 'liquibase'

  async extract(projectRoot: string, _queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    if (!detectLiquibase(projectRoot)) return { provides, consumes }

    const files = findLiquibaseFiles(projectRoot)
    for (const f of files) {
      const changelog = parseLiquibaseChangelog(f)
      if (!changelog) continue

      const changeTypes = new Set<string>()
      for (const cs of changelog.changes) {
        for (const ct of cs.changeTypes) {
          changeTypes.add(ct.type)
          for (const val of Object.values(ct.detail)) {
            if (val.includes('.')) {
              const tableName = val.split('.')[1] || val
              provides.push({
                id: `liquibase:table:${tableName}`,
                name: tableName,
                kind: 'db_table_reference',
                signature: `${ct.type}: ${val}`,
              })
            }
          }
        }
      }

      provides.push({
        id: `liquibase:${f}`,
        name: f.split(/[/\\]/).pop() || 'changelog',
        kind: 'db_changelog',
        signature: `changesets: ${changelog.changes.length}, includes: ${changelog.includePaths.length}, types: ${[...changeTypes].join(',')}`,
      })
    }

    return { provides, consumes }
  }
}
