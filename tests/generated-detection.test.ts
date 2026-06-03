import { describe, it, expect } from 'vitest'
import { computePathRelevance, isGeneratedFile, isSpringServiceImpl, findSpringImplName } from '../src/generated.js'

describe('computePathRelevance', () => {
  it('returns 1 for main source', () => {
    expect(computePathRelevance('src/main/java/com/example/Service.java')).toBe(1)
  })

  it('returns -1 for test files', () => {
    expect(computePathRelevance('src/test/java/com/example/ServiceTest.java')).toBe(-1)
  })

  it('returns -2 for generated directories', () => {
    expect(computePathRelevance('target/generated-sources/Foo.java')).toBe(-2)
  })

  it('returns -2 for paths with leading slash to node_modules', () => {
    expect(computePathRelevance('/project/node_modules/foo/index.js')).toBe(-2)
  })

  it('returns 0 for unknown paths', () => {
    expect(computePathRelevance('foo.bar')).toBe(0)
  })
})

describe('isGeneratedFile (generated.ts)', () => {
  it('detects build directory files', () => {
    expect(isGeneratedFile('build/generated/source/Foo.java')).toBe(true)
  })

  it('detects target directory files with prefix', () => {
    expect(isGeneratedFile('/project/target/classes/Foo.class')).toBe(true)
  })

  it('rejects normal source', () => {
    expect(isGeneratedFile('src/main/java/Foo.java')).toBe(false)
  })
})

describe('isSpringServiceImpl', () => {
  it('detects Impl suffix', () => {
    expect(isSpringServiceImpl('UserServiceImpl')).toBe(true)
    expect(isSpringServiceImpl('AuthServiceImpl')).toBe(true)
  })

  it('rejects interface', () => {
    expect(isSpringServiceImpl('UserService')).toBe(false)
  })
})

describe('findSpringImplName', () => {
  it('maps interface to impl', () => {
    expect(findSpringImplName('UserService')).toBe('UserServiceImpl')
    expect(findSpringImplName('AuthRepository')).toBe('AuthRepositoryImpl')
  })

  it('appends Impl even when name already ends with Impl', () => {
    expect(findSpringImplName('UserServiceImpl')).toBe('UserServiceImplImpl')
  })
})
