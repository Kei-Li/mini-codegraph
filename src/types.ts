export interface CodeGraphNode {
  id: string
  kind: string
  name: string
  qualifiedName: string
  filePath: string
  language: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  docstring: string
  signature: string
  visibility: string
  isExported: boolean
  parentId: string | null
}

export interface CodeGraphEdge {
  source: string
  target: string
  kind: string
  metadata: string
  line: number
  col: number
}

export interface FileRecord {
  path: string
  contentHash: string
  language: string
  size: number
  modifiedAt: number
  indexedAt: number
  nodeCount: number
}

export interface ExtractionResult {
  nodes: CodeGraphNode[]
  edges: CodeGraphEdge[]
  errors: string[]
}

export interface ResolvedReference {
  fromNodeId: string
  toNodeId: string
  referenceName: string
  kind: string
  line: number
  col: number
}

export interface LanguageConfig {
  name: string
  extensions: string[]
  grammarName: string
  grammarWasmFile: string
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  {
    name: 'java',
    extensions: ['.java'],
    grammarName: 'java',
    grammarWasmFile: 'tree-sitter-java.wasm',
  },
  {
    name: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    grammarName: 'typescript',
    grammarWasmFile: 'tree-sitter-typescript.wasm',
  },
  {
    name: 'python',
    extensions: ['.py', '.pyi'],
    grammarName: 'python',
    grammarWasmFile: 'tree-sitter-python.wasm',
  },
  {
    name: 'vue',
    extensions: ['.vue'],
    grammarName: 'typescript',
    grammarWasmFile: 'tree-sitter-typescript.wasm',
  },
]

export interface IndexOptions {
  projectRoot: string
  dbPath?: string
  includePatterns?: string[]
  excludePatterns?: string[]
}

export interface SearchResult {
  node: CodeGraphNode
  snippets: string[]
  score: number
}
