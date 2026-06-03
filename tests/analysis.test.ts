import { describe, it, expect } from 'vitest'
import { CodeAnalyzer } from '../src/analysis/index.js'
import type { MiniCodeGraphNode } from '../src/types.js'
import type { QueryManager } from '../src/db/queries.js'

function createNode(id: string, name: string, kind: string, filePath: string, startLine = 1, endLine = 10): MiniCodeGraphNode {
  return {
    id, name, kind, filePath, qualifiedName: name, language: 'typescript',
    startLine, endLine, startColumn: 0, endColumn: 0,
    docstring: '', signature: '', visibility: 'public', isExported: false,
  }
}

describe('CodeAnalyzer', () => {
  it('computeCyclomaticComplexity returns null for non-function', () => {
    const qm = {} as unknown as QueryManager
    const analyzer = new CodeAnalyzer(qm, '/project')
    const node = createNode('1', 'MyClass', 'class', 'Test.java')
    expect(analyzer.computeCyclomaticComplexity(node)).toBeNull()
  })

  it('findDeadImports returns empty when no imports', () => {
    const qm = {
      getAllNodes: () => [
        createNode('1', 'foo', 'function', 'test.ts'),
        createNode('2', 'bar', 'function', 'test.ts'),
      ],
    } as unknown as QueryManager
    const analyzer = new CodeAnalyzer(qm, '/project')
    const dead = analyzer.findDeadImports()
    expect(dead).toHaveLength(0)
  })
})
