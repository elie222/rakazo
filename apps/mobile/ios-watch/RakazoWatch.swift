import SwiftUI
import WatchConnectivity

@main
struct RakazoWatch: App {
  @State private var connection = WatchConnection()

  var body: some Scene {
    WindowGroup { WatchChats(connection: connection) }
  }
}

@MainActor @Observable
private final class WatchConnection: NSObject, WCSessionDelegate {
  private(set) var reachable = false
  private(set) var chatRevision: String?

  override init() {
    super.init()
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?
  ) {
    sessionReachabilityDidChange(session)
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    Task { @MainActor in self.reachable = reachable }
  }

  nonisolated func session(
    _ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]
  ) {
    guard let revision = applicationContext["chatRevision"] as? String else { return }
    Task { @MainActor in self.chatRevision = revision }
  }

  func request(_ request: WatchRequest) async throws -> WatchReply {
    guard WCSession.default.isReachable else { throw WatchFailure.unavailable }
    let data = try JSONEncoder().encode(request)
    let received: Data = try await withCheckedThrowingContinuation { continuation in
      WCSession.default.sendMessageData(data) {
        continuation.resume(returning: $0)
      } errorHandler: { _ in
        let error: WatchFailure
        switch request.action {
        case .send: error = .sendUnconfirmed
        case .answer: error = .answerUnconfirmed
        case .chats, .thread: error = .unavailable
        }
        continuation.resume(throwing: error)
      }
    }
    let reply = try JSONDecoder().decode(WatchReply.self, from: received)
    if let error = reply.error { throw error }
    return reply
  }
}

private struct WatchChats: View {
  let connection: WatchConnection
  @Environment(\.scenePhase) private var phase
  @State private var scope: UUID?
  @State private var chats: [WatchChat] = []
  @State private var path: [WatchChat] = []
  @State private var failure: WatchFailure?
  @State private var loading = false

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let failure {
          Text(failure.label)
        } else if scope == nil {
          ProgressView()
        } else if chats.isEmpty {
          Text("No chats in this Space")
        }
        ForEach(chats) { chat in
          NavigationLink(chat.name, value: chat)
        }
      }
      .navigationTitle("Chats")
      .toolbar {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
          .disabled(loading)
      }
      .navigationDestination(for: WatchChat.self) { chat in
        if let scope {
          WatchConversation(connection: connection, chat: chat, scope: scope) {
            path = []
            await load()
          }
        }
      }
    }
    .task(id: connection.reachable && phase == .active) {
      guard path.isEmpty else { return }
      if connection.reachable && phase == .active { await load() }
      else if phase == .active && chats.isEmpty { failure = .unavailable }
    }
    .onChange(of: phase) {
      guard phase == .background else { return }
      path = []
      chats = []
      scope = nil
    }
  }

  private func load() async {
    guard !loading else { return }
    loading = true
    defer { loading = false }
    do {
      let reply = try await connection.request(WatchRequest(action: .chats))
      guard phase == .active, !Task.isCancelled else { return }
      scope = reply.scope
      chats = reply.chats ?? []
      failure = nil
    } catch {
      guard !Task.isCancelled else { return }
      chats = []
      scope = nil
      failure = error as? WatchFailure ?? .unavailable
    }
  }
}

private struct WatchConversation: View {
  let connection: WatchConnection
  let chat: WatchChat
  let scope: UUID
  let reloadChats: () async -> Void

  @Environment(\.scenePhase) private var phase
  @State private var messages: [WatchMessage] = []
  @State private var botWorking = false
  @State private var working = false
  @State private var failure: WatchFailure?
  @State private var draft = ""
  @State private var sendNonce = UUID()
  @State private var sendingText: String?
  @State private var needsRefresh = false

