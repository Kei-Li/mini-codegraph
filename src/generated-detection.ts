const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  /_mock\.go$/,
  /_mocks\.go$/,
  /^mock_[^/]+\.go$/,
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  /_pb2(_grpc)?\.py$/,
  /_pb2\.pyi$/,
  /\.pb\.(cc|h)$/,
  /\.g\.cs$/,
  /Grpc\.cs$/,
  /OuterClass\.java$/,
  /Grpc\.java$/,
  /\.pb\.swift$/,
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,
  /\.generated\.rs$/,
]

export function isGeneratedFile(filePath: string): boolean {
  return GENERATED_PATTERNS.some((p) => p.test(filePath))
}

const TEST_PATTERNS: ReadonlyArray<RegExp> = [
  /\/src\/test\//,
  /\/__tests__\//,
  /\.test\./,
  /\.spec\./,
  /Test\.java$/,
  /_test\.go$/,
  /_test\.py$/,
  /\.test\.[jt]sx?$/,
]

export function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(filePath))
}
