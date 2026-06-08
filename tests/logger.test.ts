import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setLogger, getLogger, logDebug, logWarn, logError, silentLogger, defaultLogger } from '../src/errors.js'

describe('Logger functions', () => {
  beforeEach(() => {
    setLogger(silentLogger)
  })

  afterEach(() => {
    setLogger(defaultLogger)
    vi.restoreAllMocks()
  })

  it('logDebug does not throw', () => {
    expect(() => logDebug('test')).not.toThrow()
    expect(() => logDebug('test', { key: 'val' })).not.toThrow()
  })

  it('logWarn does not throw', () => {
    expect(() => logWarn('test')).not.toThrow()
    expect(() => logWarn('test', { key: 'val' })).not.toThrow()
  })

  it('logError does not throw', () => {
    expect(() => logError('test')).not.toThrow()
    expect(() => logError('test', { key: 'val' })).not.toThrow()
  })

  it('setLogger and getLogger round-trip', () => {
    const custom: typeof defaultLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    setLogger(custom)
    expect(getLogger()).toBe(custom)
  })

  it('custom logger receives messages', () => {
    const debugFn = vi.fn()
    const warnFn = vi.fn()
    const errorFn = vi.fn()
    setLogger({ debug: debugFn, info: vi.fn(), warn: warnFn, error: errorFn })

    logDebug('debug msg', { a: 1 })
    logWarn('warn msg', { b: 2 })
    logError('error msg', { c: 3 })

    expect(debugFn).toHaveBeenCalledWith('debug msg', { a: 1 })
    expect(warnFn).toHaveBeenCalledWith('warn msg', { b: 2 })
    expect(errorFn).toHaveBeenCalledWith('error msg', { c: 3 })
  })

  it('defaultLogger debug respects MINI_CG_DEBUG', () => {
    setLogger(defaultLogger)
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    delete process.env.MINI_CG_DEBUG
    logDebug('should not appear')
    expect(spy).not.toHaveBeenCalled()

    process.env.MINI_CG_DEBUG = '1'
    logDebug('should appear', { x: 1 })
    expect(spy).toHaveBeenCalled()

    delete process.env.MINI_CG_DEBUG
    spy.mockRestore()
  })

  it('defaultLogger warn and error use console', () => {
    setLogger(defaultLogger)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    logWarn('warn msg')
    expect(warnSpy).toHaveBeenCalledWith('[mini-codegraph] warn msg')

    logError('error msg')
    expect(errorSpy).toHaveBeenCalledWith('[mini-codegraph] error msg')

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
