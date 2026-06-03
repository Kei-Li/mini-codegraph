import { describe, it, expect } from 'vitest'
import {
  isTurboshaftOOM,
  detectWasmCrash,
} from '../src/extraction/wasm-runtime-flags.js'

describe('isTurboshaftOOM', () => {
  it('detects exit code 132 on Node >= 25', () => {
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10)
    if (nodeMajor >= 25) {
      expect(isTurboshaftOOM(132, null)).toBe(true)
      expect(isTurboshaftOOM(null, 'SIGILL')).toBe(true)
    }
  })

  it('returns false for normal exit', () => {
    expect(isTurboshaftOOM(0, null)).toBe(false)
  })

  it('returns false for other signals', () => {
    expect(isTurboshaftOOM(null, 'SIGTERM')).toBe(false)
  })
})

describe('detectWasmCrash', () => {
  it('detects turboshaft in message', () => {
    const err = new Error('turboshaft compilation failed')
    expect(detectWasmCrash(err)).toBe(true)
  })

  it('detects wasm in message', () => {
    const err = new Error('WebAssembly memory error')
    expect(detectWasmCrash(err)).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    const err = new Error('regular error')
    expect(detectWasmCrash(err)).toBe(false)
  })
})
