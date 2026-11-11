package riffet.shared

/** The platform notifier lives with the UI module because Android posts it with this module's icon resource. */
expect fun createNotifier(): Notifier
