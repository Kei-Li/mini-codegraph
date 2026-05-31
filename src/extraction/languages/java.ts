import Parser from 'web-tree-sitter'

export interface NodeInfo {
  kind: string
  name: string
  qualifiedName: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  parentId: string | null
  visibility: string
  isExported: boolean
  docstring: string
  signature: string
  filePath: string
  language: string
  id: string
}

export interface EdgeInfo {
  source: string
  target: string
  kind: string
  line: number
  col: number
  metadata: string
}

export function parseJavaFile(
  tree: Parser.Tree,
  source: string,
  filePath: string,
  language: string
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const nodes: NodeInfo[] = []
  const edges: EdgeInfo[] = []

  const classStack: string[] = []
  const lines = source.split('\n')

  const cursor = tree.walk()
  const visited = new Set<number>()

  function visit(): void {
    const node = cursor.currentNode
    if (!node || visited.has(node.id)) return
    visited.add(node.id)

    const nodeType = node.type
    const range = {
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
    }

    if (nodeType === 'class_declaration' || nodeType === 'interface_declaration' || nodeType === 'enum_declaration') {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'identifier' || c.type === 'name')
      const name = nameNode?.text ?? 'Unknown'
      const parentId = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const visibility = findVisibility(lines, range.startLine)
      const docstring = extractJavaDoc(lines, range.startLine)

      let qualifiedName = name
      if (parentId) {
        qualifiedName = `${getNodeName(parentId)}.${name}`
      } else {
        qualifiedName = extractPackage(lines, name)
      }

      nodes.push({
        id: nodeId,
        kind: nodeType === 'class_declaration' ? 'class' : nodeType === 'interface_declaration' ? 'interface' : 'enum',
        name,
        qualifiedName,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility,
        isExported: visibility === 'public',
        docstring,
        signature: name,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }

      classStack.push(nodeId)
      const wc = cursor.gotoFirstChild()
      if (wc) { visit(); cursor.gotoParent() }
      classStack.pop()
      return
    }

    if (nodeType === 'method_declaration' || nodeType === 'constructor_declaration') {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'identifier' || c.type === 'name')
      const name = nameNode?.text ?? (nodeType === 'constructor_declaration' ? getCurrentClassName(classStack, nodes) : 'Unknown')
      const parentId = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`
      const visibility = findVisibility(lines, range.startLine)
      const docstring = extractJavaDoc(lines, range.startLine)

      const params = node.namedChildren
        .filter((c: any) => c.type === 'formal_parameters')
        .flatMap((c: any) => c.namedChildren.map((p: any) => p.text))
        .join(', ')

      const signature = `${visibility} ${name}(${params})`.trim()

      nodes.push({
        id: nodeId,
        kind: nodeType === 'constructor_declaration' ? 'constructor' : 'method',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}(${params})`.trim() : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility,
        isExported: visibility === 'public',
        docstring,
        signature,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      return
    }

    if (nodeType === 'field_declaration') {
      const parentId = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const declarator = node.namedChildren.find((c: any) => c.type === 'variable_declarator')
      const name = declarator?.namedChildren.find((c: any) => c.type === 'identifier')?.text ?? 'unknown'
      const nodeId = `${filePath}:${name}:${range.startLine}`
      const visibility = findVisibility(lines, range.startLine)

      nodes.push({
        id: nodeId,
        kind: 'field',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility,
        isExported: visibility === 'public',
        docstring: '',
        signature: `${visibility} ${name}`.trim(),
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      return
    }

    if (nodeType === 'method_invocation') {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'identifier' || c.type === 'name')
      if (!nameNode) return
      const callName = nameNode.text

      const callerId = findEnclosingMethod(node, filePath, nodes)
      if (callerId) {
        edges.push({
          source: callerId,
          target: `${filePath}:${callName}`,
          kind: 'calls',
          line: range.startLine,
          col: range.startColumn,
          metadata: JSON.stringify({ name: callName, type: 'method_invocation' }),
        })
      }
      return
    }

    if (nodeType === 'object_creation_expression') {
      const typeNode = node.namedChildren.find((c: any) => c.type === 'type' || c.type === 'type_identifier')
      if (!typeNode) return
      const callerId = findEnclosingMethod(node, filePath, nodes)
      if (callerId) {
        edges.push({
          source: callerId,
          target: `${filePath}:${typeNode.text}`,
          kind: 'calls',
          line: range.startLine,
          col: range.startColumn,
          metadata: JSON.stringify({ name: typeNode.text, type: 'constructor' }),
        })
      }
      return
    }

    if (nodeType === 'import_declaration') {
      if (classStack.length === 0) return

      const importPath = node.text.replace('import ', '').replace(';', '').trim()
      const importName = importPath.split('.').pop() ?? importPath

      edges.push({
        source: classStack[0],
        target: importName,
        kind: 'imports',
        line: range.startLine,
        col: range.startColumn,
        metadata: JSON.stringify({ path: importPath }),
      })
      return
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const wc = cursor.gotoFirstChild()
      if (wc) { visit(); cursor.gotoParent() }
    }
  }

  visit()

  return { nodes, edges }
}

function findVisibility(lines: string[], lineNum: number): string {
  for (let i = lineNum - 2; i >= 0 && i >= lineNum - 5; i--) {
    const line = lines[i] ?? ''
    if (line.includes('public ')) return 'public'
    if (line.includes('private ')) return 'private'
    if (line.includes('protected ')) return 'protected'
  }
  return 'public'
}

function extractJavaDoc(lines: string[], lineNum: number): string {
  const docLines: string[] = []
  for (let i = lineNum - 2; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line.startsWith('*')) {
      docLines.unshift(line.replace(/^\s*\*\s?/, ''))
    } else if (line.endsWith('/**')) {
      docLines.unshift(line.replace(/^\s*\/\*\*\s?/, ''))
      break
    } else if (line.startsWith('/**')) {
      docLines.unshift(line.replace(/^\s*\/\*\*\s?/, ''))
      break
    } else if (docLines.length > 0 && !line.startsWith('*') && !line.startsWith('/**')) {
      break
    } else if (docLines.length === 0) {
      continue
    } else {
      break
    }
  }
  return docLines.join(' ')
}

function extractPackage(lines: string[], className: string): string {
  for (const line of lines) {
    if (line.trim().startsWith('package ')) {
      const pkg = line.trim().replace('package ', '').replace(';', '').trim()
      return `${pkg}.${className}`
    }
  }
  return className
}

function getNodeName(nodeId: string): string {
  const parts = nodeId.split(':')
  return parts[parts.length - 2] || nodeId
}

function getCurrentClassName(classStack: string[], _nodes: NodeInfo[]): string {
  if (classStack.length === 0) return 'Unknown'
  return getNodeName(classStack[classStack.length - 1])
}

function findEnclosingMethod(
  node: any,
  filePath: string,
  _nodes: NodeInfo[]
): string | null {
  let p = node.parent
  while (p) {
    if (p.type === 'method_declaration' || p.type === 'constructor_declaration') {
      const nameChild = p.namedChildren.find((c: any) => c.type === 'identifier' || c.type === 'name')
      const name = nameChild?.text ?? 'Unknown'
      return `${filePath}:${name}:${p.startPosition.row + 1}`
    }
    p = p.parent
  }
  return null
}
