import AppKit
import Foundation

extension Notification.Name {
    // The window events below reach view state the `Workbench` does not hold. Each carries the
    // `Workbench` it is for as `object`; a receiver handles it only when `Notification.targets(_:)`
    // says so. What the workbench can do itself is a call on it, not an event.
    /// Opens a subagent of the open conversation (userInfo: `id`, `title`).
    static let riffetOpenSubagent = Notification.Name("riffet.open-subagent")
    static let riffetToggleSidebar = Notification.Name("riffet.toggle-sidebar")
    /// Puts the keyboard in the visible composer.
    static let riffetFocusComposer = Notification.Name("riffet.focus-composer")
}

/// Opens a path an agent mentioned. On the Mac that runs the server it opens in the reader's editor;
/// for a remote server the file panel previews it instead.
@MainActor
enum FileOpener {
    /// A click on a mentioned path: the file panel previews it; ⌘- or ⌥-click opens the editor.
    /// [workbench] is the window the click happened in; without one nothing happens.
    static func activate(path: String, line: Int?, projectId: String?, workbench: Workbench?) {
        guard let workbench else { return }
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) || flags.contains(.option) {
            open(path: path, line: line, projectId: projectId, workbench: workbench)
        } else {
            workbench.preview(path: path, line: line)
        }
    }

    static func open(path: String, line: Int?, projectId: String?, workbench: Workbench) {
        if workbench.local {
            EditorLauncher.open(path: resolvedPath(path, projectId: projectId, workbench: workbench), line: line)
        } else {
            workbench.preview(path: path, line: line)
        }
    }

    /// Resolves against the server's project directory, including for a remote server. Only an
    /// absolute path is standardized: Foundation would otherwise resolve it against this Mac's cwd.
    private static func resolvedPath(_ path: String, projectId: String?, workbench: Workbench) -> String {
        let expanded = workbench.local && (path == "~" || path.hasPrefix("~/"))
            ? (path as NSString).expandingTildeInPath
            : path
        let root = workbench.project(projectId)?.cwd
        let resolved = expanded.hasPrefix("/") ? expanded : (root.map { ($0 as NSString).appendingPathComponent(expanded) } ?? expanded)
        return resolved.hasPrefix("/") ? URL(fileURLWithPath: resolved).standardized.path : resolved
    }

    /// The file link's location and actions, ahead of the message's own menu.
    static func menuItems(path: String, projectId: String?, workbench: Workbench?) -> [NSMenuItem] {
        guard let workbench else { return [] }
        let resolved = resolvedPath(path, projectId: projectId, workbench: workbench)
        let location = NSMenuItem(title: resolved, action: nil, keyEquivalent: "")
        location.isEnabled = false
        var items = [location]
        if workbench.local, resolved.hasPrefix("/") {
            let url = URL(fileURLWithPath: resolved)
            let reveal = MenuAction.item(String(localized: "在 Finder 中显示")) {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            reveal.image = NSImage.icon("folder", accessibilityDescription: nil)
            items.append(reveal)
        }
        items.append(MenuAction.item(String(localized: "复制路径")) { copyToPasteboard(resolved) })
        return items
    }
}

/// The editor a path opens in, chosen in Settings. Editors with a URL scheme get the line number.
enum EditorLauncher {
    struct Editor: Identifiable, Hashable {
        let id: String
        let name: String
        let bundleId: String
        /// `{path}` and `{line}` are substituted; nil opens the file without a line.
        let urlTemplate: String?
    }

    static let known: [Editor] = [
        Editor(id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92", urlTemplate: "cursor://file{path}:{line}"),
        Editor(id: "vscode", name: "Visual Studio Code", bundleId: "com.microsoft.VSCode", urlTemplate: "vscode://file{path}:{line}"),
        Editor(id: "zed", name: "Zed", bundleId: "dev.zed.Zed", urlTemplate: "zed://file{path}:{line}"),
        Editor(id: "xcode", name: "Xcode", bundleId: "com.apple.dt.Xcode", urlTemplate: nil),
        Editor(id: "textedit", name: String(localized: "文本编辑"), bundleId: "com.apple.TextEdit", urlTemplate: nil),
    ]

    static var installed: [Editor] {
        known.filter { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0.bundleId) != nil }
    }

    static var preferred: Editor? {
        get {
            guard let id = UserDefaults.standard.string(forKey: "riffet.editor") else { return installed.first }
            return id.isEmpty ? nil : installed.first { $0.id == id }
        }
        set { UserDefaults.standard.set(newValue?.id, forKey: "riffet.editor") }
    }

    static func open(path: String, line: Int?) {
        let fileURL = URL(fileURLWithPath: path)
        guard let editor = preferred else {
            NSWorkspace.shared.open(fileURL)
            return
        }
        if let template = editor.urlTemplate,
           let url = URL(string: template
               .replacingOccurrences(of: "{path}", with: path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)
               .replacingOccurrences(of: ":{line}", with: line.map { ":\($0)" } ?? "")) {
            NSWorkspace.shared.open(url)
            return
        }
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: editor.bundleId) else {
            NSWorkspace.shared.open(fileURL)
            return
        }
        NSWorkspace.shared.open([fileURL], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    }
}
