package riffet.shared

/** TODO(ios, P4): `UNUserNotificationCenter`. A no-op is a stub, not a notification. */
private class IosNotifier : Notifier {
    override fun notify(title: String, body: String) = Unit
}

actual fun createNotifier(): Notifier = IosNotifier()
