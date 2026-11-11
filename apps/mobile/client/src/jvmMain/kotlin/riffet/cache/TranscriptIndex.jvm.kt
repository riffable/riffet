package riffet.cache

actual fun createTranscriptIndex(serverUrl: String): TranscriptIndex = MemoryTranscriptIndex()
