package riffet.android

import android.Manifest
import android.content.Intent
import android.content.res.Configuration
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.BackEventCompat
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.decodeFromString
import riffet.contracts.Attachment
import riffet.contracts.RiffetJson
import riffet.shared.AppLog
import riffet.shared.AppLanguages
import riffet.shared.NativeFeature
import riffet.shared.NativeFeatures
import riffet.shared.RiffetAndroid
import riffet.shared.registerDownloadDeletion
import riffet.ui.app.RiffetApp
import riffet.ui.icons.LiveBrandMark
import riffet.ui.icons.LiveBrandStyle
import riffet.ui.state.RiffetConnectionState
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.RiffetTheme

/**
 * The Android host. It owns the things the UI cannot: the platform seams' Activity registration
 * (`RiffetAndroid`), the system back gesture, and the notification permission.
 *
 * The UI itself is `riffet.ui.app.RiffetApp`, in `shared/commonMain`. Back handling is here because
 * `PredictiveBackHandler` is `androidx.activity.compose`, a dependency `shared` does not declare;
 * `RiffetNavigation` is hoisted for exactly that reason.
 *
 * ## Server address
 *
 * The paired server's base URL and device token are both persisted by `DeviceTokenStore`, so a
 * relaunch restores the connection with no user action. When there is nothing stored — the normal
 * first-run case — `RiffetApp` shows the pairing screen, which is how a device gets a token. In debug
 * builds the adb extra below remains a device-testing shortcut that overrides the stored server and
 * remembers it:
 *
 * ```
 * adb shell am start -n io.github.riffable.android/riffet.android.RiffetActivity --es riffet.server http://<mac>.local:4337
 * ```
 *
 * This Activity is exported (every launcher icon is an alias of it, and the default alias keeps the
 * old `.MainActivity` name), so any installed app can start it with any extra.
 * Release builds therefore ignore the extra entirely, and even in a debug build the stored token is
 * only sent to the origin that issued it, so the shortcut can skip typing an address but never
 * redirect the token.
 *
 * ## Scope lifetime
 *
 * Nothing long-lived is created here. The connection, the store and the navigation belong to
 * [RiffetHost] at process scope, so a recreated Activity reattaches to the same open stream.
 */
class RiffetActivity : RiffetLocalizedActivity() {

