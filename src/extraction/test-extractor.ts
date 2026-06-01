import type { QueryManager } from '../db/queries.js'

export interface TestAnnotation {
  classFile: string
  className: string
  annotation: string
  mockBeans: { fieldName: string; mockClass: string }[]
  line: number
  moduleId: string
}

const TEST_ANNOTATIONS = [
  'SpringBootTest', 'WebMvcTest', 'DataJpaTest', 'DataMongoTest',
  'JdbcTest', 'TestRestTemplate', 'RestClientTest', 'JsonTest',
  'SpringJUnitConfig', 'SpringTest', 'SpringJUnitWebConfig',
]

export function indexTestAnnotations(
  queries: QueryManager,
  source: string,
  filePath: string,
  moduleId: string
): TestAnnotation[] {
  const results: TestAnnotation[] = []
  const lines = source.split('\n')
  let currentAnn: string | null = null
  let currentLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    for (const ta of TEST_ANNOTATIONS) {
      if (line.startsWith(`@${ta}`) || line.startsWith(`@${ta}(`)) {
        currentAnn = ta
        currentLine = i + 1
        break
      }
    }

    if (!currentAnn) continue

    const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/)
    if (classMatch) {
      const mockBeans: { fieldName: string; mockClass: string }[] = []

      let scanStart = Math.max(0, i - 10)
      for (let j = scanStart; j <= Math.min(i + 15, lines.length - 1); j++) {
        const ml = lines[j].trim()
        const mockMatch = ml.match(/@(MockBean|MockitoBean|Mock|InjectMocks)\s*\n?\s*(?:\w+\s+)?(\w+)\s+(\w+)/)
        if (mockMatch) {
          mockBeans.push({ fieldName: mockMatch[3], mockClass: mockMatch[2] || '' })
        }
        const mockFieldMatch = ml.match(/(?:private|public)\s+(\w+(?:<[^>]*>)?)\s+(\w+)\s*;\s*$/ )
        if (mockFieldMatch && (ml.includes('@MockBean') || ml.includes('@Mock'))) {
          mockBeans.push({ fieldName: mockFieldMatch[2], mockClass: mockFieldMatch[1].replace(/<[^>]*>/g, '') })
        }
      }

      const ta: TestAnnotation = {
        classFile: filePath,
        className: classMatch[1],
        annotation: currentAnn,
        mockBeans,
        line: currentLine,
        moduleId,
      }
      results.push(ta)

      const nodeId = `${filePath}:${classMatch[1]}`
      queries.insertAnnotation(nodeId, currentAnn, JSON.stringify({ mockBeans: mockBeans.length }), currentLine, moduleId)

      for (const mb of mockBeans) {
        const mockTargets = queries.searchNodes(mb.mockClass, 5)
          .filter(n => n.moduleId === moduleId && n.kind === 'class')
        for (const mt of mockTargets) {
          queries.insertEdge(nodeId, mt.id, 'mock_replaces',
            JSON.stringify({ mockField: mb.fieldName }), currentLine, 0)
        }
      }

      currentAnn = null
    }

    if (line.startsWith('@') && !currentAnn) {
      currentAnn = null
    }
  }

  return results
}
