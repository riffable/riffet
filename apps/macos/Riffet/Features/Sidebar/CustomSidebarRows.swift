import AppKit
import SwiftUI
import RiffetKit

/// The fill of a row of the drawn sidebar: a block when picked, a lighter one under the pointer.
@MainActor
private func rowFill(_ palette: Palette, selected: Bool, hovering: Bool) -> Color {
    if selected { return palette.bgActive }
    return hovering ? palette.bgHover : .clear
}

/// The icon column every row shares, so titles line up under one another.
private let iconColumn: CGFloat = 16
private let rowInset: CGFloat = Space.sm + Space.xxs
/// The main actions keep one height; the conversations below take `StyleSpec.Layout.sidebarRow`.
private let navRow: CGFloat = 32

/// An icon and a title in the main actions: new conversation, search, pages, menus.
struct CustomNavRow: View {
    let symbol: String
    let title: String
    var trailing: String?
    var selected = false
    var anchor: MenuAnchor?
    /// A status at the end of the row, such as the assistant's conversation running.
    var mark: AnyView?
    let style: StyleSpec
    let action: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: rowInset) {
                // A symbol's box is 1.26× its font: 12pt draws the web's 15px nav glyph.
                Image(icon: symbol)
                    .font(.riffet(size: S(style.text.body - 2), weight: .regular))
                    .foregroundStyle(palette.fg2)
                    .frame(width: iconColumn)
                Text(title)
                    .font(.riffet(size: S(style.text.sidebar)))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let trailing {
                    Text(trailing).font(.riffet(size: S(style.text.label))).foregroundStyle(palette.fg4)
                }
                if let mark { mark }
            }
            .padding(.horizontal, rowInset)
            .frame(maxWidth: .infinity, minHeight: navRow, maxHeight: navRow, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(rowFill(palette, selected: selected, hovering: hovering))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background { if let anchor { MenuAnchorView(anchor: anchor) } }
        .onHover { hovering = $0 }
    }
}