  var body: some View {
    List {
      if let failure { Text(failure.label) }
      Button("Message", systemImage: "square.and.pencil") { editing = true }
        .disabled(working || failure == .signIn || failure == .unlockPhone)
        .sheet(isPresented: $editing) {
          VStack {
            TextField("Message", text: $draft)
            Button("Send") { editing = false; Task { await send() } }
              .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
          .padding(.horizontal)
        }
      if botWorking {
        Label("Working", systemImage: "hourglass")
          .foregroundStyle(.secondary)
      }
      ForEach(messages.reversed()) { message in
        if let prompt = message.prompt {
          NavigationLink {
            WatchReview(prompt: prompt) { answer in
              try await answerPrompt(message.id, prompt: prompt, answer: answer)
            }
          } label: {
            Label {
              Text(prompt.kind == .phone ? "Continue on iPhone" : prompt.title)
                .lineLimit(3)
            } icon: {
              Image(systemName: prompt.kind == .approval ? "hand.raised" : "questionmark.bubble")
            }
          }
        }
        if !message.text.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            if message.fromUser {
              Text("You").font(.caption2).foregroundStyle(.secondary)
            }
            Text(message.text)
          }
        }
      }
      if working && messages.isEmpty { ProgressView() }
    }
    .onChange(of: connection.chatRevision) {
      guard phase == .active else { return }
      needsRefresh = true
    }
    .onChange(of: needsRefresh && !working) { _, ready in
      guard ready, phase == .active else { return }
      needsRefresh = false
      Task { await refresh() }
    }
    .navigationTitle(chat.name)
    .toolbar {
      Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
        .disabled(working)
    }
    .task(id: connection.reachable && phase == .active) {
      if connection.reachable && phase == .active { await refresh() }
      else if phase == .active { failure = .unavailable }
    }
  }

  @State private var editing = false

  private func refresh() async {
    guard !working else { return }
    working = true
    defer { working = false }
    do {
      try await read()
      if !Task.isCancelled { failure = nil }
    } catch {
      guard !Task.isCancelled else { return }
      let reason = error as? WatchFailure ?? .unavailable
      if reason == .reload { await reloadChats() }
      else {
        messages = []
        botWorking = false
        failure = reason
      }
    }
  }

  private func read() async throws {
    let reply = try await connection.request(WatchRequest(action: .thread, scope: scope, chat: chat))
    if !Task.isCancelled {
      messages = reply.messages ?? []
      botWorking = reply.botWorking == true
    }
  }

  private func send() async {
    guard !working else { return }
    working = true
    defer { working = false }
    if draft != sendingText {
      sendingText = draft
      sendNonce = UUID()
    }
    do {
      _ = try await connection.request(
        WatchRequest(action: .send, scope: scope, chat: chat, text: draft, nonce: sendNonce))
    } catch {
      failure = error as? WatchFailure ?? .sendUnconfirmed
      return
    }
    draft = ""
    sendingText = nil
    failure = nil
    do { try await read() }
    catch { failure = error as? WatchFailure ?? .unavailable }
  }

  private func answerPrompt(_ id: String, prompt: WatchPrompt, answer: String) async throws {
    guard !working else { throw WatchFailure.unavailable }
    working = true
    defer { working = false }
    _ = try await connection.request(
      WatchRequest(action: .answer, scope: scope, chat: chat, text: answer, nonce: UUID(),
        messageId: id, prompt: prompt))
    messages.removeAll { $0.id == id }
    do { try await read() }
    catch { failure = error as? WatchFailure ?? .unavailable }
  }
}

private struct WatchReview: View {
  let prompt: WatchPrompt
  let submit: (String) async throws -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var answer = ""
  @State private var saving = false
  @State private var failure: WatchFailure?

  var body: some View {
    List {
      if prompt.kind == .phone {
        Text("Review this request in Rakazo on your iPhone.")
      } else {
        Text(prompt.title).font(.headline)
        if let detail = prompt.detail, !detail.isEmpty { Text(detail) }
        if let failure { Text(failure.label) }
        if failure != .rejected && failure != .answerUnconfirmed {
          if prompt.kind == .approval {
            Button("Allow Once") { save("allow") }.disabled(saving)
            Button("Deny", role: .destructive) { save("deny") }.disabled(saving)
          } else if prompt.options.isEmpty {
            TextField("Answer", text: $answer)
            Button("Send") { save(answer) }
              .disabled(saving || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          } else {
            ForEach(prompt.options) { option in
              Button(option.label) { save(option.id) }.disabled(saving)
            }
          }
        }
      }
    }
    .navigationTitle(prompt.kind == .approval ? "Approval" : "Request")
  }

  private func save(_ answer: String) {
    guard !saving else { return }
    saving = true
    Task {
      defer { saving = false }
      do { try await submit(answer); dismiss() }
      catch { failure = error as? WatchFailure ?? .unavailable }
    }
  }
}

private extension WatchFailure {
  var label: LocalizedStringKey {
    switch self {
    case .unlockPhone: "Unlock your iPhone, then refresh."
    case .signIn: "Sign in to Rakazo on your iPhone."
    case .consent: "Review AI data sharing on your iPhone."
    case .unavailable: "Can’t reach Rakazo on your iPhone. Try again."
    case .reload: "Return to Chats and refresh."
    case .rejected: "This request has changed. Go back and refresh."
    case .sendUnconfirmed: "Send unconfirmed. Refresh before trying again."
    case .answerUnconfirmed: "Answer unconfirmed. Go back and refresh."
    }
  }
}
