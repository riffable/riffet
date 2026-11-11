package riffet.cache

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File
import riffet.shared.RiffetAndroid

/**
 * SQLite's FTS4, which every Android build ships. Its `simple` tokenizer knows no Chinese, so the
 * indexed column holds [indexTokens]' words (CJK as overlapping pairs) and [ftsQuery] asks in the
 * same words; the message text itself sits in a plain table for the snippet.
 *
 * The database is in the no-backup directory beside the transcripts it indexes, one per server.
 */
actual fun createTranscriptIndex(serverUrl: String): TranscriptIndex =
    runCatching {
        val context = RiffetAndroid.requireContext()
        val directory = File(context.noBackupFilesDir, "riffet-cache").apply { mkdirs() }
        SqliteTranscriptIndex(context, File(directory, "search-${serverUrl.trimEnd('/').lowercase().hashCode().toUInt().toString(16)}.db").path)
    }.getOrElse { MemoryTranscriptIndex() }

private class SqliteTranscriptIndex(context: Context, path: String) : TranscriptIndex {
    private val helper = object : SQLiteOpenHelper(context, path, null, SCHEMA_VERSION) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE messages (id INTEGER PRIMARY KEY, session TEXT NOT NULL, sequence INTEGER NOT NULL, role TEXT NOT NULL, created TEXT NOT NULL, body TEXT NOT NULL)")
            db.execSQL("CREATE INDEX messages_session ON messages(session)")
            db.execSQL("CREATE VIRTUAL TABLE messages_fts USING fts4(tokens)")
        }

        /** The index is derived data: a new schema is built again from the stored transcripts. */
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            db.execSQL("DROP TABLE IF EXISTS messages_fts")
            db.execSQL("DROP TABLE IF EXISTS messages")
            onCreate(db)
        }

        override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = onUpgrade(db, oldVersion, newVersion)
    }

    private val db: SQLiteDatabase get() = helper.writableDatabase

    override fun replace(sessionId: String, entries: List<IndexEntry>) = transaction {
        delete(sessionId)
        db.compileStatement("INSERT INTO messages (session, sequence, role, created, body) VALUES (?, ?, ?, ?, ?)").use { insert ->
            db.compileStatement("INSERT INTO messages_fts (docid, tokens) VALUES (?, ?)").use { tokens ->
                for (entry in entries) {
                    insert.clearBindings()
                    insert.bindString(1, sessionId)
                    insert.bindLong(2, entry.sequence)
                    insert.bindString(3, entry.role.name)
                    insert.bindString(4, entry.createdAt)
                    insert.bindString(5, entry.text)
                    val id = insert.executeInsert()
                    tokens.clearBindings()
                    tokens.bindLong(1, id)
                    tokens.bindString(2, indexTokens(entry.text).joinToString(" "))
                    tokens.executeInsert()
                }
            }
        }
    }

    override fun forget(sessionId: String) = transaction { delete(sessionId) }

    override fun clear() = transaction {
        db.execSQL("DELETE FROM messages_fts")
        db.execSQL("DELETE FROM messages")
    }

    override fun close() = helper.close()

    override fun sessions(): Set<String> =
        db.rawQuery("SELECT DISTINCT session FROM messages", null).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    override fun search(query: String, limit: Int, sessionId: String?): List<IndexHit> {
        val match = ftsQuery(query) ?: return emptyList()
        return db.rawQuery(
            "SELECT m.session, m.sequence, m.role, m.created, m.body FROM messages_fts f JOIN messages m ON m.id = f.docid " +
                "WHERE messages_fts MATCH ?" + (if (sessionId == null) "" else " AND m.session = ?") + " ORDER BY m.created DESC LIMIT ?",
            (listOf(match) + listOfNotNull(sessionId) + limit.toString()).toTypedArray(),
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val (text, highlights) = snippet(cursor.getString(4), query)
                    add(
                        IndexHit(
                            sessionId = cursor.getString(0),
                            sequence = cursor.getLong(1),
                            role = runCatching { IndexRole.valueOf(cursor.getString(2)) }.getOrDefault(IndexRole.ASSISTANT),
                            createdAt = cursor.getString(3),
                            snippet = text,
                            highlights = highlights,
                        ),
                    )
                }
            }
        }
    }

    private fun delete(sessionId: String) {
        db.execSQL("DELETE FROM messages_fts WHERE docid IN (SELECT id FROM messages WHERE session = ?)", arrayOf(sessionId))
        db.delete("messages", "session = ?", arrayOf(sessionId))
    }

    private fun transaction(block: () -> Unit) {
        val database = db
        database.beginTransaction()
        try {
            block()
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
    }

    private companion object {
        const val SCHEMA_VERSION = 1
    }
}
