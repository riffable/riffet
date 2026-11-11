package riffet.ui.icons

import androidx.compose.runtime.*
import androidx.compose.ui.graphics.vector.ImageVector
import io.ktor.util.sha256
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import riffet.cache.IconPackCache
import riffet.cache.createLocalFiles
import riffet.contracts.IconPackDocument
import riffet.shared.AppPreferences
import riffet.shared.RiffetApi
import riffet.shared.appearance
import riffet.shared.appearanceAsset

data class IconPackChoice(val id: String, val title: Map<String, String>)

class IconPackState internal constructor(private val preferences: AppPreferences, private val preferenceKey: String, private val cache: IconPackCache?) {
    var selected by mutableStateOf(preferences.string(preferenceKey) ?: "lucide")
        private set
    internal var catalog by mutableStateOf(cache?.catalog())
    internal var revision by mutableIntStateOf(0)
    internal var loaded by mutableStateOf<Pair<String, Map<String, ImageVector>>?>(null)
    var loading by mutableStateOf(false)
        internal set
    var unavailable by mutableStateOf(false)
        internal set

    init {
        catalog?.iconPacks?.firstOrNull { it.id == selected }?.let { entry ->
            cache?.pack(entry.asset.sha256)?.let { loaded = entry.asset.sha256 to it.vectors(entry.id) }
        }
    }
    val choices: List<IconPackChoice> get() = BuiltinIconPacks.titles.map { (id, title) ->
        IconPackChoice(id, mapOf("en" to title))
    } + catalog?.iconPacks.orEmpty().map { IconPackChoice(it.id, it.title) }
    val vectors: Map<String, ImageVector> get() = BuiltinIconPacks.forId(selected)
        ?: loaded?.takeIf { it.first == catalog?.iconPacks?.firstOrNull { pack -> pack.id == selected }?.asset?.sha256 }?.second.orEmpty()
    fun select(id: String) {
        if (choices.none { it.id == id }) return
        preferences.setString(preferenceKey, id)
        selected = id
    }
    fun refresh() { revision++ }
}

@Composable
fun rememberIconPacks(api: RiffetApi?, preferences: AppPreferences): IconPackState {
    val cache = remember(api?.baseUrl) { api?.baseUrl?.let { IconPackCache(createLocalFiles(), it) } }
    // Plugin ids are only meaningful on their own server. A choice survives temporary disablement.
    val state = remember(preferences, cache) { IconPackState(preferences, "icon-pack:${api?.baseUrl.orEmpty()}", cache) }
    LaunchedEffect(api, state.revision) {
        if (api == null) return@LaunchedEffect
        try {
            val catalog = api.appearance()
            if (catalog.version != 1) return@LaunchedEffect
            state.catalog = catalog
            withContext(Dispatchers.Default) { runCatching { cache?.saveCatalog(catalog) } }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { /* Offline/older server: retain the last good catalog. */ }
    }
    LaunchedEffect(api, state.selected, state.catalog, state.revision) {
        state.unavailable = false
        state.loading = false
        if (state.selected in BuiltinIconPacks.titles) return@LaunchedEffect
        val entry = state.catalog?.iconPacks?.firstOrNull { it.id == state.selected }
        if (entry == null) { state.unavailable = true; return@LaunchedEffect }
        state.loading = true
        try {
            val document = withContext(Dispatchers.Default) { cache?.pack(entry.asset.sha256) } ?: run {
                require(entry.asset.size in 1..IconPackDocument.MAX_BYTES.toLong())
                require(entry.asset.url == "/api/appearance/assets/${entry.plugin}/${entry.asset.sha256}")
                val bytes = requireNotNull(api).appearanceAsset(entry.asset.url, entry.asset.size)
                require(bytes.size.toLong() == entry.asset.size)
                withContext(Dispatchers.Default) {
                    require(sha256(bytes).toHexString() == entry.asset.sha256) { "Icon pack asset hash mismatch" }
                    IconPackDocument.parse(bytes.decodeToString())
                }
            }
            val vectors = withContext(Dispatchers.Default) { document.vectors(entry.id) }
            require(vectors.isNotEmpty())
            state.loaded = entry.asset.sha256 to vectors
            withContext(Dispatchers.Default) { runCatching { cache?.savePack(entry.asset.sha256, document) } }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { state.unavailable = true }
        finally { state.loading = false }
    }
    return state
}
