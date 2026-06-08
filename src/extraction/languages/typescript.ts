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

export function parseTypeScriptFile(
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

    if (nodeType === 'function_declaration' || nodeType === 'method_definition') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'name' || c.type === 'property' || c.type === 'identifier'
      )
      const name = nameNode?.text ?? 'anonymous'
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const isExported = checkExport(node, source)
      const docstring = extractTSDoc(lines, range.startLine)

      const params = node.namedChildren
        .filter((c: Parser.SyntaxNode) => c.type === 'formal_parameters')
        .flatMap((c: Parser.SyntaxNode) => c.namedChildren
          .filter((p: Parser.SyntaxNode) => p.type === 'identifier' || p.type === 'required_parameter' || p.type === 'optional_parameter')
          .map((p: Parser.SyntaxNode) => p.text))
        .join(', ')

      const signature = `${isExported ? 'export ' : ''}${nodeType === 'method_definition' ? 'method' : 'function'} ${name}(${params})`.trim()

      nodes.push({
        id: nodeId,
        kind: nodeType === 'method_definition' ? 'method' : 'function',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: isExported ? 'public' : 'private',
        isExported,
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

    if (nodeType === 'arrow_function') {
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const varParent = findAncestorVariable(node, cursor)
      const name = varParent ?? `anonymous_${range.startLine}`
      const nodeId = `${filePath}:${name}:${range.startLine}`

      nodes.push({
        id: nodeId,
        kind: 'function',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: 'public',
        isExported: false,
        docstring: '',
        signature: `(${name}) =>`,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      return
    }

    if (nodeType === 'class_declaration') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'name')
      const name = nameNode?.text ?? 'Unknown'
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const isExported = checkExport(node, source)
      const docstring = extractTSDoc(lines, range.startLine)

      nodes.push({
        id: nodeId,
        kind: 'class',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: isExported ? 'public' : 'private',
        isExported,
        docstring,
        signature: `${isExported ? 'export ' : ''}class ${name}`.trim(),
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }

      scopeStack.push(nodeId)
      walkChildren()
      scopeStack.pop()
      return
    }

    if (nodeType === 'interface_declaration' || nodeType === 'type_alias_declaration') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'name')
      const name = nameNode?.text ?? 'Unknown'
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const isExported = checkExport(node, source)
      const kind = nodeType === 'interface_declaration' ? 'interface' : 'type_alias'

      nodes.push({
        id: nodeId,
        kind,
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: isExported ? 'public' : 'private',
        isExported,
        docstring: '',
        signature: `${isExported ? 'export ' : ''}${kind} ${name}`.trim(),
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      return
    }

    if (nodeType === 'property_signature' || nodeType === 'method_signature') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'name' || c.type === 'property' || c.type === 'identifier'
      )
      const name = nameNode?.text ?? 'unknown'
      const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      nodes.push({
        id: nodeId,
        kind: nodeType === 'method_signature' ? 'method' : 'property',
        name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
        parentId,
        visibility: 'public',
        isExported: false,
        docstring: '',
        signature: name,
        filePath,
        language,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      return
    }

    if (nodeType === 'export_statement') {
      walkChildren()
      return
    }

    if (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration') {
      const declarators = node.namedChildren.filter((c: Parser.SyntaxNode) =>
        c.type === 'variable_declarator'
      )
      for (const decl of declarators) {
        const nameChild = decl.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'name' || c.type === 'identifier')
        if (!nameChild) continue
        const name = nameChild.text
        const parentId = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null
        const nodeId = `${filePath}:${name}:${decl.startPosition.row + 1}`

        const isExported = node.parent?.type === 'export_statement' || checkExport(node.parent, source)

        nodes.push({
          id: nodeId,
          kind: 'variable',
          name,
          qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
          startLine: decl.startPosition.row + 1,
          endLine: decl.endPosition.row + 1,
          startColumn: decl.startPosition.column,
          endColumn: decl.endPosition.column,
          parentId,
          visibility: isExported ? 'public' : 'private',
          isExported,
          docstring: '',
          signature: `${name}`.trim(),
          filePath,
          language,
        })

        if (parentId) {
          edges.push({
            source: parentId,
            target: nodeId,
            kind: 'contains',
            line: decl.startPosition.row + 1,
            col: decl.startPosition.column,
            metadata: '{}',
          })
        }

        const valueChild = decl.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'value')
        if (valueChild) {
          const fnChild = valueChild.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'arrow_function')
          if (fnChild) {
            const fnId = `${filePath}:${name}:${fnChild.startPosition.row + 1}`
            edges.push({
              source: nodeId,
              target: fnId,
              kind: 'contains',
              line: fnChild.startPosition.row + 1,
              col: fnChild.startPosition.column,
              metadata: JSON.stringify({ kind: 'arrow_function_assignment' }),
            })
          }
        }
      }
      return
    }

    if (nodeType === 'call_expression') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'identifier' || c.type === 'member_expression' ||
        c.type === 'property_identifier'
      )
      if (!nameNode) return
      const callName = nameNode.text

      const callerInfo = findEnclosingScope(node, filePath)
      if (callerInfo) {
        edges.push({
          source: callerInfo,
          target: `${filePath}:${callName}`,
          kind: 'calls',
          line: range.startLine,
          col: range.startColumn,
          metadata: JSON.stringify({ name: callName, type: 'call_expression' }),
        })
      }
      return
    }

    if (nodeType === 'import_statement') {
      const path = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'string' || c.type === 'string_fragment')
      const importPath = path?.text ?? ''
      const specifiers = node.namedChildren.filter((c: Parser.SyntaxNode) =>
        c.type === 'import_clause' || c.type === 'namespace_import'
      )
      const importNames: string[] = []

      for (const spec of specifiers) {
        if (spec.type === 'import_clause') {
          spec.namedChildren.forEach((c: Parser.SyntaxNode) => {
            if (c.type === 'identifier') importNames.push(c.text)
            if (c.type === 'named_imports') {
              c.namedChildren
                .filter((n: Parser.SyntaxNode) => n.type === 'import_specifier')
                .forEach((n: Parser.SyntaxNode) => {
                  const id = n.namedChildren.find((x: Parser.SyntaxNode) => x.type === 'identifier')
                  if (id) importNames.push(id.text)
                })
            }
          })
        } else if (spec.type === 'namespace_import') {
          const id = spec.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier')
          if (id) importNames.push(`* as ${id.text}`)
        }
      }

      const sourceId = scopeStack.length > 0 ? scopeStack[0] : `${filePath}:module`
      for (const importName of importNames) {
        edges.push({
          source: sourceId,
          target: importName,
          kind: 'imports',
          line: range.startLine,
          col: range.startColumn,
          metadata: JSON.stringify({ path: importPath, specifier: importName }),
        })
      }
      return
    }

    walkChildren()
  }

  function walkChildren(): void {
    if (cursor.gotoFirstChild()) {
      do {
        visit()
      } while (cursor.gotoNextSibling())
      cursor.gotoParent()
    }
  }

  visit()

  return { nodes, edges }
}

