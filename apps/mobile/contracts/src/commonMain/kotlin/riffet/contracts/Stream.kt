package riffet.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

/*
 * Shared machinery for the three `type`-discriminated unions below.
 *
 * A hand-written union serializer must put the discriminant back on the wire itself: `@SerialName`
 * on a variant is only consulted by kotlinx's *generated* sealed serializer, which these replace.
 * Forgetting it makes `{"type":"claim","clientId":"c"}` collapse to `{"clientId":"c"}` — the
 * server's terminal handler then answers `INVALID_MESSAGE` and every terminal control silently
 * fails. Both directions therefore go through the helpers here, and the round-trip tests assert
 * every variant of every union.
 */

private const val TYPE_DISCRIMINATOR = "type"

@Suppress("UNCHECKED_CAST")
internal fun <T : Any> encodeDiscriminatedFrame(
    encoder: JsonEncoder,
    serializers: Map<String, KSerializer<out T>>,
    name: String,
    value: T,
    unionName: String,
) {
    val serializer = serializers.getValue(name) as KSerializer<T>
    val element = encoder.json.encodeToJsonElement(serializer, value) as? JsonObject
        ?: throw SerializationException("$unionName variant must encode to a JSON object")
    // The discriminator is written first so a frame reads the way the server writes it. Order is
    // not semantic to `JSON.parse`, but it makes a captured frame easy to eyeball.
    val merged = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(element.size + 1)
    merged[TYPE_DISCRIMINATOR] = JsonPrimitive(name)
    merged.putAll(element)
    encoder.encodeJsonElement(JsonObject(merged))
}

@Suppress("UNCHECKED_CAST")
internal fun <T : Any> decodeDiscriminatedFrame(
    decoder: JsonDecoder,
    serializers: Map<String, KSerializer<out T>>,
    unionName: String,
    unknown: (String?, JsonObject) -> T,
): T {
    val element = decoder.decodeJsonElement() as? JsonObject
        ?: throw SerializationException("$unionName frame must be a JSON object")
    val type = (element[TYPE_DISCRIMINATOR] as? JsonPrimitive)?.contentOrNull
    val serializer = type?.let { serializers[it] } ?: return unknown(type, element)
    return decoder.json.decodeFromJsonElement(serializer as KSerializer<T>, element)
}

/**
 * WebSocket frames for `/api/terminals/:id/ws`. Not used until P3, but they are part of the same
 * wire contract and are cheap to keep alongside the stream types.
 */
@Serializable(with = TerminalClientMessageSerializer::class)
sealed interface TerminalClientMessage {
    @Serializable
    @SerialName("claim")
    data class Claim(val clientId: String, val takeover: Boolean? = null) : TerminalClientMessage

    @Serializable
    @SerialName("input")
    data class Input(val clientId: String, val epoch: Long, val data: String) : TerminalClientMessage

    @Serializable
    @SerialName("resize")
    data class Resize(val clientId: String, val epoch: Long, val cols: Long, val rows: Long) : TerminalClientMessage

    @Serializable
    @SerialName("release")
    data class Release(val clientId: String, val epoch: Long) : TerminalClientMessage

    /** Protocol 3: characters of output/snapshot data the emulator has finished writing. */
    @Serializable
    @SerialName("ack")
    data class Ack(val chars: Long) : TerminalClientMessage

    /** Protocol 3: pasted text; the server lets tmux decide on bracketed paste. */
    @Serializable
    @SerialName("paste")
    data class Paste(val clientId: String, val epoch: Long, val data: String) : TerminalClientMessage
}

/** Terminal socket protocol (docs/TERMINAL.md): 3 streams the pane's own output; a snapshot carries scrollback. */
const val TERMINAL_PROTOCOL = 3

/** Scrollback rows a seed carries and a client emulator keeps. */
const val TERMINAL_SCROLLBACK_ROWS = 10_000

/** A client acks written output in steps of this many characters. */
const val TERMINAL_ACK_CHARS = 5_000

object TerminalClientMessageSerializer : KSerializer<TerminalClientMessage> {

