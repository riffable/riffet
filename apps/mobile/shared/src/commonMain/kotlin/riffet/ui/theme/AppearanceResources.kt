package riffet.ui.theme

import androidx.compose.runtime.*
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.font.FontFamily
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import riffet.cache.IconPackCache
import riffet.cache.createLocalFiles
import riffet.contracts.*
import riffet.shared.*
import riffet.theme.riffetAnsi
import riffet.theme.riffetCodeColors
import riffet.theme.riffetColors
import riffet.theme.RiffetCodeTheme

/** Device-local contribution choices. Null inherits the preset; "default" explicitly opts out. */
@Serializable
data class AppearanceSelection(
    val preset: String? = null,
    val palette: String? = null,
    val uiFont: String? = null,
    val monoFont: String? = null,
    val background: String? = null,
)

enum class AppearanceSlot { PRESET, PALETTE, UI_FONT, MONO_FONT, BACKGROUND }

/** Resolved against the current catalog, without rewriting unavailable stored contributions. */
data class EffectiveAppearance(
    val palette: AppearancePalette? = null,
    val uiFont: AppearanceFont? = null,
    val monoFont: AppearanceFont? = null,
    val background: AppearanceBackground? = null,
)

fun AppearanceCatalog.resolve(selection: AppearanceSelection): EffectiveAppearance {
    val preset = presets.firstOrNull { it.id == selection.preset }
    fun <T> pick(choice: String?, inherited: String?, find: (String) -> T?): T? =
        (choice ?: inherited)?.takeUnless { it == "default" }?.let(find)
    return EffectiveAppearance(
        pick(selection.palette, preset?.palette) { id -> palettes.firstOrNull { it.id == id } },
        pick(selection.uiFont, preset?.fonts?.ui) { id -> fonts.firstOrNull { it.id == id && it.role == "ui" } },
        pick(selection.monoFont, preset?.fonts?.mono) { id -> fonts.firstOrNull { it.id == id && it.role == "mono" } },
        pick(selection.background, preset?.background) { id -> backgrounds.firstOrNull { it.id == id && "workbench" in it.areas } },
    )
}

@Stable
class AppearanceResourcesState internal constructor(private val preferences: AppPreferences, private val selectionKey: String) {
    var selection by mutableStateOf(runCatching {
        preferences.string(selectionKey)?.let { RiffetJson.instance.decodeFromString(AppearanceSelection.serializer(), it) }
    }.getOrNull() ?: AppearanceSelection())
        private set
    var catalog by mutableStateOf<AppearanceCatalog?>(null)
        internal set
    var palette by mutableStateOf<ThemeEntry?>(null)
        internal set
    var uiFont by mutableStateOf<FontFamily?>(null)
        internal set
    var monoFont by mutableStateOf<FontFamily?>(null)
        internal set
    var background by mutableStateOf<ImageBitmap?>(null)
        internal set
    private var loadingSlots by mutableStateOf<Set<AppearanceSlot>>(emptySet())
    private val loadOwners = mutableMapOf<AppearanceSlot, Any>()
    val catalogLoading: Boolean get() = AppearanceSlot.PRESET in loadingSlots
    val loading: Boolean get() = loadingSlots.isNotEmpty()
    var errors by mutableStateOf<List<AppearanceSlot>>(emptyList())
        internal set
    internal var refreshVersion by mutableIntStateOf(0)
    val effective: EffectiveAppearance get() = catalog?.resolve(selection) ?: EffectiveAppearance()
    fun refresh() { refreshVersion++ }
    internal fun beginLoad(slot: AppearanceSlot): Any = Any().also { owner ->
        loadOwners[slot] = owner
        loadingSlots = loadingSlots + slot
        errors = errors.filterNot { it == slot }
    }
    internal fun ownsLoad(slot: AppearanceSlot, owner: Any): Boolean = loadOwners[slot] === owner
    internal fun finishLoad(slot: AppearanceSlot, owner: Any, failed: Boolean? = null) {
        if (!ownsLoad(slot, owner)) return
        loadOwners.remove(slot)
        loadingSlots = loadingSlots - slot
        if (failed != null) errors = (errors.filterNot { it == slot } + if (failed) listOf(slot) else emptyList()).sortedBy { it.ordinal }
    }
    fun select(slot: AppearanceSlot, id: String?) {
        val next = when (slot) {
            AppearanceSlot.PRESET -> AppearanceSelection(preset = id?.takeUnless { it == "default" })
            AppearanceSlot.PALETTE -> selection.copy(palette = id)
            AppearanceSlot.UI_FONT -> selection.copy(uiFont = id)
            AppearanceSlot.MONO_FONT -> selection.copy(monoFont = id)
            AppearanceSlot.BACKGROUND -> selection.copy(background = id)
        }
        preferences.setString(selectionKey, RiffetJson.instance.encodeToString(AppearanceSelection.serializer(), next))
        selection = next
    }
}

