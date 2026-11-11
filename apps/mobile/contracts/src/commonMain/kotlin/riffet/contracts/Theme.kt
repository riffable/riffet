package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * The shared custom-theme library, ported from `packages/contracts/src/theme.ts`.
 *
 * The split matters: *which* themes exist is shared state, while *which one a device shows* stays a
 * local preference. This file only describes the shared half.
 *
 * A theme is self-contained — 53 roles per mode plus sixteen ANSI slots — so every client can paint
 * it without a fallback table. Colours are `#rrggbb` or `#rrggbbaa`; the server validates both the
 * key set and the format, so a client may parse them directly.
 */

/** One theme's two halves, keyed by role name without the `--` prefix. */
@Serializable
data class ThemePalette(
    val light: Map<String, String>,
    val dark: Map<String, String>,
)

/** The sixteen terminal slots per mode, in SGR 30–37 / 90–97 order. */
@Serializable
data class ThemeAnsi(
    val light: List<String>,
    val dark: List<String>,
)

@Serializable
data class CustomTheme(
    /** `custom-` followed by 8–64 lowercase letters, digits or dashes. */
    val id: String,
    val name: String,
    val description: String? = null,
    val palette: ThemePalette,
    val ansi: ThemeAnsi,
    val design: ThemeDesign? = null,
    /** The editor canvas the palette was drawn from; clients paint [palette] and never derive from it. */
    val seed: ThemeSeed? = null,
)

/** One canvas point: [hue] is the OKLCH hue in degrees, [radius] runs from grey (0) to full colour (1). */
@Serializable
data class ThemeSeedPoint(
    val hue: Double,
    val radius: Double,
)

/** The surface point, then the optional accent and sidebar points, and how far both modes soften. */
@Serializable
data class ThemeSeed(
    val points: List<ThemeSeedPoint>,
    val softness: Double,
)

/** `GET /api/themes`. [revision] is a content hash, not a counter. */
@Serializable
data class ThemeLibrary(
    val version: Int,
    val revision: String,
    val themes: List<CustomTheme> = emptyList(),
)

/**
 * `PUT /api/themes` replaces the whole library. [expectedRevision] is the revision the editor last
 * read; the server answers 409 when it has moved on, unless the submitted content is identical.
 */
@Serializable
data class ThemeLibraryUpdate(
    val expectedRevision: String,
    val themes: List<CustomTheme> = emptyList(),
)
