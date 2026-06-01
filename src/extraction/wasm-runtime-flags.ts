import { spawnSync } from 'node:child_process'

export const WASM_RUNTIME_FLAGS: readonly string[] = ['--liftoff-only']

const RELAUNCH_GUARD_ENV = 'MINI_CG_WASM_RELAUNCHED'

export const HOST_PPID_ENV = 'MINI_CG_HOST_PPID'

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

export function relaunchWithWasmRuntimeFlagsIfNeeded(scriptPath: string): void {
  if (processHasWasmRuntimeFlags()) return
  if (process.env[RELAUNCH_GUARD_ENV]) return

  const argv = buildRelaunchArgv(scriptPath, process.argv.slice(2))
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...process.env, [RELAUNCH_GUARD_ENV]: '1', [HOST_PPID_ENV]: String(process.ppid) },
    windowsHide: true,
  })

  if (result.error) return
  process.exit(result.status ?? (result.signal ? 1 : 0))
}