    private val VARIANT_SERIALIZERS: Map<String, KSerializer<out TerminalClientMessage>> = linkedMapOf(
        "claim" to TerminalClientMessage.Claim.serializer(),
        "input" to TerminalClientMessage.Input.serializer(),
        "resize" to TerminalClientMessage.Resize.serializer(),
        "release" to TerminalClientMessage.Release.serializer(),
        "ack" to TerminalClientMessage.Ack.serializer(),
        "paste" to TerminalClientMessage.Paste.serializer(),
    )

    private fun wireName(value: TerminalClientMessage): String = when (value) {
        is TerminalClientMessage.Claim -> "claim"
        is TerminalClientMessage.Input -> "input"
        is TerminalClientMessage.Resize -> "resize"
        is TerminalClientMessage.Release -> "release"
        is TerminalClientMessage.Ack -> "ack"
        is TerminalClientMessage.Paste -> "paste"
    }

    override val descriptor = buildClassSerialDescriptor("riffet.contracts.TerminalClientMessage") {
        element<String>("type")
    }

    override fun deserialize(decoder: Decoder): TerminalClientMessage {
        val json = decoder as? JsonDecoder ?: throw SerializationException("terminal frames are JSON")
        return decodeDiscriminatedFrame(json, VARIANT_SERIALIZERS, "terminal client") { type, _ ->
            throw SerializationException("unknown terminal client message: $type")
        }
    }

    override fun serialize(encoder: Encoder, value: TerminalClientMessage) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("terminal frames are JSON")
        encodeDiscriminatedFrame(json, VARIANT_SERIALIZERS, wireName(value), value, "terminal client")
    }
}

@Serializable(with = TerminalServerMessageSerializer::class)
sealed interface TerminalServerMessage {
    @Serializable
    @SerialName("output")
    data class Output(val data: String, val sequence: Long, val streamId: String? = null) : TerminalServerMessage

    @Serializable
    @SerialName("snapshot")
    data class Snapshot(val data: String, val sequence: Long, val cols: Long, val rows: Long, val streamId: String) : TerminalServerMessage

    @Serializable
    @SerialName("state")
    data class State(val terminal: TerminalInfo) : TerminalServerMessage

    @Serializable
    @SerialName("error")
    data class Error(val code: String, val message: String) : TerminalServerMessage

    @Serializable
    @SerialName("exit")
    data class Exit(val exitCode: Long? = null) : TerminalServerMessage
}

object TerminalServerMessageSerializer : KSerializer<TerminalServerMessage> {

    private val VARIANT_SERIALIZERS: Map<String, KSerializer<out TerminalServerMessage>> = linkedMapOf(
        "output" to TerminalServerMessage.Output.serializer(),
        "snapshot" to TerminalServerMessage.Snapshot.serializer(),
        "state" to TerminalServerMessage.State.serializer(),
        "error" to TerminalServerMessage.Error.serializer(),
        "exit" to TerminalServerMessage.Exit.serializer(),
    )

    private fun wireName(value: TerminalServerMessage): String = when (value) {
        is TerminalServerMessage.Output -> "output"
        is TerminalServerMessage.Snapshot -> "snapshot"
        is TerminalServerMessage.State -> "state"
        is TerminalServerMessage.Error -> "error"
        is TerminalServerMessage.Exit -> "exit"
    }

    override val descriptor = buildClassSerialDescriptor("riffet.contracts.TerminalServerMessage") {
        element<String>("type")
    }

    override fun deserialize(decoder: Decoder): TerminalServerMessage {
        val json = decoder as? JsonDecoder ?: throw SerializationException("terminal frames are JSON")
        return decodeDiscriminatedFrame(json, VARIANT_SERIALIZERS, "terminal server") { type, _ ->
            throw SerializationException("unknown terminal server message: $type")
        }
    }

    override fun serialize(encoder: Encoder, value: TerminalServerMessage) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("terminal frames are JSON")
        encodeDiscriminatedFrame(json, VARIANT_SERIALIZERS, wireName(value), value, "terminal server")
    }
}
