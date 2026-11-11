package riffet.android

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import riffet.contracts.Attachment
import riffet.contracts.Project
import riffet.contracts.RiffetJson
import riffet.shared.DisplaySettings
import riffet.shared.AppLanguages
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeatures
import riffet.shared.PreferenceKeys
import riffet.shared.ThemeId
import riffet.shared.ThemeMode
import riffet.shared.RiffetApi
import riffet.shared.createAppPreferences
import riffet.shared.settings
import riffet.ui.composer.MAX_ATTACHMENTS_PER_MESSAGE
import riffet.ui.composer.readPickedAttachment
import riffet.ui.quickchat.QuickChatSheet
import riffet.ui.state.SessionStore
import riffet.ui.theme.RiffetTheme
import riffet.ui.theme.themeCatalog

/**
 * The one entry for every system surface that starts a quick chat: the text-selection menu
 * (`ACTION_PROCESS_TEXT`), the share sheet (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`, text and any
 * files), the launcher shortcut and the Quick Settings tile (both [ACTION_QUICK_CHAT]).
 *
 * The server's `quickChat.openMode` decides what happens next. `page` hands the text to
 * [RiffetActivity], which opens the quick chat home with it prefilled. `sheet` draws a bottom sheet
 * over whatever app the reader was in; the sheet's send creates the conversation and streams it
 * there, and expanding it moves the same conversation into [RiffetActivity]. With no paired server
 * there is no sheet to draw, so the full app opens instead.
 */
class QuickChatActivity : RiffetLocalizedActivity() {

    /** The resolve in flight; a second entry replaces it so an older answer cannot take over. */
    private var resolveJob: Job? = null
    private var resolveGeneration = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.enableEdgeToEdge(window)
        val entry = entryOf(intent)
        if (entry == null) {
            finish()
            return
        }
        startResolve(entry)
    }

    /** A second tile, shortcut or share while the overlay exists reuses it with the new input. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val entry = entryOf(intent) ?: return
        startResolve(entry)
    }

    override fun onDestroy() {
        resolveJob?.cancel()
        resolveJob = null
        super.onDestroy()
    }

    private fun startResolve(entry: Entry) {
        val preferences = createAppPreferences()
        val appearance = Appearance(preferences.themeMode(), ThemeId.stored(preferences.string(PreferenceKeys.THEME_ID)))
        resolveJob?.cancel()
        val generation = ++resolveGeneration
        setContent { Loading(appearance) }
        resolveJob = RiffetHost.launch { resolve(entry, appearance, generation) }
    }

    private fun isCurrent(generation: Int): Boolean =
        generation == resolveGeneration && !isFinishing && !isDestroyed

    private suspend fun resolve(entry: Entry, appearance: Appearance, generation: Int) {
        val store = RiffetHost.awaitStore()
        if (!isCurrent(generation)) return
        val api = RiffetHost.connection.apiOrNull()
        if (store == null || api == null) {
            fallback(entry, emptyList(), generation)
            return
        }
        val project = store.awaitQuickChatProject()
        if (!isCurrent(generation)) return
        // Read the files before the settings call: a settings failure must not drop the attachments.
        val attachments = if (project != null) uploadEntryFiles(store, project, entry, generation) else emptyList()
        if (!isCurrent(generation)) return
        val settings = try {
            api.settings()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            null
        }
        if (!isCurrent(generation)) return
        if (settings == null || project == null) {
            fallback(entry, attachments, generation)
            return
        }
        if (settings.quickChat?.openMode == "page") {
            fallback(entry, attachments, generation)
            return
        }
        showSheet(api, store, project, entry, attachments, appearance, generation)
    }

    /** Files shared into the entry become ordinary project attachments before it is shown. */
    private suspend fun uploadEntryFiles(
        store: SessionStore,
        project: Project,
        entry: Entry,
        generation: Int,
    ): List<Attachment> {
        if (entry.streams.isEmpty()) return emptyList()
        return try {
            uploadSharedFiles(this@QuickChatActivity, store, project, entry.streams)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            if (isCurrent(generation)) {
                val message = (failure as? IllegalArgumentException)?.message ?: AppLanguages.localize(this@QuickChatActivity).getString(riffet.shared.R.string.host_attachment_read_failed)
                Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
            }
            emptyList()
        }
    }

    private fun fallback(entry: Entry, attachments: List<Attachment>, generation: Int) {
        if (!isCurrent(generation)) return
        openApp(entry, attachments)
        finish()
    }

    private fun showSheet(
        api: RiffetApi,
        store: SessionStore,
        project: Project,
        entry: Entry,
        attachments: List<Attachment>,
        appearance: Appearance,
        generation: Int,
    ) {
        if (!isCurrent(generation)) return
        setContent {
            RiffetAdaptiveWindow(this@QuickChatActivity) {
            QuickChatTheme(appearance, api) {
                CompositionLocalProvider(LocalNativeFeatures provides NativeFeatures.shared) {
                    QuickChatSheet(
                        api = api,
                        store = store,
                        project = project,
                        initialText = entry.text.orEmpty(),
                        initialMode = entry.mode,
                        initialAttachments = attachments,
                        onDismiss = { finish() },
                        onExpand = { sessionId, draftText, draftAttachments ->
                            if (sessionId != null) {
                                openSession(sessionId)
                            } else {
                                // Carry what the sheet already holds, not only the entry's text. Shared
                                // files that failed to upload are retried unless the sheet has its own.
                                val retry = entry.streams.takeIf { attachments.isEmpty() && draftAttachments.isEmpty() }.orEmpty()
                                openApp(entry.copy(text = draftText, streams = retry), draftAttachments)
                            }
                            finish()
                        },
                        writeScope = RiffetHost.writeScope,
                    )
                }
            }
            }
        }
    }

    private fun openSession(sessionId: String) {
        val intent = appIntent()
        intent.putExtra(RiffetActivity.EXTRA_SESSION, sessionId)
        RiffetHost.currentOrigin?.let { intent.putExtra(RiffetNotificationReceiver.EXTRA_ORIGIN, it) }
        startActivity(intent)
    }

    private fun openApp(entry: Entry, attachments: List<Attachment>) {
        val intent = appIntent()
        intent.putExtra(RiffetActivity.EXTRA_QUICK_CHAT, true)
        entry.text?.let { intent.putExtra(RiffetActivity.EXTRA_QUICK_CHAT_TEXT, it) }
        entry.mode?.let { intent.putExtra(RiffetActivity.EXTRA_QUICK_CHAT_MODE, it) }
        if (attachments.isNotEmpty()) {
            intent.putExtra(
                RiffetActivity.EXTRA_QUICK_CHAT_ATTACHMENTS,
                RiffetJson.instance.encodeToString(ListSerializer(Attachment.serializer()), attachments),
            )
        } else if (entry.streams.isNotEmpty()) {
            // The project was not known yet, so the full app uploads them once the connection is ready.
            intent.putStringArrayListExtra(RiffetActivity.EXTRA_QUICK_CHAT_STREAMS, ArrayList(entry.streams.map(Uri::toString)))
            // Grants follow ClipData across the Activity boundary, not the extra's strings alone.
            val clip = ClipData.newRawUri(SHARED_FILES_LABEL, entry.streams.first())
            entry.streams.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
            intent.clipData = clip
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(intent)
    }

    private fun appIntent(): Intent =
        Intent(this, RiffetActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    companion object {
        /** The launcher shortcut and Quick Settings tile; they carry no text. */
        const val ACTION_QUICK_CHAT: String = "riffet.android.action.QUICK_CHAT"

        /** Selecting text is most often "translate this"; fall back to 对话 when it is absent. */
        private const val TRANSLATE_MODE = "preset:translate"

        /** ClipData label for the shared files whose URI grants must survive this Activity. */
        private const val SHARED_FILES_LABEL = "shared-files"

        private fun entryOf(intent: Intent): Entry? = when (intent.action) {
            Intent.ACTION_PROCESS_TEXT -> {
                val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                Entry(text, if (text != null) TRANSLATE_MODE else null)
            }
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
                val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                Entry(text, null, streams(intent))
            }
            ACTION_QUICK_CHAT -> Entry(null, null)
            else -> null
        }

        /** One `EXTRA_STREAM` for SEND, a list for SEND_MULTIPLE; any type, as the composer's picker takes. */
        private fun streams(intent: Intent): List<Uri> {
            val uris: List<Uri?> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                }.orEmpty()
            } else {
                listOf(
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(Intent.EXTRA_STREAM)
                    },
                )
            }
            return uris.filterNotNull().distinct()
        }
    }
}

