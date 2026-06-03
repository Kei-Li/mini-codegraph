import { describe, it, expect } from 'vitest'
import { parseSearchQuery, filterNodesByKind, filterNodesByLanguage, filterNodesByFile } from '../src/search/query-parser.js'

describe('parseSearchQuery', () => {
  it('parses plain text', () => {
    const result = parseSearchQuery('UserService')
    expect(result.text).toBe('UserService')
    expect(result.kind).toBeUndefined()
    expect(result.language).toBeUndefined()
    expect(result.name).toBeUndefined()
  })

  it('parses kind filter', () => {
    const result = parseSearchQuery('kind:class UserService')
    expect(result.kind).toBe('class')
    expect(result.text).toBe('UserService')
  })

  it('parses language filter', () => {
    const result = parseSearchQuery('lang:java UserService')
    expect(result.language).toBe('java')
    expect(result.text).toBe('UserService')
  })

  it('parses language with full name', () => {
    const result = parseSearchQuery('language:java UserService')
    expect(result.language).toBe('java')
  })

  it('parses path filter', () => {
    const result = parseSearchQuery('path:*.ts UserService')
    expect(result.file).toBe('*.ts')
    expect(result.text).toBe('UserService')
  })

  it('parses name filter', () => {
    const result = parseSearchQuery('name:getUser')
    expect(result.name).toBe('getUser')
  })

  it('handles quoted value in field filter', () => {
    const result = parseSearchQuery('kind:"my class" UserService')
    expect(result.kind).toBe('my class')
    expect(result.text).toBe('UserService')
  })

  it('returns empty text for empty query', () => {
    const result = parseSearchQuery('')
    expect(result.text).toBe('')
  })

  it('handles multiple filters', () => {
    const result = parseSearchQuery('kind:class lang:java UserService')
    expect(result.kind).toBe('class')
    expect(result.language).toBe('java')
    expect(result.text).toBe('UserService')
  })
})

describe('filterNodesByKind', () => {
  const nodes = [
    { kind: 'class' },
    { kind: 'method' },
    { kind: 'function' },
    { kind: 'class' },
  ] as any[]

  it('filters by single kind', () => {
    const result = filterNodesByKind(nodes, 'class')
    expect(result).toHaveLength(2)
  })

  it('filters by comma-separated kinds', () => {
    const result = filterNodesByKind(nodes, 'class,method')
    expect(result).toHaveLength(3)
  })

  it('returns empty for no match', () => {
    const result = filterNodesByKind(nodes, 'interface')
    expect(result).toHaveLength(0)
  })
})

describe('filterNodesByLanguage', () => {
  const nodes = [
    { language: 'java', name: 'A' },
    { language: 'typescript', name: 'B' },
  ] as any[]

  it('filters by language', () => {
    const result = filterNodesByLanguage(nodes, 'java')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('A')
  })
})

describe('filterNodesByFile', () => {
  const nodes = [
    { filePath: 'src/main/java/A.java', name: 'A' },
    { filePath: 'src/main/ts/B.ts', name: 'B' },
  ] as any[]

  it('filters by glob pattern', () => {
    const result = filterNodesByFile(nodes, 'src/main/java/*')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('A')
  })
})
