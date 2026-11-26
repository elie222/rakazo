import Foundation
import OSLog
import Security
import UIKit
import ImageIO
import WatchConnectivity

/// Uses the phone's existing session and server. Credentials never cross WatchConnectivity.
@MainActor
final class WatchRelay: NSObject, WCSessionDelegate {
  static let shared = WatchRelay()
  private static let logger = Logger(subsystem: "com.rakazo.app", category: "WatchRelay")
  private var scope: UUID?
  private var identityRevision = UUID()
  private var rosterRevision = UUID()
  private var sessionReady = true
  private var selectedSpace: String?
  private var scopedSession: RakazoSession?
  private var spaceId: String?
  private var chats: [WatchChat] = []
  /// The recording the watch is sending in parts.
  private var upload: (id: UUID, next: Int, audio: Data)?
  /// Where each chat's last read left off, so a wait hears only what came after it.
  private var cursors: [String: Int] = [:]
  /// Small avatar copies of the listed chats, kept with a fingerprint of the picture they came
  /// from, so reloads skip decoding.
  private var avatars: [String: (source: Int, data: Data?)] = [:]
  private var waiting: Task<Bool, Error>?

  private enum Change: String { case chat, roster, space, sessionUnavailable, sessionReady }

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
    keepSessionReadableWhileLocked()
    // Leaving the foreground comes before the lock, so items the app created meanwhile
    // (a new Space choice, server headers) are covered too.
    for name in [
      UIApplication.protectedDataDidBecomeAvailableNotification,
      UIApplication.willResignActiveNotification,
    ] {
      _ = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) {
        [weak self] _ in DispatchQueue.main.async { self?.keepSessionReadableWhileLocked() }
      }
    }
    // The relay lives for the process. Enqueue session changes in order without making
    // the React Native thread wait on the main queue.
    _ = NotificationCenter.default.addObserver(
      forName: Notification.Name("RakazoWatchChatChanged"), object: nil, queue: nil
    ) { [weak self] notification in
      guard let kind = notification.object as? String, let change = Change(rawValue: kind)
      else { return }
      let selectedSpace = notification.userInfo?["spaceId"] as? String
      DispatchQueue.main.async { [weak self] in self?.chatChanged(change, selectedSpace: selectedSpace) }
    }
  }

  private func chatChanged(_ change: Change, selectedSpace: String?) {
    keepSessionReadableWhileLocked()
    switch change {
    case .sessionUnavailable:
      sessionReady = false
      self.selectedSpace = nil
      clearScope()
    case .sessionReady:
      sessionReady = true
      clearScope()
    case .space:
      self.selectedSpace = selectedSpace
      clearScope()
    case .roster:
      rosterRevision = UUID()
    case .chat:
      break
    }
    publishRevision()
  }

  /// The watch asks while the iPhone sleeps, so the session items expo-secure-store saved as
  /// readable only while unlocked become readable after the first unlock. A new sign-in saves
  /// fresh items, so this runs again on every session change.
  private func keepSessionReadableWhileLocked() {
    let keys = ["rakazo.session_token", "rakazo.api_base", "rakazo.space_id", "rakazo.server_headers"]
    for key in keys {
      for service in ["app:no-auth", "app"] {
        let query: [String: Any] = [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: service,
          kSecAttrAccount as String: Data(key.utf8),
        ]
        SecItemUpdate(
          query as CFDictionary,
          [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock] as CFDictionary)
      }
    }
  }

  private func clearScope() {
    identityRevision = UUID()
    scope = nil
    scopedSession = nil
    spaceId = nil
    chats = []
    upload = nil
    cursors = [:]
    avatars = [:]
    waiting?.cancel()
  }

  private func publishRevision() {
    let session = WCSession.default
    guard session.activationState == .activated, session.isWatchAppInstalled else { return }
    do {
      try session.updateApplicationContext([
        "chatRevision": UUID().uuidString,
        "rosterRevision": rosterRevision.uuidString,
        "identityRevision": identityRevision.uuidString,
      ])
    } catch {
      // Only log the error code. The watch re-reads when it reconnects or comes to the foreground.
      Self.logger.warning("Watch revision delivery failed (code: \((error as NSError).code, privacy: .public))")
    }
  }

  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?
  ) {
    if state == .activated { Task { @MainActor in publishRevision() } }
  }

  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

  nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

  nonisolated func session(
    _ session: WCSession, didReceiveMessageData data: Data,
    replyHandler: @escaping (Data) -> Void
  ) {
    Task { @MainActor in
      // A watch message wakes the app in the background; finish the answer before it suspends.
      let background = UIApplication.shared.beginBackgroundTask(withName: "WatchRequest") {
        self.waiting?.cancel()
      }
      defer { UIApplication.shared.endBackgroundTask(background) }
      var response: WatchReply
      do {
        guard data.count <= 65_536 else { throw WatchFailure.rejected }
        let request = try JSONDecoder().decode(WatchRequest.self, from: data)
        response = try await handle(request)
      } catch let error as WatchFailure {
        response = WatchReply(error: error)
      } catch MessageBotError.signedOut {
        response = WatchReply(error: .signIn)
      } catch MessageBotError.consentRequired {
        response = WatchReply(error: .consent)
      } catch {
        response = WatchReply(error: .unavailable)
      }
      do { replyHandler(try JSONEncoder().encode(response)) }
      catch { replyHandler(Data()) }
    }
  }

  private func sameSession(_ first: RakazoSession, _ second: RakazoSession) -> Bool {
    first.apiBase == second.apiBase && first.token == second.token
      && first.selectedSpaceId == second.selectedSpaceId && first.headers == second.headers
  }

  private func currentSession() throws -> RakazoSession {
    guard sessionReady else { throw WatchFailure.signIn }
    let session: RakazoSession
    do {
      session = try RakazoSession.load()
    } catch MessageBotError.signedOut where !UIApplication.shared.isProtectedDataAvailable {
      // Before the first unlock after a restart, the Keychain stays closed.
      throw WatchFailure.unlockPhone
    }
    guard let selectedSpace else { return session }
    // The app announces its selection before the Keychain write completes.
    return RakazoSession(
      apiBase: session.apiBase, token: session.token,
      selectedSpaceId: selectedSpace.isEmpty ? nil : selectedSpace, headers: session.headers)
  }

  private func verify(_ session: RakazoSession, revision: UUID) throws {
    guard revision == identityRevision, try sameSession(session, currentSession()) else {
      throw WatchFailure.reload
    }
  }

  private func handle(_ request: WatchRequest) async throws -> WatchReply {
    let revision = identityRevision
    let session = try currentSession()
    // A recording's earlier parts only wait for the last one, which checks the account.
    if request.action == .transcribe, let part = request.part, part + 1 < request.parts ?? 0 {
      guard let scope, request.scope == scope, let scopedSession, sameSession(scopedSession, session),
        let chat = request.chat, chats.contains(chat)
      else { throw WatchFailure.reload }
      _ = try receive(request)
      return WatchReply()
    }
    let userId = try await session.currentUserId()
    try verify(session, revision: revision)

    if request.action == .chats {
      async let voice: WatchVoiceStatus = session.rpc(
        "voice/status", [:], spaceId: session.selectedSpaceId, timeout: 8)
      let list: WatchSpace = try await session.rpc(
        "spaces/list", [:], spaceId: session.selectedSpaceId, timeout: 8)
      // Unknown when the status cannot be read: the watch still offers to listen.
      let transcribe = (try? await voice)?.transcribe
      try verify(session, revision: revision)
      if scopedSession.map({ sameSession($0, session) }) != true || spaceId != list.current.id {
        scope = UUID()
        scopedSession = session
        spaceId = list.current.id
      }
      let entries = list.current.bots.map { (WatchChat.Kind.bot, $0) }
        + list.current.groups.map { (WatchChat.Kind.group, $0) }
      var avatarBudget = 16_000
      let open = entries.filter { $0.1.archivedAt == nil }
      let sorted = open.sorted { $0.1.updatedAt > $1.1.updatedAt }
      // The chat a complication opened stays listed, so the watch can open it.
      let pinned = request.chat.flatMap { chat in
        sorted.first { $0.0 == chat.kind && $0.1.id == chat.id }
      }
      var listed = Array(sorted.prefix(60))
      if let pinned, !listed.contains(where: { $0.1.id == pinned.1.id }) { listed.append(pinned) }
      var rows = listed
        .map { kind, entry in
          var row = WatchChatRow(
            chat: WatchChat(kind: kind, id: entry.id, name: entry.name),
            preview: String(entry.preview?.prefix(100) ?? ""), updatedAt: entry.updatedAt)
          if let color = entry.color {
            row.color = watchColor(color)
            // Once the budget is spent, no further picture would fit, so skip decoding them.
            if avatarBudget >= 1_500, let avatar = cachedAvatar(entry.id, color),
              avatar.count <= avatarBudget
            {
              avatarBudget -= avatar.count
              row.avatar = avatar
            }
          }
          return row
        }
      avatars = avatars.filter { id, _ in rows.contains { $0.id == id } }
      let bots = sorted.filter { $0.0 == .bot }.prefix(100).map {
        WatchBot(id: $0.1.id, name: String($0.1.name.prefix(60)), color: $0.1.color.flatMap(watchColor))
      }
      // A watch message carries about 64 KB: drop pictures, then the oldest chats, to fit.
      let encoder = JSONEncoder()
      while let data = try? encoder.encode(WatchReply(scope: scope, chats: rows, bots: bots)),
        data.count > 60_000, !rows.isEmpty
      {
        if let index = rows.lastIndex(where: { $0.avatar != nil }) { rows[index].avatar = nil }
        else if let index = rows.lastIndex(where: { $0.id != pinned?.1.id }) { rows.remove(at: index) }
        else { break }
      }
      chats = rows.map(\.chat)
      return WatchReply(scope: scope, chats: rows, bots: bots, transcribe: transcribe)
    }

    guard let scope, request.scope == scope, let scopedSession, sameSession(scopedSession, session),
      let spaceId, let chat = request.chat, chats.contains(chat)
    else { throw WatchFailure.reload }
    let target = [chat.kind.targetKey: chat.id]

    if request.action == .thread {
      let thread = try await readThread(target, session: session, spaceId: spaceId)
      try verify(session, revision: revision)
      cursors[chat.id] = thread.cursor
      return WatchReply(
        messages: thread.watchMessages(for: userId),
        botWorking: thread.activeRuns?.contains {
          ["queued", "leased", "running"].contains($0.status)
        } == true)
    }

    if request.action == .transcribe {
      guard let audio = try receive(request) else { return WatchReply() }
      try await session.requireConsent(target, uses: ["voice"], spaceId: spaceId, timeout: 8)
      try verify(session, revision: revision)
      let text = try await transcribe(audio, session: session, spaceId: spaceId)
      try verify(session, revision: revision)
      return WatchReply(text: text)
    }

    if request.action == .wait {
      // Without a read to start from, the watch reads first.
      guard let cursor = cursors[chat.id] else { return WatchReply(changed: true) }
      // The watch shows one chat at a time, so a new wait replaces the last.
      waiting?.cancel()
      let wait = Task {
        // Under the time a watch message and a background wake allow.
        try await session.waitForThreadEvent(
          target, after: cursor, spaceId: spaceId, timeout: 20
        ) { Self.changes.contains($0.type) }
      }
      waiting = wait
      let changed = try await wait.value
      try verify(session, revision: revision)
      return WatchReply(changed: changed ? true : nil)
    }

    guard let text = request.text?.trimmingCharacters(in: .whitespacesAndNewlines),
      !text.isEmpty, text.utf8.count <= 8192, let nonce = request.nonce
    else { throw WatchFailure.rejected }
    var input: [String: Any] = target
    input["clientNonce"] = nonce.uuidString

    switch request.action {
    case .send:
      try await session.requireConsent(target, spaceId: spaceId, timeout: 8)
      try verify(session, revision: revision)
      input["text"] = text
      try await write("threads/send", input, session: session, spaceId: spaceId, failure: .sendUnconfirmed)
    case .answer:
      // Re-read the live card, so stale or forged commands cannot answer hidden fields,
      // change standing permissions, or approve a request the Watch could not display in full.
      let thread = try await readThread(target, session: session, spaceId: spaceId)
      guard let message = thread.messages.first(where: { $0.id == request.messageId }),
        let runId = message.runId, thread.ownsPendingAsk(message, userId: userId),
        let prompt = message.pendingAsk?.watchPrompt(), prompt == request.prompt, canAnswer(prompt, text)
      else { throw WatchFailure.rejected }
      try verify(session, revision: revision)
      input["runId"] = runId
      input["messageId"] = message.id
      input["answer"] = text
      try await write("threads/answer", input, session: session, spaceId: spaceId, failure: .answerUnconfirmed)
    case .chats, .thread, .wait, .transcribe:
      throw WatchFailure.rejected
    }
    return WatchReply()
  }

  /// Events after which the watch's copy of a chat is out of date.
  private static let changes: Set<String> = [
    "thread.message.created", "thread.message.updated", "thread.cleared", "thread.ask", "run.waiting_input",
    "run.completed", "run.failed", "run.cancelled", "computer.takeover.requested",
  ]

  private func readThread(
    _ target: [String: String], session: RakazoSession, spaceId: String
  ) async throws -> WatchThread {
    do {
      return try await session.rpc("threads/get", target, spaceId: spaceId, timeout: 8)
    } catch MessageBotError.rejected(let status, _) where status == 403 || status == 404 {
      throw WatchFailure.reload
    }
  }

  /// Adds one part of a recording, answering the whole recording once its last part arrives.
  private func receive(_ request: WatchRequest) throws -> Data? {
    guard let id = request.nonce, let audio = request.audio, let part = request.part,
      let parts = request.parts, (1...16).contains(parts), (0..<parts).contains(part)
    else { throw WatchFailure.rejected }
    if part == 0 { upload = (id, 0, Data()) }
    // A late part of a dismissed recording is refused without touching the current one.
    guard var current = upload, current.id == id else { throw WatchFailure.rejected }
    guard current.next == part, current.audio.count + audio.count <= 640_000 else {
      upload = nil
      throw WatchFailure.rejected
    }
    current.audio.append(audio)
    current.next += 1
    upload = part == parts - 1 ? nil : current
    return part == parts - 1 ? current.audio : nil
  }

  /// Turns speech into text with the voice provider the account set up, as the app's dictation does.
  private func transcribe(_ audio: Data, session: RakazoSession, spaceId: String) async throws -> String {
    var body: [String: Any] = ["audioBase64": audio.base64EncodedString(), "mimeType": "audio/m4a"]
    // Without a language the provider guesses one, and a short clip can come back in another.
    if let language = Locale.current.language.languageCode?.identifier { body["language"] = language }
    let (status, data): (Int, Data)
    do {
      (status, data) = try await session.post("/api/voice/transcribe", body, spaceId: spaceId, timeout: 30)
    } catch MessageBotError.signedOut {
      throw WatchFailure.signIn
    } catch {
      throw WatchFailure.voiceFailed
    }
    let reply = try? JSONDecoder().decode(WatchTranscript.self, from: data)
    switch status {
    case 200..<300:
      guard let reply else { throw WatchFailure.voiceFailed }
      return reply.text ?? ""
    // The server answers 409 when no voice provider is set up.
    case 409: throw WatchFailure.noVoice
    case 403 where reply?.code == "AI_CONSENT_REQUIRED": throw WatchFailure.consent
    // The voice provider account refused, for example out of credit: retrying will not help.
    case 402, 403: throw WatchFailure.voiceAccount
    default: throw WatchFailure.voiceFailed
    }
  }

  /// The six-digit hex a bot's color starts with, if it is a color.
  private func watchColor(_ value: String) -> String? {
    guard let match = value.range(of: #"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])"#,
      options: .regularExpression)
    else { return nil }
    let digits = value[match].dropFirst()
    return "#" + (digits.count == 3 ? digits.map { "\($0)\($0)" }.joined() : String(digits))
  }

  private func cachedAvatar(_ id: String, _ value: String) -> Data? {
    // Hashing is seeded per process, which is fine for an in-memory cache.
    let source = value.hashValue
    if let cached = avatars[id], cached.source == source { return cached.data }
    let data = watchAvatar(value)
    avatars[id] = (source, data)
    return data
  }

  /// A small copy of a picture avatar; drawn avatars show as their color on the watch.
  private func watchAvatar(_ value: String) -> Data? {
    guard value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ","),
      let data = Data(base64Encoded: String(value[value.index(after: comma)...])),
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      // Decodes straight to the small size, whatever the picture's own dimensions.
      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 64,
      ] as CFDictionary)
    else { return nil }
    return UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.7)
  }

  private func canAnswer(_ prompt: WatchPrompt, _ answer: String) -> Bool {
    switch prompt.kind {
    case .phone: false
    case .approval: prompt.options.contains { $0.id == answer }
    case .question: prompt.options.isEmpty || prompt.options.contains { $0.id == answer }
    }
  }

  private func write(
    _ procedure: String, _ input: [String: Any], session: RakazoSession, spaceId: String,
    failure: WatchFailure
  ) async throws {
    do {
      let _: WatchAcknowledgement = try await session.rpc(procedure, input, spaceId: spaceId, timeout: 8)
    } catch MessageBotError.signedOut {
      throw WatchFailure.signIn
    } catch MessageBotError.rejected {
      throw failure == .sendUnconfirmed ? WatchFailure.sendRejected : WatchFailure.rejected
    } catch {
      // A timeout or lost reply after commit is ambiguous. The watch keeps the nonce on retry.
      throw failure
    }
  }
}

private struct WatchAcknowledgement: Decodable {}

private struct WatchVoiceStatus: Decodable { let transcribe: Bool }

private struct WatchTranscript: Decodable {
  let text: String?
  let code: String?
}

private struct WatchSpace: Decodable {
  struct Current: Decodable {
    let id: String
    let bots: [Chat]
    let groups: [Chat]
  }
  struct Chat: Decodable {
    let id: String
    let name: String
    let color: String?
    let preview: String?
    let updatedAt: String
    let archivedAt: String?
  }
  let current: Current
}
