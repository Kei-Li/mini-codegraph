import { describe, it, expect } from 'vitest'
import { splitCamelCase, matchCamelCase, findFuzzyMatches, damerauLevenshtein } from '../src/search/fuzzy.js'

describe('damerauLevenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(damerauLevenshtein('hello', 'hello')).toBe(0)
  })

  it('returns length for empty string', () => {
    expect(damerauLevenshtein('', 'hello')).toBe(5)
    expect(damerauLevenshtein('hello', '')).toBe(5)
  })

  it('detects transposition', () => {
    expect(damerauLevenshtein('ab', 'ba')).toBe(1)
  })

  it('detects substitution', () => {
    expect(damerauLevenshtein('cat', 'car')).toBe(1)
  })

  it('detects insertion', () => {
    expect(damerauLevenshtein('cat', 'cats')).toBe(1)
  })

  it('detects deletion', () => {
    expect(damerauLevenshtein('cats', 'cat')).toBe(1)
  })

  it('handles case sensitivity', () => {
    expect(damerauLevenshtein('Hello', 'hello')).toBe(1)
  })
})

describe('splitCamelCase', () => {
  it('splits simple camelCase to lowercase', () => {
    expect(splitCamelCase('helloWorld')).toEqual(['hello', 'world'])
  })

  it('splits PascalCase to lowercase', () => {
    expect(splitCamelCase('HelloWorld')).toEqual(['hello', 'world'])
  })

  it('handles acronyms', () => {
    expect(splitCamelCase('HTTPServer')).toEqual(['http', 'server'])
  })

  it('handles single word', () => {
    expect(splitCamelCase('hello')).toEqual(['hello'])
  })
})

describe('matchCamelCase', () => {
  it('returns contiguous PascalCase matches', () => {
    const result = matchCamelCase('HelloWorld')
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]).toMatch(/^[A-Z]/)
  })
})

describe('findFuzzyMatches', () => {
  const items = [
    { id: '1', name: 'UserService', qualifiedName: 'com.example.UserService' },
    { id: '2', name: 'UserController', qualifiedName: 'com.example.UserController' },
    { id: '3', name: 'AuthService', qualifiedName: 'com.example.AuthService' },
    { id: '4', name: 'userRepository', qualifiedName: 'com.example.UserRepository' },
  ]

  it('finds exact matches', () => {
    const results = findFuzzyMatches('UserService', items, 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe('1')
    expect(results[0].distance).toBe(0)
  })

  it('returns empty for no match', () => {
    const results = findFuzzyMatches('zzzzzzz', items, 10)
    expect(results).toHaveLength(0)
  })

  it('respects limit', () => {
    const results = findFuzzyMatches('Service', items, 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('ranks by distance ascending', () => {
    const results = findFuzzyMatches('UserService', items, 10)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance)
    }
  })
})
