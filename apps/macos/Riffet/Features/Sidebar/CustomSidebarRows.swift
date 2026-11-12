import AppKit
import SwiftUI
import RiffetKit

/// The fill of a row of the drawn sidebar: a block when picked, a lighter one under the pointer.
@MainActor
private func rowFill(_ palette: Palette, style: StyleSpec, selected: Bool, hovering: Bool) -> Color {
    if selected { return style.selection == .block ? palette.bgActive : palette.bgHover }
    return hovering ? palette.bgHover : .clear
}

/// The icon column every row shares, so titles line up under one another.
private let iconColumn: CGFloat = 16
private let rowInset: CGFloat = Space.sm + Space.xxs
/// The main actions keep one height in every style; the conversations below take the style's row.
private let navRow: CGFloat = 32

/// An icon and a title in the main actions: new conversation, search, pages, menus.
struct CustomNavRow: View {
    let symbol: String
    let title: String
    var trailing: String?
    var selected = false
    var anchor: MenuAnchor?
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
                    .font(.riffet(size: S(style.text.body)))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let trailing {
                    Text(trailing).font(.riffet(size: S(style.text.label))).foregroundStyle(palette.fg4)
                }
            }
            .padding(.horizontal, rowInset)
            .frame(maxWidth: .infinity, minHeight: navRow, maxHeight: navRow, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(rowFill(palette, style: style, selected: selected, hovering: hovering))
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
    @ViewBuilder let trailing: Trailing
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(title)
                .font(.riffet(size: S(style.text.label)))
                .foregroundStyle(palette.fg4)
            Spacer(minLength: 0)
            trailing
        }
        .padding(.leading, rowInset)
        .padding(.trailing, Space.xs)
        .padding(.top, Space.sm)
        .frame(height: style.layout.sidebarRow)
    }
}

/// A foldable band of the time layout: dark, medium, with a chevron that turns when it folds, and
/// its buttons at the trailing edge.
struct CustomGroupTitle<Trailing: View>: View {
    let title: String
    let expanded: Bool
    let style: StyleSpec
    let toggle: () -> Void
    @ViewBuilder let trailing: Trailing
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: Space.xs + Space.xxs) {
                    Text(title)
                        .font(.riffet(size: S(style.text.body), weight: .medium))
                        .foregroundStyle(palette.fg)
                    // A solid caret, wider than it is tall, as Claude Desktop draws its bands' toggles.
                    Caret()
                        .fill(palette.fg3)
                        .frame(width: S(7), height: S(4))
                        .rotationEffect(.degrees(expanded ? 0 : -90))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            trailing.buttonStyle(IconButtonStyle(size: 24))
        }
        .padding(.leading, rowInset)
        .padding(.trailing, Space.xxs)
        .frame(height: style.layout.sidebarRow)
    }
}

/// A downward triangle with softened corners.
private struct Caret: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.closeSubpath()
        return path.strokedPath(StrokeStyle(lineWidth: 1, lineJoin: .round)).union(path)
    }
}

/// One conversation. Rows compare by what they show, so re-rendering the list re-draws only the
/// rows that changed, as the native sidebar's rows do.
struct CustomSessionRow: View, Equatable {
    let session: Session
    /// The hover card's text, composed only as the card is about to show.
    let info: () -> SessionHoverInfo
    let selected: Bool
    /// The agent's mark leads the row.
    let leadingAgent: Bool
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
        lhs.session == rhs.session && lhs.selected == rhs.selected && lhs.leadingAgent == rhs.leadingAgent
            && lhs.activity == rhs.activity && lhs.style == rhs.style
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.sm) {
                if leadingAgent, let agent = session.agent {
                    AgentIcon(id: agent, size: 14, color: agentMarkColor(agent, palette) ?? palette.fg3)
                        .frame(width: iconColumn)
                }
                Text(session.title.isEmpty ? String(localized: "新会话") : session.title)
                    .font(.riffet(size: S(style.text.body)))
                    .lineLimit(1)
                    .foregroundStyle(session.archivedAt != nil ? palette.fg3 : selected ? palette.fg : palette.fg2)
                Spacer(minLength: Space.xs)
                trailing
            }
            .padding(.horizontal, rowInset)
            .frame(maxWidth: .infinity, minHeight: style.layout.sidebarRow, maxHeight: style.layout.sidebarRow, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(rowFill(palette, style: style, selected: selected, hovering: hovering))
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
        if SessionStateMark.shows(session.state) {
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
/// the folder gives way to a chevron under the pointer. The menu and its dialogs are shared with `ProjectHeader`.
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
                        .font(.riffet(size: S(style.text.body)))
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

/// 任务 | 对话: the two homes a new conversation starts from, as a sliding pair.
struct CustomModeSwitch: View {
    let workbench: Workbench
    let style: StyleSpec
    @Environment(\.palette) private var palette

    /// A raised switch sets the chosen half 3pt inside the track on a shadow; an outlined one, as
    /// Claude Desktop draws it, fills the half to the track's edge and lets its hairline be that edge.
    private var inset: CGFloat { style.surface == .outlined ? 0 : 3 }

    var body: some View {
        let chat = workbench.homeIsQuickChat || workbench.openSessionIsQuickChat
        HStack(spacing: style.surface == .outlined ? 0 : Space.xxs) {
            segment(String(localized: "任务"), symbol: "chevron.left.forwardslash.chevron.right", on: !chat) { workbench.showHomeTab(quickChat: false) }
            segment(String(localized: "对话"), symbol: "bubble.left", on: chat) { workbench.showHomeTab(quickChat: true) }
        }
        .padding(inset)
        // An outlined style keeps the track a shade under the rows' own fill, as Claude Desktop does.
        .background(style.surface == .outlined ? palette.bgHover : palette.bgActive, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
    }

    private func segment(_ title: String, symbol: String, on: Bool, action: @escaping () -> Void) -> some View {
        // Concentric with the track.
        let shape = RoundedRectangle(cornerRadius: max(Radius.container - inset, 2), style: .continuous)
        return Button(action: action) {
            HStack(spacing: Space.xs + Space.xxs) {
                Image(icon: symbol).font(.riffet(size: S(style.text.secondary - 1)))
                Text(title).font(.riffet(size: S(style.text.body)))
            }
            .foregroundStyle(on ? palette.fg : palette.fg3)
            .frame(maxWidth: .infinity, minHeight: style.layout.sidebarRow - 6, maxHeight: style.layout.sidebarRow - 6)
            .background(
                shape
                    .fill(on ? palette.bgElevated : .clear)
                    // Lifted by a shadow, or drawn by a hairline (`StyleSpec.Surface`).
                    .shadow(color: .black.opacity(on && style.surface == .raised ? 0.12 : 0), radius: 1, y: 0.5)
                    .overlay(shape.strokeBorder(on && style.surface == .outlined ? palette.line : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
