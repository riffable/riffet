import AppKit
import SwiftUI
import RiffetKit

/// One scope's folder favorites (`FolderFavorites.tsx`): the host's, with absolute paths, for the
/// directory browser and the home page; or a project's files panel, with paths relative to its root.
/// They live on the server, so every device signed in to it sees the same list.
@MainActor @Observable
final class FolderFavoritesModel {
    let projectId: String?
    private(set) var favorites: [FolderFavorite] = [] { didSet { byRecentUse = Self.byRecentUse(favorites) } }
    /// Quick picks lead with what was opened most recently; never-used ones keep their order.
    /// Sorted when the list changes, not per read.
    private(set) var byRecentUse: [FolderFavorite] = []
    private var api: RiffetApi?
    @ObservationIgnored private var loadedAt = Date.distantPast
    @ObservationIgnored private var loadedFrom: String?

    init(projectId: String? = nil) { self.projectId = projectId }

    /// Reads the list again, unless the last read of the same server is younger than [maxAge]. A
    /// server without favorites, or a failed read, keeps what is shown: they are a shortcut, not
    /// something to report.
    func load(_ api: RiffetApi?, maxAge: TimeInterval = 0) async {
        if let base = api?.baseUrl, base != loadedFrom {
            loadedAt = .distantPast
            loadedFrom = base
        }
        self.api = api
        if maxAge > 0, Date().timeIntervalSince(loadedAt) < maxAge { return }
        guard let api, let next = try? await api.folderFavorites(projectId: projectId) else { return }
        loadedAt = Date()
        if next != favorites { favorites = next }
    }

    func favorite(at path: String) -> FolderFavorite? { favorites.first { $0.path == path } }

    private static func byRecentUse(_ favorites: [FolderFavorite]) -> [FolderFavorite] {
        favorites.filter(\.exists).sorted { a, b in
            let (x, y) = (a.lastUsedAt ?? "", b.lastUsedAt ?? "")
            return x != y ? x > y : a.sort < b.sort
        }
    }

    @discardableResult
    func add(_ path: String) async -> FolderFavorite? {
        guard let api else { return nil }
        do {
            let created = try await api.addFolderFavorite(path: path, projectId: projectId, label: nil)
            if !favorites.contains(where: { $0.id == created.id }) { favorites.append(created) }
            return created
        } catch {
            alert(String(localized: "无法收藏该目录"), error.riffetMessage)
            return nil
        }
    }

    func remove(_ favorite: FolderFavorite) async {
        guard let api else { return }
        do {
            try await api.removeFolderFavorite(id: favorite.id)
            favorites.removeAll { $0.id == favorite.id }
        } catch {
            alert(String(localized: "无法取消收藏"), error.riffetMessage)
        }
    }

    func toggle(_ path: String) async {
        if let existing = favorite(at: path) { await remove(existing) } else { await add(path) }
    }

    /// Asks for a display name; an empty one, or the folder's own name, goes back to the folder's name.
    func rename(_ favorite: FolderFavorite) async {
        guard let api else { return }
        let folder = folderName(favorite.path)
        let alert = NSAlert()
        alert.messageText = String(localized: "重命名收藏")
        alert.informativeText = String(localized: "留空则显示目录名")
        let field = NSTextField(string: favorite.label ?? folder)
        field.placeholderString = folder
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "保存"))
        alert.addButton(withTitle: String(localized: "取消"))
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = value.isEmpty || value == folder ? "" : value
        guard label != (favorite.label ?? "") else { return }
        do {
            let updated = try await api.updateFolderFavorite(id: favorite.id, label: label, used: false)
            favorites = favorites.map { $0.id == updated.id ? updated : $0 }
        } catch {
            self.alert(String(localized: "无法重命名收藏"), error.riffetMessage)
        }
    }

    /// One step up (-1) or down (1); shown at once, put back if the server refuses.
    func move(_ favorite: FolderFavorite, by delta: Int) async {
        guard let api, let from = favorites.firstIndex(where: { $0.id == favorite.id }) else { return }
        let to = from + delta
        guard favorites.indices.contains(to) else { return }
        let before = favorites
        favorites.swapAt(from, to)
        do {
            favorites = try await api.reorderFolderFavorites(ids: favorites.map(\.id), projectId: projectId)
        } catch {
            favorites = before
            alert(String(localized: "无法调整收藏顺序"), error.riffetMessage)
        }
    }

    private func alert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}

private func folderName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}

/// What a favorite is shown as: its label, else the folder's own name.
func favoriteName(_ favorite: FolderFavorite) -> String {
    favorite.label ?? folderName(favorite.path)
}

/// 重命名 / 上移 / 下移 / 取消收藏, for a favorite's context menu.
struct FolderFavoriteMenuItems: View {
    let model: FolderFavoritesModel
    let favorite: FolderFavorite

    var body: some View {
        let index = model.favorites.firstIndex { $0.id == favorite.id }
        Button("重命名…") { Task { await model.rename(favorite) } }
        Button("上移") { Task { await model.move(favorite, by: -1) } }.disabled(index == nil || index == 0)
        Button("下移") { Task { await model.move(favorite, by: 1) } }.disabled(index == nil || index == model.favorites.count - 1)
        Divider()
        Button("取消收藏", role: .destructive) { Task { await model.remove(favorite) } }
    }
}

/// A favorite as a chip: a star and its name, greyed with 不存在 when the folder is gone. The
/// context menu manages it; a missing one also offers removal in place.
struct FolderFavoriteChip: View {
    let model: FolderFavoritesModel
    let favorite: FolderFavorite
    var current = false
    let open: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 2) {
            Button(action: open) {
                HStack(spacing: 4) {
                    Image(icon: "star.fill").font(.riffet(size: S(9.5))).foregroundStyle(favorite.exists ? palette.warning : palette.fg4)
                    Text(favoriteName(favorite)).lineLimit(1).truncationMode(.middle)
                    if !favorite.exists { Text("不存在").font(.riffet(size: S(10.5))).foregroundStyle(palette.fg4) }
                }
                .font(.riffet(size: S(12)))
                .foregroundStyle(favorite.exists ? palette.fg2 : palette.fg4)
            }
            .buttonStyle(ChipButtonStyle(active: current))
            .disabled(!favorite.exists)
            if !favorite.exists {
                Button { Task { await model.remove(favorite) } } label: { Image(icon: "xmark").font(.riffet(size: S(8.5), weight: .bold)) }
                    .buttonStyle(IconButtonStyle(size: 20))
                    .help("移除收藏")
            }
        }
        .help(favorite.path)
        .contextMenu { FolderFavoriteMenuItems(model: model, favorite: favorite) }
    }
}

/// The favorites as a wrapping row of chips, or nothing when there are none.
struct FolderFavoriteStrip: View {
    let model: FolderFavoritesModel
    var currentPath: String?
    let open: (FolderFavorite) -> Void

    var body: some View {
        if !model.favorites.isEmpty {
            FlowLayout(spacing: 4) {
                ForEach(model.favorites, id: \.id) { favorite in
                    FolderFavoriteChip(model: model, favorite: favorite, current: favorite.path == currentPath) { open(favorite) }
                }
            }
        }
    }
}