    /** Set by the onboarding's notification page; called once the system answered. */
    private var notificationAnswered: (() -> Unit)? = null
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationAnswered?.invoke()
        notificationAnswered = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Locale changes update this existing Compose tree. Navigation, drafts and in-flight
        // work keep their owners; configuration callbacks also update background text.
        registerDownloadDeletion(this)
        // Keep both gesture and three-button navigation transparent, without the system's contrast
        // scrim. RiffetSystemBars owns icon contrast; the app draws the background under the bars.
        WindowCompat.enableEdgeToEdge(window)
        RiffetHost.start(if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_SERVER_URL) else null)
        // Debug builds only: proves the crash record end to end (`--ez riffet.debug.crash true`).
        if (BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_DEBUG_CRASH, false)) {
            intent.removeExtra(EXTRA_DEBUG_CRASH)
            window.decorView.post { throw IllegalStateException("debug crash requested") }
        }
        // A recreated Activity gets its launch intent again; only a fresh launch is a request.
        if (savedInstanceState == null) openRequested(intent)
        setContent {
            RiffetAdaptiveWindow(this) {
                val store by RiffetHost.store.collectAsState()
                val restoring by RiffetHost.restoring.collectAsState()
                val navigation = RiffetHost.navigation

                // The keep-alive notification is the first thing this app posts, so ask when it starts.
                val keepAlive by remember(store) {
                    store?.connection?.map { it != RiffetConnectionState.Idle } ?: flowOf(false)
                }.collectAsState(false)
                LaunchedEffect(keepAlive) { if (keepAlive) requestNotificationsOnce() }

                // The deepest visible page owns back. Open sheets/drawers take precedence; title-bar,
                // app swipe and system back all use the same target and unsaved/in-flight guard.
                PredictiveBackHandler(enabled = navigation.canGoBack) { swipes ->
                    navigation.beginBackGesture()
                    try {
                        swipes.collect { event ->
                            if (NativeFeatures.shared.isOn(NativeFeature.PREDICTIVE_BACK)) {
                                navigation.updateBackGesture(event.progress, event.swipeEdge == BackEventCompat.EDGE_LEFT)
                            }
                        }
                        navigation.finishBackGesture()
                    } finally {
                        navigation.cancelBackGesture()
                    }
                }

                RiffetTheme {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        if (restoring) {
                            // A restore is usually over within a few frames: a spinner shown at once only
                            // flashes. It fades in if the restore is still going after a moment.
                            var slow by remember { mutableStateOf(false) }
                            LaunchedEffect(Unit) { delay(SLOW_RESTORE_MILLIS); slow = true }
                            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                AnimatedVisibility(visible = slow, enter = fadeIn()) {
                                    val colors = LocalRiffetColors.current
                                    LiveBrandMark(fg = colors.fg, accent = colors.accent, style = LiveBrandStyle.Run, modifier = Modifier.size(48.dp))
                                }
                            }
                        } else {
                            RiffetApp(
                                store = store,
                                connection = RiffetHost.connection,
                                // A successful pairing lands exactly where a successful restore does:
                                // a fresh SessionStore over the newly issued device token.
                                onPaired = RiffetHost::install,
                                onDisconnected = RiffetHost::uninstall,
                                navigation = navigation,
                                writeScope = RiffetHost.writeScope,
                                drafts = RiffetHost.drafts,
                                marks = RiffetHost.marks,
                                hasSavedPairing = RiffetHost.hasSavedPairing,
                                deviceAppearance = RiffetDevice.appearance,
                                requestNotifications = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) { answered ->
                                    notificationsAsked = true
                                    notificationAnswered = answered
                                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                                } else null,
                            )
                        }
                    }
                }
            }
        }
    }

    /** A notification tapped while the app is already running. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openRequested(intent)
    }

    private fun openRequested(intent: Intent) {
        deepLink(intent)
        if (intent.hasExtra(EXTRA_QUICK_CHAT)) {
            val text = intent.getStringExtra(EXTRA_QUICK_CHAT_TEXT)
            val mode = intent.getStringExtra(EXTRA_QUICK_CHAT_MODE)
            val attachments = intent.getStringExtra(EXTRA_QUICK_CHAT_ATTACHMENTS)?.let { encoded ->
                runCatching { RiffetJson.instance.decodeFromString(ListSerializer(Attachment.serializer()), encoded) }.getOrNull()
            }.orEmpty()
            // Files the entry could not upload before it knew the project: this Activity owns the
            // connection, so it uploads them once the store and project are available.
            val streams = intent.getStringArrayListExtra(EXTRA_QUICK_CHAT_STREAMS).orEmpty()
                .filter { it.isNotBlank() }
                .map(Uri::parse)
            intent.removeExtra(EXTRA_QUICK_CHAT)
            intent.removeExtra(EXTRA_QUICK_CHAT_TEXT)
            intent.removeExtra(EXTRA_QUICK_CHAT_MODE)
            intent.removeExtra(EXTRA_QUICK_CHAT_ATTACHMENTS)
            intent.removeExtra(EXTRA_QUICK_CHAT_STREAMS)
            // Wait for the store like a notification press does: installing it resets navigation,
            // so the request has to be made after that, not before.
            RiffetHost.launch {
                val store = RiffetHost.awaitStore()
                if (store == null) {
                    if (streams.isNotEmpty()) attachmentsNotSent()
                    return@launch
                }
                val uploaded = if (streams.isNotEmpty()) {
                    val project = store.awaitQuickChatProject(timeoutMillis = 3_000L)
                    if (project == null) emptyList() else try {
                        uploadSharedFiles(applicationContext, store, project, streams)
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (_: Throwable) {
                        emptyList()
                    }
                } else {
                    emptyList()
                }
                if (streams.isNotEmpty() && uploaded.isEmpty()) attachmentsNotSent()
                RiffetHost.navigation.requestQuickChat(text, mode, attachments + uploaded)
            }
        }
        val sessionId = intent.getStringExtra(EXTRA_SESSION) ?: return
        intent.removeExtra(EXTRA_SESSION)
        val origin = intent.getStringExtra(RiffetNotificationReceiver.EXTRA_ORIGIN)
        RiffetHost.launch {
            val installed = RiffetHost.awaitStore()
            if (origin == null || origin != RiffetHost.currentOrigin || installed == null || !RiffetHost.isCurrentStore(installed)) {
                Toast.makeText(applicationContext, AppLanguages.localize(this@RiffetActivity).getString(riffet.shared.R.string.host_notification_other_server), Toast.LENGTH_SHORT).show()
                return@launch
            }
            RiffetHost.navigation.request(sessionId)
            RiffetHost.notifier.cancel(sessionId, origin)
        }
    }

    private fun attachmentsNotSent() {
        Toast.makeText(applicationContext, AppLanguages.localize(this).getString(riffet.shared.R.string.host_quick_chat_attachments_not_sent), Toast.LENGTH_SHORT).show()
    }

    /**
     * The iPhone's URL scheme, routed through the entries a notification press and the quick chat
     * use: `riffet://session?id=<id>` (or `riffet://session/<id>`) opens that conversation on the
     * paired server, `riffet://new?prompt=<text>` opens the quick chat home with the text in the
     * composer, unsent. Notification intents carry `riffet://notification/…` only to stay distinct
     * and have no VIEW action, so they never reach this.
     */
    private fun deepLink(intent: Intent) {
        if (intent.action != Intent.ACTION_VIEW) return
        val uri = intent.data?.takeIf { it.scheme == DEEP_LINK_SCHEME } ?: return
        // Handled once: a recreated Activity or a later onNewIntent must not replay it.
        intent.action = null
        intent.data = null
        AppLog.log("app", "deep link ${uri.host}")
        when (uri.host) {
            "session" -> {
                val id = uri.getQueryParameter("id")?.takeIf { it.isNotBlank() } ?: uri.pathSegments.firstOrNull() ?: return
                RiffetHost.launch {
                    if (RiffetHost.awaitStore() != null) RiffetHost.navigation.request(id)
                }
            }
            "new" -> {
                val prompt = uri.getQueryParameter("prompt")?.takeIf { it.isNotBlank() }
                RiffetHost.launch {
                    if (RiffetHost.awaitStore() != null) RiffetHost.navigation.requestQuickChat(prompt, null)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        RiffetAndroid.attachActivity(this)
        RiffetDevice.capabilitiesChanged()
        RiffetHost.onForeground()
    }

    override fun onStop() {
        RiffetAndroid.attachActivity(null)
        RiffetDevice.capabilitiesChanged()
        RiffetHost.onBackground()
        super.onStop()
    }

    private fun requestNotificationsOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || notificationsAsked) return
        notificationsAsked = true
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        /** Optional `--es riffet.server <baseUrl>` override, debug builds only; see the class comment. */
        const val EXTRA_SERVER_URL: String = "riffet.server"

        /** The conversation a notification opens. */
        const val EXTRA_SESSION: String = "riffet.open.session"

        /** A system entry asking for the quick chat home; the marker is present even with no text. */
        const val EXTRA_QUICK_CHAT: String = "riffet.quick-chat"

        /** The text selection or shared text to prefill the quick chat composer with. */
        const val EXTRA_QUICK_CHAT_TEXT: String = "riffet.quick-chat.text"

        /** The chat mode to preselect, e.g. `preset:translate`. */
        const val EXTRA_QUICK_CHAT_MODE: String = "riffet.quick-chat.mode"

        /** JSON of the already-uploaded attachments, e.g. an image shared into the quick chat. */
        const val EXTRA_QUICK_CHAT_ATTACHMENTS: String = "riffet.quick-chat.attachments"

        /** Shared files (URI strings) the entry could not upload before it knew the quick chat project. */
        const val EXTRA_QUICK_CHAT_STREAMS: String = "riffet.quick-chat.streams"

        /** Debug builds: crash on launch, to check the crash record in the exported log. */
        private const val EXTRA_DEBUG_CRASH: String = "riffet.debug.crash"

        /** How long a restore may take before its spinner shows. */
        private const val SLOW_RESTORE_MILLIS = 400L

        private const val DEEP_LINK_SCHEME = "riffet"

        /** Once per process: a refusal is respected until the next launch. */
        private var notificationsAsked = false
    }
}

/** Locale updates keep entry sheets and their in-flight uploads alive. */
abstract class RiffetLocalizedActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguages.refresh(this)
    }

    override fun onStart() {
        super.onStart()
        AppLanguages.refresh(this)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        AppLanguages.refresh(this)
    }
}
