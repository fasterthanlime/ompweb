import Foundation
import Testing
@testable import Nook

@MainActor
struct PCMConverterTests {
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
