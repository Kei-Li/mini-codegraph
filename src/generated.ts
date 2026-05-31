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
]

const TEST_FILE_PATTERNS = [
  /[/\\]src[/\\]test[/\\]/,
  /[/\\]src\/test[/\\]/,
  /test[/\\]/,
  /__tests__[/\\]/,
  /\.test\./,
  /\.spec\./,
  /Test\.java$/,
  /Tests\.java$/,
]

const GENERATED_FILE_NAMES = [
  'generated',
  'GrpcService',
  'GrpcClient',
  'Proto',
  'MapperImpl',
  'QueryDSL',
  'Q',
  'ModelMapper',
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

export function rankBoost(filePath: string): number {
  if (isGeneratedFile(filePath)) return -2
  if (isTestFile(filePath)) return -1
  if (filePath.includes('src/main') || filePath.includes('src/')) return 1
  return 0
}
