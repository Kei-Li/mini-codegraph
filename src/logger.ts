import { type Logger as ErrorsLogger, defaultLogger as _errorsDefault, silentLogger as _errorsSilent, setLogger as _setErrorsLogger, getLogger as _getErrorsLogger } from './errors.js'

export type Logger = ErrorsLogger
export const defaultLogger = _errorsDefault
export const silentLogger = _errorsSilent
export const setLogger = _setErrorsLogger
export const getLogger = _getErrorsLogger

export function logDebug(message: string, context?: unknown): void { _getErrorsLogger().debug(message, context) }
export function logInfo(message: string, context?: unknown): void { _getErrorsLogger().info(message, context) }
export function logWarn(message: string, context?: unknown): void { _getErrorsLogger().warn(message, context) }
export function logError(message: string, context?: unknown): void { _getErrorsLogger().error(message, context) }
