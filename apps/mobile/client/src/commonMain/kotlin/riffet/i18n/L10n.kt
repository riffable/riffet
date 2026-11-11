package riffet.i18n

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The language the shared layer words its text in: `zh-Hans` (the default) or `en`.
 *
 * Apple targets read it from the app bundle's preferred localization, so the macOS and iOS apps
 * follow their own language setting with no Swift wiring; Android keeps the process locale in
 * sync with its app-language preference (or the system when no preference is set).
 *
 * The getter asks the platform every time, so a language change is picked up by the next string
 * lookup instead of staying frozen at process start. [locale]'s setter only pins an override, which
 * is what tests use; production code never sets it.
 */
object L10n {
    private var pinnedLocale: String? = null
    private val localeChanges = MutableStateFlow(platformLocale())
    /** Invalidates derived presentation text without restarting a store or an in-flight action. */
    val changes: StateFlow<String> = localeChanges.asStateFlow()

    fun refreshLocale() {
        localeChanges.value = locale
    }

    var locale: String
        get() = pinnedLocale ?: platformLocale()
        set(value) {
            pinnedLocale = value
            // `core` carries its own catalog (it cannot depend on this module); keep it in step.
            // Its setter only records its own override, so this cannot recurse.
            riffet.core.UiText.locale = value
            refreshLocale()
        }

    /**
     * The display text [key] names in [UiText], with `{0}`, `{1}`, … filled from [args].
     *
     * A missing key returns the key itself, so a typo is visible in the interface instead of
     * silently falling back to another language.
     */
    fun uiText(key: String, vararg args: Any?): String {
        val pattern = (if (locale == "en") UiText.en else UiText.zhHans)[key] ?: return key
        if (args.isEmpty()) return pattern
        // Replacing through the pattern only keeps an argument that itself contains `{1}` intact.
        return UI_PLACEHOLDER.replace(pattern) { match ->
            args.getOrNull(match.groupValues[1].toInt())?.toString().orEmpty()
        }
    }

    /**
     * The text the server's error [code] names (`i18n/errors`, generated into [ErrorText]), filled
     * from [params]; null for a code without one. `{message}` in a text is [message].
     */
    fun errorText(code: String, params: Map<String, String> = emptyMap(), message: String = ""): String? {
        val pattern = (if (locale == "en") ErrorText.en else ErrorText.zhHans)[code] ?: return null
        return IcuMessage(pattern, params + ("message" to message), locale).render()
    }

    /**
     * What to show for a server error: the text [code] names, else [message] as the server sent it.
     * A message the server still words in Chinese predates the catalogs and is shown as it is, until
     * its domain moves to codes; the [params] it quotes do not count.
     */
    fun serverError(code: String?, params: Map<String, String>, message: String): String {
        val own = params.values.filter { it.isNotEmpty() }.fold(message) { text, value -> text.replace(value, "") }
        if (own.any { it in '㐀'..'䶿' || it in '一'..'鿿' || it in '豈'..'﫿' }) return message
        return code?.let { errorText(it, params, message) } ?: message
    }
}

/** `zh-Hans` or `en`, from the platform's current language setting; read on every access. */
internal expect fun platformLocale(): String

/** `{0}`, `{1}`, … in a UI text pattern. */
private val UI_PLACEHOLDER = Regex("""\{(\d+)\}""")

/**
 * The ICU subset `scripts/gen-i18n.ts` admits: `{name}`, `{name, select, …}` and
 * `{name, plural, …}` with `=N`, `one`, `other` and `#`. Apostrophes are plain text.
 */
private class IcuMessage(private val text: String, private val params: Map<String, String>, private val locale: String) {
    private var at = 0

    fun render(): String = StringBuilder().also { message(it, null) }.toString()

    /** Reads up to the `}` that closes the current branch; appends to [out] unless only skipping. */
    private fun message(out: StringBuilder?, number: String?) {
        while (at < text.length) {
            val char = text[at]
            when {
                char == '}' -> return
                char == '{' -> argument(out, number)
                else -> {
                    if (char == '#' && number != null) out?.append(number) else out?.append(char)
                    at++
                }
            }
        }
    }

    /** `{name}`, or `{name, kind, key {…} …}`; [at] is on the opening brace. */
    private fun argument(out: StringBuilder?, number: String?) {
        at++
        val name = word()
        if (text[at] == '}') {
            at++
            out?.append(params[name].orEmpty())
            return
        }
        at++ // ,
        val kind = word()
        at++ // ,
        val value = params[name].orEmpty()
        // Each branch's key and where its text starts; the one to show is known once all are read.
        val branches = mutableListOf<Pair<String, Int>>()
        while (true) {
            skipSpaces()
            if (text[at] == '}') break
            val key = word()
            at++ // {
            branches += key to at
            message(null, null)
            at++ // }
        }
        at++ // }
        if (out == null) return
        val category = if (locale == "en" && value.toDoubleOrNull() == 1.0) "one" else "other"
        val chosen = if (kind == "plural") {
            branches.find { it.first == "=$value" } ?: branches.find { it.first == category }
        } else {
            branches.find { it.first == value }
        } ?: branches.find { it.first == "other" } ?: return
        val resume = at
        at = chosen.second
        message(out, if (kind == "plural") value else number)
        at = resume
    }

    /** A name, keyword or branch key, with the spaces around it. */
    private fun word(): String {
        skipSpaces()
        val start = at
        while (at < text.length && (text[at].isLetterOrDigit() || text[at] == '_' || text[at] == '=')) at++
        val word = text.substring(start, at)
        skipSpaces()
        return word
    }

    private fun skipSpaces() {
        while (at < text.length && text[at].isWhitespace()) at++
    }
}
