import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'
import { detectDrools, indexDroolsFiles } from '../../extraction/middleware/drools-extractor.js'

export class DroolsExtractor implements IExtractor {
  name = 'drools'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    if (!detectDrools(projectRoot)) return { provides, consumes }

    const moduleId = projectRoot.split(/[/\\]/).pop() || 'unknown'
    const result = indexDroolsFiles(queries, projectRoot, moduleId)

    for (const rule of result.rules) {
      provides.push({
        id: rule.id,
        name: rule.ruleName,
        kind: 'drools_rule',
        signature: `salience:${rule.salience}, agenda:${rule.agendaGroup || '-'}, when: ${rule.whenCondition.slice(0, 80)}`,
      })
    }

    for (const type of result.types) {
      provides.push({
        id: type.id,
        name: type.typeName,
        kind: 'drools_fact',
        signature: `fields: ${type.fields.map(f => `${f.name}:${f.type}`).join(', ')}`,
      })
    }

    return { provides, consumes }
  }
}
