import AVFAudio
import Foundation
import OSLog

struct AudioPacket: Sendable {
    let samples: Data
    let sampleRate: Double
}

nonisolated func makeAudioTap(
    continuation: AsyncStream<AudioPacket>.Continuation,
    sampleRate: Double
) -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
    return { buffer, _ in
        guard let channel = buffer.floatChannelData?[0] else { return }
        let data = Data(bytes: channel, count: Int(buffer.frameLength) * MemoryLayout<Float>.size)
        if case .dropped = continuation.yield(AudioPacket(samples: data, sampleRate: sampleRate)) {
            continuation.finish()
        }
    }
}

@MainActor
final class NativeAudio {
    private let logger = Logger(subsystem: "rs.vxn.nook", category: "capture")
    private var engine: AVAudioEngine?
    private var consumer: Task<Void, Never>?
    private var continuation: AsyncStream<AudioPacket>.Continuation?
    private var pending = Data()
    private var failure: String?
    private var activeID: String?
    private var stopping = 0
    private var totalBytes = 0
    private var converter: PCMConverter?

    func start(id: String) async throws {
        guard activeID == nil, stopping == 0 else { throw CaptureError("A recording is already active") }
        activeID = id
        pending.removeAll(keepingCapacity: true)
        totalBytes = 0
        failure = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            if activeID == id { activeID = nil }
            throw CaptureError("Microphone access is disabled. Enable it in Settings for Nook.")
        }
        guard activeID == id else { throw CaptureError("Recording canceled") }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError("No microphone is available") }
            self.converter = try PCMConverter(sampleRate: format.sampleRate)
            let (stream, continuation) = AsyncStream<AudioPacket>.makeStream(bufferingPolicy: .bufferingOldest(8))
            self.continuation = continuation
            let rate = format.sampleRate
            input.installTap(onBus: 0, bufferSize: 4096, format: format,
                             block: makeAudioTap(continuation: continuation, sampleRate: rate))
            self.engine = engine
            consumer = Task { [weak self] in
                for await packet in stream {
                    guard let self, self.activeID == id else { return }
                    self.consume(packet)
                }
                if let self, self.engine?.isRunning == true { self.fail("Microphone buffer overflow") }
            }
            try engine.start()
            logger.info("Native microphone started")
        } catch {
            await cancel(id: id)
            throw error
        }
    }

    private func consume(_ packet: AudioPacket) {
        guard failure == nil, let converter else { return }
        do { append(try converter.convert(packet.samples)) }
        catch { fail("Microphone conversion failed") }
    }

    private func append(_ data: Data) {
        totalBytes += data.count
        guard totalBytes <= 5 * 60 * 24_000 * 2, pending.count + data.count <= 96_000 else {
            fail("Recording limit reached or audio delivery stalled")
            return
        }
        pending.append(data)
    }

    private func fail(_ message: String) {
        failure = message
        engine?.stop()
        logger.error("Native microphone stopped: \(message, privacy: .public)")
    }

    func read(id: String) throws -> String {
        guard activeID == id else { throw CaptureError("Recording is no longer active") }
        if let failure { throw CaptureError(failure) }
        let data = pending
        pending.removeAll(keepingCapacity: true)
        return data.base64EncodedString()
    }

    func stop(id: String) async throws -> String {
        guard activeID == id else { throw CaptureError("Recording is no longer active") }
        await stopEngine()
        defer { if activeID == id { activeID = nil } }
        return try read(id: id)
    }

    func cancel(id: String? = nil) async {
        if let id, id != activeID { return }
        activeID = nil
        await stopEngine()
        pending.removeAll()
    }

    private func stopEngine() async {
        stopping += 1
        defer { stopping -= 1 }
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        continuation?.finish()
        continuation = nil
        await consumer?.value
        consumer = nil
        if activeID != nil, failure == nil, let converter {
            do { append(try converter.finish()) }
            catch { fail("Microphone flush failed") }
        }
        converter = nil
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { logger.error("Audio session deactivation failed: \(error.localizedDescription, privacy: .public)") }
        logger.info("Native microphone released")
    }
}

struct CaptureError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