val LocalAppearanceResources = staticCompositionLocalOf<AppearanceResourcesState?> { null }

/** Resolve the live authenticated identity before touching any catalog, choice or asset cache. */
@Composable
fun rememberAppearanceResources(api: RiffetApi?): AppearanceResourcesState? {
    val focused = LocalWindowInfo.current.isWindowFocused
    val identity by produceState<Pair<RiffetApi?, String?>>(null to null, api, focused) {
        val scope = try { api?.let { platformAppearanceScope(it) } }
        catch (failure: CancellationException) { throw failure }
        catch (_: Exception) { null }
        value = api to scope
    }
    if (identity.first !== api) return null
    val scope = identity.second ?: return null
    return api?.let { rememberAppearanceResources(it, scope) }
}

/** [scopeKey] includes the server and pairing/account identity; never share private catalog bytes across accounts. */
@Composable
fun rememberAppearanceResources(api: RiffetApi, scopeKey: String): AppearanceResourcesState {
    val preferences = remember { createAppPreferences() }
    val state = remember(api, scopeKey) { AppearanceResourcesState(preferences, "appearance.selection|$scopeKey") }
    val cache = remember(scopeKey) { IconPackCache(createLocalFiles(), "appearance-resources|$scopeKey") }
    LaunchedEffect(state, state.refreshVersion) {
        val owner = state.beginLoad(AppearanceSlot.PRESET)
        try {
            val cached = withContext(Dispatchers.Default) { cache.catalog() }
            if (state.ownsLoad(AppearanceSlot.PRESET, owner) && state.catalog == null) state.catalog = cached
            val next = api.appearance()
            require(next.version == 1) { "Unsupported appearance catalog" }
            withContext(Dispatchers.Default) { cache.saveCatalog(next) }
            if (state.ownsLoad(AppearanceSlot.PRESET, owner)) state.catalog = next
            state.finishLoad(AppearanceSlot.PRESET, owner, failed = false)
        } catch (failure: CancellationException) { throw failure }
        catch (_: Exception) { state.finishLoad(AppearanceSlot.PRESET, owner, failed = true) }
        finally { state.finishLoad(AppearanceSlot.PRESET, owner) }
    }
    val resolved = state.effective
    // Payload keys exclude catalog revisions and unrelated selection/title changes.
    AppearanceResourceEffect(state, AppearanceSlot.PALETTE, resolved.palette?.asset, update = { state.palette = it }) {
        val contribution = requireNotNull(resolved.palette)
        val bytes = appearanceResourceBytes(api, scopeKey, contribution.asset, 512 * 1024L)
        val custom = RiffetJson.instance.decodeFromString(CustomTheme.serializer(), bytes.decodeToString())
        val syntaxEntry = custom.syntax?.let { s ->
            val lightSyntax = riffetCodeColors(s.light.colors, s.light.commentItalic)
            val darkSyntax = riffetCodeColors(s.dark.colors, s.dark.commentItalic)
            if (lightSyntax != null && darkSyntax != null) RiffetCodeTheme("plugin-" + contribution.asset.sha256.take(16), localizedAppearanceTitle(contribution.title), lightSyntax, darkSyntax) else null
        }
        ThemeEntry("plugin-" + contribution.asset.sha256.take(16), localizedAppearanceTitle(contribution.title), "",
            requireNotNull(riffetColors(custom.palette.light)), requireNotNull(riffetColors(custom.palette.dark)),
            requireNotNull(riffetAnsi(custom.ansi.light)), requireNotNull(riffetAnsi(custom.ansi.dark)),
            contribution.asset.sha256, custom.design, syntaxEntry)
    }
    AppearanceResourceEffect(state, AppearanceSlot.UI_FONT, resolved.uiFont?.let { it.role to it.files }, update = { state.uiFont = it }) {
        loadAppearanceFont(api, scopeKey, requireNotNull(resolved.uiFont))
    }
    AppearanceResourceEffect(state, AppearanceSlot.MONO_FONT, resolved.monoFont?.let { it.role to it.files }, update = { state.monoFont = it }) {
        loadAppearanceFont(api, scopeKey, requireNotNull(resolved.monoFont))
    }
    AppearanceResourceEffect(state, AppearanceSlot.BACKGROUND, resolved.background?.asset, update = { state.background = it }) {
        loadAppearanceBackground(appearanceResourceBytes(api, scopeKey, requireNotNull(resolved.background).asset, 16 * 1024 * 1024L))
    }
    return state
}