function checkExport(node: Parser.SyntaxNode | null, source: string): boolean {
  if (!node) return false
  const lineStart = node.startPosition?.row ?? 0
  const lines = source.split('\n')
  const line = lines[lineStart] ?? ''
  return line.trim().startsWith('export ')
}

function extractTSDoc(lines: string[], lineNum: number): string {
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

function getNodeName(nodeId: string): string {
  const parts = nodeId.split(':')
  return parts[parts.length - 2] || nodeId
}

function findAncestorVariable(node: Parser.SyntaxNode, _cursor: Parser.TreeCursor): string | null {
  let p = node.parent
  while (p) {
    const decl = p.namedChildren.find((c: Parser.SyntaxNode) =>
      c.type === 'variable_declarator' && c.namedChildren.some((n: Parser.SyntaxNode) =>
        n.type === 'value' && n.namedChildren.some((v: Parser.SyntaxNode) => v.id === node.id)
      )
    )
    if (decl) {
      const name = decl.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'name')
      return name?.text ?? null
    }
    p = p.parent
  }
  return null
}

function findEnclosingScope(node: Parser.SyntaxNode, filePath: string): string | null {
  let p = node.parent
  while (p) {
    if (p.type === 'function_declaration' || p.type === 'method_definition' ||
        p.type === 'arrow_function' || p.type === 'function') {
      const nameNode = p.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'name' || c.type === 'property' || c.type === 'identifier'
      )
      const name = nameNode?.text ?? 'anonymous'
      return `${filePath}:${name}:${p.startPosition.row + 1}`
    }
    p = p.parent
  }
  return null
}
