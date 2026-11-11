import AppKit
import SwiftUI
import RiffetKit

struct BackupSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var busy = false
    @State private var error: String?
    @State private var receipt: BackupReceipt?
    /// The backup and the empty folder picked for the restore command.
    @State private var restore: (backup: String, target: String)?

    /// What `POST /api/system/backup` answers: where the backup went and how many files it holds.
    private struct BackupReceipt {
        let path: String
        let files: Int?
    }

    var body: some View {
        // Restoring needs no running server, so the pane stays when disconnected.
        Form {
            SettingsBlock(String(localized: "备份"), detail: contents) {
                if let workbench = model.workbench {
                    HStack(spacing: Space.sm) {
                        SettingsActionButton(
                            busy ? "备份中…" : "创建备份",
                            symbol: "externaldrive.badge.plus",
                            kind: .primary
                        ) {
                            Task { await create(workbench) }
                        }
                        .disabled(busy)
                        if busy { Spinner(size: .small) }
                        Spacer(minLength: 0)
                    }
                } else {
                    SettingsHint("连接服务器后可备份。", symbol: "network.slash")
                }
                if let receipt {
                    SettingsRow(String(localized: "最新备份"), detail: receipt.files.map { String(localized: "\($0) 个文件") }) {
                        HStack(spacing: Space.xs) {
                            Text(receipt.path)
                                .font(.riffet(size: S(12), design: .monospaced))
                                .foregroundStyle(palette.fg2)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                                .frame(maxWidth: 280, alignment: .trailing)
                                .help(receipt.path)
                            CopyButton(text: receipt.path, help: String(localized: "复制备份位置"))
                            if model.target == .local {
                                Button {
                                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: receipt.path)])
                                } label: {
                                    Image(icon: "folder")
                                }
                                .buttonStyle(.borderless)
                                .help("在访达中显示")
                            }
                        }
                    }
                }
                SettingsErrorText(message: error)
            }
            SettingsBlock("恢复", detail: "在服务器执行；完成后用目标目录启动。") {
                if model.target == .local {
                    SettingsRow("从备份恢复", detail: restore == nil ? "目标目录必须为空。" : nil) {
                        SettingsActionButton(restore == nil ? "生成恢复命令…" : "重新选择…", symbol: "folder") { chooseRestore() }
                            .controlSize(.small)
                    }
                    if let restore {
                        let command = restoreCommand(restore)
                        HStack(alignment: .top, spacing: Space.sm) {
                            Text(command)
                                .font(.riffet(size: S(11.5), design: .monospaced))
                                .foregroundStyle(palette.fg2)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            CopyButton(text: command, help: String(localized: "复制恢复命令"))
                        }
                        .padding(Space.sm)
                        .background(palette.formFill(palette.bgSubtle), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                .strokeBorder(palette.lineSoft)
                        )
                    }
                } else {
                    // The backups and the CLI are on the server's machine; only it can restore.
                    SettingsHint("在运行服务器的电脑上执行 riffet restore。", symbol: "terminal")
                }
            }
        }
        .riffetForm()
    }

    private var contents: String {
        model.workbench?.supportsProjectlessTasks == true ? String(localized: "包含凭证，不含任务工作文件。") : String(localized: "包含凭证。")
    }

    /// A command this Mac can run as it is: the App's bundled server when it carries one, the
    /// checkout it was built from, or else the `riffet` command line.
    private func restoreCommand(_ restore: (backup: String, target: String)) -> String {
        "\(cliCommand) restore --backup \(quoted(restore.backup)) --state-dir \(quoted(restore.target))"
    }

    private var cliCommand: String {
        let server = Bundle.main.bundleURL.appending(path: "Contents/Resources/server")
        let node = server.appending(path: "bin/node").path
        let cli = server.appending(path: "dist/cli.js").path
        if FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: cli) {
            return "\(quoted(node)) \(quoted(cli))"
        }
        if let root = AppBuildRecord.bundled?.sourceRoot, !root.isEmpty {
            return "node \(quoted(root + "/dist/cli.js"))"
        }
        return "riffet"
    }

    private func quoted(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Picks the backup, then an empty folder to restore into, and fills both into the command.
    private func chooseRestore() {
        let source = NSOpenPanel()
        source.canChooseDirectories = true
        source.canChooseFiles = false
        source.allowsMultipleSelection = false
        source.prompt = String(localized: "选择备份")
        source.directoryURL = model.server.stateDirectory.appendingPathComponent("backups")
        guard source.runModal() == .OK, let backup = source.url else { return }
        let target = NSOpenPanel()
        target.canChooseDirectories = true
        target.canChooseFiles = false
        target.canCreateDirectories = true
        target.allowsMultipleSelection = false
        target.prompt = String(localized: "恢复到这里")
        guard target.runModal() == .OK, let destination = target.url else { return }
        restore = (backup.path, destination.path)
    }

    private func create(_ workbench: Workbench) async {
        guard let api = workbench.host.api else { return }
        busy = true
        error = nil
        do {
            let text = try await api.backup()
            let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
            receipt = BackupReceipt(path: object?["path"] as? String ?? text, files: object?["files"] as? Int)
        } catch {
            self.error = error.riffetMessage
        }
        busy = false
    }
}
