package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * The appearance catalog, ported from `packages/contracts/src/appearance.ts`.
 *
 * Plugins contribute palettes, fonts, backgrounds and presets; `GET /api/appearance` lists what the
 * *enabled* ones provide, with each file resolved to a content-addressed asset. The built-in themes
 * and `/api/themes` are separate and unchanged. Which items a device shows stays a local
 * preference, so the selection is not part of this file.
 */

/** A file the server vouches for. [url] is `/api/appearance/assets/<pluginId>/<sha256>`: the bytes at it never change. */
@Serializable
data class AppearanceAsset(
    val url: String,
    val sha256: String,
    val size: Long,
    val type: String,
)

/** A palette's asset is a JSON [CustomTheme]; its own id and name are ignored, the contribution id identifies it. */
@Serializable
data class AppearancePalette(
    val id: String,
    val plugin: String,
    /** Display text by BCP-47 tag. */
    val title: Map<String, String>,
    val asset: AppearanceAsset,
)

@Serializable
data class AppearanceFontFile(
    val url: String,
    val sha256: String,
    val size: Long,
    val type: String,
    /** A CSS weight or range such as `400` or `100 900`. */
    val weight: String? = null,
    /** `normal` or `italic`. */
    val style: String? = null,
    val unicodeRange: String? = null,
)

@Serializable
data class AppearanceFont(
    val id: String,
    val plugin: String,
    val title: Map<String, String>,
    /** `ui` or `mono`. */
    val role: String,
    /** The family name the font files carry. */
    val family: String,
    val fallback: List<String> = emptyList(),
    val files: List<AppearanceFontFile> = emptyList(),
)

@Serializable
data class AppearanceBackground(
    val id: String,
    val plugin: String,
    val title: Map<String, String>,
    val asset: AppearanceAsset,
    val areas: List<String> = emptyList(),
    /** 0 to 1. */
    val opacity: Double = 1.0,
    /** `cover` or `tile`. */
    val fit: String = "cover",
)

@Serializable
data class AppearancePresetFonts(val ui: String? = null, val mono: String? = null)

/** References are contribution ids, possibly of other plugins; one that is missing is skipped at display time. */
@Serializable
data class AppearancePreset(
    val id: String,
    val plugin: String,
    val title: Map<String, String>,
    val palette: String? = null,
    val fonts: AppearancePresetFonts? = null,
    val background: String? = null,
)

/** `GET /api/appearance`. [revision] is a content hash of everything else. */
@Serializable
data class AppearanceCatalog(
    val version: Int,
    val revision: String,
    val iconPacks: List<AppearancePalette> = emptyList(),
    val palettes: List<AppearancePalette> = emptyList(),
    val fonts: List<AppearanceFont> = emptyList(),
    val backgrounds: List<AppearanceBackground> = emptyList(),
    val presets: List<AppearancePreset> = emptyList(),
)
