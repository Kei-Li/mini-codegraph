import type Parser from 'web-tree-sitter'
import type { NodeInfo, EdgeInfo } from './types.js'

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
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'name')
      const name = nameNode?.text ?? 'Unknown'
      const parentId = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`

      const visibility = findVisibility(lines, range.startLine)
      const docstring = extractJavaDoc(lines, range.startLine)
      const annotations = extractAnnotationsFor(lines, range.startLine)

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
        annotations,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }

      classStack.push(nodeId)
      visitChildren()
      classStack.pop()
      return
    }

    if (nodeType === 'method_declaration' || nodeType === 'constructor_declaration') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'name')
      const name = nameNode?.text ?? (nodeType === 'constructor_declaration' ? getCurrentClassName(classStack, nodes) : 'Unknown')
      const parentId = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const nodeId = `${filePath}:${name}:${range.startLine}`
      const visibility = findVisibility(lines, range.startLine)
      const docstring = extractJavaDoc(lines, range.startLine)
      const annotations = extractAnnotationsFor(lines, range.startLine)

      const params = node.namedChildren
        .filter((c: Parser.SyntaxNode) => c.type === 'formal_parameters')
        .flatMap((c: Parser.SyntaxNode) => c.namedChildren.map((p: Parser.SyntaxNode) => p.text))
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
        annotations,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }

      visitChildren()
      return
    }

    if (nodeType === 'field_declaration') {
      const parentId = classStack.length > 0 ? classStack[classStack.length - 1] : null
      const declarator = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'variable_declarator')
      const name = declarator?.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier')?.text ?? 'unknown'
      const nodeId = `${filePath}:${name}:${range.startLine}`
      const visibility = findVisibility(lines, range.startLine)
      const annotations = extractAnnotationsFor(lines, range.startLine)

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
        annotations,
      })

      if (parentId) {
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: range.startLine, col: range.startColumn, metadata: '{}' })
      }
      return
    }

    if (nodeType === 'method_invocation') {
      const nameNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'name')
      if (!nameNode) return
      const callName = nameNode.text

      const callerId = findEnclosingMethod(node, filePath)
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

      const objectNode = node.namedChildren.find((c: Parser.SyntaxNode) =>
        c.type === 'object_identifier' || c.type === 'scoped_identifier' || c.type === 'member_expression'
      )
      if (objectNode) {
        const qualifier = objectNode.text
        if (qualifier && qualifier !== callName) {
          const fullCall = `${qualifier}.${callName}`
          const callerId2 = findEnclosingMethod(node, filePath)
          if (callerId2) {
            edges.push({
              source: callerId2,
              target: `${filePath}:${fullCall}`,
              kind: 'calls',
              line: range.startLine,
              col: range.startColumn,
              metadata: JSON.stringify({ name: fullCall, type: 'qualified_invocation' }),
            })
          }
        }
      }
      return
    }

    if (nodeType === 'object_creation_expression') {
      const typeNode = node.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'type' || c.type === 'type_identifier')
      if (!typeNode) return
      const callerId = findEnclosingMethod(node, filePath)
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

    visitChildren()
  }

  function visitChildren(): void {
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

function extractAnnotationsFor(lines: string[], lineNum: number): { name: string; value: string }[] {
  const annotations: { name: string; value: string }[] = []
  for (let i = lineNum - 2; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (!line.startsWith('@')) break

    const annMatch = line.match(/@(\w+)\s*(?:\(([^)]*)\))?/)
    if (annMatch) {
      annotations.push({
        name: annMatch[1],
        value: annMatch[2]?.trim() ?? '',
      })
    }
  }
  return annotations
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

function findEnclosingMethod(node: Parser.SyntaxNode, filePath: string): string | null {
  let p = node.parent
  while (p) {
    if (p.type === 'method_declaration' || p.type === 'constructor_declaration') {
      const nameChild = p.namedChildren.find((c: Parser.SyntaxNode) => c.type === 'identifier' || c.type === 'name')
      const name = nameChild?.text ?? 'Unknown'
      return `${filePath}:${name}:${p.startPosition.row + 1}`
    }
    p = p.parent
  }
  return null
}

/**
 * Regex-based fallback parser for Java files when tree-sitter fails.
 * Extracts classes/interfaces/enums, methods/constructors, fields, and annotations.
 */
export function parseJavaFileWithRegex(
  source: string,
  filePath: string,
  language: string
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const nodes: NodeInfo[] = []
  const edges: EdgeInfo[] = []
  const lines = source.split('\n')
  const annotationLines = new Map<number, { name: string; value: string }[]>()
  const classStack: { id: string; name: string; startLine: number }[] = []
  let currentPackage = ''

  // Extract package
  for (let i = 0; i < lines.length; i++) {
    const pkgMatch = lines[i]?.match(/^\s*package\s+([\w.]+)\s*;/)
    if (pkgMatch) { currentPackage = pkgMatch[1]; break }
  }

  // First pass: collect annotations per line (0-indexed)
  for (let i = 0; i < lines.length; i++) {
    const tr = lines[i]?.trim() ?? ''
    if (tr.startsWith('@')) {
      const annMatch = tr.match(/@(\w+)\s*(?:\(([^)]*)\))?/)
      if (annMatch) {
        const anns = annotationLines.get(i) ?? []
        anns.push({ name: annMatch[1], value: annMatch[2]?.trim() ?? '' })
        annotationLines.set(i, anns)
      }
    }
  }

  // Look up annotations that appear on lines immediately preceding `lineIdx` (0-indexed)
  function collectAnnotationsBefore(lineIdx: number): { name: string; value: string }[] {
    const result: { name: string; value: string }[] = []
    for (let j = lineIdx - 1; j >= 0; j--) {
      const tr = lines[j]?.trim() ?? ''
      if (!tr.startsWith('@')) break
      const anns = annotationLines.get(j)
      if (anns) result.unshift(...anns)
    }
    return result
  }

  // Track lines that already had a structural declaration matched
  const classLines = new Set<number>()

  // Second pass: extract class/interface/enum declarations
  const classPattern = /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)*(class|interface|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(classPattern)
    if (!m) continue
    classLines.add(i)
    const kind = m[1] === 'class' ? 'class' : m[1] === 'interface' ? 'interface' : 'enum'
    const name = m[2]
    const parentId = classStack.length > 0 ? classStack[classStack.length - 1].id : null
    const nodeId = `${filePath}:${name}:${i + 1}`
    const visibility = findVisibility(lines, i + 1)
    const docstring = extractJavaDoc(lines, i + 1)
    const anns = collectAnnotationsBefore(i)
    const qualifiedName = currentPackage ? `${currentPackage}.${name}` : name

    nodes.push({
      id: nodeId, kind, name, qualifiedName,
      startLine: i + 1, endLine: findClassEnd(lines, i),
      startColumn: 0, endColumn: 0, parentId, visibility,
      isExported: visibility === 'public', docstring, signature: name,
      filePath, language, annotations: anns,
    })

    if (parentId) {
      edges.push({ source: parentId, target: nodeId, kind: 'contains', line: i + 1, col: 0, metadata: '{}' })
    }

    // extends/implements edges
    if (m[3]) {
      edges.push({ source: nodeId, target: m[3], kind: 'extends', line: i + 1, col: 0, metadata: '{}' })
    }
    if (m[4]) {
      const ifaces = m[4].split(',').map(s => s.trim()).filter(Boolean)
      for (const iface of ifaces) {
        edges.push({ source: nodeId, target: iface, kind: 'implements', line: i + 1, col: 0, metadata: '{}' })
      }
    }

    classStack.push({ id: nodeId, name, startLine: i + 1 })
  }

  // Third pass: extract fields and methods
  const methodPattern = /^\s*(?:(public|private|protected)\s+)?(?:(abstract|static|final|synchronized)\s+)?(?:<[^>]+>\s+)?([\w][\w.\[\]]*(?:<[^>]*>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/
  const constructorPattern = /^\s*(?:(public|private|protected)\s+)?\s*(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/
  const fieldPattern = /^\s*(?:(public|private|protected)\s+)?(?:(static|final|volatile|transient)\s+)?([\w][\w.\[\]]*(?:<[^>]*>)?)\s+(\w+)(?:\s*=\s*[^;]+)?\s*;/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // Skip lines that already had a class/interface/enum matched
    if (classLines.has(i)) continue
    const parentId = classStack.length > 0 ? classStack[classStack.length - 1].id : null
    if (!parentId) continue

    // Skip lines inside nested class scope
    if (!isInScope(classStack, i + 1)) continue

    const anns = collectAnnotationsBefore(i)

    // Method
    const mm = line.match(methodPattern)
    if (mm && !isKeyword(mm[4])) {
      const visibility = mm[1] || 'public'
      const name = mm[4]
      const returnType = mm[3]
      const params = mm[5]
      const nodeId = `${filePath}:${name}:${i + 1}`
      const docstring = extractJavaDoc(lines, i + 1)

      nodes.push({
        id: nodeId, kind: 'method', name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}(${params})`.trim() : name,
        startLine: i + 1, endLine: findMethodEnd(lines, i),
        startColumn: 0, endColumn: 0, parentId, visibility,
        isExported: visibility === 'public', docstring,
        signature: `${visibility} ${returnType} ${name}(${params})`.trim(),
        filePath, language, annotations: anns,
      })
      edges.push({ source: parentId, target: nodeId, kind: 'contains', line: i + 1, col: 0, metadata: '{}' })
      continue
    }

    // Constructor
    const cm = line.match(constructorPattern)
    if (cm && classStack.length > 0) {
      const visibility = cm[1] || 'public'
      const name = cm[2]
      if (name === classStack[classStack.length - 1].name) {
        const params = cm[3]
        const nodeId = `${filePath}:${name}:${i + 1}`
        const docstring = extractJavaDoc(lines, i + 1)
        nodes.push({
          id: nodeId, kind: 'constructor', name,
          qualifiedName: parentId ? `${getNodeName(parentId)}.${name}(${params})`.trim() : name,
          startLine: i + 1, endLine: findMethodEnd(lines, i),
          startColumn: 0, endColumn: 0, parentId, visibility,
          isExported: visibility === 'public', docstring,
          signature: `${visibility} ${name}(${params})`.trim(),
          filePath, language, annotations: anns,
        })
        edges.push({ source: parentId, target: nodeId, kind: 'contains', line: i + 1, col: 0, metadata: '{}' })
        continue
      }
    }

    // Field
    const fm = line.match(fieldPattern)
    if (fm && !line.includes('(') && !line.includes(')')) {
      const visibility = fm[1] || 'public'
      const name = fm[3]
      const nodeId = `${filePath}:${name}:${i + 1}`
      nodes.push({
        id: nodeId, kind: 'field', name,
        qualifiedName: parentId ? `${getNodeName(parentId)}.${name}` : name,
        startLine: i + 1, endLine: i + 1,
        startColumn: 0, endColumn: 0, parentId, visibility,
        isExported: visibility === 'public', docstring: '',
        signature: `${visibility} ${name}`.trim(),
        filePath, language, annotations: anns,
      })
      edges.push({ source: parentId, target: nodeId, kind: 'contains', line: i + 1, col: 0, metadata: '{}' })
    }
  }

  return { nodes, edges }
}

function findClassEnd(lines: string[], start: number): number {
  let braceCount = 0
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') braceCount++
      if (ch === '}') braceCount--
    }
    if (braceCount <= 0 && i > start) return i + 1
  }
  return lines.length
}

function findMethodEnd(lines: string[], start: number): number {
  let braceCount = 0
  let started = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') { braceCount++; started = true }
      if (ch === '}') braceCount--
    }
    if (started && braceCount <= 0) return i + 1
  }
  return lines.length
}

function isInScope(classStack: { id: string; name: string; startLine: number }[], line: number): boolean {
  if (classStack.length === 0) return true
  const top = classStack[classStack.length - 1]
  return line >= top.startLine
}

function isKeyword(name: string): boolean {
  const keywords = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'try', 'catch', 'finally', 'new', 'throw', 'synchronized', 'assert'])
  return keywords.has(name)
}
