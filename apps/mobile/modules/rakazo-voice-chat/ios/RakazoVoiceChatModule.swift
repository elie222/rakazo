import ExpoModulesCore

/// Hands the "Start Voice Chat" Shortcuts action to the chat screen. The request lives in the app's
/// own storage, so a link can open a chat but never its microphone.
public class RakazoVoiceChatModule: Module {
  private static let key = "rakazo.pending_voice_chat"
  private static let maxAge: TimeInterval = 30
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("RakazoVoiceChat")
    Events("onPendingVoiceChat")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: Notification.Name("RakazoPendingVoiceChat"), object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onPendingVoiceChat", [:])
      }
      // Covers a request posted while the observer was being set up.
      if UserDefaults.standard.dictionary(forKey: Self.key) != nil {
        self.sendEvent("onPendingVoiceChat", [:])
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }

    /// True once, for the bot the action asked to call, while the request is fresh.
    Function("takePendingVoiceChat") { (botId: String) -> Bool in
      let defaults = UserDefaults.standard
      guard let request = defaults.dictionary(forKey: Self.key) as? [String: String],
        request["botId"] == botId
      else { return false }
      defaults.removeObject(forKey: Self.key)
      guard let at = request["at"].flatMap(Double.init) else { return false }
      return Date().timeIntervalSince1970 - at <= Self.maxAge
    }
  }
}