/** Each slot owns its result and pending flag; cancellation cannot publish into a newer request. */
@Composable
private fun <T> AppearanceResourceEffect(
    state: AppearanceResourcesState,
    slot: AppearanceSlot,
    resourceKey: Any?,
    update: (T?) -> Unit,
    load: suspend () -> T,
) {
    var previousKey by remember(state, slot) { mutableStateOf<Any?>(null) }
    LaunchedEffect(state, resourceKey, state.refreshVersion) {
        val owner = state.beginLoad(slot)
        // Refresh keeps the already decoded resource visible. A different payload must not inherit it.
        if (resourceKey != previousKey) {
            update(null)
            previousKey = resourceKey
        }
        try {
            val value = if (resourceKey == null) null else load()
            if (state.ownsLoad(slot, owner)) update(value)
            state.finishLoad(slot, owner, failed = false)
        } catch (failure: CancellationException) { throw failure }
        catch (_: Exception) {
            if (state.ownsLoad(slot, owner)) update(null)
            state.finishLoad(slot, owner, failed = true)
        } finally { state.finishLoad(slot, owner) }
    }
}

/** Locale matching follows the existing contribution protocol, with deterministic fallback. */
fun localizedAppearanceTitle(title: Map<String, String>, locale: String = appearanceLocaleTag()): String {
    val language = locale.substringBefore('-').lowercase()
    return title.entries.firstOrNull { it.key.equals(locale, ignoreCase = true) }?.value
        ?: title.entries.sortedBy { it.key }.firstOrNull { it.key.substringBefore('-').lowercase() == language }?.value
        ?: title["zh-Hans"] ?: title["en"] ?: title.entries.minByOrNull { it.key }?.value.orEmpty()
}

internal expect fun appearanceLocaleTag(): String
internal expect suspend fun platformAppearanceScope(api: RiffetApi): String?
internal expect suspend fun appearanceResourceBytes(api: RiffetApi, scopeKey: String, asset: AppearanceAsset, maxBytes: Long): ByteArray
internal expect suspend fun loadAppearanceFont(api: RiffetApi, scopeKey: String, font: AppearanceFont): FontFamily
internal expect suspend fun loadAppearanceBackground(bytes: ByteArray): ImageBitmap

internal const val APPEARANCE_MAX_EXPANDED_FONT_BYTES = 32 * 1024 * 1024L

/** Bounds final sfnt, transformed stream and Brotli ring before the native decoder runs. */
internal fun validateWoff2(bytes: ByteArray): Long {
    require(bytes.size >= 48)
    fun u32(offset: Int): Long = (0..3).fold(0L) { out, i -> (out shl 8) or (bytes[offset + i].toLong() and 255) }
    fun u16(offset: Int): Int = ((bytes[offset].toInt() and 255) shl 8) or (bytes[offset + 1].toInt() and 255)
    require(u32(0) == 0x774F4632L && u32(8) == bytes.size.toLong())
    require(u32(4) == 0x00010000L || u32(4) == 0x4F54544FL) { "Font collections are not supported" }
    val tables = u16(12)
    val expanded = u32(16)
    require(tables in 1..256 && expanded in 1..APPEARANCE_MAX_EXPANDED_FONT_BYTES && u16(14) == 0)
    var cursor = 48
    fun base128(): Long {
        var result = 0L
        repeat(5) { index ->
            require(cursor < bytes.size)
            val value = bytes[cursor++].toInt() and 255
            require(index != 0 || value != 0x80)
            require(result <= 0x1ffffffL)
            result = (result shl 7) or (value and 127).toLong()
            if (value and 128 == 0) return result
        }
        error("Invalid WOFF2 length")
    }
    var transformedTotal = 0L
    var originalTotal = 0L
    repeat(tables) {
        require(cursor < bytes.size)
        val flags = bytes[cursor++].toInt() and 255
        val tag = flags and 63
        val explicit = if (tag == 63) { require(cursor + 4 <= bytes.size); u32(cursor).also { cursor += 4 } } else 0L
        val glyfOrLoca = tag == 10 || tag == 11 || explicit == 0x676C7966L || explicit == 0x6C6F6361L
        val transformed = if (glyfOrLoca) flags shr 6 != 3 else flags shr 6 != 0
        val original = base128()
        originalTotal += original
        transformedTotal += if (transformed) base128() else original
        require(originalTotal <= APPEARANCE_MAX_EXPANDED_FONT_BYTES && transformedTotal <= APPEARANCE_MAX_EXPANDED_FONT_BYTES)
    }
    require(cursor.toLong() + u32(20) <= bytes.size && u32(20) > 0)
    val header = bytes[cursor].toInt() and 255
    val window = if (header and 1 == 0) 16 else {
        val first = (header shr 1) and 7
        if (first != 0) 17 + first else {
            val second = (header shr 4) and 7
            require(second != 1) { "Large Brotli windows are not supported" }
            if (second == 0) 17 else 8 + second
        }
    }
    require(window in 10..22)
    return expanded
}
