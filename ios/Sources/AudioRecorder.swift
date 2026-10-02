import AVFoundation

enum RecorderError: LocalizedError, Equatable {
    case denied
    case noInput

    var errorDescription: String? {
        switch self {
        case .denied: return "Mikrofon-Zugriff wurde nicht erlaubt."
        case .noInput: return "Kein Mikrofon gefunden."
        }
    }
}

/// Nimmt nativ auf (läuft auch im Hintergrund und bei gesperrtem Handy weiter).
/// Schreibt alle 4 Minuten eine neue, fertige .m4a-Datei, die die Web-Oberfläche abholt.
final class AudioRecorder {
    static let shared = AudioRecorder()

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var fileStarted = Date()
    private var format: AVAudioFormat?
    private var tapInstalled = false
    private var observers: [NSObjectProtocol] = []
    private var lastEngineStart = Date.distantPast
    private var level: Float = 0

    private(set) var isRecording = false
    private(set) var startedAt: Date?
    private(set) var tag = ""
    private(set) var interruptions = 0

    private let segmentSeconds: TimeInterval = 240

    private lazy var baseDir: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Aufnahmen", isDirectory: true)
        for sub in ["fertig", "laufend"] {
            try? FileManager.default.createDirectory(at: dir.appendingPathComponent(sub, isDirectory: true),
                                                     withIntermediateDirectories: true)
        }
        return dir
    }()
    private var readyDir: URL { baseDir.appendingPathComponent("fertig", isDirectory: true) }
    private var activeDir: URL { baseDir.appendingPathComponent("laufend", isDirectory: true) }

    var startedAtMs: Double { (startedAt?.timeIntervalSince1970 ?? 0) * 1000 }

    // MARK: - Start / Stop

    func start(tag: String, completion: @escaping (Result<Void, Error>) -> Void) {
        if isRecording { completion(.success(())); return }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async {
                guard granted else { completion(.failure(RecorderError.denied)); return }
                do {
                    try self.configureSession()
                    self.tag = tag
                    try self.startEngine()
                    self.interruptions = 0
                    self.startedAt = Date()
                    self.isRecording = true
                    self.observe()
                    completion(.success(()))
                } catch {
                    self.teardownEngine()
                    completion(.failure(error))
                }
            }
        }
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        teardownEngine()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func status() -> [String: Any] {
        [
            "recording": isRecording,
            "startedAt": startedAtMs,
            "tag": tag,
            "level": Double(level),
            "interruptions": interruptions,
        ]
    }

    // MARK: - Fertige Stücke abholen

    func collect(max: Int = 3) -> [[String: Any]] {
        let fm = FileManager.default
        let files = ((try? fm.contentsOfDirectory(at: readyDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "m4a" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        var result: [[String: Any]] = []
        for url in files {
            if result.count >= max { break }
            var seconds = 0.0
            if let f = try? AVAudioFile(forReading: url), f.fileFormat.sampleRate > 0 {
                seconds = Double(f.length) / f.fileFormat.sampleRate
            }
            guard seconds > 0.3, let data = try? Data(contentsOf: url) else {
                try? fm.removeItem(at: url) // leer oder kaputt
                continue
            }
            result.append([
                "id": url.lastPathComponent,
                "tag": Self.tag(from: url.lastPathComponent),
                "data": data.base64EncodedString(),
                "mime": "audio/mp4",
                "seconds": seconds,
            ])
        }
        return result
    }

    func ack(_ ids: [String]) {
        for id in ids {
            let name = (id as NSString).lastPathComponent
            guard name.hasSuffix(".m4a") else { continue }
            try? FileManager.default.removeItem(at: readyDir.appendingPathComponent(name))
        }
    }

    /// Dateiname: seg-<Zeit in ms>-<Aufnahme-ID>.m4a
    private static func tag(from name: String) -> String {
        let base = (name as NSString).deletingPathExtension
        let parts = base.split(separator: "-", maxSplits: 2, omittingEmptySubsequences: false)
        return parts.count == 3 ? String(parts[2]) : ""
    }

    // MARK: - Audio

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default,
                                options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker])
        try session.setActive(true)
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { throw RecorderError.noInput }
        format = fmt
        try withLock { try openFileLocked(format: fmt) }
        if tapInstalled { input.removeTap(onBus: 0) }
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buffer, _ in
            self?.write(buffer)
        }
        tapInstalled = true
        engine.prepare()
        lastEngineStart = Date()
        try engine.start()
    }

    private func teardownEngine() {
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine.stop()
        withLock { finishFileLocked() }
    }

    private func restart() {
        guard isRecording else { return }
        interruptions += 1
        teardownEngine()
        do {
            try configureSession()
            try startEngine()
        } catch {
            NSLog("Plaude: Neustart fehlgeschlagen: \(error)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, self.isRecording, !self.engine.isRunning else { return }
                do {
                    try self.configureSession()
                    try self.startEngine()
                } catch {
                    NSLog("Plaude: Zweiter Neustart fehlgeschlagen: \(error)")
                }
            }
        }
    }

    private func observe() {
        let nc = NotificationCenter.default
        // Anruf, Siri, Wecker …: Stück sichern, danach weiter aufnehmen
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, self.isRecording,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                self.withLock { self.finishFileLocked() }
            } else {
                self.restart()
            }
        })
        // Kopfhörer rein/raus usw.
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self, self.isRecording, Date().timeIntervalSince(self.lastEngineStart) > 1 else { return }
            self.restart()
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.restart()
        })
    }

    private func write(_ buffer: AVAudioPCMBuffer) {
        updateLevel(buffer)
        withLock {
            guard self.file != nil else { return }
            do {
                try self.file?.write(from: buffer)
            } catch {
                NSLog("Plaude: Schreiben fehlgeschlagen: \(error)")
            }
            if Date().timeIntervalSince(self.fileStarted) >= self.segmentSeconds, let fmt = self.format {
                self.finishFileLocked()
                try? self.openFileLocked(format: fmt)
            }
        }
    }

    private func updateLevel(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += samples[i] * samples[i] }
        level = min(1, (sum / Float(n)).squareRoot() * 4)
    }

    private func openFileLocked(format fmt: AVAudioFormat) throws {
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let safeTag = tag.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let url = activeDir.appendingPathComponent("seg-\(ms)-\(safeTag).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: fmt.sampleRate,
            AVNumberOfChannelsKey: fmt.channelCount,
            AVEncoderBitRateKey: fmt.sampleRate >= 32000 ? 64000 : 32000,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings,
                               commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
        fileURL = url
        fileStarted = Date()
    }

    /// Schließt die aktuelle Datei und legt sie zum Abholen bereit.
    private func finishFileLocked() {
        guard let url = fileURL else { return }
        file = nil // beim Freigeben wird die Datei abgeschlossen
        fileURL = nil
        try? FileManager.default.moveItem(at: url, to: readyDir.appendingPathComponent(url.lastPathComponent))
    }

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}
