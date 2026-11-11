import QuickLook
import SwiftUI
import UIKit

/// System export/share sheet; passing local file URLs also offers “Save to Files”.
struct NativeShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onComplete: ((Bool) -> Void)?

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, _ in onComplete?(completed) }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Local, already authenticated/downloaded file only; never exposes a bearer token to QuickLook.
struct FilePreview: UIViewControllerRepresentable {
    let url: URL
    var title: String?

    func makeCoordinator() -> Coordinator { Coordinator(url: url, title: title) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.item.url != url || context.coordinator.item.title != title else { return }
        context.coordinator.item = PreviewItem(url: url, title: title)
        controller.reloadData()
    }

    @MainActor final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var item: PreviewItem
        init(url: URL, title: String?) { item = PreviewItem(url: url, title: title) }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { item }
    }
}

final class PreviewItem: NSObject, QLPreviewItem {
    let url: URL
    let title: String?
    var previewItemURL: URL? { url }
    var previewItemTitle: String? { title }
    init(url: URL, title: String?) { self.url = url; self.title = title }
}
