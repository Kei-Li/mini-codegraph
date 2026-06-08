import type Parser from 'web-tree-sitter'

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

export function parsePythonFile(
  tree: Parser.Tree,
  source: string,
  filePath: string,
  language: string
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const nodes: NodeInfo[] = []
  const edges: EdgeInfo[] = []
  const lines = source.split('\n')

  const cursor = tree.walk()
  const visited = new Set<number>()
  const scopeStack: string[] = []

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

    if (nodeType === 'function_definition' || nodeType === 'async_function_definition') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'name')
      const name = nameNode?.text ?? 'anonymous'
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const docstring = extractPythonDocstring(lines, range.startLine)
      const params = node.namedChildren
        .filter((c: Parser.SyntaxNode) => c.type === 'parameters')
        .flatMap((c: Parser.SyntaxNode) => c.namedChildren.map((p: Parser.SyntaxNode) => p.text))
        .join(', ')
      const signature = `def ${name}(${params})`

      let qualifiedName = name
      if (parentId) qualifiedName = `${getNodeName(parentId)}.${name}`

      const kind = parentId && getNodeKind(parentId, nodes) === 'class' ? 'method' : 'function'

      nodes.push({
        id: nodeId,
        kind,
        name,
        qualifiedName,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: name.startsWith('_') ? 'private' : 'public',
        isExported: !name.startsWith('_'),
        docstring,
        signature,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }

      scopeStack.push(nodeId)
      visitChildren()
      scopeStack.pop()
      return
    }

    if (nodeType === 'class_definition') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'name')
      const name = nameNode?.text ?? 'Unknown'
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const docstring = extractPythonDocstring(lines, range.startLine)
      const bases = node.namedChildren
        .filter((c: Parser.SyntaxNode) => c.type === 'argument_list' || c.type === 'superclass')
        .flatMap((c: Parser.SyntaxNode) => c.namedChildren.map((p: Parser.SyntaxNode) => p.text))
        .join(', ')
      const signature = `class ${name}(${bases})`

      let qualifiedName = name
      if (parentId) qualifiedName = `${getNodeName(parentId)}.${name}`

      nodes.push({
        id: nodeId,
        kind: 'class',
        name,
        qualifiedName,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: name.startsWith('_') ? 'private' : 'public',
        isExported: !name.startsWith('_'),
        docstring,
        signature,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }

      scopeStack.push(nodeId)
      visitChildren()
      scopeStack.pop()
      return
    }

    if (nodeType === 'call') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'identifier' || c.type === 'attribute' || c.type === 'string'
      )
      if (!nameNode) { visitChildren(); return }
      const callName = nameNode.type === 'attribute'
        ? nameNode.namedChildren.map((c: Parser.SyntaxNode) => c.text).join('.')
        : nameNode.text

      const callerId = findEnclosingScope(node, filePath)
      if (callerId) {
        edges.push({
          source: callerId,
          target: `${filePath}:${callName}`,
          kind: 'calls',
          line: range.startLine,
          col: range.startColumn,
          metadata: JSON.stringify({ name: callName, type: 'call' }),
        })
      }
      visitChildren()
      return
    }

    if (nodeType === 'import_statement' || nodeType === 'import_from_statement') {
      const modules = node.namedChildren
        .filter((c: Parser.SyntaxNode) => c.type === 'dotted_name' || c.type === 'aliased_import' || c.type === 'wildcard_import')
        .map((c: Parser.SyntaxNode) => {
          if (c.type === 'dotted_name') return c.text
          if (c.type === 'aliased_import') return c.namedChildren.map((x: Parser.SyntaxNode) => x.text).join(' as ')
          return c.text
        })

      if (nodeType === 'import_from_statement') {
        const fromNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'dotted_name')
        const fromName = fromNode?.text ?? ''
        for (const m of modules) {
          const importName = `${fromName}.${m}`
          const nodeId = `${filePath}:${importName}:${range.startLine}`
          nodes.push({
            id: nodeId,
            kind: 'import',
            name: m,
            qualifiedName: importName,
            startLine: range.startLine,
            endLine: range.endLine,
            startColumn: range.startColumn,
            endColumn: range.endColumn,
            parentId: null,
            visibility: 'public',
            isExported: true,
            docstring: '',
            signature: `from ${fromName} import ${m}`,
            filePath,
            language,
          })
          edges.push({ source: `${filePath}:module`, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
          edges.push({ source: `${filePath}:module`, target: `${fromName.replaceAll('.', '/')}/__init__.py`, kind: 'imports', line: range.startLine, col: range.startColumn, metadata: '{}' })
        }
      } else {
        for (const m of modules) {
          const nodeId = `${filePath}:${m}:${range.startLine}`
          nodes.push({
            id: nodeId,
            kind: 'import',
            name: m,
            qualifiedName: m,
            startLine: range.startLine,
            endLine: range.endLine,
            startColumn: range.startColumn,
            endColumn: range.endColumn,
            parentId: null,
            visibility: 'public',
            isExported: true,
            docstring: '',
            signature: `import ${m}`,
            filePath,
            language,
          })
          edges.push({ source: `${filePath}:module`, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
          const modulePath = m.replaceAll('.', '/')
          edges.push({ source: `${filePath}:module`, target: `${modulePath}/__init__.py`, kind: 'imports', line: range.startLine, col: range.startColumn, metadata: '{}' })
        }
      }

      visitChildren()
      return
    }

    if (nodeType === 'assignment') {
      const leftNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'identifier' || c.type === 'attribute' || c.type === 'pattern_list'
      )
      if (!leftNode || leftNode.type !== 'identifier') { visitChildren(); return }
      const name = leftNode.text
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      nodes.push({
        id: nodeId,
        kind: 'variable',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: name.startsWith('_') ? 'private' : 'public',
        isExported: !name.startsWith('_'),
        docstring: '',
        signature: `${name} = ...`,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      visitChildren()
      return
    }

    if (nodeType === 'decorated_definition') {
      const defNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'function_definition' || c.type === 'class_definition' || c.type === 'async_function_definition'
      )
      if (defNode) {
        const nameNode = defNode.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier')
        const decorators = node.namedChildren
          .filter((c: Parser.SyntaxNode) => c.type === 'decorator')
          .map((d: Parser.SyntaxNode) => d.text)
        if (nameNode && decorators.length > 0) {
          const name = nameNode.text
          if (name === 'route' || name === 'app' || decorators.some(d => d.includes('route') || d.includes('app.'))) {
            const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
            const nodeId = `${filePath}:${name}:${range.startLine}`
            const docstring = extractPythonDocstring(lines, range.startLine)
            const signature = decorators.join(', ') + `\ndef ${name}(...)`

            nodes.push({
              id: nodeId,
              kind: 'route_handler',
              name,
              qualifiedName: name,
              startLine: range.startLine,
              endLine: range.endLine,
              startColumn: range.startColumn,
              endColumn: range.endColumn,
              parentId,
              visibility: 'public',
              isExported: true,
              docstring,
              signature,
              filePath,
              language,
            })
            if (parentId) {
              edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
            }
            scopeStack.push(nodeId)
            visitChildren()
            scopeStack.pop()
            return
          }
        }
      }
      visitChildren()
      return
    }

    visitChildren()
  }

  function visitChildren(): void {
    if (cursor.gotoFirstChild()) {
      do { visit() } while (cursor.gotoNextSibling())
      cursor.gotoParent()
    }
  }

  visit()
  return { nodes, edges }
}

function findEnclosingScope(node: Parser.SyntaxNode, filePath: string): string | null {
  let p = node.parent
  while (p) {
    if (p.type === 'function_definition' || p.type === 'async_function_definition' ||
        p.type === 'class_definition') {
      const nameNode = p.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'identifier' || c.type === 'name'
      )
      const name = nameNode?.text ?? 'anonymous'
      return `${filePath}:${name}:${p.startPosition.row + 1}`
    }
    p = p.parent
  }
  return null
}

function getNodeName(nodeId: string): string {
  const parts = nodeId.split(':')
  return parts.length >= 2 ? parts[parts.length - 2] : nodeId
}

function getNodeKind(nodeId: string, nodes: NodeInfo[]): string {
  const node = nodes.find(n => n.id === nodeId)
  return node?.kind ?? ''
}

function extractPythonDocstring(lines: string[], startLine: number): string {
  for (let i = startLine; i < Math.min(startLine + 3, lines.length); i++) {
    const line = (lines[i - 1] ?? '').trim()
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const end = line.indexOf(line.startsWith('"""') ? '"""' : "'''", 3)
      if (end !== -1) return line.slice(3, end)
      let doc = line.slice(3) + '\n'
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const l = lines[j - 1].trim()
        const delim = line.startsWith('"""') ? '"""' : "'''"
        const idx = l.indexOf(delim)
        if (idx !== -1) { doc += l.slice(0, idx); break }
        doc += l + '\n'
      }
      return doc.trim()
    }
  }
  return ''
}
