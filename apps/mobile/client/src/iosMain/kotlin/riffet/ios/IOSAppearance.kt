package riffet.ios

/** Native Swift returns these saved iOS values before the device call is acknowledged. */
data class IOSAppearanceTheme(val id: String, val name: String)
data class IOSAppearanceSnapshot(val themeId: String, val mode: String, val themes: List<IOSAppearanceTheme>)
