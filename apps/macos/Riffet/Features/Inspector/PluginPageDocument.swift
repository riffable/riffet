import CryptoKit
import Foundation

/*
 * The page a plugin's web view runs in, built the way the web host builds it
 * (apps/web/src/plugins/isolated/document.ts and entry.ts), so keep the two in step; the base stylesheet is
 * generated from packages/plugin-web (`pnpm gen:plugin-style`). The view's own
 * script is the only script in it. The policy is what limits what the page can load and where it can
 * send data: it travels as the response header and again as a meta tag.
 *
 * The page asks for its channel itself, in `channelScript`, before any of the view's code exists, and
 * keeps the answer where the bridge client (`connect()` in packages/plugin-web) takes it from: the view
 * never sends the request, and a page it navigates to later has nothing it could ask for.
 */

struct PluginPageFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum PluginPageDocument {
    /// The page is served under `riffet-plugin://<pluginId>/index.html` by `PluginSchemeHandler`.
    static let scheme = "riffet-plugin"
    static let pagePath = "/index.html"

    static func url(pluginId: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = pluginId
        components.path = pagePath
        return components.url
    }

    /// Whether `url` names the page of `pluginId`; `allowRoot` also accepts `/`.
    static func isPage(_ url: URL, pluginId: String, allowRoot: Bool = false) -> Bool {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == pluginId.lowercased(),
              url.user == nil, url.password == nil, url.port == nil else { return false }
        return url.path == pagePath || (allowRoot && (url.path.isEmpty || url.path == "/"))
    }

    /// The Content-Security-Policy of the page: nothing loads from anywhere, and the network is closed
    /// unless the package holds `network`.
    static func policy(network: Bool) -> String {
        [
            "default-src 'none'", "script-src 'unsafe-inline' blob:", "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
            "connect-src \(network ? "https:" : "'none'")", "base-uri 'none'", "form-action 'none'",
        ].joined(separator: "; ")
    }

