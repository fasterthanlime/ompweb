import AVFAudio
import Foundation
import Testing
@testable import Nook

@MainActor
struct PCMConverterTests {
    @Test
    func audioTapRunsOnAudioExecutor() async throws {
        let (stream, continuation) = AsyncStream<AudioPacket>.makeStream(bufferingPolicy: .bufferingOldest(8))
        let tap = makeAudioTap(continuation: continuation, sampleRate: 48_000)
        // AVAudioEngine invokes the tap outside MainActor; reproduce that boundary.
        await Task.detached {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4)!
            buffer.frameLength = 4
            for i in 0..<4 { buffer.floatChannelData![0][i] = 0.25 }
            tap(buffer, AVAudioTime(sampleTime: 0, atRate: 48_000))
            continuation.finish()
        }.value
        var packets = [AudioPacket]()
        for await packet in stream { packets.append(packet) }
        #expect(packets.count == 1)
        #expect(packets.first?.sampleRate == 48_000)
        #expect(packets.first?.samples.count == 16)
        let values = try #require(packets.first).samples.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        #expect(values == [0.25, 0.25, 0.25, 0.25])
    }

    @Test(arguments: [24_000.0, 44_100.0, 48_000.0])
    func convertsRealMicrophoneFormats(sampleRate: Double) throws {
        let converter = try PCMConverter(sampleRate: sampleRate)
        var result = Data()
        let count = Int(sampleRate)
        for offset in stride(from: 0, to: count, by: 4096) {
            let samples = (offset..<min(offset + 4096, count)).map {
                Float(0.5 * sin(2 * Double.pi * 440 * Double($0) / sampleRate))
            }
            result.append(try samples.withUnsafeBytes { try converter.convert(Data($0)) })
        }
        result.append(try converter.finish())
        #expect(abs(result.count / 2 - 24_000) <= 1)
        let samples = result.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        let rms = sqrt(samples.reduce(0.0) { $0 + pow(Double($1) / 32768, 2) } / Double(samples.count))
        #expect(abs(rms - 0.5 / sqrt(2)) < 0.01)
    }
}
