package riffet.shared

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import riffet.i18n.L10n

/**
 * Every failure this client distinguishes. The UI branches on the type, never on a message string:
 * a 401 has to send the user back to pairing, while a 500 is a retry.
 */
sealed class RiffetException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * The device token was missing, revoked, or wrong. Distinct from [RiffetHttpException] because the
 * only correct response is to forget the stored token and pair again, not to retry the request.
 *
 * [code] carries the server's own code (`UNAUTHENTICATED`, `INVALID_PAIRING_CODE`) so the pairing
 * screen can tell "this code expired" from "this device was revoked".
 */
class RiffetUnauthenticatedException(val code: String?, message: String) : RiffetException(message)

/**
 * Any other non-2xx response, carrying the server's typed error body when there was one. [message]
 * is the text [code] names in the interface language ([L10n.serverError]); [serverMessage] is what
 * the server said, English for developers and logs.
 */
class RiffetHttpException(
    val status: Int,
    val code: String?,
    val serverMessage: String,
    val details: JsonElement? = null,
    val params: Map<String, String> = emptyMap(),
) : RiffetException(serverMessage) {
    /** Only an explicit server rejection permits replacing a saved creation request. */
    val creationRejectedBeforeAcceptance: Boolean
        get() = (details as? JsonObject)?.get("accepted") == JsonPrimitive(false)

    override val message: String
        get() = L10n.serverError(code, params, serverMessage)
}

/** The request never reached a response: DNS, TCP, TLS or a timeout. */
class RiffetNetworkException(message: String, cause: Throwable) : RiffetException(message, cause)

/** The API was used before a host was paired or connected. */
class RiffetNotConnectedException(message: String = "Pair with a Riffet host before using the API.") :
    RiffetException(message)

/**
 * The QR payload could not be trusted. A [UnknownVersion] is deliberately distinct from [Invalid]:
 * the code is well formed but this build cannot speak its protocol, so the message must tell the
 * user to update the app rather than that they scanned the wrong code.
 */
sealed class PairingPayloadException(message: String) : RiffetException(message) {
    class UnknownVersion(val version: Int?, val rawVersion: JsonElement?) : PairingPayloadException(
        "This QR code is version ${rawVersion ?: version ?: "?"}; this app only understands version " +
            "${PairingPayload.CURRENT_VERSION}. Update the app.",
    )

    class Invalid(message: String) : PairingPayloadException(message)
}
