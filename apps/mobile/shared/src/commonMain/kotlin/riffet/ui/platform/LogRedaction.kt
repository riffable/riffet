package riffet.ui.platform

/**
 * Removes credentials from log text before it leaves the device (导出 / 上传). The log is written
 * without them on purpose; this is the backstop for a line that quoted a header, a URL or an
 * exception message carrying one. Device ids stay readable: they name a pairing, not a secret.
 */
fun redactLog(text: String): String = PATTERNS.fold(text) { acc, (pattern, replacement) -> pattern.replace(acc, replacement) }

private val PATTERNS = listOf(
    // First, so a header's token is replaced whole rather than its id kept and its tail doubled.
    Regex("""(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]+""") to "$1 <redacted>",
    // A device token is `wkn_<16 hex id>_<secret>`; keep the id.
    Regex("""\bwkn_([0-9a-f]{16})_[A-Za-z0-9_\-]+""") to "wkn_$1_<redacted>",
    Regex("""\bwkn_share_preview=[^;\s]+""") to "wkn_share_preview=<redacted>",
    Regex("""(?i)\b(authorization|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+""") to "$1$2<redacted>",
    Regex("""(?i)\b(access_token|device_token|api_key|apikey|password|secret)(\s*[=:]\s*)[^\s&"',;]+""") to "$1$2<redacted>",
)
