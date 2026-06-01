const GENERATED_PATTERNS = [
  /[/\\]target[/\\]generated-sources[/\\]/,
  /[/\\]target[/\\]generated-test-sources[/\\]/,
  /[/\\]target[/\\]classes[/\\]/,
  /[/\\]dist[/\\]/,
  /[/\\]build[/\\]generated[/\\]/,
  /[/\\]node_modules[/\\]/,
  /[/\\]\.next[/\\]/,
  /[/\\]out[/\\]/,
  /[/\\]__pycache__[/\\]/,
  /[/\\]\.nuxt[/\\]/,
  /[/\\]proto-gen[/\\]/,
  /[/\\]protobuf[/\\]/,
  /[/\\]grpc-gen[/\\]/,
]

const TEST_FILE_PATTERNS = [
  /[/\\]src[/\\]test[/\\]/,
  /[/\\]test[/\\]s?[/\\]/,
  /__tests__[/\\]/,
  /\.test\./,
  /\.spec\./,
  /Test\.java$/,
  /Tests\.java$/,
  /Spec\./,
]

const GENERATED_FILE_NAMES = [
  'generated', 'GrpcService', 'GrpcClient', 'Proto',
  'MapperImpl', 'QueryDSL', 'Q', 'ModelMapper', 'AutoValue',
  '_pb', '_grpc_pb', 'Mock', 'Stub',
]

export function isGeneratedFile(filePath: string): boolean {
  for (const p of GENERATED_PATTERNS) {
    if (p.test(filePath)) return true
  }
  for (const name of GENERATED_FILE_NAMES) {
    if (filePath.includes(name)) return true
  }
  return false
}

export function isTestFile(filePath: string): boolean {
  for (const p of TEST_FILE_PATTERNS) {
    if (p.test(filePath)) return true
  }
  return false
}

export function isSpringServiceInterface(nodeName: string): boolean {
  return nodeName.startsWith('I') && /^I[A-Z]/.test(nodeName)
}

export function isSpringServiceImpl(nodeName: string, interfaceName?: string): boolean {
  if (interfaceName) {
    const base = interfaceName.startsWith('I') ? interfaceName.slice(1) : interfaceName
    return nodeName === `${base}Impl` || nodeName === `${interfaceName}Impl`
  }
  return nodeName.endsWith('Impl')
}

export function findSpringImplName(interfaceName: string): string {
  if (interfaceName.startsWith('I') && /^I[A-Z]/.test(interfaceName)) {
    return interfaceName.slice(1) + 'Impl'
  }
  return interfaceName + 'Impl'
}

export function matchingSpringPattern(implName: string): string | null {
  if (implName.endsWith('Impl')) {
    return implName.slice(0, -4)
  }
  return null
}

export function computePathRelevance(filePath: string): number {
  if (isGeneratedFile(filePath)) return -2
  if (isTestFile(filePath)) return -1
  if (filePath.includes('src/main') || filePath.includes('src/')) return 1
  if (filePath.includes('app/') || filePath.includes('components/')) return 1
  return 0
}

export function rankSearchResults<T extends { filePath: string }>(
  results: T[]
): T[] {
  return results.sort((a, b) => {
    const ra = computePathRelevance(a.filePath)
    const rb = computePathRelevance(b.filePath)
    if (ra !== rb) return rb - ra
    return 0
  })
}

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'target', 'build', 'dist', '.next', '.nuxt',
  '__pycache__', '.cache', '.idea', '.vscode', 'coverage', '.nyc_output',
  '.mini-codegraph', 'grammars', 'vendor', '.gradle', 'out', 'bin', 'obj',
  '.tox', '.eggs', 'eggs-info', 'site-packages', 'Pods', '.build',
  'DerivedData', '.serverless', '.terraform', '.docusaurus',
])
