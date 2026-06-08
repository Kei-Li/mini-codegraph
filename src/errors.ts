export class MiniCodeGraphError extends Error {
  readonly code: string
  readonly context?: Record<string, unknown>

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'MiniCodeGraphError'
    this.code = code
    this.context = context
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor)
  }
}

export class FileError extends MiniCodeGraphError {
  readonly filePath: string

  constructor(message: string, filePath: string, cause?: Error) {
    super(message, 'FILE_ERROR', { filePath, cause: cause?.message })
    this.name = 'FileError'
    this.filePath = filePath
    if (cause) this.cause = cause
  }
}

export class ParseError extends MiniCodeGraphError {
  readonly filePath: string
  readonly line?: number
  readonly column?: number

  constructor(message: string, filePath: string, options?: { line?: number; column?: number; cause?: Error }) {
    super(message, 'PARSE_ERROR', { filePath, line: options?.line, column: options?.column, cause: options?.cause?.message })
    this.name = 'ParseError'
    this.filePath = filePath
    this.line = options?.line
    this.column = options?.column
    if (options?.cause) this.cause = options.cause
  }
}

export class DatabaseError extends MiniCodeGraphError {
  readonly operation: string

  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', { operation, cause: cause?.message })
    this.name = 'DatabaseError'
    this.operation = operation
    if (cause) this.cause = cause
  }
}

export class SearchError extends MiniCodeGraphError {
  readonly query: string

  constructor(message: string, query: string, cause?: Error) {
    super(message, 'SEARCH_ERROR', { query, cause: cause?.message })
    this.name = 'SearchError'
    this.query = query
    if (cause) this.cause = cause
  }
}

export class ConfigError extends MiniCodeGraphError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details)
    this.name = 'ConfigError'
  }
}

export class ResolutionError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'RESOLUTION_ERROR', context)
    this.name = 'ResolutionError'
  }
}

export class GrammarError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'GRAMMAR_ERROR', context)
    this.name = 'GrammarError'
  }
}

export class LockError extends MiniCodeGraphError {
  constructor(message: string, lockPath?: string) {
    super(message, 'LOCK_ERROR', lockPath ? { lockPath } : undefined)
    this.name = 'LockError'
  }
}

export interface Logger {
  debug(message: string, context?: unknown): void
  info(message: string, context?: unknown): void
  warn(message: string, context?: unknown): void
  error(message: string, context?: unknown): void
}

function formatContext(context?: unknown): string {
  if (context === undefined || context === null) return ''
  if (typeof context === 'string') return context
  if (context instanceof Error) return context.message
  if (typeof context === 'object') {
    try { return JSON.stringify(context) } catch { return String(context) }
  }
  return String(context)
}

export const defaultLogger: Logger = {
  debug(message: string, context?: unknown) {
    if (process.env.MINI_CG_DEBUG) {
      const ctx = formatContext(context)
      console.debug(`[mini-codegraph] ${message}${ctx ? ' ' + ctx : ''}`)
    }
  },
  info(message: string, context?: unknown) {
    const ctx = formatContext(context)
    console.info(`[mini-codegraph] ${message}${ctx ? ' ' + ctx : ''}`)
  },
  warn(message: string, context?: unknown) {
    const ctx = formatContext(context)
    console.warn(`[mini-codegraph] ${message}${ctx ? ' ' + ctx : ''}`)
  },
  error(message: string, context?: unknown) {
    const ctx = formatContext(context)
    console.error(`[mini-codegraph] ${message}${ctx ? ' ' + ctx : ''}`)
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

export function logDebug(message: string, context?: unknown): void {
  currentLogger.debug(message, context)
}

export function logWarn(message: string, context?: unknown): void {
  currentLogger.warn(message, context)
}

export function logError(message: string, context?: unknown): void {
  currentLogger.error(message, context)
}
