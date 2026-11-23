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
  private(set) var identityRevision: String?
  private(set) var rosterRevision: String?

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
    Task { @MainActor in
      updateRevisions()
      reachable = WCSession.default.isReachable
    }
  }

  nonisolated func session(
    _ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]
  ) {
    Task { @MainActor in updateRevisions() }
  }

  private func updateRevisions() {
    let session = WCSession.default
    guard session.activationState == .activated else { return }
    let context = session.receivedApplicationContext
    identityRevision = context["identityRevision"] as? String
    rosterRevision = context["rosterRevision"] as? String
    chatRevision = context["chatRevision"] as? String
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
  @State private var chats: [WatchChatRow] = []
  @State private var path: [WatchChatRow.ID] = []
  @State private var failure: WatchFailure?
  @State private var loading = false
  @State private var needsReload = false

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
        ForEach(chats) { row in
          NavigationLink(value: row.id) { WatchChatSummary(row: row) }
        }
      }
      .navigationTitle("Chats")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
            .labelStyle(.iconOnly)
            .disabled(loading)
        }
      }
      .navigationDestination(for: WatchChatRow.ID.self) { id in
        if let scope, let row = chats.first(where: { $0.id == id }) {
          WatchConversation(connection: connection, row: row, scope: scope) {
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
    .onChange(of: connection.rosterRevision) {
      needsReload = true
    }
    .onChange(of: connection.identityRevision) {
      clearChats()
      needsReload = true
    }
    .onChange(of: needsReload && !loading && path.isEmpty && phase == .active) { _, ready in
      guard ready else { return }
      needsReload = false
      Task { await load() }
    }
    .onChange(of: phase) {
      if phase == .background { clearChats() }
    }
  }

  private func clearChats() {
    path = []
    chats = []
    scope = nil
    failure = nil
  }

  private func load() async {
    guard !loading else { return }
    let identity = connection.identityRevision
    loading = true
    defer { loading = false }
    do {
      let reply = try await connection.request(WatchRequest(action: .chats))
      guard phase == .active, !Task.isCancelled, identity == connection.identityRevision
      else { return }
      scope = reply.scope
      chats = reply.chats ?? []
      failure = nil
    } catch {
      guard !Task.isCancelled, identity == connection.identityRevision else { return }
      chats = []
      scope = nil
      failure = error as? WatchFailure ?? .unavailable
    }
  }
}

private struct WatchChatSummary: View {
  let row: WatchChatRow

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        WatchAvatar(row: row)
        VStack(alignment: .leading, spacing: 0) {
          Text(row.chat.name).font(.headline).lineLimit(1)
          if let date = WatchDate.parse(row.updatedAt) {
            Text(WatchDate.label(date)).font(.footnote).foregroundStyle(.secondary)
          }
        }
      }
      let preview = row.preview.split(whereSeparator: \.isNewline).joined(separator: " ")
      if !preview.isEmpty {
        Text(preview).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
      }
    }
    .padding(.vertical, 4)
  }
}

private struct WatchAvatar: View {
  let row: WatchChatRow
  var size: CGFloat = 32

  var body: some View {
    let color = row.color.flatMap(Color.init(hex:)) ?? Color.gray
    Group {
      if let data = row.avatar, let image = UIImage(data: data) {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        ZStack {
          color
          if row.chat.kind == .group {
            Image(systemName: "person.2.fill").font(.system(size: size * 0.4))
          } else {
            Text(row.chat.name.prefix(1).uppercased()).font(.system(size: size * 0.5, weight: .semibold))
          }
        }
        .foregroundStyle(row.color.map(Color.isLight(hex:)) == true ? .black : .white)
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .accessibilityHidden(true)
  }
}

private struct WatchConversation: View {
  let connection: WatchConnection
  let row: WatchChatRow
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

  private var chat: WatchChat { row.chat }
  private var tint: Color { row.color.flatMap(Color.init(hex:)) ?? Color.gray }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 6) {
          if working && messages.isEmpty { ProgressView() }
          ForEach(messages) { message in
            if !message.text.isEmpty { WatchBubble(message: message, tint: tint) }
            if let prompt = message.prompt {
              NavigationLink {
                WatchReview(prompt: prompt, busy: $working) { answer in
                  startAnswer(message.id, prompt: prompt, answer: answer)
                }
              } label: {
                Label {
                  Text(prompt.kind == .phone ? "Continue on iPhone" : prompt.title).lineLimit(3)
                } icon: {
                  Image(systemName: prompt.kind == .approval ? "hand.raised" : "questionmark.bubble")
                }
              }
            }
          }
          if botWorking {
            ProgressView()
              .frame(maxWidth: .infinity, alignment: .leading)
              .accessibilityLabel("Working")
          }
          if let failure {
            Text(failure.label).font(.footnote).foregroundStyle(.secondary)
          }
          TextField("Message", text: $draft)
            .onSubmit { startSend() }
            .disabled(working || failure == .signIn || failure == .unlockPhone)
            .id(Self.composer)
        }
        .padding(.horizontal, 4)
      }
      .defaultScrollAnchor(.bottom)
      .onChange(of: messages.last?.id) { proxy.scrollTo(Self.composer, anchor: .bottom) }
      .onChange(of: botWorking) { proxy.scrollTo(Self.composer, anchor: .bottom) }
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
      ToolbarItem(placement: .topBarTrailing) {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
          .labelStyle(.iconOnly)
          .disabled(working)
      }
    }
    .task(id: connection.reachable && phase == .active) {
      if connection.reachable && phase == .active { await refresh() }
      else if phase == .active { failure = .unavailable }
    }
  }

  private static let composer = "composer"

  private func refresh() async {
    guard !working else {
      needsRefresh = true
      return
    }
    working = true
    defer { working = false }
    await read()
  }

  private func read() async {
    let identity = connection.identityRevision
    do {
      let reply = try await connection.request(WatchRequest(action: .thread, scope: scope, chat: chat))
      guard !Task.isCancelled, identity == connection.identityRevision else { return }
      messages = reply.messages ?? []
      botWorking = reply.botWorking == true
      failure = nil
    } catch {
      guard !Task.isCancelled, identity == connection.identityRevision else { return }
      let reason = error as? WatchFailure ?? .unavailable
      messages = []
      botWorking = false
      if reason == .reload { await reloadChats() }
      else { failure = reason }
    }
  }

  private func startSend() {
    guard !working, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    working = true
    Task { await send() }
  }

  private func send() async {
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
    await read()
  }

  private func startAnswer(
    _ id: String, prompt: WatchPrompt, answer: String
  ) -> Task<Void, Error>? {
    guard !working else { return nil }
    working = true
    return Task {
      defer { working = false }
      _ = try await connection.request(
        WatchRequest(action: .answer, scope: scope, chat: chat, text: answer, nonce: UUID(),
          messageId: id, prompt: prompt))
      messages.removeAll { $0.id == id }
      await read()
    }
  }
}

