import AVFAudio
import Foundation

@MainActor
final class PCMConverter {
    private let inputFormat: AVAudioFormat
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
    private let converter: AVAudioConverter

    init(sampleRate: Double) throws {
        guard let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: input, to: outputFormat) else {
            throw CaptureError("Cannot convert microphone audio")
        }
        inputFormat = input
        self.converter = converter
    }

    func convert(_ samples: Data) throws -> Data {
        guard samples.count.isMultiple(of: 4),
              let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count / 4)) else {
            throw CaptureError("Invalid microphone buffer")
        }
        input.frameLength = input.frameCapacity
        samples.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress, let destination = input.floatChannelData?[0] {
                destination.update(from: base.assumingMemoryBound(to: Float.self), count: Int(input.frameLength))
            }
        }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 24_000 / inputFormat.sampleRate)) + 64
        return try converted(input: input, capacity: capacity)
    }

    func finish() throws -> Data { try converted(input: nil, capacity: 4096) }

    private func converted(input: AVAudioPCMBuffer?, capacity: AVAudioFrameCount) throws -> Data {
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            throw CaptureError("Cannot allocate audio buffer")
        }
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            guard let input else { status.pointee = .endOfStream; return nil }
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return input
        }
        if let error { throw error }
        guard let samples = output.int16ChannelData?[0] else { throw CaptureError("Missing converted audio") }
        return Data(bytes: samples, count: Int(output.frameLength) * 2)
    }
}
