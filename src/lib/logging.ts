type LogLevel = 'debug' | 'info' | 'warn' | 'error'

let rendererLoggingInstalled = false

export function installRendererErrorLogging() {
    if (rendererLoggingInstalled) return
    rendererLoggingInstalled = true

    window.addEventListener('error', event => {
        logRendererError('Unhandled renderer error', event.error ?? event.message, {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
        })
    })

    window.addEventListener('unhandledrejection', event => {
        logRendererError('Unhandled renderer rejection', event.reason)
    })

    installRendererConsoleLogging()
}

export function logRendererError(message: string, error: unknown, details?: Record<string, unknown>) {
    sendRendererLog('error', message, {
        error: serializeError(error),
        ...(details ? { details } : {}),
    })
}

function installRendererConsoleLogging() {
    const originalConsole = {
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    }

    console.warn = (...args: unknown[]) => {
        sendRendererLog('warn', 'console.warn', args)
        originalConsole.warn(...args)
    }

    console.error = (...args: unknown[]) => {
        sendRendererLog('error', 'console.error', args.map(serializeError))
        originalConsole.error(...args)
    }
}

function sendRendererLog(level: LogLevel, message: string, details?: unknown) {
    try {
        window.ipcRenderer?.send('log:renderer', { level, message, details })
    } catch {
        // Logging must never break the UI.
    }
}

function serializeError(value: unknown): unknown {
    if (value instanceof Error) {
        const errorRecord = value as Error & { cause?: unknown }

        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            cause: errorRecord.cause ? serializeError(errorRecord.cause) : undefined,
        }
    }

    return value
}
