import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  safeJsonParse,
  validatePathWithinRoot,
  normalizePath,
  computeContentHash,
  languageForFile,
  isSupportedFile,
  FileLock,
} from '../src/utils.js'

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 })
  })

  it('returns fallback on invalid JSON', () => {
    expect(safeJsonParse('not json', {})).toEqual({})
  })

  it('returns fallback on null/empty input', () => {
    expect(safeJsonParse('', {})).toEqual({})
  })

  it('strips __proto__ keys via reviver', () => {
    const result = safeJsonParse('{"__proto__":{"polluted":true},"a":1}', {})
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toBeUndefined()
    expect(result).toEqual({ a: 1 })
  })

  it('strips constructor keys via reviver', () => {
    const result = safeJsonParse('{"constructor":{"prototype":{"polluted":true}},"a":1}', {})
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')).toBeUndefined()
    expect(result).toEqual({ a: 1 })
  })

  it('strips nested __proto__ keys', () => {
    const result = safeJsonParse('{"nested":{"__proto__":{"polluted":true},"b":2},"a":1}', {})
    expect(Object.getOwnPropertyDescriptor(result.nested, '__proto__')).toBeUndefined()
    expect(result).toEqual({ nested: { b: 2 }, a: 1 })
  })

  it('handles array values correctly', () => {
    const result = safeJsonParse('[{"__proto__":{"polluted":true},"a":1}]', [])
    expect(Array.isArray(result)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(result[0], '__proto__')).toBeUndefined()
    expect(result[0]).toEqual({ a: 1 })
  })

  it('returns undefined when fallback omitted and parse fails', () => {
    expect(safeJsonParse('not json')).toBeUndefined()
  })

  it('returns parsed value for valid input without fallback', () => {
    expect(safeJsonParse('"hello"')).toBe('hello')
  })
})

describe('validatePathWithinRoot', () => {
  const root = resolve('/test-project')

  it('accepts valid path within root', () => {
    const filePath = join(root, 'src', 'file.ts')
    const result = validatePathWithinRoot(root, filePath)
    expect(result).toBe(filePath)
  })

  it('accepts root itself', () => {
    const result = validatePathWithinRoot(root, root)
    expect(result).toBe(root)
  })

  it('rejects path with ../ traversal', () => {
    const result = validatePathWithinRoot(root, join(root, '..', 'etc', 'passwd'))
    expect(result).toBeNull()
  })

  it('rejects completely unrelated path', () => {
    const result = validatePathWithinRoot(root, resolve('/etc/passwd'))
    expect(result).toBeNull()
  })

  it('resolves relative paths within root', () => {
    const result = validatePathWithinRoot(root, 'src/file.ts')
    expect(result).toBe(join(root, 'src', 'file.ts'))
  })
})

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\main\\java\\App.java')).toBe('src/main/java/App.java')
  })

  it('leaves forward slashes unchanged', () => {
    expect(normalizePath('src/main/java/App.java')).toBe('src/main/java/App.java')
  })
})

describe('computeContentHash', () => {
  it('returns consistent hash for same content', () => {
    const hash1 = computeContentHash('hello world')
    const hash2 = computeContentHash('hello world')
    expect(hash1).toBe(hash2)
  })

  it('returns different hash for different content', () => {
    const hash1 = computeContentHash('hello world')
    const hash2 = computeContentHash('hello world!')
    expect(hash1).not.toBe(hash2)
  })

  it('returns 32-char hex string', () => {
    const hash = computeContentHash('test content')
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('handles empty string', () => {
    const hash = computeContentHash('')
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('languageForFile', () => {
  it('detects Java', () => {
    const lang = languageForFile('Main.java')
    expect(lang?.name).toBe('java')
  })

  it('detects TypeScript', () => {
    const lang = languageForFile('app.ts')
    expect(lang?.name).toBe('typescript')
  })

  it('detects Python', () => {
    const lang = languageForFile('main.py')
    expect(lang?.name).toBe('python')
  })

  it('returns undefined for unknown extension', () => {
    expect(languageForFile('readme.md')).toBeUndefined()
  })
})

describe('isSupportedFile', () => {
  it('returns true for .java', () => {
    expect(isSupportedFile('test.java')).toBe(true)
  })

  it('returns true for .ts', () => {
    expect(isSupportedFile('test.ts')).toBe(true)
  })

  it('returns false for .md', () => {
    expect(isSupportedFile('readme.md')).toBe(false)
  })
})

describe('FileLock', () => {
  const lockDir = join(tmpdir(), 'minicg-test-locks')
  let lockPath: string
  let lock: FileLock

  beforeEach(() => {
    if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true })
    lockPath = join(lockDir, `test-${Date.now()}.lock`)
    lock = new FileLock(lockPath)
  })

  afterEach(() => {
    try { if (existsSync(lockPath)) unlinkSync(lockPath) } catch { /* silent */ }
  })

  it('acquires and releases lock', () => {
    expect(() => lock.acquire()).not.toThrow()
    expect(() => lock.release()).not.toThrow()
  })

  it('prevents double acquire', () => {
    lock.acquire()
    const lock2 = new FileLock(lockPath)
    expect(() => lock2.acquire()).toThrow(/locked by another process/)
    lock.release()
  })

  it('withLock runs function and releases', () => {
    let ran = false
    lock.withLock(() => { ran = true })
    expect(ran).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('withLockAsync runs function and releases', async () => {
    let ran = false
    await lock.withLockAsync(async () => { ran = true })
    expect(ran).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })
})