/** What the system handed us: the text, the preset a selection implies, and shared files. */
private data class Entry(val text: String?, val mode: String?, val streams: List<Uri> = emptyList())

/**
 * Reads and uploads shared files into [project], under the composer picker's rules: at most
 * [MAX_ATTACHMENTS_PER_MESSAGE], each within its byte limit, and one unreadable file refuses the
 * batch. Exceptions reach the caller, which reports them and keeps the text entry usable; an
 * [IllegalArgumentException] carries a message fit to show.
 */
internal suspend fun uploadSharedFiles(
    context: Context,
    store: SessionStore,
    project: Project,
    uris: List<Uri>,
): List<Attachment> {
    require(uris.size <= MAX_ATTACHMENTS_PER_MESSAGE) {
        AppLanguages.localize(context).getString(riffet.shared.R.string.host_attachment_batch_limit, MAX_ATTACHMENTS_PER_MESSAGE)
    }
    val picked = withContext(Dispatchers.IO) { uris.map { readPickedAttachment(context, it) } }
    return picked.map { store.uploadAttachment(it, project.id) }
}

/** The theme preferences, read once so the loading frame and the sheet agree. */
private data class Appearance(val mode: ThemeMode, val themeId: String)

@Composable
private fun QuickChatTheme(appearance: Appearance, api: RiffetApi? = null, content: @Composable () -> Unit) {
    val dark = when (appearance.mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val themes = themeCatalog(null)
    val entry = themes.firstOrNull { it.id == appearance.themeId } ?: themes.first()
    val resources = riffet.ui.theme.rememberAppearanceResources(api)
    // The sheet is part of the app, so it follows the reader's text size and transcript spacing.
    val display = DisplaySettings.shared
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalDensity provides Density(density.density, density.fontScale * display.textSize.scale),
        riffet.ui.theme.LocalAppearanceResources provides resources,
    ) {
        RiffetTheme(
            darkTheme = dark, entry = resources?.palette ?: entry, interfaceStyle = display.interfaceStyle, amoled = display.amoled,
            uiFont = resources?.uiFont, monoFont = resources?.monoFont,
            surfaceMaterial = display.surfaceMaterial, materialStrength = display.materialStrength, content = content,
        )
    }
}

/** The translucent frame between the entry activity and the answer; never a blank window. */
@Composable
private fun Loading(appearance: Appearance) {
    QuickChatTheme(appearance) {
        Box(
            modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.32f)),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator()
        }
    }
}
