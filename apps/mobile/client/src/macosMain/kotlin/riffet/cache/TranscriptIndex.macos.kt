package riffet.cache

/** Rebuilt from the stored transcripts on every launch (`indexMissing`), so search covers the whole device copy. */
actual fun createTranscriptIndex(serverUrl: String): TranscriptIndex = MemoryTranscriptIndex()
