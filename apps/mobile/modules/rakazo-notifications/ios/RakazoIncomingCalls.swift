import ExpoModulesCore
import CallKit
import PushKit
import AVFAudio
import Security

/// Created at application launch, before the JavaScript bridge exists.
public class RakazoCallsSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    _ = IncomingCalls.shared
    return true
  }
}

final class IncomingCalls: NSObject, PKPushRegistryDelegate, CXProviderDelegate, URLSessionTaskDelegate {
  static let shared = IncomingCalls()
  static let changed = Notification.Name("RakazoIncomingCallChanged")
  private let provider: CXProvider
  private var registry: PKPushRegistry!
  private var calls: [UUID: [String: String]] = [:]
  private var deadlines: [UUID: DispatchWorkItem] = [:]
  /** Calls declined here, until they expire; a later report of one must not ring again. */
  private var declined: [UUID: Date] = [:]
  /** Calls the app has joined; an earlier end only backs out of the join. */
  private var joined: Set<UUID> = []
  private var pending: [[String: String]] = []
  private var token: String?
  private var active: UUID?
  private var accepted: Set<UUID> = []
  private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

  override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    config.includesCallsInRecents = false
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: .main)
    registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
  }

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }
  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    token = nil
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }
  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    var call: [String: String] = [:]
    for key in ["callId", "botId", "botName", "expiresAt"] {
      if let value = payload.dictionaryPayload[key] as? String { call[key] = value }
    }
    // Even malformed or expired VoIP pushes must be reported before completion.
    report(call, mandatory: true, completion: completion)
  }

  private func expiry(_ call: [String: String]) -> Date {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return call["expiresAt"].flatMap(parser.date(from:)) ?? .distantPast
  }

  func report(_ call: [String: String], mandatory: Bool = false, completion: @escaping () -> Void = {}) {
    let id = call["callId"].flatMap(UUID.init(uuidString:)) ?? UUID()
    declined = declined.filter { $0.value > Date() }
    if (calls[id] != nil || declined[id] != nil) && !mandatory { completion(); return }
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: call["botName"] ?? "Rakazo")
    update.localizedCallerName = call["botName"] ?? "Rakazo"
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    provider.reportNewIncomingCall(with: id, update: update) { error in
      DispatchQueue.main.async {
      defer { completion() }
      guard error == nil else { return }
      guard self.hasSession(), self.declined[id] == nil, self.expiry(call) > Date(), call["botId"] != nil, call["callId"] != nil else {
        self.provider.reportCall(with: id, endedAt: Date(), reason: .unanswered)
        return
      }
      self.calls[id] = call
      NotificationCenter.default.post(name: Self.changed, object: nil)
      let deadline = DispatchWorkItem { self.end(id, reason: .unanswered) }
      self.deadlines[id]?.cancel()
      self.deadlines[id] = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + max(0, self.expiry(call).timeIntervalSinceNow), execute: deadline)
      }
    }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let call = calls[action.callUUID], expiry(call) > Date() else { action.fail(); end(action.callUUID, reason: .unanswered); return }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
    } catch { action.fail(); end(action.callUUID, reason: .failed); return }
    active = action.callUUID
    action.fulfill()
    // Answered in the app, which has already joined.
    if accepted.remove(action.callUUID) != nil { return }
    // Answered from the system UI, possibly on the lock screen. Fulfilled now so CallKit never
    // times the answer out; the app joins once it is opened (and unlocked), which needs the
    // user's SecureStore session. The ring deadline still ends a call the app never joins.
    pending.append(call.merging(["action": "answer"]) { _, new in new })
    NotificationCenter.default.post(name: Self.changed, object: nil)
    // A URL alone cannot answer: only the pending native action grants that intent.
    if let url = URL(string: "rakazo:///") { UIApplication.shared.open(url, options: [:]) }
  }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    // Not joined yet: the server still has it ringing, so this is a decline.
    if let call = calls[action.callUUID], !joined.contains(action.callUUID) {
      declined[action.callUUID] = expiry(call)
      decline(call)
    }
    end(action.callUUID, reason: .remoteEnded)
    action.fulfill()
  }
  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    if let call = action as? CXCallAction { end(call.callUUID, reason: .failed) }
  }
  func providerDidReset(_ provider: CXProvider) {
    for id in Array(calls.keys) { end(id, reason: .failed) }
    pending.removeAll { $0["action"] == "answer" }
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }
  func finishAnswer(_ callId: String, success: Bool) {
    guard let id = UUID(uuidString: callId) else { return }
    guard success else { end(id, reason: .failed); return }
    // Ended while joining: end() already queued the end that backs the app out.
    guard calls[id] != nil else { return }
    deadlines.removeValue(forKey: id)?.cancel()
    joined.insert(id)
    if active == id { return }
    accepted.insert(id)
    CXCallController().request(CXTransaction(action: CXAnswerCallAction(call: id))) { error in
      guard error != nil else { return }
      DispatchQueue.main.async {
        // The app already holds this call; it carries on without the system call UI.
        self.accepted.remove(id)
        self.joined.remove(id)
        self.end(id, reason: .failed)
      }
    }
  }
  func end(_ id: UUID, reason: CXCallEndedReason) {
    deadlines.removeValue(forKey: id)?.cancel()
    let call = calls.removeValue(forKey: id)
    pending.removeAll { $0["callId"].flatMap(UUID.init(uuidString:)) == id && $0["action"] == "answer" }
    // The app is in, or joining, this call: tell it, so it hangs up or abandons the join.
    if let call, active == id || accepted.contains(id) || joined.contains(id) {
      pending.append(call.merging(["action": "end"]) { _, new in new })
      NotificationCenter.default.post(name: Self.changed, object: nil)
    }
    accepted.remove(id)
    joined.remove(id)
    if active == id { active = nil }
    provider.reportCall(with: id, endedAt: Date(), reason: reason)
  }
  private static let credentialKey = "rakazo.incoming-session"
  func configure(_ base: String, headers: [String: String]) {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "rakazo.calls", kSecAttrAccount as String: Self.credentialKey]
    SecItemDelete(query as CFDictionary)
    guard let data = try? JSONSerialization.data(withJSONObject: ["base": base, "headers": headers]) else { return }
    var value = query
    value[kSecValueData as String] = data
    // A decline from the lock screen needs this session, just like Android's encrypted store.
    value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(value as CFDictionary, nil)
  }
  func clear() {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "rakazo.calls", kSecAttrAccount as String: Self.credentialKey] as CFDictionary)
    for id in Array(calls.keys) { end(id, reason: .remoteEnded) }
    pending.removeAll()
  }
  func state() -> [String: Any] {
    let canAnswer = UIApplication.shared.applicationState == .active
    let actions = pending.filter { $0["action"] != "answer" || canAnswer }
    pending.removeAll { $0["action"] != "answer" || canAnswer }
    return ["token": token ?? "", "actions": actions, "ringing": calls.filter { $0.key != active }.map { $0.value }]
  }

  private func savedSession() -> (base: String, headers: [String: String])? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "rakazo.calls", kSecAttrAccount as String: Self.credentialKey,
      kSecMatchLimit as String: kSecMatchLimitOne, kSecReturnData as String: true]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data,
      let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let base = saved["base"] as? String, let headers = saved["headers"] as? [String: String]
    else { return nil }
    return (base, headers)
  }
  private func hasSession() -> Bool {
    savedSession()?.headers["authorization"]?.isEmpty == false
  }
  private func decline(_ call: [String: String]) {
    guard expiry(call) > Date(), let saved = savedSession(),
      let url = URL(string: saved.base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/rpc/notifications/declineIncomingCall")
    else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 8
    for (name, value) in saved.headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("rakazo://", forHTTPHeaderField: "Origin")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["json": ["callId": call["callId"] ?? ""]])
    let task = UIApplication.shared.beginBackgroundTask(expirationHandler: nil)
    session.dataTask(with: request) { _, _, _ in
      DispatchQueue.main.async { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
    }.resume()
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

public class RakazoNotificationsModule: Module {
  private var observer: NSObjectProtocol?
  public func definition() -> ModuleDefinition {
    Name("RakazoNotifications")
    Events("onIncomingCallChanged", "onWorkActivityToken", "onWorkActivityStartToken")
    OnCreate {
      if #available(iOS 18.0, *) {
        WorkActivities.shared.onToken = { [weak self] token in
          self?.sendEvent("onWorkActivityToken", ["token": token])
        }
        WorkActivities.shared.onStartToken = { [weak self] token in
          self?.sendEvent("onWorkActivityStartToken", ["token": token])
        }
        WorkActivities.shared.observe()
      }
    }
    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(forName: IncomingCalls.changed, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onIncomingCallChanged", [:])
      }
    }
    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }
    AsyncFunction("configureIncomingSession") { (base: String, headers: [String: String]) in IncomingCalls.shared.configure(base, headers: headers) }.runOnQueue(.main)
    AsyncFunction("incomingState") { () -> [String: Any] in IncomingCalls.shared.state() }.runOnQueue(.main)
    AsyncFunction("reportIncomingCall") { (call: [String: String]) in IncomingCalls.shared.report(call) }.runOnQueue(.main)
    AsyncFunction("finishAnswer") { (id: String, success: Bool) in IncomingCalls.shared.finishAnswer(id, success: success) }.runOnQueue(.main)
    AsyncFunction("endIncomingCall") { (id: String) in
      if let uuid = UUID(uuidString: id) { IncomingCalls.shared.end(uuid, reason: .remoteEnded) }
    }.runOnQueue(.main)
    AsyncFunction("clearIncomingCalls") { IncomingCalls.shared.clear() }.runOnQueue(.main)
    AsyncFunction("startWorkActivity") { (title: String, spaceId: String, botId: String?, groupId: String?) in
      if #available(iOS 18.0, *) {
        // A group's bot is known only once the server's first update names it.
        let name = title.isEmpty
          ? Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? ""
          : title
        WorkActivities.shared.start(.init(
          status: .working, title: name, line: "", spaceId: spaceId, botId: botId, groupId: groupId))
      }
    }.runOnQueue(.main)
    AsyncFunction("refreshWorkActivity") {
      if #available(iOS 18.0, *) {
        WorkActivities.shared.refreshStartToken()
        WorkActivities.shared.refresh()
      }
    }.runOnQueue(.main)
    AsyncFunction("endWorkActivity") {
      if #available(iOS 18.0, *) { WorkActivities.shared.end() }
    }.runOnQueue(.main)
  }
}
