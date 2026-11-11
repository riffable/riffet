package riffet.shared

import riffet.contracts.RiffetJson
import riffet.contracts.ThemeDesign

/** The Mac cache preserves the versioned design object with the contract's serializer. */
object ThemeDesignCodec {
    fun encode(value: ThemeDesign): String = RiffetJson.instance.encodeToString(ThemeDesign.serializer(), value)
    @Throws(Exception::class)
    fun decode(text: String): ThemeDesign = RiffetJson.instance.decodeFromString(ThemeDesign.serializer(), text)
}