/// A quiet row under a list: 展开其余 N 个会话, 显示更多.
struct CustomLinkRow: View {
    let symbol: String?
    let title: String
    let style: StyleSpec
    let action: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                if let symbol {
                    Image(icon: symbol)
                        .font(.riffet(size: S(style.text.label), weight: .semibold))
                        .foregroundStyle(palette.fg4)
                        .frame(width: iconColumn)
                }
                Text(title)
                    .font(.riffet(size: S(style.text.secondary)))
                    .foregroundStyle(hovering ? palette.fg2 : palette.fg3)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, rowInset)
            .frame(maxWidth: .infinity, minHeight: style.layout.sidebarRow, maxHeight: style.layout.sidebarRow, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The label over a tree's projects: small, quiet, with its buttons at the trailing edge.
struct CustomSectionTitle<Trailing: View>: View {
    let title: String
    let style: StyleSpec
    /// The buttons show while the pointer is on the row, as on the web; a row that is nothing but
    /// its buttons keeps them.
    var buttonsOnHover = true
    @ViewBuilder let trailing: Trailing
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(title)
                .font(.riffet(size: S(style.text.label)))
                .foregroundStyle(palette.fg4)
            Spacer(minLength: 0)
            trailing
                .opacity(!buttonsOnHover || hovering ? 1 : 0)
                .animation(Motion.fast, value: hovering)
        }
        .padding(.leading, rowInset)
        .padding(.trailing, Space.xs)
        .padding(.top, Space.sm)
        .frame(height: style.layout.sidebarRow)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// One conversation. Rows compare by what they show, so re-rendering the list re-draws only the
/// rows that changed.
struct CustomSessionRow: View, Equatable {
    let session: Session
    /// The hover card's text, composed only as the card is about to show.
    let info: () -> SessionHoverInfo
    let selected: Bool
    /// The title sits under its project's name, past the icon column.
    let indented: Bool
    /// The relative time, shown at the trailing edge while no state or mark takes it.
    let activity: String?
    let style: StyleSpec
    let menu: SessionRowMenu
    let hover: (Bool) -> Void
    let open: () -> Void
    @Environment(\.palette) private var palette
    @State private var anchorBox = HoverAnchorBox()
    @State private var hovering = false

    static func == (lhs: CustomSessionRow, rhs: CustomSessionRow) -> Bool {
        lhs.session == rhs.session && lhs.selected == rhs.selected && lhs.indented == rhs.indented
            && lhs.activity == rhs.activity && lhs.style == rhs.style
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.sm) {
                if indented { Color.clear.frame(width: iconColumn, height: 0) }
                Text(session.shownTitle.isEmpty ? String(localized: "新会话") : session.shownTitle)
                    .font(.riffet(size: S(style.text.sidebar)))
                    .lineLimit(1)
                    .foregroundStyle(session.archivedAt != nil ? palette.fg3 : selected ? palette.fg : palette.fg2)
                Spacer(minLength: Space.xs)
                trailing
            }
            .padding(.horizontal, rowInset)
            .frame(maxWidth: .infinity, minHeight: style.layout.sidebarRow, maxHeight: style.layout.sidebarRow, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(rowFill(palette, selected: selected, hovering: hovering))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sessionRowHover(box: anchorBox, info: info) { entered in
            hovering = entered
            hover(entered)
        }
        .contextMenu { SessionRowMenuItems(session: session, menu: menu) }
    }

    /// The state when it asks for attention, else the mark and the time.
    @ViewBuilder private var trailing: some View {
        if SessionStateMark.shows(session.state, unread: !selected && UnreadStore.shared.isUnread(session)) {
            SessionStateMark(state: session.state)
        } else if session.terminalHold != nil {
            Image(icon: "terminal")
                .font(.riffet(size: S(style.text.label)))
                .foregroundStyle(palette.fg4)
                .help("在终端中")
        } else {
            if let activity {
                Text(activity)
                    .font(.riffet(size: S(style.text.label)))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
        }
    }
}

/// A project of the tree: folder, name, a plus for a new conversation. The row folds its conversations;
/// the folder gives way to a chevron under the pointer.
struct CustomProjectRow: View {
    let workbench: Workbench
    let project: Project
    let favorites: FolderFavoritesModel
    let expanded: Bool
    let style: StyleSpec
    let toggle: () -> Void
    @Environment(\.palette) private var palette
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: Space.sm) {
                    Image(icon: hovering ? (expanded ? "chevron.down" : "chevron.right") : "folder")
                        .font(.riffet(size: S(style.text.body - 3), weight: hovering ? .semibold : .regular))
                        .foregroundStyle(palette.fg2)
                        .frame(width: iconColumn)
                    Text(project.name)
                        .font(.riffet(size: S(style.text.sidebar)))
                        .foregroundStyle(palette.fg)
                        .lineLimit(1)
                    if let worktree = project.worktree {
                        Text(worktree.branch).font(.riffet(size: S(style.text.label), design: .monospaced)).foregroundStyle(palette.fg4).lineLimit(1)
                    }
                    ForEach((project.tags ?? []).prefix(2), id: \.self) { tag in
                        Text(tag).font(.riffet(size: S(style.text.label - 1))).foregroundStyle(palette.fg4)
                            .padding(.horizontal, 4).background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.control))
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button {
                if project.isTaskWorkspace { workbench.selectHomeProject(nil); workbench.showHome() }
                else { workbench.showHome(projectId: project.id) }
            } label: { Image(icon: "plus").font(.riffet(size: S(style.text.label), weight: .semibold)) }
                .buttonStyle(IconButtonStyle(size: 24))
                .opacity(hovering ? 1 : 0)
                .help("在 \(project.name) 中新建会话")
                .accessibilityLabel("在 \(project.name) 中新建会话")
        }
        .padding(.leading, rowInset)
        .padding(.trailing, Space.xs)
        .frame(maxWidth: .infinity, minHeight: style.layout.sidebarRow, maxHeight: style.layout.sidebarRow, alignment: .leading)
        .opacity(project.archivedAt == nil ? 1 : 0.6)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .projectActions(workbench: workbench, project: project, favorites: favorites)
    }
}
