package riffet.android

import android.Manifest
import android.content.Intent
import android.content.res.Configuration
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
import kotlinx.coroutines.delay
import kotlinx.serialization.decodeFromString
import riffet.shared.AppLog
import riffet.shared.AppLanguages
import riffet.shared.NativeFeature
import riffet.shared.NativeFeatures
import riffet.shared.RiffetAndroid
import riffet.shared.registerDownloadDeletion
import riffet.ui.app.RiffetApp
import riffet.ui.icons.LiveBrandMark
import riffet.ui.icons.LiveBrandStyle
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

    /**
     * The iPhone's URL scheme, routed through the entry a notification press uses:
     * `riffet://session?id=<id>` (or `riffet://session/<id>`) opens that conversation on the paired
     * server, `riffet://new?prompt=<text>` opens 新建任务 with the text in the composer, unsent. Notification intents carry `riffet://notification/…` only to stay distinct
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
                    if (RiffetHost.awaitStore() != null) RiffetHost.navigation.requestStart(prompt)
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

    companion object {
        /** Optional `--es riffet.server <baseUrl>` override, debug builds only; see the class comment. */
        const val EXTRA_SERVER_URL: String = "riffet.server"

        /** The conversation a notification opens. */
        const val EXTRA_SESSION: String = "riffet.open.session"

        /** Debug builds: crash on launch, to check the crash record in the exported log. */
        private const val EXTRA_DEBUG_CRASH: String = "riffet.debug.crash"

        /** How long a restore may take before its spinner shows. */
        private const val SLOW_RESTORE_MILLIS = 400L

        private const val DEEP_LINK_SCHEME = "riffet"
    }
}

/** Applies the in-app language on create, start and configuration changes. */
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
