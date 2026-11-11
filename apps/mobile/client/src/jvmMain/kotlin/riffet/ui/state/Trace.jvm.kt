package riffet.ui.state

actual fun traceBegin(name: String) = Unit

actual fun traceEnd() = Unit

actual fun traceAsyncBegin(name: String, cookie: Int) = Unit

actual fun traceAsyncEnd(name: String, cookie: Int) = Unit

actual fun lifecycleTraceEnabled(): Boolean = false

actual fun lifecycleTrace(message: String) = Unit
