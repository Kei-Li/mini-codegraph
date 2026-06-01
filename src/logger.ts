export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const DEBUG_ENABLED = () => process.env.MINI_CG_DEBUG === '1'

export const defaultLogger: Logger = {
  debug(...args: unknown[]) {
    if (DEBUG_ENABLED()) {
      console.error('[debug]', ...args)
    }
  },
  info(...args: unknown[]) {
    console.error(...args)
  },
  warn(...args: unknown[]) {
    console.error('[warn]', ...args)
  },
  error(...args: unknown[]) {
    console.error('[error]', ...args)
  },
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

let currentLogger: Logger = defaultLogger

export function setLogger(logger: Logger): void {
  currentLogger = logger
}

export function getLogger(): Logger {
  return currentLogger
}

export function logDebug(...args: unknown[]): void { currentLogger.debug(...args) }
export function logInfo(...args: unknown[]): void { currentLogger.info(...args) }
export function logWarn(...args: unknown[]): void { currentLogger.warn(...args) }
export function logError(...args: unknown[]): void { currentLogger.error(...args) }
