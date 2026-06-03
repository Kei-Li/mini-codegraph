import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { mockExecFileSync } = vi.hoisted(() => {
  return { mockExecFileSync: vi.fn() }
})

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}))

import { execFileSync } from 'node:child_process'
import {
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  type GitHookName,
} from '../src/sync/git-hooks.js'

describe('git-hooks', () => {
  let tmpDir: string
  let hooksDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mini-cg-hooks-test-'))
    hooksDir = join(tmpDir, '.git', 'hooks')
    mkdirSync(hooksDir, { recursive: true })

    // Mock git commands to return our tmpDir's hooks dir
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: string[], options?: any) => {
      if (args.includes('--is-inside-work-tree')) return 'true\n'
      if (args.includes('--git-path')) return '.git/hooks\n'
      if (args.includes('rev-parse') && args.includes('HEAD')) return 'mockhash\n'
      return ''
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* silent */ }
  })

  describe('isGitRepo', () => {
    it('returns true when git says inside work tree', () => {
      expect(isGitRepo(tmpDir)).toBe(true)
    })

    it('returns false on git failure', () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('not a repo') })
      expect(isGitRepo(tmpDir)).toBe(false)
    })
  })

  describe('installGitSyncHook', () => {
    it('installs hooks in hooks dir', () => {
      const result = installGitSyncHook(tmpDir, ['post-commit'])

      expect(result.installed).toContain('post-commit')
      expect(result.hooksDir).toBe(hooksDir)

      const content = readFileSync(join(hooksDir, 'post-commit'), 'utf-8')
      expect(content).toContain('mini-codegraph sync hook')
      expect(content).toContain('mini-cg sync')
    })

    it('installs multiple hooks', () => {
      const result = installGitSyncHook(tmpDir, ['post-commit', 'post-merge'])
      expect(result.installed).toHaveLength(2)

      for (const hook of ['post-commit', 'post-merge']) {
        expect(existsSync(join(hooksDir, hook))).toBe(true)
      }
    })

    it('appends to existing hook file', () => {
      writeFileSync(join(hooksDir, 'post-commit'), '#!/bin/sh\necho "existing"\n')

      installGitSyncHook(tmpDir, ['post-commit'])

      const content = readFileSync(join(hooksDir, 'post-commit'), 'utf-8')
      expect(content).toContain('existing')
      expect(content).toContain('mini-codegraph sync hook')
    })

    it('returns skipped when not a git repo', () => {
      vi.mocked(execFileSync).mockReset()
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not a repo') })

      const result = installGitSyncHook(tmpDir)
      expect(result.installed).toEqual([])
      expect(result.skipped).toBe('not a git repository')
    })

    it('replaces existing marker block', () => {
      writeFileSync(join(hooksDir, 'post-commit'), [
        '#!/bin/sh',
        '# >>> mini-codegraph sync hook >>>',
        'old content',
        '# <<< mini-codegraph sync hook <<<',
        'footer',
      ].join('\n'))

      installGitSyncHook(tmpDir, ['post-commit'])

      const content = readFileSync(join(hooksDir, 'post-commit'), 'utf-8')
      expect(content).toContain('footer')
      expect(content).not.toContain('old content')
    })
  })

  describe('removeGitSyncHook', () => {
    it('removes marker block from hook file', () => {
      writeFileSync(join(hooksDir, 'post-commit'), [
        '#!/bin/sh',
        '# >>> mini-codegraph sync hook >>>',
        'sync content',
        '# <<< mini-codegraph sync hook <<<',
        'footer',
      ].join('\n'))

      const result = removeGitSyncHook(tmpDir, ['post-commit'])
      expect(result.installed).toContain('post-commit')

      const content = readFileSync(join(hooksDir, 'post-commit'), 'utf-8')
      expect(content).not.toContain('mini-codegraph')
      expect(content).toContain('footer')
    })

    it('deletes hook file if only marker content remains', () => {
      writeFileSync(join(hooksDir, 'post-commit'), [
        '#!/bin/sh',
        '# >>> mini-codegraph sync hook >>>',
        'sync content',
        '# <<< mini-codegraph sync hook <<<',
      ].join('\n'))

      removeGitSyncHook(tmpDir, ['post-commit'])
      expect(existsSync(join(hooksDir, 'post-commit'))).toBe(false)
    })

    it('does nothing if hook has no marker', () => {
      writeFileSync(join(hooksDir, 'post-commit'), '#!/bin/sh\necho "custom"\n')

      removeGitSyncHook(tmpDir, ['post-commit'])
      expect(readFileSync(join(hooksDir, 'post-commit'), 'utf-8')).toContain('custom')
    })
  })

  describe('isSyncHookInstalled', () => {
    it('returns false for clean project', () => {
      expect(isSyncHookInstalled(tmpDir)).toBe(false)
    })

    it('returns true after installing hooks', () => {
      installGitSyncHook(tmpDir, ['post-commit'])
      expect(isSyncHookInstalled(tmpDir)).toBe(true)
    })

    it('returns false after removing hooks', () => {
      installGitSyncHook(tmpDir, ['post-commit'])
      removeGitSyncHook(tmpDir, ['post-commit'])
      expect(isSyncHookInstalled(tmpDir)).toBe(false)
    })

    it('returns false when not a git repo', () => {
      vi.mocked(execFileSync).mockReset()
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('error') })

      expect(isSyncHookInstalled(tmpDir)).toBe(false)
    })
  })
})
