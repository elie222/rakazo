import ActivityKit
import AppIntents
import Foundation

/// The Live Activity a voice message shows while it records, which iOS requires for recording in
/// the background. Compiled into the app and the widget extension.
struct VoiceMessageAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    enum Status: String, Codable { case listening, sending, thinking, failed }
    var status: Status
    var text: String
  }
}

extension VoiceMessageAttributes {
  /// Clears activities left behind when iOS closed the app mid-recording; their buttons would
  /// otherwise start a fresh app that knows nothing about them.
  static func endAll() async {
    for activity in Activity<VoiceMessageAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}

/// The Live Activity's send button. It runs in the app, which sets `send`.
@available(iOS 17.0, *)
struct SendVoiceMessageIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Send Voice Message"
  static let isDiscoverable = false
  @MainActor static var send: (() async -> Void)?

  @MainActor
  func perform() async throws -> some IntentResult {
    if let send = Self.send { await send() } else { await VoiceMessageAttributes.endAll() }
    return .result()
  }
}

/// The Live Activity's cancel button: stops listening and sends nothing. It runs in the app.
@available(iOS 17.0, *)
struct CancelVoiceMessageIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Cancel Voice Message"
  static let isDiscoverable = false
  @MainActor static var cancel: (() async -> Void)?

  @MainActor
  func perform() async throws -> some IntentResult {
    if let cancel = Self.cancel { await cancel() } else { await VoiceMessageAttributes.endAll() }
    return .result()
  }
}
