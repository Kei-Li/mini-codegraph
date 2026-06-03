import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { mockExecFileSync } = vi.hoisted(() => {
  return { mockExecFileSync: vi.fn() }
})

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}))

import { execFileSync } from 'node:child_process'
import { GitSyncManager } from '../src/sync/git-sync.js'
import { DatabaseConnection } from '../src/db/connection.js'
import { QueryManager } from '../src/db/queries.js'

describe('GitSyncManager', () => {
  let tmpDir: string
  let manager: GitSyncManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mini-cg-git-test-'))
    manager = new GitSyncManager(tmpDir)
    vi.clearAllMocks()
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* silent */ }
  })

  describe('isGitRepo', () => {
    it('returns false when no .git directory', () => {
      expect(manager.isGitRepo()).toBe(false)
    })

    it('returns true when .git directory exists', () => {
      mkdirSync(join(tmpDir, '.git'))
      expect(manager.isGitRepo()).toBe(true)
    })
  })

  describe('getCurrentCommitHash', () => {
    it('returns hash from git rev-parse', () => {
      vi.mocked(execFileSync).mockReturnValueOnce('abc123\n')

      const hash = manager.getCurrentCommitHash()
      expect(hash).toBe('abc123')
      expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf-8' })
    })

    it('returns empty string on error', () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('not a git repo') })

      expect(manager.getCurrentCommitHash()).toBe('')
    })
  })

  describe('getChangedFilesSince', () => {
    it('returns files from git diff and ls-files', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('src/main.ts\nsrc/utils.ts\n')
        .mockReturnValueOnce('new-file.ts\n')

      const files = manager.getChangedFilesSince('abc123')
      expect(files).toContain('src/main.ts')
      expect(files).toContain('src/utils.ts')
      expect(files).toContain('new-file.ts')
    })

    it('filters unsupported files', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('file.ts\nfile.png\nfile.txt\n')
        .mockReturnValueOnce('')

      const files = manager.getChangedFilesSince('abc123')
      expect(files).toContain('file.ts')
      expect(files).not.toContain('file.png')
      expect(files).not.toContain('file.txt')
    })

    it('returns empty array on error', () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('git error') })

      expect(manager.getChangedFilesSince('abc123')).toEqual([])
    })
  })

  describe('getAllTrackedFiles', () => {
    it('returns files from git ls-files', () => {
      vi.mocked(execFileSync).mockReturnValueOnce('src/a.ts\nsrc/b.ts\nnode_modules/x.png\n')

      const files = manager.getAllTrackedFiles()
      expect(files).toContain('src/a.ts')
      expect(files).toContain('src/b.ts')
      expect(files).not.toContain('node_modules/x.png')
    })
  })

  describe('getFileDiff', () => {
    it('parses diff output correctly', () => {
      const diffOutput = [
        'diff --git a/file.ts b/file.ts',
        '--- a/file.ts',
        '+++ b/file.ts',
        '+new line',
        '-old line',
        ' unchanged',
        '+another new',
        '',
      ].join('\n')
      vi.mocked(execFileSync).mockReturnValueOnce(diffOutput)

      const result = manager.getFileDiff('abc123', 'file.ts')
      expect(result.added).toBe(2)
      expect(result.removed).toBe(1)
      expect(result.lines.length).toBeGreaterThanOrEqual(4)
    })

    it('handles error', () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('error') })

      expect(manager.getFileDiff('abc123', 'file.ts')).toEqual({ added: 0, removed: 0, lines: [] })
    })
  })

  describe('detectNewFilesSince', () => {
    it('returns added files', () => {
      vi.mocked(execFileSync).mockReturnValueOnce('new1.ts\nnew2.ts\nimage.png\n')

      const files = manager.detectNewFilesSince('abc123')
      expect(files).toContain('new1.ts')
      expect(files).toContain('new2.ts')
      expect(files).not.toContain('image.png')
    })
  })

  describe('detectDeletedFilesSince', () => {
    it('returns deleted files', () => {
      vi.mocked(execFileSync).mockReturnValueOnce('old.ts\ndeprecated.ts\n')

      const files = manager.detectDeletedFilesSince('abc123')
      expect(files).toContain('old.ts')
      expect(files).toContain('deprecated.ts')
    })
  })

  describe('sync', () => {
    function createMockQueryManager(): QueryManager {
      const db = new DatabaseConnection(':memory:')
      db.open()
      const qm = new QueryManager(db)
      return qm
    }

    it('returns empty when no previous hash', () => {
      const qm = createMockQueryManager()
      const result = manager.sync(qm)
      expect(result).toEqual({ added: [], removed: [], changed: [] })
      qm.db.close()
    })

    it('returns empty when hash unchanged', () => {
      const qm = createMockQueryManager()
      vi.mocked(execFileSync).mockReturnValue('samehash\n')

      manager.getCurrentCommitHash()
      const result = manager.sync(qm)
      expect(result).toEqual({ added: [], removed: [], changed: [] })
      qm.db.close()
    })

    it('skips sync when not a git repo', () => {
      const qm = createMockQueryManager()
      manager.setLastCommitHash('oldhash')
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not a repo') })

      const result = manager.sync(qm)
      expect(result).toEqual({ added: [], removed: [], changed: [] })
      qm.db.close()
    })

    it('returns changed files when hash differs', () => {
      mkdirSync(join(tmpDir, '.git'))
      const qm = createMockQueryManager()
      manager.setLastCommitHash('oldhash')

      vi.mocked(execFileSync)
        .mockReturnValueOnce('newhash\n')  // getCurrentCommitHash
        .mockReturnValueOnce('new1.ts\n')  // detectNewFilesSince
        .mockReturnValueOnce('old.ts\n')   // detectDeletedFilesSince
        .mockReturnValueOnce('changed.ts\n') // getChangedFilesSince (diff)
        .mockReturnValueOnce('')             // getChangedFilesSince (untracked)

      const result = manager.sync(qm)
      expect(result.added).toContain('new1.ts')
      expect(result.removed).toContain('old.ts')
      expect(result.changed).toContain('changed.ts')
      expect(manager.getLastCommitHash()).toBe('newhash')
      qm.db.close()
    })
  })

  describe('commit hash management', () => {
    it('setLastCommitHash and getLastCommitHash round-trip', () => {
      manager.setLastCommitHash('abc123')
      expect(manager.getLastCommitHash()).toBe('abc123')
    })
  })
})
