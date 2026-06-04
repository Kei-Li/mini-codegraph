import type { IExtractor, ExtractionOutput } from './frameworks.js'
import type { QueryManager } from '../../db/queries.js'

export class DatabaseExtractor implements IExtractor {
  name = 'database'

  async extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput> {
    const provides: ExtractionOutput['provides'] = []
    const consumes: ExtractionOutput['consumes'] = []

    const jpaNodes = queries.getNodesByIdPrefix('jpa:')
    for (const node of jpaNodes) {
      provides.push({
        id: `db.table.${node.name}`,
        name: node.name,
        kind: 'db_table',
        signature: node.signature || 'jpa_entity',
      })
    }

    const mongoNodes = queries.getNodesByIdPrefix('mongo:')
    for (const node of mongoNodes) {
      provides.push({
        id: `db.mongo.${node.name}`,
        name: node.name,
        kind: 'db_collection',
        signature: node.signature || 'mongo_document',
      })
    }

    const sqlNodes = queries.getNodesByIdPrefix('mysql:table:')
    for (const node of sqlNodes) {
      provides.push({
        id: `db.sql.${node.name}`,
        name: node.name,
        kind: 'db_table',
        signature: node.signature || 'sql_table',
      })
    }

    const mybatisEdges = queries.getEdgesByType('mybatis_mapper')
    for (const edge of mybatisEdges) {
      consumes.push({
        symbolId: edge.targetId,
        referenceType: 'db_rw',
        sourceLocation: edge.sourceId,
      })
    }

    return { provides, consumes }
  }
}
