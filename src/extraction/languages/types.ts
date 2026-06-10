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
  annotations?: { name: string; value: string }[]
}

export interface EdgeInfo {
  source: string
  target: string
  kind: string
  line: number
  col: number
  metadata: string
}
