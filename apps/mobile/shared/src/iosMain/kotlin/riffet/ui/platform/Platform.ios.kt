package riffet.ui.platform

import androidx.compose.runtime.Composable

actual fun approvalVerificationAvailability(): VerificationAvailability = VerificationAvailability.UNSUPPORTED

@Composable
actual fun rememberKeepAliveStatus(): KeepAliveStatus? = null

actual fun openKeepAlivePage(page: KeepAlivePage) = Unit
