import Foundation
import Vision
import ImageIO

// Local-only helper. Never print paths, recognized content, or native error details to stderr.
func fail() -> Never {
    FileHandle.standardError.write(Data("LOCAL_OCR_FAILED\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2 else { fail() }
let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) == 1,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 8192, height <= 8192, width * height <= 12_000_000,
      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary)
else { fail() }

do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let supported = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant", "ko-KR"].filter { supported.contains($0) }
    let orientationRaw = (properties[kCGImagePropertyOrientation] as? UInt32) ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) ?? .up
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    try handler.perform([request])
    let observations = (request.results ?? []).sorted {
        let leftRow = Int(($0.boundingBox.midY / 0.012).rounded())
        let rightRow = Int(($1.boundingBox.midY / 0.012).rounded())
        if leftRow != rightRow { return leftRow > rightRow }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }
    guard observations.count <= 256 else { fail() }
    let lines: [[String: Any]] = observations.compactMap {
        guard let candidate = $0.topCandidates(1).first else { return nil }
        return ["text": candidate.string, "confidence": candidate.confidence]
    }
    let output = try JSONSerialization.data(withJSONObject: ["lines": lines])
    guard output.count <= 131_072 else { fail() }
    FileHandle.standardOutput.write(output)
} catch { fail() }
