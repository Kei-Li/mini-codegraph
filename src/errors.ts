export class MiniCodeGraphError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'MiniCodeGraphError'
  }
}

export class FileError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'FILE_ERROR', context)
    this.name = 'FileError'
  }
}

export class ParseError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PARSE_ERROR', context)
    this.name = 'ParseError'
  }
}

export class DatabaseError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', context)
    this.name = 'DatabaseError'
  }
}

export class SearchError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SEARCH_ERROR', context)
    this.name = 'SearchError'
  }
}

export class ConfigError extends MiniCodeGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context)
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
