package riffet.ui.theme

import androidx.compose.runtime.Immutable
import riffet.contracts.ThemeDesign
import riffet.contracts.CustomTheme
import riffet.contracts.ThemeLibrary
import riffet.shared.ThemeId
import riffet.theme.RiffetAnsi
import riffet.theme.RiffetColors
import riffet.theme.RiffetThemes
import riffet.theme.riffetAnsi
import riffet.theme.riffetColors

/**
 * One pickable palette: a built-in from the generated table, or one shared through the server's
 * theme library.
 *
 * [revision] names the *contents* rather than the id. Built-ins never change; every custom theme
 * shares the library's revision, so editing one invalidates all of them. Anything that memoises a
 * resolved palette — the terminal's [riffet.ui.terminal.TerminalPalette], a `remember` key — must
 * include it as well as [id].
 */
@Immutable
data class ThemeEntry(
    val id: String,
    val name: String,
    val summary: String,
    val light: RiffetColors,
    val dark: RiffetColors,
    val ansiLight: RiffetAnsi,
    val ansiDark: RiffetAnsi,
    val revision: String,
    val design: ThemeDesign? = null,
)

/** The built-ins, in the picker's order. [ThemeId] supplies the names and order; the colours are
 *  generated. Built-in summaries are Compose resources resolved by the picker, so they stay out of
 *  this non-composable catalog; custom themes keep the description the server sent. */
val builtinThemeEntries: List<ThemeEntry> = ThemeId.entries.mapNotNull { theme ->
    RiffetThemes.firstOrNull { it.id == theme.id }?.let { values ->
        ThemeEntry(
            id = theme.id,
            name = theme.label,
            summary = "",
            light = values.light,
            dark = values.dark,
            ansiLight = values.ansiLight,
            ansiDark = values.ansiDark,
            revision = "builtin",
        )
    }
}

/**
 * The picker's catalogue: built-ins first, then the library's themes in its order. A custom theme
 * that cannot be painted in full is left out rather than shown as a half-valid option — the same
 * rule the server and the other clients apply.
 *
 * A null [library] means "nothing fetched or cached yet", so only the built-ins are known. The
 * caller must not read that as evidence that a stored custom id no longer exists.
 */
fun themeCatalog(library: ThemeLibrary?): List<ThemeEntry> {
    if (library == null) return builtinThemeEntries
    return builtinThemeEntries + library.themes.mapNotNull { it.toEntry(library.revision) }
}

private val CustomThemeId = Regex("^custom-[a-z0-9-]{8,64}$")

private fun CustomTheme.toEntry(revision: String): ThemeEntry? {
    if (!CustomThemeId.matches(id)) return null
    val name = name.trim()
    if (name.isEmpty() || name.length > 60) return null
    return ThemeEntry(
        id = id,
        name = name,
        summary = description?.trim().orEmpty(),
        light = riffetColors(palette.light) ?: return null,
        dark = riffetColors(palette.dark) ?: return null,
        ansiLight = riffetAnsi(ansi.light) ?: return null,
        ansiDark = riffetAnsi(ansi.dark) ?: return null,
        revision = revision,
        design = design,
    )
}
