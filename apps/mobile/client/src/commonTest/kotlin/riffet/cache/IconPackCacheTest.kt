package riffet.cache

import riffet.contracts.*
import kotlin.test.*

class IconPackCacheTest {
    private val hash = "a".repeat(64)
    private val document = IconPackDocument(icons = mapOf("Plus" to IconGlyph(24f, 24f, listOf(IconPath("M12 4v16M4 12h16", fill = false, strokeWidth = 2f)))))

    @Test fun persistsPerServerAndRecoversFromCorruptFiles() {
        val files = InMemoryLocalFiles()
        val first = IconPackCache(files, "https://first")
        val catalog = AppearanceCatalog(version = 1, revision = "1", iconPacks = listOf(AppearancePalette("acme.pack/icons", "acme.pack", mapOf("en" to "Icons"), AppearanceAsset("/api/appearance/assets/acme.pack/$hash", hash, 100, "application/json"))))
        first.saveCatalog(catalog)
        first.savePack(hash, document)
        val relaunched = IconPackCache(files, "https://first")
        assertEquals(catalog, relaunched.catalog())
        assertEquals(document, relaunched.pack(hash))
        val other = IconPackCache(files, "https://second")
        assertNull(other.catalog())
        assertNull(other.pack(hash))
        assertNull(first.pack("../../secret"))
        val root = "icon-packs/${appearanceCacheToken("https://first")}"
        files.write("$root/$hash.json", "{truncated")
        files.write("$root/catalog.json", "{truncated")
        assertNull(relaunched.pack(hash))
        assertNull(relaunched.catalog())
        first.savePack(hash, document)
        assertEquals(document, relaunched.pack(hash))
    }

    @Test fun rejectsUnsupportedOrUnboundedGeometry() {
        assertFails { IconPackDocument.parse("""{"version":2,"icons":{}}""") }
        assertFalse(document.copy(icons = mapOf("Plus" to IconGlyph(Float.POSITIVE_INFINITY, 24f, listOf(IconPath("M0 0"))))).valid())
        assertFails { IconPackDocument.parse("""{"version":1,"icons":{"Plus":{"width":24,"height":24,"paths":[{"d":"<script/>"}]}}}""") }
    }
}
