import type { QueryManager } from '../db/queries.js'
import type { JpaEntity } from '../types.js'

export function extractJpaEntities(source: string, filePath: string): JpaEntity[] {
  const entities: JpaEntity[] = []

  if (!source.includes('@Entity') && !source.includes('@MappedSuperclass')) return entities

  const classMatch = source.match(/(?:public\s+)?(?:abstract\s+)?\bclass\s+(\w+)/)
  if (!classMatch) return entities

  const className = classMatch[1]
  const tableMatch = source.match(/@Table\s*\([^)]*name\s*=\s*"(\w+)"/)
  const tableName = tableMatch?.[1] ?? className.toLowerCase()

  const columns: JpaEntity['columns'] = []
  const relationships: JpaEntity['relationships'] = []

  const fieldMatches = source.matchAll(/(?:@Column\s*\(([^)]*)\)\s*)?(?:private\s+)?(\w+)\s+(\w+)\s*;/g)
  for (const fm of fieldMatches) {
    const annBody = fm[1] || ''
    const fieldType = fm[2]
    const fieldName = fm[3]
    const colNameMatch = annBody.match(/name\s*=\s*"(\w+)"/)
    const nullable = annBody.includes('nullable = false') ? false : true
    const unique = annBody.includes('unique = true')
    columns.push({
      name: colNameMatch?.[1] ?? fieldName,
      field: fieldName,
      type: fieldType,
      nullable,
      unique,
    })
  }

  const relMatches = source.matchAll(/@(OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(([^)]*)\)\s*(?:private\s+)?(\w+)(?:\s*<\s*(\w+)\s*>)?\s*(\w+)\s*;?/g)
  for (const rm of relMatches) {
    const relType = rm[1]
    const relBody = rm[2] || ''
    const targetType = rm[4] || rm[3]
    const fieldName = rm[5] || rm[3]
    const fetchMatch = relBody.match(/fetch\s*=\s*(LAZY|EAGER)/)
    relationships.push({
      field: fieldName,
      targetEntity: targetType,
      type: relType,
      fetch: fetchMatch?.[1] ?? 'LAZY',
    })
  }

  if (columns.length > 0 || relationships.length > 0) {
    entities.push({ className, tableName, columns, relationships })
  }

  return entities
}

export function indexJpaEntities(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): JpaEntity[] {
  const entities = extractJpaEntities(source, filePath)
  if (entities.length === 0) return entities

  for (const e of entities) {
    const entityId = `jpa:${e.className}`

    const existing = queries.getNode(entityId)
    if (!existing) {
      queries.insertNode({
        id: entityId, kind: 'data', name: e.className,
        qualifiedName: `jpa:${e.className}`,
        filePath, language: 'java',
        startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
        docstring: `JPA Entity: ${e.className} (table: ${e.tableName})`,
        signature: JSON.stringify({ table: e.tableName, columns: e.columns.length, relationships: e.relationships.length }),
        visibility: 'public', isExported: false, parentId: null, moduleId,
      })
    }

    const nodeMatches = queries.searchNodes(e.className, 10)
    for (const n of nodeMatches) {
      if (n.filePath === filePath) {
        queries.insertAnnotation(n.id, 'Entity', e.tableName, 0, moduleId)
        queries.insertEdge(n.id, entityId, 'jpa_entity',
          JSON.stringify({ table: e.tableName, class: e.className }), 0, 0)
      }
    }

    for (const rel of e.relationships) {
      const targetNodes = queries.searchNodes(rel.targetEntity, 10)
      for (const tn of targetNodes) {
        queries.insertEdge(entityId, tn.id, 'jpa_relationship',
          JSON.stringify({ type: rel.type, field: rel.field, fetch: rel.fetch }), 0, 0)
      }
    }
  }

  return entities
}
