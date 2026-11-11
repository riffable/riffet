package riffet.terminal

/**
 * The callbacks [TerminalEmulator] and [TerminalBuffer] make besides [TerminalOutput]: the cursor
 * and logging. Termux's interface also carried session lifecycle events; there is no local session
 * here.
 */
interface TerminalSessionClient {
    fun onTerminalCursorStateChange(state: Boolean)

    /** The user's preferred cursor style (one of `TerminalEmulator.TERMINAL_CURSOR_STYLE_*`), or null. */
    fun getTerminalCursorStyle(): Int?

    fun logError(tag: String, message: String)
    fun logWarn(tag: String, message: String)
    fun logInfo(tag: String, message: String)
    fun logDebug(tag: String, message: String)
    fun logVerbose(tag: String, message: String)
    fun logStackTraceWithMessage(tag: String, message: String?, throwable: Throwable)
    fun logStackTrace(tag: String, throwable: Throwable)
}

/** Null-safe forwarding to a possibly absent client, as Termux's `Logger` does. */
internal object Logger {
    fun logError(client: TerminalSessionClient?, logTag: String, message: String) {
        client?.logError(logTag, message)
    }

    fun logWarn(client: TerminalSessionClient?, logTag: String, message: String) {
        client?.logWarn(logTag, message)
    }

    fun logInfo(client: TerminalSessionClient?, logTag: String, message: String) {
        client?.logInfo(logTag, message)
    }

    fun logDebug(client: TerminalSessionClient?, logTag: String, message: String) {
        client?.logDebug(logTag, message)
    }

    fun logVerbose(client: TerminalSessionClient?, logTag: String, message: String) {
        client?.logVerbose(logTag, message)
    }

    fun logStackTraceWithMessage(client: TerminalSessionClient?, tag: String, message: String?, throwable: Throwable) {
        client?.logStackTraceWithMessage(tag, message, throwable)
    }
}
