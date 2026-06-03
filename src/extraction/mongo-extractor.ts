import type { QueryManager } from '../db/queries.js'

export interface MongoEntity {
  className: string
  filePath: string
  collection: string
  fields: { name: string; type: string; annotation: string }[]
  indexes: { name: string; fields: string; unique: boolean }[]
  repository: boolean
  repositoryMethod?: string
  templateUsage: boolean
}

const MONGO_ANNOTATIONS = ['@Document', '@DBRef', '@Field', '@TextIndexed', '@GeoSpatialIndexed', '@CompoundIndex', '@Indexed']

export function extractMongoEntities(source: string, filePath: string): MongoEntity[] {
  const entities: MongoEntity[] = []
  const lines = source.split('\n')

  let currentClass: string | null = null
  let currentCollection = ''
  let currentFields: { name: string; type: string; annotation: string }[] = []
  let currentIndexes: { name: string; fields: string; unique: boolean }[] = []
  let inClass = false
  let braceDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    const docMatch = line.match(/@Document\s*\(\s*(?:collection\s*=\s*)?["']([^"']+)["']/)
    if (docMatch) {
      const className = lines[i + 1]?.trim().match(/(?:public\s+)?(?:class|interface)\s+(\w+)/)
      if (className) {
        currentClass = className[1]
        currentCollection = docMatch[1]
        currentFields = []
        currentIndexes = []
        inClass = true
        braceDepth = 0
        continue
      }
    }

    if (inClass) {
      braceDepth += (line.match(/{/g) || []).length
      braceDepth -= (line.match(/}/g) || []).length

      for (const ann of MONGO_ANNOTATIONS) {
        if (ann !== '@Document' && line.startsWith(ann)) {
          const fieldLine = lines[i + 1]?.trim() || ''
          const fieldMatch = fieldLine.match(/(?:private|public|protected)\s+(\S+)\s+(\w+)/)
          if (fieldMatch) {
            currentFields.push({ name: fieldMatch[2], type: fieldMatch[1], annotation: ann })
          }

          if (ann === '@CompoundIndex') {
            const defMatch = line.match(/def\s*=\s*['"]([^'"]+)['"]/)
            const unique = line.includes('unique = true')
            if (defMatch) currentIndexes.push({ name: '', fields: defMatch[1], unique })
          }
        }
      }

      if (braceDepth <= 0 && inClass && currentClass) {
        entities.push({
          className: currentClass, filePath, collection: currentCollection,
          fields: [...currentFields], indexes: [...currentIndexes],
          repository: false, templateUsage: false,
        })
        currentClass = null
        inClass = false
      }
    }
  }

  const mongoRepoMatch = source.match(/(?:interface|class)\s+(\w+)\s+extends\s+\w*MongoRepository\s*<\s*(\w+)/)
  if (mongoRepoMatch) {
    const entityName = mongoRepoMatch[2]
    const existingEntity = entities.find(e => e.className === entityName)
    if (existingEntity) {
      existingEntity.repository = true
      existingEntity.repositoryMethod = mongoRepoMatch[1]
      const methodLines = source.match(/(?:find\w+|delete\w+|update\w+|count\w+)\s*\([^)]*\)\s*;/g)
      if (methodLines) existingEntity.repositoryMethod = methodLines.join(', ')
    }
  }

  const templateMatch = source.match(/MongoTemplate\s+\w+/)
  if (templateMatch) {
    entities.forEach(e => { if (!e.repository) e.templateUsage = true })
  }

  return entities
}

export function indexMongoEntities(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): MongoEntity[] {
  const entities = extractMongoEntities(source, filePath)

  for (const entity of entities) {
    const nodeId = `mongo:${filePath}:${entity.className}`

    queries.insertNode({
      id: nodeId, kind: 'mongo_entity', name: entity.className, qualifiedName: entity.className,
      filePath, language: 'java', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
      docstring: '', signature: JSON.stringify({
        collection: entity.collection,
        fields: entity.fields.length,
        indexes: entity.indexes,
        repository: entity.repository,
        templateUsage: entity.templateUsage,
      }),
      visibility: 'public', isExported: false, parentId: null, moduleId,
    })

    if (entity.repository && entity.repositoryMethod) {
      const repoNodeId = `mongo:repo:${filePath}:${entity.repositoryMethod}`
      queries.insertNode({
        id: repoNodeId, kind: 'mongo_repository', name: entity.repositoryMethod,
        qualifiedName: entity.repositoryMethod, filePath, language: 'java',
        startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
        docstring: '', signature: JSON.stringify({ entity: entity.className }),
        visibility: 'public', isExported: true, parentId: null, moduleId,
      })
      queries.insertEdge(nodeId, repoNodeId, 'contains', JSON.stringify({ kind: 'mongo_repository' }), 0, 0)
    }
  }

  return entities
}
