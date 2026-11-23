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
      var response: WatchReply
      do {
        guard data.count <= 32_768 else { throw WatchFailure.rejected }
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
    let userId = try await session.currentUserId()
    try verify(session, revision: revision)

    if request.action == .chats {
      let list: WatchSpace = try await session.rpc(
        "spaces/list", [:], spaceId: session.selectedSpaceId, timeout: 8)
      try verify(session, revision: revision)
      if scopedSession.map({ sameSession($0, session) }) != true || spaceId != list.current.id {
        scope = UUID()
        scopedSession = session
        spaceId = list.current.id
      }
      let entries = list.current.bots.map { (WatchChat.Kind.bot, $0) }
        + list.current.groups.map { (WatchChat.Kind.group, $0) }
      var avatarBudget = 16_000
      var rows = entries.filter { $0.1.archivedAt == nil }
        .sorted { $0.1.updatedAt > $1.1.updatedAt }
        .prefix(60)
        .map { kind, entry in
          var row = WatchChatRow(
            chat: WatchChat(kind: kind, id: entry.id, name: entry.name),
            preview: String(entry.preview?.prefix(100) ?? ""), updatedAt: entry.updatedAt)
          if let color = entry.color {
            row.color = watchColor(color)
            if let avatar = watchAvatar(color), avatar.count <= avatarBudget {
              avatarBudget -= avatar.count
              row.avatar = avatar
            }
          }
          return row
        }
      // A watch message carries about 64 KB: drop pictures, then the oldest chats, to fit.
      let encoder = JSONEncoder()
      while let data = try? encoder.encode(WatchReply(scope: scope, chats: rows)),
        data.count > 60_000, !rows.isEmpty
      {
        if let index = rows.lastIndex(where: { $0.avatar != nil }) { rows[index].avatar = nil }
        else { rows.removeLast() }
      }
      chats = rows.map(\.chat)
      return WatchReply(scope: scope, chats: rows)
    }

    guard let scope, request.scope == scope, let scopedSession, sameSession(scopedSession, session),
      let spaceId, let chat = request.chat, chats.contains(chat)
    else { throw WatchFailure.reload }
    let target = [chat.kind.targetKey: chat.id]

    if request.action == .thread {
      let thread = try await readThread(target, session: session, spaceId: spaceId)
      try verify(session, revision: revision)
      return WatchReply(
        messages: thread.watchMessages(for: userId),
        botWorking: thread.activeRuns?.contains {
          ["queued", "leased", "running"].contains($0.status)
        } == true)
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
    case .chats, .thread:
      throw WatchFailure.rejected
    }
    return WatchReply()
  }

  private func readThread(
    _ target: [String: String], session: RakazoSession, spaceId: String
  ) async throws -> WatchThread {
    do {
      return try await session.rpc("threads/get", target, spaceId: spaceId, timeout: 8)
    } catch MessageBotError.rejected(let status, _) where status == 403 || status == 404 {
      throw WatchFailure.reload
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
