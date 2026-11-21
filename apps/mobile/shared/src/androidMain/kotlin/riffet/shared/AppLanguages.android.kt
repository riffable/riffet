package riffet.shared

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import android.os.LocaleList
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

actual val appLanguageSupported: Boolean = true

/** AppCompat owns Activity configuration; non-Activity contexts use the same in-memory choice. */
actual object AppLanguages {
    private const val KEY = "app.language"
    private var selection by mutableStateOf(AppLanguage.SYSTEM)
    private val mutableChanges = MutableStateFlow("")
    val changes: StateFlow<String> = mutableChanges.asStateFlow()

    actual val current: AppLanguage
        @Composable get() {
            // Also observe changes made from Android's app-language settings.
            LocalConfiguration.current
            return selection
        }

    fun initialize(context: Context) {
        val preferences = createAppPreferences()
        val stored = preferences.string(KEY)
        if (Build.VERSION.SDK_INT >= 33) {
            // One-time handoff after an OS upgrade. Subsequent system-settings choices are authoritative.
            if (stored != null) {
                val manager = context.getSystemService(LocaleManager::class.java)
                if (manager.applicationLocales.isEmpty) manager.applicationLocales = LocaleList.forLanguageTags(stored)
                preferences.setString(KEY, null)
            }
        } else {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(stored.orEmpty()))
        }
        refresh(context)
    }

    actual fun change(language: AppLanguage) {
        val context = RiffetAndroid.requireContext()
        if (language == selected(context)) return
        if (Build.VERSION.SDK_INT < 33) createAppPreferences().setString(KEY, language.tag)
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(language.tag))
        refresh(context)
    }

    /** Called after both application and Activity configuration callbacks, without restarting work. */
    fun refresh(context: Context) {
        selection = selected(context)
        val locales = effectiveLocales(context)
        effective = locales
        localized = null
        // Compose, client L10n, core UiText and formatters must agree, including in background starts.
        LocaleList.setDefault(locales)
        riffet.i18n.L10n.refreshLocale()
        mutableChanges.value = locales.toLanguageTags()
    }

    /**
     * The locales [refresh] last resolved, and the context last localized for them. Every string a
     * host component reads goes through [localize]; resolving the locales costs two binder calls
     * and a new configuration context, which composition paid on every pass.
     */
    @Volatile private var effective: LocaleList? = null
    @Volatile private var localized: Pair<Context, Context>? = null

    fun localize(context: Context): Context {
        val locales = effective ?: effectiveLocales(context).also { effective = it }
        if (context.resources.configuration.locales == locales) return context
        localized?.let { (base, made) -> if (base === context && made.resources.configuration.locales == locales) return made }
        val made = context.createConfigurationContext(Configuration(context.resources.configuration).apply { setLocales(locales) })
        // Only the application context is kept: holding an Activity or Service here would leak it.
        if (context === context.applicationContext) localized = context to made
        return made
    }

    private fun selected(context: Context): AppLanguage {
        val language = appLocales(context)[0]?.language
        return when (language) {
            "zh" -> AppLanguage.CHINESE
            "en" -> AppLanguage.ENGLISH
            else -> AppLanguage.SYSTEM
        }
    }

    private fun appLocales(context: Context): LocaleListCompat =
        if (Build.VERSION.SDK_INT >= 33) {
            LocaleListCompat.wrap(context.getSystemService(LocaleManager::class.java).applicationLocales)
        } else AppCompatDelegate.getApplicationLocales()

    private fun effectiveLocales(context: Context): LocaleList {
        val app = appLocales(context)
        val requested = if (!app.isEmpty) LocaleList.forLanguageTags(app.toLanguageTags())
        else if (Build.VERSION.SDK_INT >= 33) context.getSystemService(LocaleManager::class.java).systemLocales
        else Resources.getSystem().configuration.locales
        return supportedLocales(requested)
    }
}

private fun supportedLocales(locales: LocaleList): LocaleList {
    val supported = (0 until locales.size()).asSequence().map { locales[it] }
        .firstOrNull { it.language == "zh" || it.language == "en" } ?: Locale.SIMPLIFIED_CHINESE
    return LocaleList(supported)
}

@Composable
internal actual fun AppLanguageEnvironment(content: @Composable () -> Unit) {
    val configuration = LocalConfiguration.current
    val context = LocalContext.current
    // Compose resources use the primary locale; Android resources try the whole language list.
    // Select the same supported locale for both, including systems such as [fr, en].
    val resolved = remember(configuration) {
        Configuration(configuration).apply { setLocales(supportedLocales(configuration.locales)) }
    }
    // Native Compose strings read LocalResources, while multiplatform strings read configuration.
    // Keep LocalContext itself intact: camera and window code must still find its Activity.
    val resources = remember(context, resolved) { context.createConfigurationContext(resolved).resources }
    CompositionLocalProvider(
        LocalConfiguration provides resolved,
        LocalResources provides resources,
        LocalLayoutDirection provides LayoutDirection.Ltr,
        content = content,
    )
}
