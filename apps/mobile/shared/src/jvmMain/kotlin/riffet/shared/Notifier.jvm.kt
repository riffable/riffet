package riffet.shared

private class JvmNotifier : Notifier {
    override fun notify(title: String, body: String) {
        println("[$title] $body")
    }
}

actual fun createNotifier(): Notifier = JvmNotifier()
