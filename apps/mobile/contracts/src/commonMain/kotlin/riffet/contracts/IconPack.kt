package riffet.contracts

import kotlinx.serialization.Serializable

/** Portable monochrome paths; mirrored by packages/contracts/src/icon-pack.ts. */
@Serializable
data class IconPath(
    val d: String,
    val fill: Boolean = true,
    val strokeWidth: Float = 0f,
    val lineCap: String = "round",
    val lineJoin: String = "round",
    val fillRule: String = "nonzero",
)

@Serializable
data class IconGlyph(val width: Float, val height: Float, val paths: List<IconPath>)

@Serializable
data class IconPackDocument(val version: Int = 1, val icons: Map<String, IconGlyph>) {
    fun valid(): Boolean = version == 1 && icons.size in 1..256 && icons.all { (name, glyph) ->
        name.matches(Regex("[A-Z][A-Za-z0-9]{0,63}")) &&
            glyph.width.isFinite() && glyph.width in 1f..1024f && glyph.height.isFinite() && glyph.height in 1f..1024f &&
            glyph.paths.size in 1..32 && glyph.paths.all { path ->
                path.d.length in 1..16384 && path.d.first() in "Mm" &&
                    path.d.all { it in "MmLlHhVvCcSsQqTtAaZz0123456789eE.,+- \t\n\r" } &&
                    NUMBER.findAll(path.d).all { it.value.toFloatOrNull()?.let { n -> n.isFinite() && n in -10000f..10000f } == true } &&
                    path.strokeWidth.isFinite() && path.strokeWidth in 0f..64f &&
                    path.lineCap in listOf("round", "butt", "square") &&
                    path.lineJoin in listOf("round", "miter", "bevel") && path.fillRule in listOf("nonzero", "evenodd")
            }
    }

    companion object {
        private val NUMBER = Regex("[-+]?(?:\\d*\\.)?\\d+(?:[eE][-+]?\\d+)?")
        const val MAX_BYTES = 1024 * 1024
        fun parse(text: String): IconPackDocument {
            require(text.length <= MAX_BYTES)
            return RiffetJson.instance.decodeFromString(serializer(), text).also { require(it.valid()) }
        }
    }
}
