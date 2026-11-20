import SwiftUI
import UIKit
import RiffetKit

/// The edit page for a project text file (mobile.md §2.3): a sheet with Cancel and Save in the bar and
/// the text filling the rest. The page owns the draft; `save` returns the error text to show under the
/// editor, or nil once the file is written and the sheet may close.
struct ProjectFileEditor: View {
    let path: String
    let original: String
    let save: (_ content: String, _ overwrite: Bool) async -> ProjectFileSaveOutcome
    /// `reload` asks the page to read the file again, after the reader gave up their edits.
    let close: (_ reload: Bool) -> Void
    @Environment(\.palette) private var palette
    @State private var text: String
    @State private var saving = false
    @State private var confirming = false
    @State private var failure: String?
    @State private var conflict = false

    init(path: String, original: String, save: @escaping (String, Bool) async -> ProjectFileSaveOutcome, close: @escaping (Bool) -> Void) {
        self.path = path; self.original = original; self.save = save; self.close = close
        _text = State(initialValue: original)
    }

    private var dirty: Bool { text != original }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                Text(path).riffetFont(.monoSmall).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                    .padding(.horizontal, RiffetMetrics.pageInset).padding(.vertical, RiffetMetrics.floatingGap)
                ProjectFileTextView(text: $text, editable: !saving)
                if let failure {
                    Text(failure).riffetFont(.caption).foregroundStyle(palette.danger)
                        .padding(.horizontal, RiffetMetrics.pageInset).padding(.vertical, RiffetMetrics.floatingGap)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(palette.bg)
            .navigationTitle((path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "取消", bundle: .riffet)) { if dirty { confirming = true } else { close(false) } }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() }
                    else { Button(String(localized: "保存", bundle: .riffet)) { Task { await submit(overwrite: false) } }.disabled(!dirty) }
                }
            }
            .confirmationDialog(String(localized: "文件已在别处改动", bundle: .riffet), isPresented: $conflict, titleVisibility: .visible) {
                Button(String(localized: "覆盖保存", bundle: .riffet)) { Task { await submit(overwrite: true) } }
                Button(String(localized: "放弃我的修改", bundle: .riffet), role: .destructive) { close(true) }
                Button(String(localized: "取消", bundle: .riffet), role: .cancel) {}
            }
        }
        .riffetUnsavedGuard(dirty: dirty, locked: saving, confirming: $confirming, discard: { close(false) })
    }

    private func submit(overwrite: Bool) async {
        saving = true; failure = nil
        let outcome = await save(text, overwrite)
        saving = false
        switch outcome {
        case .saved: close(true)
        case .changed: conflict = true
        case .failed(let message): failure = message
        }
    }
}

enum ProjectFileSaveOutcome { case saved, changed, failed(String) }

/// A UITextView holds a large file far better than TextEditor: no per-keystroke diffing of the whole
/// string by SwiftUI, and the typing aids that corrupt code are off.
private struct ProjectFileTextView: UIViewRepresentable {
    @Binding var text: String
    let editable: Bool
    @Environment(\.palette) private var palette

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.autocapitalizationType = .none
        view.keyboardDismissMode = .interactive
        view.alwaysBounceVertical = true
        view.textContainerInset = UIEdgeInsets(top: 8, left: RiffetMetrics.pageInset - 5, bottom: 8, right: RiffetMetrics.pageInset - 5)
        view.text = text
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        view.backgroundColor = UIColor(palette.bg)
        view.textColor = UIColor(palette.fg)
        view.tintColor = UIColor(palette.accent)
        view.isEditable = editable
        if view.text != text { view.text = text }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        let text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func textViewDidChange(_ view: UITextView) { text.wrappedValue = view.text }
    }
}
