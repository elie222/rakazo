import SwiftUI
import WatchConnectivity
import WidgetKit

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
        case .transcribe: error = .voiceFailed
        case .chats, .thread, .wait: error = .unavailable
        }
        continuation.resume(throwing: error)
      }
    }
    let reply = try JSONDecoder().decode(WatchReply.self, from: received)
    if let error = reply.error { throw error }
    return reply
  }

  /// Sends a recording in parts that each fit one message, and answers its words.
  func transcribe(_ audio: Data, scope: UUID, chat: WatchChat) async throws -> String {
    let id = UUID()
    let size = 40_000
    let parts = (audio.count + size - 1) / size
    var reply = WatchReply()
    for part in 0..<parts {
      let start = audio.startIndex + part * size
      try Task.checkCancellation()
      reply = try await request(
        WatchRequest(
          action: .transcribe, scope: scope, chat: chat, nonce: id,
          audio: audio[start..<min(start + size, audio.endIndex)], part: part, parts: parts))
    }
    return reply.text ?? ""
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
  @State private var canTranscribe: Bool?
  /// The chat a complication opened, waiting for the list that has it.
  @State private var voiceTarget: WatchChat?
  @State private var listen = false

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
          WatchConversation(
            connection: connection, row: row, scope: scope, canTranscribe: canTranscribe != false,
            listen: $listen
          ) {
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
    .onOpenURL { url in
      guard let target = WatchShelf.voiceTarget(url), let kind = WatchChat.Kind(rawValue: target.kind)
      else { return }
      let name = WatchShelf.load().first { $0.id == target.id }?.name ?? ""
      voiceTarget = WatchChat(kind: kind, id: target.id, name: name)
      openVoiceTarget()
      if voiceTarget != nil { Task { await load() } }
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

  private func openVoiceTarget() {
    guard scope != nil, let target = voiceTarget,
      let row = chats.first(where: { $0.chat.kind == target.kind && $0.id == target.id })
    else { return }
    voiceTarget = nil
    path = [row.id]
    listen = true
  }

  private func saveShelf(_ bots: [WatchBot], rows: [WatchChatRow]) {
    let saved = bots.map { bot in
      WatchShelfChat(
        kind: WatchChat.Kind.bot.rawValue, id: bot.id, name: bot.name, color: bot.color,
        avatar: rows.first { $0.chat.kind == .bot && $0.id == bot.id }?.avatar)
    }
    guard WatchShelf.save(saved) else { return }
    WidgetCenter.shared.invalidateConfigurationRecommendations()
    WidgetCenter.shared.reloadTimelines(ofKind: WatchShelf.complicationKind)
  }

  private func clearChats() {
    voiceTarget = nil
    path = []
    chats = []
    scope = nil
    failure = nil
  }

  private func load() async {
    guard !loading else { return }
    let identity = connection.identityRevision
    let requested = voiceTarget
    loading = true
    defer { loading = false }
    do {
      // The relay keeps the chat a complication opened in the list, however old it is.
      let reply = try await connection.request(WatchRequest(action: .chats, chat: voiceTarget))
      guard phase == .active, !Task.isCancelled, identity == connection.identityRevision
      else { return }
      scope = reply.scope
      chats = reply.chats ?? []
      canTranscribe = reply.transcribe
      failure = nil
      saveShelf(reply.bots ?? [], rows: chats)
      openVoiceTarget()
      // A tap during a load that asked for another bot or none asks again. A bot that is gone
      // opens nothing, and a later load must not start listening by itself.
      if voiceTarget != nil && voiceTarget != requested { Task { await load() } }
      else { voiceTarget = nil }
    } catch {
      guard !Task.isCancelled, identity == connection.identityRevision else { return }
      chats = []
      scope = nil
      failure = error as? WatchFailure ?? .unavailable
      // Signed out: the face stops offering the account's bots. Each load replaces them otherwise.
      if failure == .signIn { saveShelf([], rows: []) }
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
  let canTranscribe: Bool
  /// Set when a complication opened the chat to speak a message.
  @Binding var listen: Bool
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
  @State private var recording = false
  @State private var sendAfterWork = false
  @FocusState private var typing: Bool
  @State private var waits = 0

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
          if botWorking { WatchTypingBubble(tint: tint) }
          if let failure {
            Text(failure.label).font(.footnote).foregroundStyle(.secondary)
          }
          TextField("Message", text: $draft)
            .onSubmit { startSend() }
            .disabled(working || failure == .signIn || failure == .unlockPhone)
            .focused($typing)
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
    .onChange(of: working) {
      guard !working, sendAfterWork else { return }
      sendAfterWork = false
      startSend()
    }
    .onChange(of: listen, initial: true) {
      guard listen else { return }
      listen = false
      if canTranscribe { recording = true } else { typing = true }
    }
    .sheet(isPresented: $recording) {
      WatchVoiceSheet { audio in
        try await connection.transcribe(audio, scope: scope, chat: chat)
      } finish: { result in
        recording = false
        switch result {
        case .text(let text):
          // The words wait in the composer while they send, so the wrist shows what went out.
          draft = text
          if working { sendAfterWork = true } else { startSend() }
        case .typeInstead:
          typing = true
        }
      }
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
    // A suspended iPhone app cannot publish a revision, so ask it to wait for the reply.
    .task(id: botWorking && connection.reachable && phase == .active ? waits : nil) {
      guard botWorking, connection.reachable, phase == .active else { return }
      do {
        let reply = try await connection.request(WatchRequest(action: .wait, scope: scope, chat: chat))
        guard !Task.isCancelled else { return }
        if reply.changed == true { await refresh() } else { waits += 1 }
      } catch {
        // Stop rather than retry; the message asks for a refresh.
        if !Task.isCancelled { failure = error as? WatchFailure ?? .unavailable }
      }
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
      waits += 1
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
    let text = draft
    if text != sendingText {
      sendingText = text
      sendNonce = UUID()
    }
    do {
      _ = try await connection.request(
        WatchRequest(action: .send, scope: scope, chat: chat, text: text, nonce: sendNonce))
    } catch {
      failure = error as? WatchFailure ?? .sendUnconfirmed
      return
    }
    // Words spoken while this sent wait to go next.
    if draft == text { draft = "" }
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

/// The bot's side of the thread while it works on a reply: a bubble with pulsing dots.
private struct WatchTypingBubble: View {
  let tint: Color
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(minimumInterval: 0.15, paused: reduceMotion)) { context in
      let phase = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate * 2.4
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { index in
          let wave = (sin(phase - Double(index) * 0.9) + 1) / 2
          Circle()
            .frame(width: 6, height: 6)
            .opacity(0.35 + 0.65 * wave)
            .offset(y: -2 * wave)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(tint.opacity(0.3), in: RoundedRectangle(cornerRadius: 16))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement()
    .accessibilityLabel("Working")
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

extension WatchFailure {
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
    case .noVoice: "Voice messages aren’t set up."
    case .voiceFailed: "Couldn’t transcribe. Try again."
    case .voiceAccount: "Check Voice settings on your iPhone."
    }
  }
}
