import ExpoModulesCore
import ObjectiveC
import UIKit
import UniformTypeIdentifiers

/// Images pasted into a chat's text field arrive as dropped files, the same payload
/// Android sends for a drop, so the chat attaches them like any other file. Text
/// pasted with them still goes into the field.
public class RakazoFileDropModule: Module {
  private struct Limits {
    var enabled = false
    var maxBytes = 0
    var maxFiles = 0
  }

  // Only touched on the main thread, where text views handle paste.
  nonisolated(unsafe) private static var limits = Limits()
  nonisolated(unsafe) private static weak var current: RakazoFileDropModule?

  private static let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("dropped", isDirectory: true)
  // Matches the composer's testID, so other text fields keep their normal paste.
  private static let composerID = "chat-composer"
  // Room for a photo that is over the attachment limit until the chat resizes it.
  private static let resizeHeadroom = 4
  // Formats attachments accept as they are; anything else is re-encoded as JPEG.
  private static let keptTypes: [UTType] = [.png, .jpeg, .gif, .webP]
  private let worker = DispatchQueue(label: "rakazo.file-drop")

  public func definition() -> ModuleDefinition {
    Name("RakazoFileDrop")

    Events("onFilesDropped", "onDropStarted")

    Function("setDropTarget") { (enabled: Bool, maxBytes: Double, maxFiles: Int) in
      let usable = enabled && maxBytes.isFinite && maxBytes > 0
      let next = Limits(
        enabled: usable, maxBytes: usable ? Int(min(maxBytes, Double(Int.max / 8))) : 0,
        maxFiles: max(0, maxFiles))
      DispatchQueue.main.async { Self.limits = next }
    }
    AsyncFunction("release") { (uri: String) in
      guard let url = URL(string: uri), url.isFileURL else { return }
      let root = Self.root.resolvingSymlinksInPath().path
      let target = url.resolvingSymlinksInPath()
      guard target.path.hasPrefix(root + "/") else { return }
      let manager = FileManager.default
      try? manager.removeItem(at: target)
      let parent = target.deletingLastPathComponent()
      if parent.path != root, (try? manager.contentsOfDirectory(atPath: parent.path))?.isEmpty == true {
        try? manager.removeItem(at: parent)
      }
    }
    OnCreate {
      // Queue the sweep before any copies so it cannot delete a new paste.
      self.worker.async { try? FileManager.default.removeItem(at: Self.root) }
      Self.current = self
      _ = Self.installPaste
    }
    OnDestroy {
      DispatchQueue.main.async { Self.limits = Limits() }
    }
  }

  private static func acceptsImages(_ view: AnyObject) -> Bool {
    guard limits.enabled, limits.maxFiles > 0, let textView = view as? UITextView,
      textView.isEditable, isComposer(textView)
    else { return false }
    return UIPasteboard.general.hasImages
  }

  // React Native puts the testID on the text view or on the component view around it.
  private static func isComposer(_ view: UIView) -> Bool {
    sequence(first: view, next: { $0.superview }).prefix(3)
      .contains { $0.accessibilityIdentifier == composerID }
  }

  /// Wraps paste on React Native's multiline text view. Only that class changes; other
  /// text views keep their own behavior.
  private static let installPaste: Void = {
    guard let textView = NSClassFromString("RCTUITextView") else { return }
    let pasteAction = #selector(UIResponderStandardEditActions.paste(_:))

    let canPerform = #selector(UIResponder.canPerformAction(_:withSender:))
    if let method = class_getInstanceMethod(textView, canPerform) {
      typealias CanPerform = @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
      let original = unsafeBitCast(method_getImplementation(method), to: CanPerform.self)
      let wrapped: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = { view, action, sender in
        if action == pasteAction, RakazoFileDropModule.acceptsImages(view) { return true }
        return original(view, canPerform, action, sender)
      }
      class_replaceMethod(
        textView, canPerform, imp_implementationWithBlock(wrapped), method_getTypeEncoding(method))
    }

    if let method = class_getInstanceMethod(textView, pasteAction) {
      typealias Paste = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
      let original = unsafeBitCast(method_getImplementation(method), to: Paste.self)
      let wrapped: @convention(block) (AnyObject, AnyObject?) -> Void = { view, sender in
        let pasteboard = UIPasteboard.general
        guard RakazoFileDropModule.acceptsImages(view), let module = RakazoFileDropModule.current else {
          original(view, pasteAction, sender)
          return
        }
        module.attach(pasteboard.itemProviders, limits: RakazoFileDropModule.limits)
        if pasteboard.hasStrings { original(view, pasteAction, sender) }
      }
      class_replaceMethod(
        textView, pasteAction, imp_implementationWithBlock(wrapped), method_getTypeEncoding(method))
    }
  }()

