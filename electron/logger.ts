import { app, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const SECRET_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)/i
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 50
const MAX_STRING_LENGTH = 8000

let loggingConfigured = false
let ipcLoggingInstalled = false
let consoleLoggingInstalled = false

export function configureLogging() {
    if (loggingConfigured) return
    loggingConfigured = true

    log.transports.file.level = 'debug'
    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}'
    log.transports.console.level = false
    log.initialize({ preload: true, spyRendererConsole: true })

    log.errorHandler.startCatching({
        showDialog: false,
        onError: ({ error, errorName, processType, versions }) => {
            log.error(`[${processType}] ${errorName}`, {
                error: serializeForLog(error),
                versions: sanitizeForLog(versions),
            })
            return false
        },
    })

    installConsoleLogging()
    installIpcLogging()

    app.on('render-process-gone', (_event, webContents, details) => {
        log.error('[Renderer] Process gone', {
            url: webContents.getURL(),
            details: sanitizeForLog(details),
        })
    })

    app.on('child-process-gone', (_event, details) => {
        log.error('[App] Child process gone', sanitizeForLog(details))
    })
}

export function logError(message: string, error: unknown, details?: Record<string, unknown>) {
    log.error(message, {
        error: serializeForLog(error),
        ...(details ? { details: sanitizeForLog(details) } : {}),
    })
}

function logRendererMessage(level: LogLevel, message: string, details?: unknown) {
    const safeLevel = isLogLevel(level) ? level : 'info'
    log[safeLevel](`[Renderer] ${message}`, sanitizeForLog(details))
}

function installIpcLogging() {
    if (ipcLoggingInstalled) return
    ipcLoggingInstalled = true

    ipcMain.on('log:renderer', (_event: IpcMainEvent, payload: { level?: LogLevel; message?: string; details?: unknown } = {}) => {
        logRendererMessage(payload.level ?? 'info', payload.message ?? 'Renderer log message', payload.details)
    })

    const originalHandle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        return originalHandle(channel, async (event, ...args) => {
            try {
                return await listener(event, ...args)
            } catch (error) {
                logError(`[IPC] Handler failed: ${channel}`, error, {
                    channel,
                    senderUrl: event.sender.getURL(),
                    args,
                })
                throw error
            }
        })
    }) as typeof ipcMain.handle
}

function installConsoleLogging() {
    if (consoleLoggingInstalled) return
    consoleLoggingInstalled = true

    const originalConsole = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    }

    console.log = (...args: unknown[]) => {
        log.info(...sanitizeForLog(args))
        originalConsole.log(...args)
    }
    console.info = (...args: unknown[]) => {
        log.info(...sanitizeForLog(args))
        originalConsole.info(...args)
    }
    console.warn = (...args: unknown[]) => {
        log.warn(...sanitizeForLog(args))
        originalConsole.warn(...args)
    }
    console.error = (...args: unknown[]) => {
        log.error(...sanitizeForLog(args))
        originalConsole.error(...args)
    }
}

function isLogLevel(level: string): level is LogLevel {
    return level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
}

function serializeForLog(value: unknown): unknown {
    if (value instanceof Error) {
        const errorRecord = value as Error & {
            code?: unknown
            cause?: unknown
            response?: unknown
            request?: unknown
            config?: unknown
        }

        return sanitizeForLog({
            name: value.name,
            message: value.message,
            stack: value.stack,
            code: errorRecord.code,
            cause: errorRecord.cause ? serializeForLog(errorRecord.cause) : undefined,
            response: errorRecord.response,
            request: errorRecord.request,
            config: errorRecord.config,
        })
    }

    return sanitizeForLog(value)
}

function sanitizeForLog<T>(value: T): T {
    return sanitize(value, 0, new WeakSet()) as T
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value

    if (typeof value === 'string') {
        return value.length > MAX_STRING_LENGTH
            ? `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`
            : value
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
    if (typeof value !== 'object') return String(value)

    if (value instanceof Date) return value.toISOString()
    if (value instanceof Error) return serializeForLog(value)

    if (seen.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '[Max depth reached]'
    seen.add(value)

    if (Array.isArray(value)) {
        const result = value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitize(item, depth + 1, seen))
        if (value.length > MAX_ARRAY_ITEMS) result.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`)
        seen.delete(value)
        return result
    }

    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        result[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitize(child, depth + 1, seen)
    }

    seen.delete(value)
    return result
}
