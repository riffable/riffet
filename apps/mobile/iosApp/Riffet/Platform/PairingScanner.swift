@preconcurrency import AVFoundation
import SwiftUI
import UIKit

enum ScannerFailure: LocalizedError, Equatable, Sendable {
    case permissionDenied, restricted, unavailable
    case configuration(String)
    case interrupted(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied: String(localized: "相机访问未获允许。请在系统设置中允许 Riffet 使用相机，或手动输入配对码。", bundle: .riffet)
        case .restricted: String(localized: "当前设备限制了相机访问，可以手动输入配对码。", bundle: .riffet)
        case .unavailable: String(localized: "此设备没有可用的相机，可以手动输入配对码。", bundle: .riffet)
        case .configuration(let message): String(localized: "无法启动扫描：\(message)", bundle: .riffet)
        case .interrupted(let message): String(localized: "扫描已中断：\(message)", bundle: .riffet)
        }
    }
}

/// Decodes exactly one QR per presentation. The shared PairingPayload parser validates its content.
struct PairingScanner: UIViewControllerRepresentable {
    let onDecoded: @MainActor (String) -> Void
    let onFailure: @MainActor (ScannerFailure) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        ScannerController(onDecoded: onDecoded, onFailure: onFailure)
    }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) { controller.stop() }
}

@MainActor
final class ScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    private let onDecoded: @MainActor (String) -> Void
    private let onFailure: @MainActor (ScannerFailure) -> Void
    private let engine = CaptureEngine()
    private var preview: AVCaptureVideoPreviewLayer?
    private var request: Task<Void, Never>?
    private var hasDecoded = false
    private var observers: [NSObjectProtocol] = []

    init(onDecoded: @escaping @MainActor (String) -> Void, onFailure: @escaping @MainActor (ScannerFailure) -> Void) {
        self.onDecoded = onDecoded
        self.onFailure = onFailure
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(onDecoded:onFailure:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.isAccessibilityElement = true
        view.accessibilityLabel = String(localized: "配对码扫描取景器", bundle: .riffet)
        view.accessibilityHint = String(localized: "将 Mac 上的 Riffet 配对二维码放入相机画面", bundle: .riffet)
        let preview = AVCaptureVideoPreviewLayer(session: engine.session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: engine.session, queue: .main) { [weak self] notification in
            let message = (notification.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription ?? String(localized: "相机服务不可用，请重新打开扫描。", bundle: .riffet)
            Task { @MainActor [weak self] in self?.onFailure(.interrupted(message)) }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: engine.session, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.onFailure(.interrupted(String(localized: "相机正被其他应用使用，或应用已进入后台。", bundle: .riffet))) }
        })
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        // RotationCoordinator keeps the preview upright on portrait and landscape iPhones.
        if let device = AVCaptureDevice.default(for: .video), let connection = preview?.connection {
            let rotation = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: preview)
            let angle = rotation.videoRotationAngleForHorizonLevelPreview
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !hasDecoded else { return }
        request = Task { [weak self] in
            let granted: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: granted = true
            case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .video)
            case .restricted: self?.onFailure(.restricted); return
            default: self?.onFailure(.permissionDenied); return
            }
            guard !Task.isCancelled, let self else { return }
            guard granted else { onFailure(.permissionDenied); return }
            engine.start(delegate: self) { [weak self] failure in
                Task { @MainActor [weak self] in
                    guard let self, self.viewIfLoaded?.window != nil else { return }
                    self.onFailure(failure)
                }
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stop() }
    func stop() { request?.cancel(); request = nil; engine.stop() }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !hasDecoded, let text = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        hasDecoded = true
        engine.stop()
        onDecoded(text)
    }

    deinit {
        request?.cancel()
        engine.stop()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }
}

/// AVCaptureSession configuration and blocking start/stop stay on one serial queue.
/// The preview layer only reads the session; UI callbacks are explicitly delivered on MainActor.
private final class CaptureEngine: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "io.github.riffable.camera")
    private var configured = false

    func start(delegate: AVCaptureMetadataOutputObjectsDelegate, failure: @escaping @Sendable (ScannerFailure) -> Void) {
        // AVCaptureMetadataOutput retains neither delegate nor queue; the view owns its lifetime.
        let delegateBox = DelegateReference(delegate)
        queue.async { [self] in
            do {
                if !configured {
                    guard let device = AVCaptureDevice.default(for: .video) else { failure(.unavailable); return }
                    let input = try AVCaptureDeviceInput(device: device)
                    let output = AVCaptureMetadataOutput()
                    session.beginConfiguration()
                    defer { session.commitConfiguration() }
                    guard session.canAddInput(input), session.canAddOutput(output) else { failure(.configuration(String(localized: "相机不支持二维码扫描。", bundle: .riffet))); return }
                    session.addInput(input)
                    session.addOutput(output)
                    guard output.availableMetadataObjectTypes.contains(.qr) else { failure(.configuration(String(localized: "相机不支持二维码扫描。", bundle: .riffet))); return }
                    output.setMetadataObjectsDelegate(delegateBox.value, queue: .main)
                    output.metadataObjectTypes = [.qr]
                    configured = true
                }
                session.startRunning()
            } catch { failure(.configuration(error.localizedDescription)) }
        }
    }
    func stop() { queue.async { [self] in if session.isRunning { session.stopRunning() } } }
}

private final class DelegateReference: @unchecked Sendable {
    weak var value: AVCaptureMetadataOutputObjectsDelegate?
    init(_ value: AVCaptureMetadataOutputObjectsDelegate) { self.value = value }
}
