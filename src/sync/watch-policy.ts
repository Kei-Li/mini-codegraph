import { readFileSync } from 'node:fs'
import { logDebug } from '../logger.js'

let wslChecked = false
let wslValue = false

export function detectWsl(): boolean {
  if (wslChecked) return wslValue
  wslChecked = true
  if (process.platform !== 'linux') { wslValue = false; return wslValue }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) { wslValue = true; return wslValue }
  try {
    const version = readFileSync('/proc/version', 'utf8').toLowerCase()
    wslValue = version.includes('microsoft') || version.includes('wsl')
  } catch { wslValue = false }
  logDebug('WSL detection', { wsl: wslValue })
  return wslValue
}

function isWindowsDriveMount(projectRoot: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(projectRoot.replace(/\\/g, '/'))
}

export interface WatchProbe {
  env?: Record<string, string | undefined>
  isWsl?: boolean
}

export function watchDisabledReason(projectRoot: string, probe: WatchProbe = {}): string | null {
  const env = probe.env ?? process.env as Record<string, string | undefined>

  if (env.MINI_CG_NO_WATCH === '1') return 'MINI_CG_NO_WATCH=1 is set'
  if (env.MINI_CG_FORCE_WATCH === '1') return null

  const isWsl = probe.isWsl ?? detectWsl()
  if (isWsl && isWindowsDriveMount(projectRoot)) {
    return 'project is on a WSL2 /mnt/ drive, where recursive fs.watch is too slow to be reliable'
  }

  return null
}

export function __resetWslCacheForTests(): void {
  wslChecked = false
  wslValue = false
}