  private func attach(_ providers: [NSItemProvider], limits: Limits) {
    let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    guard !images.isEmpty else { return }
    let kept = Array(images.prefix(limits.maxFiles))
    let maxBytes = limits.maxBytes * Self.resizeHeadroom
    // Bound the names included in the notice, as Android does.
    let skipped = Array(repeating: "image", count: min(images.count - kept.count, 6))
    sendEvent("onDropStarted", [:])
    worker.async {
      let directory = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let files = kept.map { self.copy($0, into: directory, maxBytes: maxBytes) }
      if !files.contains(where: { $0["uri"] != nil }) {
        try? FileManager.default.removeItem(at: directory)
      }
      self.sendEvent("onFilesDropped", ["files": files, "skipped": skipped])
    }
  }

  /// An image that cannot be loaded or saved comes back without a uri, so the chat reports it.
  private func copy(_ provider: NSItemProvider, into directory: URL, maxBytes: Int) -> [String: Any] {
    let failed: [String: Any] = ["name": "image", "mimeType": "image/jpeg", "size": 0.0]
    let images = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
      .filter { $0.conforms(to: .image) }
    var type: UTType?
    var data: Data?
    // The first kept format that loads, in the clipboard's order of preference.
    for candidate in images where Self.keptTypes.contains(candidate) {
      if let loaded = load(provider, candidate) {
        (type, data) = (candidate, loaded)
        break
      }
    }
    // Too large even to resize: the chat reports it as over the limit without a copy.
    if let data, let type, data.count > maxBytes {
      return describe(type, size: data.count)
    }
    // Other formats, like HEIC, are converted to JPEG. Only the source is capped: its
    // pixels bound the JPEG, which the chat then resizes.
    if data == nil {
      for candidate in images where !Self.keptTypes.contains(candidate) {
        guard let source = load(provider, candidate) else { continue }
        if source.count > maxBytes {
          return describe(.jpeg, size: source.count)
        }
        if let converted = UIImage(data: source)?.jpegData(compressionQuality: 0.9) {
          (type, data) = (.jpeg, converted)
          break
        }
      }
    }
    guard let data, let type else { return failed }
    let destination = directory.appendingPathComponent(UUID().uuidString)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: destination)
    } catch {
      return failed
    }
    var file = describe(type, size: data.count)
    file["uri"] = destination.absoluteString
    // Lets the chat shrink a large photo the same way it does one picked from the library.
    if let image = UIImage(data: data) {
      file["width"] = Double(image.size.width * image.scale)
      file["height"] = Double(image.size.height * image.scale)
    }
    return file
  }

  private func describe(_ type: UTType, size: Int) -> [String: Any] {
    [
      "name": "image.\(type.preferredFilenameExtension ?? "jpg")",
      "mimeType": type.preferredMIMEType ?? "image/jpeg",
      "size": Double(size),
    ]
  }

  private func load(_ provider: NSItemProvider, _ type: UTType) -> Data? {
    let done = DispatchSemaphore(value: 0)
    var result: Data?
    provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
      result = data
      done.signal()
    }
    // A provider that never answers costs its image only, not every later paste.
    return done.wait(timeout: .now() + 30) == .success ? result : nil
  }
}
