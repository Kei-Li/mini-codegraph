import { spawnSync } from 'node:child_process'

export const WASM_RUNTIME_FLAGS: readonly string[] = ['--liftoff-only']

const RELAUNCH_GUARD_ENV = 'MINI_CG_WASM_RELAUNCHED'

export const HOST_PPID_ENV = 'MINI_CG_HOST_PPID'

const SENSITIVE_ENV_PATTERNS = /^(GITHUB_|NPM_|AWS_|TOKEN_|SECRET_|PASSWORD|API_KEY|ACCESS_KEY|SESSION_)/i

function filterSensitiveEnv(): Record<string, string | undefined> {
  const safe: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERNS.test(key)) safe[key] = value
  }
  return safe
}

export function processHasWasmRuntimeFlags(execArgv: readonly string[] = process.execArgv): boolean {
  return WASM_RUNTIME_FLAGS.every((flag) => execArgv.includes(flag))
}

export function buildRelaunchArgv(
  scriptPath: string,
  scriptArgs: readonly string[],
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const preserved = execArgv.filter((arg) => !WASM_RUNTIME_FLAGS.includes(arg))
  return [...WASM_RUNTIME_FLAGS, ...preserved, scriptPath, ...scriptArgs]
}

const TURBOSHAFT_OOM_EXIT_CODE = 132
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10)

export function isTurboshaftOOM(exitCode: number | null, signal: string | null): boolean {
  return (exitCode === TURBOSHAFT_OOM_EXIT_CODE || signal === 'SIGILL') && NODE_MAJOR >= 25
}

export function relaunchWithWasmRuntimeFlagsIfNeeded(scriptPath: string): void {
  if (processHasWasmRuntimeFlags()) return
  if (process.env[RELAUNCH_GUARD_ENV]) return

  const argv = buildRelaunchArgv(scriptPath, process.argv.slice(2))
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...filterSensitiveEnv(), [RELAUNCH_GUARD_ENV]: '1', [HOST_PPID_ENV]: String(process.ppid) },
    windowsHide: true,
  })

  if (result.error) return
  if (result.status !== null && isTurboshaftOOM(result.status, result.signal)) {
    console.error('WASM runtime crashed (V8 turboshaft OOM). Re-launching with --liftoff-only may help.')
  }
  process.exit(result.status ?? (result.signal ? 1 : 0))
}

export function detectWasmCrash(error: Error): boolean {
  const msg = error.message ?? ''
  return msg.includes('turboshaft') || msg.includes('wasm') || msg.includes('WebAssembly')
}
