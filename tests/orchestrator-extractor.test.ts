import { describe, it, expect } from 'vitest'
import { EXTRACTOR_GUARDS, sourceIncludesAny, shouldRunExtractor } from '../src/extraction/core/extractor-guards.js'

describe('ExtractionOrchestrator', () => {
  describe('shouldRunExtractor', () => {
    it('returns true when source matches JPA guard keywords', () => {
      expect(shouldRunExtractor('@Entity\npublic class Foo {}', 'jpa')).toBe(true)
    })

    it('returns false when source has no matching JPA guard', () => {
      expect(shouldRunExtractor('public class Foo { }', 'jpa')).toBe(false)
    })

    it('returns true for security when @PreAuthorize present', () => {
      expect(shouldRunExtractor('@PreAuthorize("hasRole(ADMIN)")', 'security')).toBe(true)
    })

    it('returns true for lombok when @Data present', () => {
      expect(shouldRunExtractor('@Data\npublic class Foo {}', 'lombok')).toBe(true)
    })

    it('returns true for unknown extractor name', () => {
      expect(shouldRunExtractor('anything', 'nonexistent_extractor')).toBe(true)
    })
  })

  describe('sourceIncludesAny', () => {
    it('returns true when any keyword is found', () => {
      expect(sourceIncludesAny('hello world test', ['world', 'nope'])).toBe(true)
    })

    it('returns false when no keywords match', () => {
      expect(sourceIncludesAny('hello world', ['foo', 'bar'])).toBe(false)
    })

    it('returns true on first match (short-circuits)', () => {
      expect(sourceIncludesAny('find me', ['me', 'other'])).toBe(true)
    })
  })

  describe('EXTRACTOR_GUARDS', () => {
    it('has all expected extractor guard entries', () => {
      expect(EXTRACTOR_GUARDS.jpa).toBeDefined()
      expect(EXTRACTOR_GUARDS.security).toBeDefined()
      expect(EXTRACTOR_GUARDS.lombok).toBeDefined()
      expect(EXTRACTOR_GUARDS.mapstruct).toBeDefined()
      expect(EXTRACTOR_GUARDS.redis).toBeDefined()
      expect(EXTRACTOR_GUARDS.async).toBeDefined()
      expect(EXTRACTOR_GUARDS.aop).toBeDefined()
    })

    it('jpa guard contains @Entity', () => {
      expect(EXTRACTOR_GUARDS.jpa).toContain('@Entity')
    })

    it('lombok guard contains @Data', () => {
      expect(EXTRACTOR_GUARDS.lombok).toContain('@Data')
    })
  })
})
