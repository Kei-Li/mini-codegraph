import Parser from 'web-tree-sitter'
import type { NodeInfo, EdgeInfo } from './java.js'

export type { NodeInfo, EdgeInfo }

export function parseKotlinFile(source: string, filePath: string, parser: Parser, _config: any): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const tree = parser.parse(source)
  const rootNode = tree.rootNode
  const nodes: NodeInfo[] = []
  const edges: EdgeInfo[] = []

  const nsStack: string[] = []
  let currentClass: { name: string; id: string; qualifiedName: string; startLine: number } | null = null

  function visit(node: Parser.SyntaxNode, depth: number) {
    if (node.type === 'source_file') {
      const pkgNode = node.children.find(c => c.type === 'package_header')
      if (pkgNode) {
        const idNode = pkgNode.children.find(c => c.type === 'identifier')
        if (idNode) nsStack.push(idNode.text)
      }
    }

    if (node.type === 'class_declaration' || node.type === 'object_declaration') {
      const nameNode = node.childForFieldName('name')
      if (nameNode) {
        const name = nameNode.text
        const qualifiedName = [...nsStack, name].join('.')
        const id = `${filePath}:${qualifiedName}`
        const annotations: { name: string; value: string }[] = []
        const annNode = node.children.find(c => c.type === 'modifier_list' || c.type === 'annotations')
        if (annNode) {
          for (const child of annNode.children) {
            if (child.type === 'annotation') {
              const annNameNode = child.children.find(c => c.type === 'type_identifier' || c.type === 'user_type')
              if (annNameNode) {
                annotations.push({ name: annNameNode.text, value: child.text })
              }
            }
          }
        }

        const isExported = node.parent?.type === 'source_file'
        nodes.push({
          id, name, qualifiedName,
          kind: node.type === 'object_declaration' ? 'object' : 'class',
          filePath, language: 'kotlin',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          parentId: currentClass?.id ?? null,
          visibility: 'public',
          isExported,
          docstring: '',
          signature: node.text.substring(0, 200),
          annotations,
        })

        if (currentClass) {
          edges.push({ source: currentClass.id, target: id, kind: 'contains', line: node.startPosition.row + 1, col: node.startPosition.column, metadata: '{}' })
        }

        const prevClass = currentClass
        currentClass = { name, id, qualifiedName, startLine: node.startPosition.row + 1 }

        const superclassNode = node.childForFieldName('superclass')
        if (superclassNode) {
          const typeNode = superclassNode.children.find(c => c.type === 'type_identifier' || c.type === 'user_type')
          if (typeNode) {
            edges.push({ source: id, target: typeNode.text, kind: 'extends', line: node.startPosition.row + 1, col: node.startPosition.column, metadata: '{}' })
          }
        }

        for (const child of node.children) {
          if (child.type === 'supertype_list' || child.type === 'type_constraint') {
            for (const iface of child.children) {
              const t = iface.type === 'type_identifier' ? iface : iface.children.find(c => c.type === 'type_identifier')
              if (t) {
                edges.push({ source: id, target: t.text, kind: 'implements', line: node.startPosition.row + 1, col: node.startPosition.column, metadata: '{}' })
              }
            }
          }
        }

        visitChildren(node, depth + 1)
        currentClass = prevClass
        return
      }
    }

    if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName('name')
      if (nameNode) {
        const name = nameNode.text
        const qualifiedName = currentClass ? `${currentClass.qualifiedName}.${name}` : [...nsStack, name].join('.')
        const id = currentClass ? `${currentClass.id}.${name}` : `${filePath}:${qualifiedName}`
        const annotations: { name: string; value: string }[] = []
        const annNode = node.children.find(c => c.type === 'modifier_list' || c.type === 'annotations')
        if (annNode) {
          for (const child of annNode.children) {
            if (child.type === 'annotation') {
              const annNameNode = child.children.find(c => c.type === 'type_identifier' || c.type === 'user_type')
              if (annNameNode) annotations.push({ name: annNameNode.text, value: child.text })
            }
          }
        }
        const paramString = node.children.filter(c => c.type === 'parameters').map(p => p.text).join('')
        const returnTypeNode = node.childForFieldName('return_type')
        const signature = `${name}${paramString}${returnTypeNode ? ': ' + returnTypeNode.text : ''}`
        nodes.push({
          id, name, qualifiedName, kind: 'function',
          filePath, language: 'kotlin',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          parentId: currentClass?.id ?? null,
          visibility: 'public', isExported: false,
          docstring: '', signature, annotations,
        })
        if (currentClass) {
          edges.push({ source: currentClass.id, target: id, kind: 'contains', line: node.startPosition.row + 1, col: node.startPosition.column, metadata: '{}' })
        }
      }
      visitChildren(node, depth + 1)
      return
    }

    if (node.type === 'property_declaration') {
      const nameNode = node.childForFieldName('name')
      if (nameNode) {
        const name = nameNode.text
        const qualifiedName = currentClass ? `${currentClass.qualifiedName}.${name}` : [...nsStack, name].join('.')
        const id = currentClass ? `${currentClass.id}.${name}` : `${filePath}:${qualifiedName}`
        nodes.push({
          id, name, qualifiedName, kind: 'property',
          filePath, language: 'kotlin',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          parentId: currentClass?.id ?? null, visibility: 'public', isExported: false,
          docstring: '', signature: node.text.substring(0, 200), annotations: [],
        })
      }
      visitChildren(node, depth + 1)
      return
    }

    visitChildren(node, depth + 1)
  }

  function visitChildren(node: Parser.SyntaxNode, depth: number) {
    if (depth > 50) return
    for (const child of node.children) visit(child, depth + 1)
  }

  visit(rootNode, 0)
  return { nodes, edges }
}

export function extractAnnotations(node: Parser.SyntaxNode): { name: string; value: string }[] {
  const annotations: { name: string; value: string }[] = []
  if (node.type === 'annotation') {
    const nameNode = node.children.find(c => c.type === 'type_identifier' || c.type === 'user_type')
    if (nameNode) annotations.push({ name: nameNode.text, value: node.text })
  }
  for (const child of node.children) annotations.push(...extractAnnotations(child))
  return annotations
}
