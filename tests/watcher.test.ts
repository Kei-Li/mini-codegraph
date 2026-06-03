import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { mockWatch, mockOn, mockClose, mockWatchDisabledReason } = vi.hoisted(() => {
  const mockClose = vi.fn()
  const mockOn = vi.fn()
  const mockWatch = vi.fn(() => ({ on: mockOn, close: mockClose }))
  const mockWatchDisabledReason = vi.fn(() => null)
  return { mockWatch, mockOn, mockClose, mockWatchDisabledReason }
})

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
  FSWatcher: class {},
}))

vi.mock('../src/sync/watch-policy.js', () => ({
  watchDisabledReason: mockWatchDisabledReason,
}))

import { FileWatcher, LockUnavailableError } from '../src/sync/watcher.js'

describe('FileWatcher', () => {
  let tmpDir: string
  let syncFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mini-cg-watcher-test-'))
    syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 100 })
    mockOn.mockReset()
    mockClose.mockReset()
    mockWatch.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* silent */ }
  })

  describe('start', () => {
    it('starts the chokidar watcher', () => {
      const watcher = new FileWatcher(tmpDir, syncFn, { debounceMs: 5000 })
      const result = watcher.start()
      expect(result).toBe(true)
      expect(mockWatch).toHaveBeenCalled()
    })

    it('returns false when watch policy disables', async () => {
      const { watchDisabledReason } = await import('../src/sync/watch-policy.js')
      vi.mocked(watchDisabledReason).mockReturnValueOnce('WSL on /mnt')

      const watcher = new FileWatcher(tmpDir, syncFn)
      const result = watcher.start()
      expect(result).toBe(false)
    })

    it('is idempotent on multiple start calls', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      watcher.start()
      watcher.start()
      expect(mockWatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('isActive', () => {
    it('returns false before start', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      expect(watcher.isActive()).toBe(false)
    })

    it('returns true after start', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      watcher.start()
      expect(watcher.isActive()).toBe(true)
    })

    it('returns false after stop', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      watcher.start()
      watcher.stop()
      expect(watcher.isActive()).toBe(false)
    })
  })

  describe('stop', () => {
    it('closes the chokidar watcher', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      watcher.start()
      watcher.stop()
      expect(mockClose).toHaveBeenCalled()
    })

    it('is safe to call without starting', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      expect(() => watcher.stop()).not.toThrow()
    })
  })

  describe('getPendingFiles', () => {
    it('returns empty before any changes', () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      expect(watcher.getPendingFiles()).toEqual([])
    })
  })

  describe('waitUntilReady', () => {
    it('resolves immediately if chokidar is already ready', async () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      watcher.start()
      // Simulate chokidar ready
      const readyCallback = mockOn.mock.calls.find((c: any[]) => c[0] === 'ready')?.[1]
      if (readyCallback) readyCallback()

      await expect(watcher.waitUntilReady(100)).resolves.toBeUndefined()
      watcher.stop()
    })

    it('rejects on timeout', async () => {
      const watcher = new FileWatcher(tmpDir, syncFn)
      watcher.start()

      await expect(watcher.waitUntilReady(50)).rejects.toThrow('timed out')
      watcher.stop()
    })
  })

  describe('LockUnavailableError', () => {
    it('has correct name and default message', () => {
      const err = new LockUnavailableError()
      expect(err.name).toBe('LockUnavailableError')
      expect(err.message).toContain('file lock unavailable')
    })

    it('accepts custom message', () => {
      const err = new LockUnavailableError('custom')
      expect(err.message).toBe('custom')
    })
  })
})
