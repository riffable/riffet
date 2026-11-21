import AVFoundation
import RiffetKit

/// The iPhone microphone for voice input: 16 kHz mono PCM16LE in exact 100 ms frames (3 200 bytes), each with its loudness.
final class IOSDictationMicrophone: NSObject, DictationMicrophone, @unchecked Sendable {
    private static let frameBytes = 3200
    /// Activating the audio session and starting the engine block for hundreds of milliseconds on a device (longer
    /// when Bluetooth switches to its call profile); on the main thread the press would show nothing until then.
    /// One serial queue keeps a stop's deactivation ahead of the next start's activation.
    private static let audio = DispatchQueue(label: "riffet.dictation.microphone", qos: .userInitiated)
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var interruptions: NSObjectProtocol?
    /// Bumped by every start and stop, so a permission answer or tap callback from an earlier run is ignored.
    private var run = 0

    func start(sink: any DictationSink) {
        lock.lock(); run += 1; let mine = run; lock.unlock()
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else { return self.fail(sink, .denied, mine) }
            Self.audio.async { self.begin(sink, mine) }
        }
    }

    func stop() {
        lock.lock(); run += 1; let running = engine; engine = nil; let watching = interruptions; interruptions = nil; lock.unlock()
        if let watching { NotificationCenter.default.removeObserver(watching) }
        guard let running else { return }
        Self.audio.async {
            running.inputNode.removeTap(onBus: 0)
            running.stop()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func current(_ mine: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return run == mine }

    private func fail(_ sink: any DictationSink, _ problem: MicrophoneProblem, _ mine: Int) {
        guard current(mine) else { return }
        sink.failed(problem: problem)
    }

    private func begin(_ sink: any DictationSink, _ mine: Int) {
        guard current(mine) else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
            try session.setActive(true)
        } catch { return fail(sink, .failed, mine) }
        // From here the session is active: a start that gives up hands it back.
        func giveUp(_ problem: MicrophoneProblem) {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            fail(sink, problem, mine)
        }
        guard session.isInputAvailable else { return giveUp(.noMicrophone) }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return giveUp(.noMicrophone) }
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else { return giveUp(.failed) }
        let pending = Pending()
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self, self.current(mine) else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / format.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in
                if supplied { inputStatus.pointee = .noDataNow; return nil }
                supplied = true
                inputStatus.pointee = .haveData
                return buffer
            }
            guard status != .error, error == nil, let samples = out.int16ChannelData, out.frameLength > 0 else { return }
            pending.bytes.append(UnsafeBufferPointer(start: samples[0], count: Int(out.frameLength)).withMemoryRebound(to: UInt8.self) { Data($0) })
            while pending.bytes.count >= Self.frameBytes {
                let frame = Data(pending.bytes.prefix(Self.frameBytes))
                pending.bytes.removeFirst(Self.frameBytes)
                sink.frame(pcm: byteArrayFromData(data: frame), level: Self.level(frame))
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return giveUp(.failed)
        }
        // A call or another app taking the microphone ends the recording: what was said is finished.
        let watching = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            guard let self, self.current(mine),
                  (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .began else { return }
            self.stop()
            sink.interrupted()
        }
        lock.lock()
        if run == mine { self.engine = engine; self.interruptions = watching; lock.unlock() }
        else {
            // Stopped while this start was under way: nothing else holds this engine or the session it activated.
            lock.unlock(); NotificationCenter.default.removeObserver(watching); input.removeTap(onBus: 0); engine.stop()
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Root-mean-square of the frame, as the web's capture worklet and Android measure it.
    private static func level(_ frame: Data) -> Float {
        let count = frame.count / 2
        guard count > 0 else { return 0 }
        let sum = frame.withUnsafeBytes { raw -> Float in
            raw.bindMemory(to: Int16.self).reduce(0) { $0 + (Float($1) / 32768) * (Float($1) / 32768) }
        }
        return min(1, (sum / Float(count)).squareRoot())
    }

    private final class Pending { var bytes = Data() }
}
