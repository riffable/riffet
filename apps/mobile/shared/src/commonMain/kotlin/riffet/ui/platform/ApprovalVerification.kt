package riffet.ui.platform

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import riffet.contracts.NativeInteractionKind
import riffet.shared.createAppPreferences
import riffet.shared.createBiometricGate

/** Whether this device can verify its owner before an approval goes out. */
enum class VerificationAvailability {
    AVAILABLE,

    /** The platform can, but no screen lock or biometric is set up. */
    NOT_ENROLLED,

    /** Nothing on this platform acts on the switch; the settings page does not offer it. */
    UNSUPPORTED,
}

expect fun approvalVerificationAvailability(): VerificationAvailability

/**
 * 确认操作前验证本人: the device owner is verified before an answer that lets the Agent act
 * (permission, plan, confirmation) is sent, from the transcript or from a notification. Questions
 * and choices are not gated, as on iPhone. Stored on this device only, like [riffet.shared.NativeFeatures].
 */
object ApprovalVerification {
    private const val KEY = "approval.verify"
    private val preferences by lazy { createAppPreferences() }
    private val gate by lazy { createBiometricGate() }

    // Created on first read, which may be inside a read-only snapshot; creation is not a write.
    private var stored by mutableStateOf<Boolean?>(null)

    val required: Boolean
        get() = stored ?: (preferences.string(KEY) == "true")

    fun setRequired(on: Boolean) {
        stored = on
        preferences.setString(KEY, if (on) "true" else null)
    }

    /** The kinds whose answer lets the Agent go ahead; the same set the iPhone gates. */
    fun guards(kind: NativeInteractionKind): Boolean =
        kind == NativeInteractionKind.PERMISSION || kind == NativeInteractionKind.PLAN || kind == NativeInteractionKind.CONFIRMATION

    /** True when [kind] needs no verification, or the owner just passed it. */
    suspend fun verify(kind: NativeInteractionKind, reason: String): Boolean =
        !required || !guards(kind) || gate.authenticate(reason)

    /** Unconditional, for turning the switch on. */
    suspend fun authenticate(reason: String): Boolean = gate.authenticate(reason)
}
