package riffet.contracts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /api/marks` as `apps/server/src/marks.ts` writes it: optional fields are left out rather
 * than null, and a kind or colour this client does not know must not drop the page.
 */
class MarkContractTest {

    @Test
    fun `a marks page decodes the server's fields`() {
        val page = RiffetJson.instance.decodeFromString(MarkListPage.serializer(), MARK_PAGE_FIXTURE)

        assertEquals(3, page.total)
        assertEquals("WyIyMDI2LTEwLTIwVDA4OjAwOjAwLjAwMFoiLCJtMyJd", page.nextCursor)

        val span = page.marks[0]
        assertTrue(span.isSpan)
        assertEquals(listOf("msg-1", "uuid-1"), span.anchor.ids)
        assertEquals(42L, span.anchor.sequence)
        assertEquals(12, span.quote?.start)
        assertNull(span.quote?.end)
        assertEquals("blue", span.color)
        assertEquals("codex", span.backendId)

        val image = page.marks[1]
        assertTrue(image.isAsset)
        assertTrue(image.orphaned)
        assertEquals(2048L, image.asset?.bytes)
        assertEquals(true, image.asset?.stored)
        assertEquals("docs/shot.png", image.excerpt)

        // Kinds and colours stay strings: a newer server's value reads as itself.
        assertEquals("table", page.marks[2].kind)
        assertNull(page.marks[2].backendId)
    }
}

private const val MARK_PAGE_FIXTURE = """
{
  "marks": [
    {
      "id": "m1", "sessionId": "s1", "projectId": "p1", "backendId": "codex", "kind": "span",
      "anchor": { "messageId": "msg-1", "aliases": ["uuid-1"], "runId": "r1", "sequence": 42, "generation": "g1" },
      "quote": { "exact": "保存它", "prefix": "请", "suffix": "。", "start": 12 },
      "snapshot": { "text": "请保存它。", "sessionTitle": "收藏", "at": "2026-10-20T08:00:00.000Z" },
      "note": "备注", "color": "blue", "state": "ok",
      "createdAt": "2026-10-21T08:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z"
    },
    {
      "id": "m2", "sessionId": "s1", "projectId": "p1", "kind": "image",
      "anchor": { "messageId": "msg-2" },
      "asset": { "name": "shot.png", "path": "docs/shot.png", "mimeType": "image/png", "bytes": 2048, "stored": true },
      "snapshot": { "text": "docs/shot.png", "sessionTitle": "收藏", "at": "2026-10-20T08:00:00.000Z" },
      "state": "orphaned", "createdAt": "2026-10-20T08:00:00.000Z", "updatedAt": "2026-10-20T08:00:00.000Z"
    },
    {
      "id": "m3", "sessionId": "s2", "projectId": "p1", "kind": "table", "color": "purple", "futureField": 1,
      "anchor": { "messageId": "msg-3" },
      "snapshot": { "text": "", "sessionTitle": "", "at": "2026-10-20T08:00:00.000Z" },
      "state": "ok", "createdAt": "2026-10-20T08:00:00.000Z", "updatedAt": "2026-10-20T08:00:00.000Z"
    }
  ],
  "nextCursor": "WyIyMDI2LTEwLTIwVDA4OjAwOjAwLjAwMFoiLCJtMyJd",
  "total": 3
}
"""
