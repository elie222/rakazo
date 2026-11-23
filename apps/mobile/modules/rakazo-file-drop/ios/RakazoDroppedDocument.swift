import Foundation
import ImageIO
import UniformTypeIdentifiers

enum RakazoDroppedDocument {
  private static func supported(_ type: UTType) -> Bool {
    type.conforms(to: .pdf) || type.conforms(to: .image) || type.conforms(to: .text)
  }

  private static func documentType(_ provider: NSItemProvider) -> UTType? {
    provider.registeredTypeIdentifiers.compactMap { UTType($0) }.first(where: supported)
  }

  static func accepts(_ provider: NSItemProvider) -> Bool {
    documentType(provider) != nil || provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
  }

  static func startCopy(
    _ provider: NSItemProvider, into directory: URL, maxBytes: Int, resizeHeadroom: Int,
    after initialSweep: DispatchGroup
  ) -> () -> [String: Any] {
    let expectedType = documentType(provider)
    let name = provider.suggestedName
    let result = FileCopy()
    let done = DispatchSemaphore(value: 0)
    let complete: @Sendable (URL?) -> Void = { source in
      defer { done.signal() }
      guard let source else { return }
      // The provider's temporary URL expires when its completion handler returns.
      result.store {
        initialSweep.wait()
        return copyFile(source, into: directory, name: name, type: expectedType, maxBytes: maxBytes,
          resizeHeadroom: resizeHeadroom)
      }
    }
    let progress: Progress
    if let expectedType {
      progress = provider.loadFileRepresentation(forTypeIdentifier: expectedType.identifier) { url, _ in
        complete(url)
      }
    } else {
      progress = provider.loadObject(ofClass: NSURL.self) { object, _ in
        complete((object as? NSURL) as URL?)
      }
    }
    let deadline = DispatchTime.now() + 30
    return {
      let timedOut = done.wait(timeout: deadline) == .timedOut
      let payload = result.take(timedOut: timedOut)
      if timedOut { progress.cancel() }
      return payload
        ?? ["name": name ?? "file", "mimeType": expectedType?.preferredMIMEType ?? "", "size": 0]
    }
  }

  private final class FileCopy: @unchecked Sendable {
    private let lock = NSLock()
    private var payload: [String: Any]?
    private var expired = false

    func store(_ copy: () -> [String: Any]?) {
      lock.withLock {
        if !expired { payload = copy() }
      }
    }

    func take(timedOut: Bool) -> [String: Any]? {
      lock.withLock {
        expired = timedOut
        return payload
      }
    }
  }

  private static func copyFile(
    _ source: URL, into directory: URL, name suggestedName: String?, type expectedType: UTType?,
    maxBytes: Int, resizeHeadroom: Int
  ) -> [String: Any]? {
    guard source.isFileURL else { return nil }
    let scoped = source.startAccessingSecurityScopedResource()
    defer { if scoped { source.stopAccessingSecurityScopedResource() } }
    guard let values = try? source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey]),
      values.isRegularFile == true, let size = values.fileSize
    else { return nil }
    let type = values.contentType.flatMap { supported($0) ? $0 : nil } ?? expectedType
    var name = suggestedName ?? source.lastPathComponent
    let sourceExtension = source.pathExtension
    if URL(fileURLWithPath: name).pathExtension.isEmpty,
      let suffix = sourceExtension.isEmpty ? type?.preferredFilenameExtension : sourceExtension
    {
      name += "." + suffix
    }
    var payload: [String: Any] = ["name": name, "mimeType": type?.preferredMIMEType ?? "", "size": size]
    guard let type else { return payload }
    let image = type.conforms(to: .image)
    guard size <= maxBytes * (image ? resizeHeadroom : 1) else { return payload }
    let destination = directory.appendingPathComponent(UUID().uuidString)
    do {
      let manager = FileManager.default
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      try manager.copyItem(at: source, to: destination)
    } catch {
      try? FileManager.default.removeItem(at: destination)
      return payload
    }
    payload["uri"] = destination.absoluteString
    if image, let imageSource = CGImageSourceCreateWithURL(destination as CFURL, nil),
      let dimensions = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any]
    {
      payload["width"] = dimensions[kCGImagePropertyPixelWidth]
      payload["height"] = dimensions[kCGImagePropertyPixelHeight]
    }
    return payload
  }
}
