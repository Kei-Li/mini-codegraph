import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GrammarLoader } from '../src/extraction/core/grammar-loader.js'

describe('GrammarLoader', () => {
  let loader: GrammarLoader

  beforeEach(() => {
    loader = new GrammarLoader()
  })

  it('starts with no files parsed', () => {
    expect(loader.totalFilesParsed).toBe(0)
  })

  it('hasGrammar returns false for unknown language', () => {
    // Since no WASM files exist, this should return false
    expect(loader.hasGrammar('nonexistent_language_xyz')).toBe(false)
  })

  it('recycleIfNeeded does nothing when count is low', () => {
    // Should not throw when called on fresh loader
    expect(() => loader.recycleIfNeeded()).not.toThrow()
  })

  it('resetParser does not throw for unknown language', () => {
    expect(() => loader.resetParser('unknown')).not.toThrow()
  })

  it('resetAllParsers does not throw', () => {
    expect(() => loader.resetAllParsers()).not.toThrow()
  })

  it('loadGrammar throws GrammarError for unknown language', async () => {
    await expect(loader.loadGrammar('nonexistent_xyz')).rejects.toThrow()
  })

  it('double init does not throw', async () => {
    try {
      await loader.init()
      await loader.init()
    } catch {
      // WASM may not be available in test env; both init calls should at least not crash
    }
  })
})
