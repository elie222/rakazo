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
    var maxFiles = 0
  }

  // Only touched on the main thread, where text views handle paste.
  nonisolated(unsafe) private static var limits = Limits()
  nonisolated(unsafe) private static weak var current: RakazoFileDropModule?

  private static let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("dropped", isDirectory: true)
  // Formats attachments accept as they are; anything else is re-encoded as JPEG.
  private static let keptTypes: [UTType] = [.png, .jpeg, .gif, .webP]
  private let worker = DispatchQueue(label: "rakazo.file-drop")

  public func definition() -> ModuleDefinition {
    Name("RakazoFileDrop")

    Events("onFilesDropped", "onDropStarted")

    // Size limits are applied when the chat reads the files, after large photos are resized.
    Function("setDropTarget") { (enabled: Bool, maxBytes: Double, maxFiles: Int) in
      let next = Limits(enabled: enabled && maxBytes.isFinite && maxBytes > 0, maxFiles: max(0, maxFiles))
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
    limits.enabled && limits.maxFiles > 0 && (view as? UITextView)?.isEditable == true
      && UIPasteboard.general.hasImages
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
        module.attach(pasteboard.itemProviders, maxFiles: RakazoFileDropModule.limits.maxFiles)
        if pasteboard.hasStrings { original(view, pasteAction, sender) }
      }
      class_replaceMethod(
        textView, pasteAction, imp_implementationWithBlock(wrapped), method_getTypeEncoding(method))
    }
  }()

  private func attach(_ providers: [NSItemProvider], maxFiles: Int) {
    let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    guard !images.isEmpty else { return }
    let kept = Array(images.prefix(maxFiles))
    // Bound the names included in the notice, as Android does.
    let skipped = Array(repeating: "image", count: min(images.count - kept.count, 6))
    sendEvent("onDropStarted", [:])
    worker.async {
      let directory = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let files = kept.compactMap { self.copy($0, into: directory) }
      if files.isEmpty { try? FileManager.default.removeItem(at: directory) }
      self.sendEvent("onFilesDropped", ["files": files, "skipped": skipped])
    }
  }

  private func copy(_ provider: NSItemProvider, into directory: URL) -> [String: Any]? {
    let registered = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
    var type = registered.first { Self.keptTypes.contains($0) }
    var data = type.flatMap { load(provider, $0) }
    if data == nil {
      type = .jpeg
      data = load(provider, .image).flatMap { UIImage(data: $0)?.jpegData(compressionQuality: 0.9) }
    }
    guard let data, let type, let ext = type.preferredFilenameExtension else { return nil }
    let destination = directory.appendingPathComponent(UUID().uuidString)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: destination)
    } catch {
      return nil
    }
    var file: [String: Any] = [
      "uri": destination.absoluteString,
      "name": "image.\(ext)",
      "mimeType": type.preferredMIMEType ?? "image/jpeg",
      "size": Double(data.count),
    ]
    // Lets the chat shrink a large photo the same way it does one picked from the library.
    if let image = UIImage(data: data) {
      file["width"] = Double(image.size.width * image.scale)
      file["height"] = Double(image.size.height * image.scale)
    }
    return file
  }

  private func load(_ provider: NSItemProvider, _ type: UTType) -> Data? {
    let done = DispatchSemaphore(value: 0)
    var result: Data?
    provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
      result = data
      done.signal()
    }
    done.wait()
    return result
  }
}
