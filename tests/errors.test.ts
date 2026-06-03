import { describe, it, expect } from 'vitest'
import {
  MiniCodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  ConfigError,
  ResolutionError,
  GrammarError,
  LockError,
  defaultLogger,
  silentLogger,
  setLogger,
  getLogger,
} from '../src/errors.js'

describe('Error classes', () => {
  it('MiniCodeGraphError has code and context', () => {
    const err = new MiniCodeGraphError('test error', 'TEST_CODE', { key: 'val' })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('MiniCodeGraphError')
    expect(err.code).toBe('TEST_CODE')
    expect(err.context).toEqual({ key: 'val' })
    expect(err.message).toBe('test error')
  })

  it('FileError includes filePath and cause', () => {
    const cause = new Error('cause')
    const err = new FileError('file not found', '/path/to/file.ts', cause)
    expect(err).toBeInstanceOf(MiniCodeGraphError)
    expect(err.name).toBe('FileError')
    expect(err.filePath).toBe('/path/to/file.ts')
    expect(err.code).toBe('FILE_ERROR')
  })

  it('ParseError includes line and column', () => {
    const err = new ParseError('parse failed', 'file.ts', { line: 10, column: 5 })
    expect(err.name).toBe('ParseError')
    expect(err.code).toBe('PARSE_ERROR')
    expect(err.line).toBe(10)
    expect(err.column).toBe(5)
  })

  it('DatabaseError includes operation', () => {
    const err = new DatabaseError('db fail', 'INSERT')
    expect(err.name).toBe('DatabaseError')
    expect(err.operation).toBe('INSERT')
  })

  it('SearchError includes query', () => {
    const err = new SearchError('search fail', 'UserService')
    expect(err.name).toBe('SearchError')
    expect(err.query).toBe('UserService')
  })

  it('ConfigError stores details', () => {
    const err = new ConfigError('bad config', { setting: 'foo' })
    expect(err.name).toBe('ConfigError')
    expect(err.context).toEqual({ setting: 'foo' })
  })

  it('ResolutionError stores context', () => {
    const err = new ResolutionError('cannot resolve', { symbol: 'Foo' })
    expect(err.name).toBe('ResolutionError')
    expect(err.context).toEqual({ symbol: 'Foo' })
  })

  it('GrammarError stores context', () => {
    const err = new GrammarError('grammar not found', { lang: 'java' })
    expect(err.name).toBe('GrammarError')
    expect(err.context).toEqual({ lang: 'java' })
  })

  it('LockError stores lockPath', () => {
    const err = new LockError('lock taken', '/path/to/lock')
    expect(err.name).toBe('LockError')
    expect(err.code).toBe('LOCK_ERROR')
  })
})

describe('Logger', () => {
  afterEach(() => {
    setLogger(defaultLogger)
  })

  it('defaultLogger has all methods', () => {
    expect(typeof defaultLogger.debug).toBe('function')
    expect(typeof defaultLogger.warn).toBe('function')
    expect(typeof defaultLogger.error).toBe('function')
  })

  it('silentLogger does nothing', () => {
    expect(() => silentLogger.debug('test')).not.toThrow()
    expect(() => silentLogger.warn('test')).not.toThrow()
    expect(() => silentLogger.error('test')).not.toThrow()
  })

  it('setLogger/getLogger round-trip', () => {
    setLogger(silentLogger)
    expect(getLogger()).toBe(silentLogger)
  })
})