    // BEGIN GENERATED plugin-base-style (scripts/gen-plugin-style.ts)
    /// `PLUGIN_BASE_STYLE` of packages/plugin-web: tokens and element rules, the same text as the web page.
    static let baseStyleVersion = 3
    static let baseStyle = #"""
:root{--riffet-space-1:4px;--riffet-space-2:8px;--riffet-space-3:12px;--riffet-space-4:16px;--riffet-space-5:24px;--riffet-radius-control:8px;--riffet-radius-container:10px;--riffet-radius-card:12px;--riffet-font-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI","Helvetica Neue",sans-serif;--riffet-font-mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,"PingFang SC",monospace;--riffet-text-reading:calc(14px*var(--text-scale,1));--riffet-leading-reading:calc(23px*var(--text-scale,1));--riffet-text-ui:calc(13px*var(--text-scale,1));--riffet-leading-ui:calc(20px*var(--text-scale,1));--riffet-text-small:calc(12px*var(--text-scale,1));--riffet-leading-small:calc(16px*var(--text-scale,1));--riffet-control-height:32px;--riffet-border-width:1px;--riffet-focus-ring:color-mix(in srgb,var(--accent) 50%,transparent)}
:where(html,body){margin:0;height:100%}
:where(body){background:var(--bg);color:var(--fg);font:var(--riffet-text-ui)/var(--riffet-leading-ui) var(--riffet-font-sans);-webkit-font-smoothing:antialiased}
:where(a){color:var(--accent);text-decoration:none}
:where(a:hover){text-decoration:underline;text-underline-offset:3px}
:where(button,input,textarea,select){box-sizing:border-box;margin:0;font:inherit;color:inherit}
:where(button,input[type=button],input[type=submit],input[type=reset]){display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--riffet-control-height);padding:0 12px;border:var(--riffet-border-width) solid var(--line-strong);border-radius:var(--riffet-radius-control);background:var(--bg-elevated);font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none;transition:background-color .15s}
:where(button:hover:not(:disabled),input[type=button]:hover:not(:disabled),input[type=submit]:hover:not(:disabled),input[type=reset]:hover:not(:disabled)){background:var(--bg-subtle)}
:where(button:disabled,input[type=button]:disabled,input[type=submit]:disabled,input[type=reset]:disabled){opacity:.45;cursor:default}
:where(input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=color],[type=button],[type=submit],[type=reset],[type=image]),textarea,select){width:100%;min-width:0;height:var(--riffet-control-height);padding:0 10px;border:var(--riffet-border-width) solid var(--line-strong);border-radius:var(--riffet-radius-control);background:var(--bg-elevated);outline:none;transition:border-color .15s,box-shadow .15s}
:where(textarea){height:auto;min-height:80px;padding:8px 10px;line-height:20px;resize:vertical}
:where(input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=color],[type=button],[type=submit],[type=reset],[type=image]):hover,textarea:hover,select:hover){border-color:color-mix(in srgb,var(--fg-4) 60%,transparent)}
:where(input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=color],[type=button],[type=submit],[type=reset],[type=image]):focus,textarea:focus,select:focus){border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 15%,transparent)}
:where(input,textarea,select)::placeholder{color:var(--fg-4)}
:where(input,textarea,select):disabled{opacity:.5}
:where(:focus-visible){outline:2px solid var(--riffet-focus-ring);outline-offset:1px}
:where(input,textarea,select):focus-visible{outline:none}
[data-pointer-focus]:focus-visible{outline:none}
::selection{background:color-mix(in srgb,var(--accent) 24%,transparent)}
:where(code,kbd,samp,pre){font-family:var(--riffet-font-mono);font-size:.86em}
:where(pre){margin:0;padding:var(--riffet-space-2) var(--riffet-space-3);overflow:auto;border:var(--riffet-border-width) solid var(--line);border-radius:var(--riffet-radius-container);background:var(--bg-subtle);font-size:var(--riffet-text-small);line-height:var(--riffet-leading-ui)}
:where(pre code){font-size:inherit}
:where(hr){margin:var(--riffet-space-4) 0;border:0;border-top:var(--riffet-border-width) solid var(--line)}
:where(table){border-collapse:collapse}
:where(th,td){padding:7px var(--riffet-space-3);border-bottom:var(--riffet-border-width) solid var(--line);text-align:left;vertical-align:top}
:where(th){background:var(--bg-subtle);color:var(--fg-2);font-weight:500}
:where(*){scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}
:where(*)::-webkit-scrollbar{width:10px;height:10px}
:where(*)::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background:var(--line-strong) padding-box}
:where(*)::-webkit-scrollbar-thumb:hover{background:var(--fg-4) padding-box}
:where(*)::-webkit-scrollbar-track,:where(*)::-webkit-scrollbar-corner{background:transparent}
@media (prefers-reduced-motion:reduce){:where(*){transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important}}
"""#
    /// `PLUGIN_FOCUS_SCRIPT` of packages/plugin-web: a ring only where a navigating key moved focus.
    static let focusScript = #"(function(w){var K={Tab:1,ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Home:1,End:1,PageUp:1,PageDown:1},M="data-pointer-focus",n=false,p=false,F='a[href],button,input,select,textarea,[tabindex],[role="button"],[role="menuitem"],[role="option"],[role="radio"],[role="checkbox"],[role="switch"],[role="tab"]',T='input,textarea,[contenteditable]:not([contenteditable="false"])';w.addEventListener("pointerdown",function(e){n=false;p=true;var t=e.target instanceof Element?e.target.closest(F):null;if(t)t.setAttribute(M,"")},true);w.addEventListener("focusin",function(e){var t=e.target;if(!(t instanceof Element)||t.closest(T))return;if(n||(!p&&e.relatedTarget===null))t.removeAttribute(M);else t.setAttribute(M,"")},true);w.addEventListener("keydown",function(e){p=false;n=!!K[e.key]&&!e.metaKey&&!e.ctrlKey&&!e.altKey},true);w.addEventListener("keyup",function(){n=false},true)})(window)"#
    // END GENERATED plugin-base-style

    /// The first script of the page (`CHANNEL_SCRIPT` of the web host, with the protocol's names filled in):
    /// listens for the host's answer, then asks. On the Mac `window.parent` is the window itself, which
    /// is where the bridge's shim listens.
    static let channelScript = #"(function(w){var p=new Promise(function(r){w.addEventListener("message",function f(e){var d=e.data;if(e.source===w.parent&&d&&d.type==="riffet-plugin:init"&&d.version===1&&e.ports&&e.ports[0]){w.removeEventListener("message",f);r(e.ports[0])}})});Object.defineProperty(w,"__riffetPort",{value:p});w.parent.postMessage({type:"riffet-plugin:ready",version:1},"*")})(window)"#

    static func bootstrap(code: String, network: Bool, theme: PluginBridgeTheme, locale: String) -> String {
        let vars = theme.vars.filter { isVariableName($0.key) && isSafeValue($0.value) }
            .sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ";")
        return [
            "<!doctype html>",
            "<html lang=\"\(attribute(locale))\"><head><meta charset=\"utf-8\">",
            "<meta http-equiv=\"Content-Security-Policy\" content=\"\(attribute(policy(network: network)))\">",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
            "<style>:root{color-scheme:\(theme.scheme);\(vars)}\(baseStyle)</style>",
            // The channel request and the app's focus-ring policy, in one element ahead of the view's code.
            "<script>\(channelScript);\(focusScript)</script>",
            "</head><body><div id=\"root\"></div>",
            // The view's script runs as a classic script created here, so it needs no `src` and the policy needs no origin.
            "<script>(function(){var s=document.createElement(\"script\");s.textContent=\(literal(code));document.head.appendChild(s)})()</script>",
            "</body></html>",
        ].joined()
    }

    /// A string literal for a script: JSON is a valid JavaScript string, and `<` is written as an escape
    /// so no `</script>` or `<!--` in the view's code can end or confuse the element that holds it.
    static func literal(_ value: String) -> String {
        var out = "\""
        out.reserveCapacity(value.utf8.count + 2)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{8}": out += "\\b"
            case "\u{c}": out += "\\f"
            case "<": out += "\\u003c"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    /// Text that can sit inside a double-quoted attribute.
    private static func attribute(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
    }

    /// `--[a-z0-9-]+`
    private static func isVariableName(_ name: String) -> Bool {
        name.hasPrefix("--") && name.count > 2 && name.utf8.dropFirst(2).allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
    }

    /// A colour value that is safe to write into a style rule: the palette's own forms, nothing that
    /// could close the rule or the element.
    private static func isSafeValue(_ value: String) -> Bool {
        let forms = Set("#(),.%_/+- ".unicodeScalars)
        return (1...80).contains(value.count) && value.unicodeScalars.allSatisfy {
            ($0.isASCII && ($0.properties.isAlphabetic || ("0"..."9").contains($0))) || forms.contains($0) || $0 == "\t"
        }
    }
}

/// The web entry of a development or installed package, read through the files route with the
/// user's session (which the view never sees) and checked against its integrity when the server
/// recorded one.
enum PluginEntry {
    /// The largest web entry the host will read. A bundled view is a few hundred kilobytes; this
    /// leaves room for a library.
    static let maxBytes = 8 * 1024 * 1024

    /// `key` (the package's integrity, else its version) is written as `?v=` so an upgraded entry is never
    /// answered from a cache of the old one; the server ignores it.
    static func url(base: String, pluginId: String, path: String, key: String? = nil) -> URL? {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        func component(_ value: String) -> String? { value.addingPercentEncoding(withAllowedCharacters: unreserved) }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).map { component(String($0)) }
        guard let id = component(pluginId), !segments.contains(where: { $0 == nil }) else { return nil }
        let query = key.flatMap(component).map { "?v=\($0)" } ?? ""
        return URL(string: "\(base)/api/integrations/\(id)/files/\(segments.compactMap { $0 }.joined(separator: "/"))\(query)")
    }

    /// The version of the bridge protocol this host speaks (`BRIDGE_VERSION` in packages/plugin-web).
    static let bridgeVersion = 1
    static let webApiVersion = 1

    /// Whether `range`, a package's `hostApi.web`, admits this host's bridge protocol version
    /// (`satisfies` of apps/server/src/plugins-host/semver.ts for a whole-number version, `N.0.0`):
    /// comparators `>= > <= < = ^ ~ x *`, spaces AND, `||` OR. A range it cannot read never matches.
    static func admits(_ range: String) -> Bool {
        guard range.count <= 128 else { return false }
        var matched = false
        for alternative in range.components(separatedBy: "||") {
            // `>= 1` and `>=1` are the same comparator.
            let text = alternative.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"(>=|<=|>|<|=|\^|~)\s+"#, with: "$1", options: .regularExpression)
            let tokens = text.split(whereSeparator: \.isWhitespace).map(String.init)
            guard !tokens.isEmpty else { return false }
            var all = true
            for token in tokens {
                guard let ok = comparator(token) else { return false }
                all = all && ok
            }
            matched = matched || all
        }
        return matched
    }

    /// One comparator against `bridgeVersion.0.0`; nil when unreadable.
    private static func comparator(_ token: String) -> Bool? {
        if token == "*" || token == "x" || token == "X" { return true }
        let op = [">=", "<=", ">", "<", "=", "^", "~"].first(where: token.hasPrefix) ?? ""
        let parts = token.dropFirst(op.count).split(separator: ".", omittingEmptySubsequences: false)
        func number(_ part: Substring) -> Int? { !part.isEmpty && part.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 } ? Int(part) : nil }
        guard (1...3).contains(parts.count), let major = number(parts[0]) else { return nil }
        // The given components stop at the first wildcard; the rest count as zero.
        var v = [major, 0, 0]
        var given = 1
        for (index, part) in parts.enumerated().dropFirst() {
            if ["x", "X", "*"].contains(part) { break }
            guard let value = number(part) else { return nil }
            v[index] = value
            given = index + 1
        }
        func compare(_ other: [Int]) -> Int {
            zip([webApiVersion, 0, 0], other).first(where: { $0 != $1 }).map { $0 < $1 ? -1 : 1 } ?? 0
        }
        // The first version past everything `given` components cover.
        let next = given <= 1 ? [v[0] + 1, 0, 0] : given == 2 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1]
        switch op {
        case "", "=": return compare(v) >= 0 && compare(next) < 0
        case ">=": return compare(v) >= 0
        case ">": return compare(next) >= 0
        case "<": return compare(v) < 0
        case "<=": return compare(next) < 0
        case "~": return compare(v) >= 0 && compare(given >= 2 ? [v[0], v[1] + 1, 0] : [v[0] + 1, 0, 0]) < 0
        default:
            // ^: nothing at or past the first non-zero component changes.
            let caret = v[0] > 0 || given <= 1 ? [v[0] + 1, 0, 0] : v[1] > 0 || given == 2 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]
            return compare(v) >= 0 && compare(caret) < 0
        }
    }

    /// Throws unless `data` hashes to `integrity`. A form this host does not know is a mismatch: an
    /// integrity it cannot check is not one it can pass.
    static func verify(_ data: Data, integrity: String?) throws {
        guard let integrity else { return }
        guard let expected = expectedDigest(integrity), expected == hex(SHA256.hash(data: data)) else {
            throw PluginPageFailure("The view's script does not match its recorded integrity")
        }
    }

    /// The script as text: UTF-8, without a byte order mark.
    static func code(_ data: Data) -> String {
        let text = String(decoding: data, as: UTF8.self)
        return text.hasPrefix("\u{feff}") ? String(text.dropFirst()) : text
    }

    /// `sha256-<hex>` or `sha256-<base64>` as the hex digest it stands for; nil for any other form.
    private static func expectedDigest(_ integrity: String) -> String? {
        guard integrity.hasPrefix("sha256-") else { return nil }
        let body = String(integrity.dropFirst(7))
        guard !body.isEmpty, !body.unicodeScalars.contains(where: { "\n\r\u{2028}\u{2029}".unicodeScalars.contains($0) }) else { return nil }
        let lowered = body.lowercased()
        if lowered.count == 64, lowered.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) { return lowered }
        // Base64 without its padding is accepted, as `atob` does.
        guard body.count % 4 != 1 else { return nil }
        let padded = body + String(repeating: "=", count: (4 - body.count % 4) % 4)
        guard let bytes = Data(base64Encoded: padded), bytes.count == 32 else { return nil }
        return hex(bytes)
    }

    private static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
