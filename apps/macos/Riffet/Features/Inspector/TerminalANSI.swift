import AppKit
import SwiftTerm

/// The terminal's sixteen ANSI colours per theme, light and dark. Built-ins are generated from
/// `scripts/theme-ansi.ts`, the same table the web and the mobile client use; custom themes carry
/// their own, which is why this takes the values rather than a theme id.
enum TerminalANSI {
    static func colors(_ ansi: RiffetAnsiValues, dark: Bool) -> [RiffetRGBA] {
        dark ? ansi.dark : ansi.light
    }

    static func color(_ color: RiffetRGBA) -> SwiftTerm.Color {
        let channel = { (value: Double) in UInt16((min(max(value, 0), 1) * 255).rounded()) * 257 }
        return SwiftTerm.Color(red: channel(color.red), green: channel(color.green), blue: channel(color.blue))
    }

    static func nativeColor(_ color: RiffetRGBA) -> NSColor {
        NSColor(srgbRed: color.red, green: color.green, blue: color.blue, alpha: color.alpha)
    }

    static func argb(_ color: RiffetRGBA) -> Int32 {
        Int32(bitPattern: 0xFF000000 | UInt32((color.red * 255).rounded()) << 16
              | UInt32((color.green * 255).rounded()) << 8 | UInt32((color.blue * 255).rounded()))
    }
}
