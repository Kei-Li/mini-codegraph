import { describe, it, expect } from 'vitest'
import { safeJsonParse, validatePathWithinRoot } from '../src/utils.js'
import { detectWasmCrash, isTurboshaftOOM } from '../src/extraction/wasm-runtime-flags.js'

describe('safeJsonParse - prototype pollution prevention', () => {
  it('strips __proto__ at top level', () => {
    const malicious = '{"__proto__":{"polluted":true},"legit":"value"}'
    const result = safeJsonParse(malicious, {})
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toBeUndefined()
    expect(result.legit).toBe('value')
  })

  it('strips __proto__ in nested objects', () => {
    const malicious = '{"level1":{"__proto__":{"polluted":true},"legit":"inner"}}'
    const result = safeJsonParse(malicious, {})
    expect(Object.getOwnPropertyDescriptor(result.level1, '__proto__')).toBeUndefined()
    expect(result.level1.legit).toBe('inner')
  })

  it('strips constructor at top level', () => {
    const malicious = '{"constructor":{"prototype":{"polluted":true}},"a":1}'
    const result = safeJsonParse(malicious, {})
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')).toBeUndefined()
    expect(result.a).toBe(1)
  })

  it('strips __proto__ inside arrays', () => {
    const malicious = '[{"__proto__":{"polluted":true},"a":1}]'
    const result = safeJsonParse(malicious, [])
    expect(Array.isArray(result)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(result[0], '__proto__')).toBeUndefined()
    expect(result[0].a).toBe(1)
  })

  it('does not affect normal JSON', () => {
    const result = safeJsonParse('{"a":1,"b":{"c":2}}', {})
    expect(result).toEqual({ a: 1, b: { c: 2 } })
  })

  it('handles deeply nested safe JSON without stripping errors', () => {
    const json = JSON.stringify({ a: { b: { c: { d: 1 } } } })
    const result = safeJsonParse(json, {})
    expect(result.a.b.c.d).toBe(1)
  })

  it('does not strip non-dangerous properties', () => {
    const result = safeJsonParse('{"constructorVal":"ok","proto":"ok"}', {})
    expect(result.constructorVal).toBe('ok')
    expect(result.proto).toBe('ok')
  })
})

describe('validatePathWithinRoot - path traversal prevention', () => {
  it('rejects simple traversal with ..', () => {
    const root = '/safe/project'
    expect(validatePathWithinRoot(root, '/safe/project/../../etc/passwd')).toBeNull()
  })

  it('rejects absolute path outside root', () => {
    const root = '/safe/project'
    expect(validatePathWithinRoot(root, '/etc/passwd')).toBeNull()
  })

  it('rejects traversal with multiple ../', () => {
    const root = '/safe/project'
    expect(validatePathWithinRoot(root, '/safe/project/../../../tmp/evil')).toBeNull()
  })

  it('accepts path with . (same dir)', () => {
    const root = '/safe/project'
    const result = validatePathWithinRoot(root, '/safe/project/./src/file.ts')
    expect(result).not.toBeNull()
    expect(result!.endsWith('file.ts')).toBe(true)
  })
})

describe('wasm-runtime-flags - environment security', () => {
  it('detectWasmCrash finds turboshaft', () => {
    expect(detectWasmCrash(new Error('turboshaft compilation error'))).toBe(true)
  })

  it('detectWasmCrash finds wasm', () => {
    expect(detectWasmCrash(new Error('WebAssembly out of memory'))).toBe(true)
  })

  it('detectWasmCrash returns false for unrelated', () => {
    expect(detectWasmCrash(new Error('normal error'))).toBe(false)
  })

  it('isTurboshaftOOM returns false for exit 0', () => {
    expect(isTurboshaftOOM(0, null)).toBe(false)
  })
})
