package riffet.ui.composer

actual fun createOutboxStore(serverUrl: String?): OutboxStore = InMemoryOutboxStore()
