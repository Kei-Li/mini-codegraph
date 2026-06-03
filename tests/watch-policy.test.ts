import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watchDisabledReason, __resetWslCacheForTests } from '../src/sync/watch-policy.js'

describe('watchDisabledReason', () => {
  beforeEach(() => {
    __resetWslCacheForTests()
  })

  it('returns reason when MINI_CG_NO_WATCH=1', () => {
    const reason = watchDisabledReason('/project', { env: { MINI_CG_NO_WATCH: '1' } })
    expect(reason).toContain('MINI_CG_NO_WATCH')
  })

  it('returns null when MINI_CG_FORCE_WATCH=1', () => {
    const reason = watchDisabledReason('/project', { env: { MINI_CG_FORCE_WATCH: '1' } })
    expect(reason).toBeNull()
  })

  it('returns null when not WSL', () => {
    const reason = watchDisabledReason('/project', { env: {}, isWsl: false })
    expect(reason).toBeNull()
  })

  it('returns reason on WSL /mnt drive', () => {
    const reason = watchDisabledReason('/mnt/c/Users/project', { env: {}, isWsl: true })
    expect(reason).toContain('/mnt/')
  })

  it('returns null on WSL non-mnt drive', () => {
    const reason = watchDisabledReason('/home/user/project', { env: {}, isWsl: true })
    expect(reason).toBeNull()
  })

  it('wsl takes precedence over MINI_CG_FORCE_WATCH', () => {
    const reason = watchDisabledReason('/mnt/c/project', {
      env: { MINI_CG_FORCE_WATCH: '1' },
      isWsl: true,
    })
    expect(reason).toBeNull()
  })
})