private struct WatchBubble: View {
  let message: WatchMessage
  let tint: Color

  var body: some View {
    let alignment: HorizontalAlignment = message.fromUser ? .trailing : .leading
    VStack(alignment: alignment, spacing: 2) {
      if let author = message.author {
        Text(author).font(.caption2).foregroundStyle(.secondary)
      }
      // People's messages show as typed, the way the phone shows them.
      Text(message.fromUser || message.author != nil
        ? AttributedString(message.text) : WatchMarkdown.render(message.text))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
          message.fromUser ? Color.gray.opacity(0.4) : tint.opacity(0.3),
          in: RoundedRectangle(cornerRadius: 16))
    }
    .frame(maxWidth: .infinity, alignment: Alignment(horizontal: alignment, vertical: .center))
    .padding(message.fromUser ? .leading : .trailing, 16)
  }
}

/// Renders the Markdown bots write with what a watch `Text` can show: inline styles, headings
/// as bold lines, bullets and code blocks.
enum WatchMarkdown {
  static func render(_ text: String) -> AttributedString {
    var result = AttributedString()
    var fence: String?
    var first = true
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
      var line = String(raw)
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if let open = fence, trimmed.hasPrefix(open) {
        fence = nil
        continue
      }
      if fence == nil, let open = ["```", "~~~"].first(where: trimmed.hasPrefix) {
        fence = open
        continue
      }
      // Table rows read as cells side by side; their divider lines add nothing.
      if fence == nil, trimmed.hasPrefix("|") {
        if trimmed.allSatisfy({ "|-: ".contains($0) }) { continue }
        line = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "| "))
          .components(separatedBy: "|")
          .map { $0.trimmingCharacters(in: .whitespaces) }
          .joined(separator: "  ")
      }
      if !first { result += AttributedString("\n") }
      first = false
      if fence != nil {
        var code = AttributedString(line)
        code.font = Font.system(.footnote, design: .monospaced)
        result += code
        continue
      }
      var heading = false
      if let marker = line.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
        line.removeSubrange(marker)
        if let closing = line.range(of: #"\s+#+\s*$"#, options: .regularExpression) {
          line.removeSubrange(closing)
        }
        heading = true
      } else if let marker = line.range(of: #"^\s*[-*+]\s+"#, options: .regularExpression) {
        let indent = line[marker].prefix { $0 == " " }
        line.replaceSubrange(marker, with: indent + "• ")
      }
      var part =
        (try? AttributedString(
          markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(line)
      if heading { part.font = Font.headline }
      result += part
    }
    return result
  }
}

private enum WatchDate {
  static func parse(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }

  static func label(_ date: Date) -> String {
    Calendar.current.isDateInToday(date)
      ? date.formatted(date: .omitted, time: .shortened)
      : date.formatted(.dateTime.month(.defaultDigits).day())
  }
}

private extension Color {
  init?(hex: String) {
    guard hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    self.init(
      red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255)
  }

  static func isLight(hex: String) -> Bool {
    guard let value = UInt32(hex.dropFirst(), radix: 16) else { return false }
    let components = [16, 8, 0].map { Double((value >> $0) & 0xFF) / 255 }
    return 0.299 * components[0] + 0.587 * components[1] + 0.114 * components[2] > 0.6
  }
}

private struct WatchReview: View {
  let prompt: WatchPrompt
  @Binding var busy: Bool
  let submit: (String) -> Task<Void, Error>?
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
          if prompt.options.isEmpty {
            TextField("Answer", text: $answer)
            Button("Send") { save(answer) }
              .disabled(busy || saving || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          } else {
            ForEach(prompt.options) { option in
              Button(option.label, role: prompt.kind == .approval && option.id == "deny" ? .destructive : nil) {
                save(option.id)
              }.disabled(busy || saving)
            }
          }
        }
      }
    }
    .navigationTitle(prompt.kind == .approval ? "Approval" : "Request")
  }

  private func save(_ answer: String) {
    guard !saving, let submission = submit(answer) else { return }
    saving = true
    Task {
      defer { saving = false }
      do { try await submission.value; dismiss() }
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
    case .sendRejected: "Couldn’t send this message."
    case .sendUnconfirmed: "Send unconfirmed. Refresh before trying again."
    case .answerUnconfirmed: "Answer unconfirmed. Go back and refresh."
    }
  }
}
