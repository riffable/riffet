package riffet.cache

import riffet.contracts.AppearanceCatalog
import riffet.contracts.IconPackDocument
import riffet.contracts.RiffetJson

/** Per-server catalog and content-addressed vectors. A failed refresh never overwrites this cache. */
class IconPackCache(private val files: LocalFiles, serverKey: String) {
    private val root = "icon-packs/${appearanceCacheToken(serverKey)}"
    fun catalog(): AppearanceCatalog? = runCatching {
        val text = files.read("$root/catalog.json") ?: return null
        RiffetJson.instance.decodeFromString(AppearanceCatalog.serializer(), text).takeIf { it.version == 1 }
    }.getOrNull()
    fun saveCatalog(catalog: AppearanceCatalog) = files.write("$root/catalog.json", RiffetJson.instance.encodeToString(AppearanceCatalog.serializer(), catalog))
    fun pack(hash: String): IconPackDocument? = runCatching {
        require(hash.matches(Regex("[0-9a-f]{64}")))
        files.read("$root/$hash.json")?.let(IconPackDocument::parse)
    }.getOrNull()
    fun savePack(hash: String, pack: IconPackDocument) {
        require(hash.matches(Regex("[0-9a-f]{64}")) && pack.valid())
        files.write("$root/$hash.json", RiffetJson.instance.encodeToString(IconPackDocument.serializer(), pack))
    }
}
