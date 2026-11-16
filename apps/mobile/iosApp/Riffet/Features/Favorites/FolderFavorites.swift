import SwiftUI
import RiffetKit

/// One scope's folder favorites (`FolderFavorites.tsx` on the web): the Mac's, with absolute paths,
/// for picking a project; or a project's files ([projectId]), with paths relative to its root. They
/// live on the server, so every device signed in to it sees the same list.
@MainActor @Observable
final class FolderFavoritesModel {
    let projectId: String?
    private(set) var favorites: [FolderFavorite] = []
    /// The last failed change; reads fail quietly, favorites are a shortcut.
    var error: String?
    private var api: RiffetApi?

    init(projectId: String? = nil) { self.projectId = projectId }

    func load(_ api: RiffetApi?) async {
        self.api = api
        guard let api, let next = try? await api.folderFavorites(projectId: projectId) else { return }
        favorites = next
    }

    func favorite(at path: String) -> FolderFavorite? { favorites.first { $0.path == path } }

    /// Quick picks lead with what was opened most recently; never-used ones keep their order.
    var byRecentUse: [FolderFavorite] {
        favorites.filter(\.exists).sorted { a, b in
            let (x, y) = (a.lastUsedAt ?? "", b.lastUsedAt ?? "")
            return x != y ? x > y : a.sort < b.sort
        }
    }

    func toggle(_ path: String) async {
        if let existing = favorite(at: path) { await remove(existing); return }
        await change(String(localized: "无法收藏该目录", bundle: .riffet)) { api in
            let created = try await api.addFolderFavorite(path: path, projectId: self.projectId, label: nil)
            if !self.favorites.contains(where: { $0.id == created.id }) { self.favorites.append(created) }
        }
    }

    func remove(_ favorite: FolderFavorite) async {
        await change(String(localized: "无法取消收藏", bundle: .riffet)) { api in
            try await api.removeFolderFavorite(id: favorite.id)
            self.favorites.removeAll { $0.id == favorite.id }
        }
    }

    /// An empty [label], or the folder's own name, goes back to showing the folder's name.
    func rename(_ favorite: FolderFavorite, to label: String) async {
        let value = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = value == folderName(favorite.path) ? "" : value
        guard next != (favorite.label ?? "") else { return }
        await change(String(localized: "无法重命名收藏", bundle: .riffet)) { api in
            let updated = try await api.updateFolderFavorite(id: favorite.id, label: next, used: false)
            self.favorites = self.favorites.map { $0.id == updated.id ? updated : $0 }
        }
    }

    /// A drag in edit mode (`.onMove`); shown at once, put back if the server refuses.
    func reorder(fromOffsets source: IndexSet, toOffset destination: Int) async {
        let before = favorites
        favorites.move(fromOffsets: source, toOffset: destination)
        guard favorites.map(\.id) != before.map(\.id) else { return }
        await change(String(localized: "无法调整收藏顺序", bundle: .riffet), undo: { self.favorites = before }) { api in
            self.favorites = try await api.reorderFolderFavorites(ids: self.favorites.map(\.id), projectId: self.projectId)
        }
    }

    private func change(_ failure: String, undo: () -> Void = {}, _ body: (RiffetApi) async throws -> Void) async {
        guard let api else { return }
        error = nil
        do { try await body(api) } catch {
            undo()
            self.error = error.riffetMessage.isEmpty ? failure : error.riffetMessage
        }
    }
}

private func folderName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}

/// What a favorite is shown as: its label, else the folder's own name.
func favoriteName(_ favorite: FolderFavorite) -> String {
    favorite.label ?? folderName(favorite.path)
}

/// 重命名 / 取消收藏 for a favorite's context menu (order changes in edit mode: `.onMove` + `reorder`); [rename] asks for the name.
struct FolderFavoriteMenu: View {
    let model: FolderFavoritesModel
    let favorite: FolderFavorite
    let rename: () -> Void

    var body: some View {
        if favorite.exists {
            Button("重命名", systemImage: "pencil", action: rename)
        }
        Button("取消收藏", systemImage: "star.slash", role: .destructive) { Task { await model.remove(favorite) } }
    }
}

/// A favorite's row label: a star, its name and path, greyed with 不存在 when the folder is gone.
struct FolderFavoriteLabel: View {
    let favorite: FolderFavorite
    var showsPath = true
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "star.fill").foregroundStyle(favorite.exists ? palette.warning : palette.fg3)
            VStack(alignment: .leading, spacing: 2) {
                Text(favoriteName(favorite)).riffetFont(.body).foregroundStyle(favorite.exists ? palette.fg : palette.fg3).lineLimit(1)
                if showsPath || !favorite.exists {
                    Text(favorite.exists ? favorite.path : String(localized: "\(favorite.path) · 不存在", bundle: .riffet)).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// Asks for a favorite's display name, as an alert over whatever presents it.
struct FolderFavoriteRenameAlert: ViewModifier {
    let model: FolderFavoritesModel
    @Binding var target: FolderFavorite?
    @State private var draft = ""

    func body(content: Content) -> some View {
        content.alert("重命名收藏", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } })) {
            TextField(target.map { folderName($0.path) } ?? "", text: $draft)
            Button("取消", role: .cancel) { target = nil }
            Button("保存") {
                if let favorite = target { Task { await model.rename(favorite, to: draft) } }
                target = nil
            }
        } message: { Text("留空则显示目录名") }
        .onChange(of: target?.id) { _, _ in draft = target.map(favoriteName) ?? "" }
    }
}
