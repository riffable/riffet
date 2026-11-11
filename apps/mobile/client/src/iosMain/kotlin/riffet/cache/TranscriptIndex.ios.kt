package riffet.cache

/** Search survives process death and stays scoped to the exact server's device copy. */
actual fun createTranscriptIndex(serverUrl: String): TranscriptIndex = FileTranscriptIndex(createLocalFiles(), serverUrl)
