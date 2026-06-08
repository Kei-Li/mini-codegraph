import type { QueryManager } from '../../db/queries.js'

const LOMBOK_LOG_ANNOTATIONS = new Set([
  'Slf4j', 'Log4j', 'Log4j2', 'Log', 'CommonsLog', 'Flogger', 'CustomLog', 'XSlf4j',
])

const LOMBOK_BUILDER_ANNOTATIONS = new Set([
  'Builder', 'SuperBuilder',
])

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function generateGetterName(fieldName: string, fieldType: string): string {
  if (fieldType.toLowerCase() === 'boolean') {
    return `is${capitalize(fieldName)}`
  }
  return `get${capitalize(fieldName)}`
}

function generateSetterName(fieldName: string): string {
  return `set${capitalize(fieldName)}`
}

export function indexLombokAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): { synthesizedNodes: number; synthesizedEdges: number } {
  let synthesizedNodes = 0
  let synthesizedEdges = 0
  const lines = source.split('\n')

  const classAnnotations = new Map<string, Set<string>>()
  const classFields = new Map<string, { name: string; type: string; line: number }[]>()
  const currentClassAnnotations: string[] = []
  let currentClassName = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    const annMatch = line.match(/^@(\w+)(?:\([^)]*\))?\s*$/)
    if (annMatch) {
      const annName = annMatch[1]
      currentClassAnnotations.push(annName)
      continue
    }

    const classMatch = line.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/)
    if (classMatch) {
      currentClassName = classMatch[1]
      const anns = new Set(currentClassAnnotations)
      classAnnotations.set(currentClassName, anns)
      classFields.set(currentClassName, [])
      currentClassAnnotations.length = 0
      continue
    }

    if (currentClassName && !line.startsWith('@') && !line.startsWith('import') && !line.startsWith('package')) {
      if (currentClassAnnotations.length > 0) {
        const existing = classAnnotations.get(currentClassName) ?? new Set()
        for (const a of currentClassAnnotations) existing.add(a)
        classAnnotations.set(currentClassName, existing)
        currentClassAnnotations.length = 0
      }

      const fieldMatch = line.match(/(?:private\s+)?(?:final\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*(?:;|=|,)/)
      if (fieldMatch && !line.startsWith('(') && !line.startsWith(')') && !line.includes('(')) {
        const fieldType = fieldMatch[1]
        const fieldName = fieldMatch[2]
        if (!fieldType.startsWith('@') && fieldName !== currentClassName && !fieldType.startsWith('return')) {
          const fields = classFields.get(currentClassName) ?? []
          fields.push({ name: fieldName, type: fieldType, line: i + 1 })
          classFields.set(currentClassName, fields)
        }
      }

      const methodMatch = line.match(/(?:public\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
      if (methodMatch && !['if', 'for', 'while', 'switch', 'return'].includes(methodMatch[2])) {
        currentClassName = ''
      }
    }

    if (line.startsWith('}') && currentClassName) {
      currentClassName = ''
    }
  }

  const allNodes = queries.getAllNodes()
  const fileNodes = allNodes.filter(n => n.filePath === filePath && n.moduleId === moduleId)

  for (const [className, anns] of classAnnotations) {
    const classNode = fileNodes.find(n => n.name === className && n.kind === 'class')
    if (!classNode) continue

    const fields = classFields.get(className) ?? []
    const isData = anns.has('Data')
    const isGetter = anns.has('Getter') || isData
    const isSetter = anns.has('Setter') || isData
    const isAllArgs = anns.has('AllArgsConstructor') || isData
    const isNoArgs = anns.has('NoArgsConstructor') || isData
    const isBuilder = LOMBOK_BUILDER_ANNOTATIONS.has('Builder') && anns.has('Builder') || anns.has('SuperBuilder')
    const isValue = anns.has('Value')
    const isSlf4j = LOMBOK_LOG_ANNOTATIONS.has('Slf4j') && anns.has('Slf4j')
    const isToString = anns.has('ToString') || isData
    const isEqualsHashCode = anns.has('EqualsAndHashCode') || isData

    if (isValue) {
      const synthesizedId = `${filePath}:${className}:allArgsConstructor`
      queries.insertNode({
        id: synthesizedId,
        kind: 'constructor',
        name: className,
        qualifiedName: `${classNode.qualifiedName}.${className}`,
        filePath,
        language: 'java',
        startLine: classNode.startLine,
        endLine: classNode.startLine,
        startColumn: 0, endColumn: 0,
        docstring: 'Synthesized by Lombok @Value',
        signature: `${className}(${fields.map(f => `${f.type} ${f.name}`).join(', ')})`,
        visibility: 'public',
        isExported: false,
        parentId: classNode.id,
        moduleId,
      })
      queries.insertAnnotation(synthesizedId, 'Lombok', 'Value', classNode.startLine, moduleId)
      queries.insertEdge(classNode.id, synthesizedId, 'lombok_synthetic', JSON.stringify({ annotation: 'Value' }), classNode.startLine, 0)
      synthesizedNodes++
      synthesizedEdges++
    }

    for (const field of fields) {
      if (isGetter) {
        const getterName = generateGetterName(field.name, field.type)
        const getterId = `${filePath}:${className}:${getterName}`
        queries.insertNode({
          id: getterId,
          kind: 'method',
          name: getterName,
          qualifiedName: `${classNode.qualifiedName}.${getterName}`,
          filePath,
          language: 'java',
          startLine: field.line,
          endLine: field.line,
          startColumn: 0, endColumn: 0,
          docstring: `Getter for ${field.name} (Lombok ${isValue ? '@Value' : '@Getter'})`,
          signature: `public ${field.type} ${getterName}() { return this.${field.name}; }`,
          visibility: 'public',
          isExported: false,
          parentId: classNode.id,
          moduleId,
        })
        queries.insertAnnotation(getterId, 'Lombok', isValue ? 'Value' : 'Getter', field.line, moduleId)
        queries.insertEdge(classNode.id, getterId, 'lombok_synthetic', JSON.stringify({ annotation: isValue ? 'Value' : 'Getter', field: field.name }), field.line, 0)
        synthesizedNodes++
        synthesizedEdges++
      }

      if (isSetter && !isValue) {
        const setterName = generateSetterName(field.name)
        const setterId = `${filePath}:${className}:${setterName}`
        queries.insertNode({
          id: setterId,
          kind: 'method',
          name: setterName,
          qualifiedName: `${classNode.qualifiedName}.${setterName}`,
          filePath,
          language: 'java',
          startLine: field.line,
          endLine: field.line,
          startColumn: 0, endColumn: 0,
          docstring: `Setter for ${field.name} (Lombok @Setter)`,
          signature: `public void ${setterName}(${field.type} ${field.name}) { this.${field.name} = ${field.name}; }`,
          visibility: 'public',
          isExported: false,
          parentId: classNode.id,
          moduleId,
        })
        queries.insertAnnotation(setterId, 'Lombok', 'Setter', field.line, moduleId)
        queries.insertEdge(classNode.id, setterId, 'lombok_synthetic', JSON.stringify({ annotation: 'Setter', field: field.name }), field.line, 0)
        synthesizedNodes++
        synthesizedEdges++
      }
    }

    if (isAllArgs && fields.length > 0) {
      const ctorId = `${filePath}:${className}:allArgsConstructor`
      queries.insertNode({
        id: ctorId,
        kind: 'constructor',
        name: className,
        qualifiedName: `${classNode.qualifiedName}.${className}`,
        filePath,
        language: 'java',
        startLine: classNode.startLine,
        endLine: classNode.startLine,
        startColumn: 0, endColumn: 0,
        docstring: 'Synthesized by Lombok @AllArgsConstructor',
        signature: `${className}(${fields.map(f => `${f.type} ${f.name}`).join(', ')})`,
        visibility: 'public',
        isExported: false,
        parentId: classNode.id,
        moduleId,
      })
      queries.insertAnnotation(ctorId, 'Lombok', 'AllArgsConstructor', classNode.startLine, moduleId)
      queries.insertEdge(classNode.id, ctorId, 'lombok_synthetic', JSON.stringify({ annotation: 'AllArgsConstructor' }), classNode.startLine, 0)
      synthesizedNodes++
      synthesizedEdges++
    }

    if (isNoArgs) {
      const ctorId = `${filePath}:${className}:noArgsConstructor`
      queries.insertNode({
        id: ctorId,
        kind: 'constructor',
        name: className,
        qualifiedName: `${classNode.qualifiedName}.${className}`,
        filePath,
        language: 'java',
        startLine: classNode.startLine,
        endLine: classNode.startLine,
        startColumn: 0, endColumn: 0,
        docstring: 'Synthesized by Lombok @NoArgsConstructor',
        signature: `public ${className}() {}`,
        visibility: 'public',
        isExported: false,
        parentId: classNode.id,
        moduleId,
      })
      queries.insertAnnotation(ctorId, 'Lombok', 'NoArgsConstructor', classNode.startLine, moduleId)
      queries.insertEdge(classNode.id, ctorId, 'lombok_synthetic', JSON.stringify({ annotation: 'NoArgsConstructor' }), classNode.startLine, 0)
      synthesizedNodes++
      synthesizedEdges++
    }

    if (isBuilder) {
      const builderId = `${filePath}:${className}:builder`
      queries.insertNode({
        id: builderId,
        kind: 'method',
        name: 'builder',
        qualifiedName: `${classNode.qualifiedName}.builder`,
        filePath,
        language: 'java',
        startLine: classNode.startLine,
        endLine: classNode.startLine,
        startColumn: 0, endColumn: 0,
        docstring: 'Synthesized by Lombok @Builder',
        signature: `public static ${className}Builder builder()`,
        visibility: 'public',
        isExported: false,
        parentId: classNode.id,
        moduleId,
      })
      queries.insertAnnotation(builderId, 'Lombok', 'Builder', classNode.startLine, moduleId)
      queries.insertEdge(classNode.id, builderId, 'lombok_synthetic', JSON.stringify({ annotation: 'Builder' }), classNode.startLine, 0)
      synthesizedNodes++
      synthesizedEdges++
    }

    if (isToString) {
      const toStringId = `${filePath}:${className}:toString`
      const existingToString = fileNodes.find(n => n.name === 'toString' && n.parentId === classNode.id)
      if (!existingToString) {
        queries.insertNode({
          id: toStringId,
          kind: 'method',
          name: 'toString',
          qualifiedName: `${classNode.qualifiedName}.toString`,
          filePath,
          language: 'java',
          startLine: classNode.startLine,
          endLine: classNode.startLine,
          startColumn: 0, endColumn: 0,
          docstring: 'Synthesized by Lombok @ToString',
          signature: `public String toString() { ... }`,
          visibility: 'public',
          isExported: false,
          parentId: classNode.id,
          moduleId,
        })
        queries.insertAnnotation(toStringId, 'Lombok', 'ToString', classNode.startLine, moduleId)
        queries.insertEdge(classNode.id, toStringId, 'lombok_synthetic', JSON.stringify({ annotation: 'ToString' }), classNode.startLine, 0)
        synthesizedNodes++
        synthesizedEdges++
      }
    }

    if (isEqualsHashCode) {
      const equalsId = `${filePath}:${className}:equals`
      const hashCodeId = `${filePath}:${className}:hashCode`
      const existingEquals = fileNodes.find(n => n.name === 'equals' && n.parentId === classNode.id)
      const existingHashCode = fileNodes.find(n => n.name === 'hashCode' && n.parentId === classNode.id)

      if (!existingEquals) {
        queries.insertNode({
          id: equalsId,
          kind: 'method',
          name: 'equals',
          qualifiedName: `${classNode.qualifiedName}.equals`,
          filePath,
          language: 'java',
          startLine: classNode.startLine,
          endLine: classNode.startLine,
          startColumn: 0, endColumn: 0,
          docstring: 'Synthesized by Lombok @EqualsAndHashCode',
          signature: 'public boolean equals(Object o) { ... }',
          visibility: 'public',
          isExported: false,
          parentId: classNode.id,
          moduleId,
        })
        queries.insertAnnotation(equalsId, 'Lombok', 'EqualsAndHashCode', classNode.startLine, moduleId)
        queries.insertEdge(classNode.id, equalsId, 'lombok_synthetic', JSON.stringify({ annotation: 'EqualsAndHashCode' }), classNode.startLine, 0)
        synthesizedNodes++
        synthesizedEdges++
      }

      if (!existingHashCode) {
        queries.insertNode({
          id: hashCodeId,
          kind: 'method',
          name: 'hashCode',
          qualifiedName: `${classNode.qualifiedName}.hashCode`,
          filePath,
          language: 'java',
          startLine: classNode.startLine,
          endLine: classNode.startLine,
          startColumn: 0, endColumn: 0,
          docstring: 'Synthesized by Lombok @EqualsAndHashCode',
          signature: 'public int hashCode() { ... }',
          visibility: 'public',
          isExported: false,
          parentId: classNode.id,
          moduleId,
        })
        queries.insertAnnotation(hashCodeId, 'Lombok', 'EqualsAndHashCode', classNode.startLine, moduleId)
        queries.insertEdge(classNode.id, hashCodeId, 'lombok_synthetic', JSON.stringify({ annotation: 'EqualsAndHashCode' }), classNode.startLine, 0)
        synthesizedNodes++
        synthesizedEdges++
      }
    }

    if (isSlf4j) {
      const logFieldId = `${filePath}:${className}:log`
      queries.insertNode({
        id: logFieldId,
        kind: 'field',
        name: 'log',
        qualifiedName: `${classNode.qualifiedName}.log`,
        filePath,
        language: 'java',
        startLine: classNode.startLine,
        endLine: classNode.startLine,
        startColumn: 0, endColumn: 0,
        docstring: 'Synthesized by Lombok @Slf4j',
        signature: 'private static final Logger log = LoggerFactory.getLogger(...)',
        visibility: 'private',
        isExported: false,
        parentId: classNode.id,
        moduleId,
      })
      queries.insertAnnotation(logFieldId, 'Lombok', 'Slf4j', classNode.startLine, moduleId)
      queries.insertEdge(classNode.id, logFieldId, 'lombok_synthetic', JSON.stringify({ annotation: 'Slf4j' }), classNode.startLine, 0)
      synthesizedNodes++
      synthesizedEdges++
    }
  }

  return { synthesizedNodes, synthesizedEdges }
}
