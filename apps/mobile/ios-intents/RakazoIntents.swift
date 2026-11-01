import AppIntents
import Foundation
import Security
import UIKit
import UniformTypeIdentifiers

/// Sends a message to a bot from Shortcuts, Siri or the Action button without opening the app.
/// Without a chosen bot it goes to the one whose chat was opened last, so it needs no setup.
struct MessageBotIntent: AppIntent {
  static let title: LocalizedStringResource = "Message Bot"
  static let description = IntentDescription(
    "Send a message to a bot. It works on it in the background and doesn't wait for a reply.")
  // The session is in the keychain, which is readable only while the device is unlocked.
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Bot", description: "Leave empty to use the chat you opened last.")
  var bot: BotEntity?

  @Parameter(title: "Message", requestValueDialog: "What should it say?")
  var message: String

  @Parameter(title: "File")
  var file: IntentFile?

  static var parameterSummary: some ParameterSummary {
    Summary("Send \(\.$message) to \(\.$bot)") { \.$file }
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw $message.needsValueError()
    }
    _ = try await send(message, file: file, to: bot)
    return .result(dialog: "Sent.")
  }
}

/// Sends like Message Bot, then waits for the reply so Siri can read it out or a shortcut can use it.
struct AskBotIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Bot"
  static let description = IntentDescription(
    "Ask a bot and get its reply here, to show, read aloud or use in the next step.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Bot", description: "Leave empty to use the chat you opened last.")
  var bot: BotEntity?

  @Parameter(title: "Message", requestValueDialog: "What should it say?")
  var message: String

  @Parameter(title: "File")
  var file: IntentFile?

  static var parameterSummary: some ParameterSummary {
    Summary("Ask \(\.$bot) \(\.$message)") { \.$file }
  }

  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw $message.needsValueError()
    }
    let sent = try await send(message, file: file, to: bot)
    guard let reply = try await reply(to: sent), !reply.isEmpty else {
      return .result(value: "", dialog: "Sent. The reply will be in Rakazo.")
    }
    return .result(value: reply, dialog: "\(reply)")
  }
}

/// Starts a routine now, the way mentioning it in the composer does.
struct RunRoutineIntent: AppIntent {
  static let title: LocalizedStringResource = "Run Routine"
  static let description = IntentDescription("Start a routine now. It runs in the background.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Routine")
  var routine: RoutineEntity

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let session = try RakazoSession.load()
    try await session.requireConsent(["routineId": routine.routineId], spaceId: routine.spaceId)
    let _: Started = try await session.rpc(
      "routines/testRun", ["routineId": routine.routineId, "clientNonce": UUID().uuidString],
      spaceId: routine.spaceId)
    return .result(dialog: "Started.")
  }
}

/// Opens a bot's chat through the app's own link, the same route a notification opens.
struct OpenBotIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Bot"
  static let description = IntentDescription("Open a bot's chat in Rakazo.")
  static let openAppWhenRun = true

  @Parameter(title: "Bot")
  var bot: BotEntity

  @MainActor
  func perform() async throws -> some IntentResult {
    await openChat(botId: bot.botId, spaceId: bot.spaceId)
    return .result()
  }
}

/// Opens a bot's chat and starts a voice call. The call request goes through
/// modules/rakazo-voice-chat, since the chat link alone must never open the microphone.
struct StartVoiceChatIntent: AppIntent {
  static let title: LocalizedStringResource = "Start Voice Chat"
  static let description = IntentDescription("Open Rakazo and start a voice call with a bot.")
  static let openAppWhenRun = true

  @Parameter(title: "Bot", description: "Leave empty to use the chat you opened last.")
  var bot: BotEntity?

  @MainActor
  func perform() async throws -> some IntentResult {
    guard let target = target(bot) else { throw MessageBotError.noBot }
    let botId = target.botId
    UserDefaults.standard.set(
      ["botId": botId, "at": String(Date().timeIntervalSince1970)],
      forKey: "rakazo.pending_voice_chat")
    NotificationCenter.default.post(name: Notification.Name("RakazoPendingVoiceChat"), object: nil)
    await openChat(botId: botId, spaceId: target.spaceId)
    return .result()
  }
}

/// The chosen bot, or the one whose chat was opened last, with the Space it was opened in.
private func target(_ bot: BotEntity?) -> (botId: String, spaceId: String?)? {
  if let bot { return (bot.botId, bot.spaceId) }
  guard let last = secureStoreItem("rakazo.last_bot_id"), !last.isEmpty else { return nil }
  let space = secureStoreItem("rakazo.last_bot_space_id")
  return (last, space?.isEmpty == false ? space : nil)
}

@MainActor
private func openChat(botId: String, spaceId: String?) async {
  var link = URLComponents(string: "rakazo://thread")
  link?.queryItems = [URLQueryItem(name: "botId", value: botId)]
  if let spaceId { link?.queryItems?.append(URLQueryItem(name: "spaceId", value: spaceId)) }
  if let url = link?.url { await UIApplication.shared.open(url) }
}

private struct Delivery {
  let session: RakazoSession
  let botId: String
  let spaceId: String?
  let runId: String
}

/// Sends with the app's own session and the same procedures as the composer, so the bot runs it
/// as a message the user sent. Without a chosen bot it goes to the one whose chat was opened last.
private func send(_ message: String, file: IntentFile?, to bot: BotEntity?) async throws -> Delivery {
  guard let target = target(bot) else { throw MessageBotError.noBot }
  let botId = target.botId
  let session = try RakazoSession.load()
  let spaceId = target.spaceId ?? session.selectedSpaceId
  try await session.requireConsent(["botId": botId], spaceId: spaceId)
  var input: [String: Any] = [
    "botId": botId,
    "text": message.trimmingCharacters(in: .whitespacesAndNewlines),
    "clientNonce": UUID().uuidString,
  ]
  if let file {
    let artifact: Artifact = try await session.rpc(
      "artifacts/create",
      [
        "botId": botId,
        "name": file.filename,
        "mimeType": file.type?.preferredMIMEType ?? "application/octet-stream",
        "contentBase64": file.data.base64EncodedString(),
      ],
      spaceId: spaceId)
    input["artifactIds"] = [artifact.id]
    input["imageHandling"] = "confirm"
  }
  let sent: Sent = try await session.rpc("threads/send", input, spaceId: spaceId)
  return Delivery(session: session, botId: botId, spaceId: spaceId, runId: sent.runId)
}

/// The bot's text for the run, once it finishes or stops to wait for the user; nil if it is still
/// working after about half a minute, which is as long as Siri waits comfortably.
private func reply(to sent: Delivery) async throws -> String? {
  let deadline = Date().addingTimeInterval(28)
  while Date() < deadline {
    try await Task.sleep(nanoseconds: 2_000_000_000)
    // The message is already sent, so a dropped connection only means no reply yet.
    let thread: ThreadSnapshot
    do {
      thread = try await sent.session.rpc(
        "threads/get", ["botId": sent.botId], spaceId: sent.spaceId, timeout: 5)
    } catch is URLError {
      continue
    }
    let active = thread.activeRuns?.first { $0.id == sent.runId }
    if let active, !active.status.hasPrefix("waiting") { continue }
    if active == nil, thread.run?.id == sent.runId, thread.run?.status == "failed" {
      throw MessageBotError.server(nil)
    }
    let text = thread.messages
      .filter { $0.runId == sent.runId && $0.role == "bot" }
      .flatMap(\.blocks).compactMap(\.text).joined(separator: "\n\n")
    if text.isEmpty, active != nil { throw MessageBotError.needsYou }
    // Replies are markdown; Siri and the result dialog show plain text.
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)).map { String($0.characters) }
      ?? text
  }
  return nil
}

/// Puts the actions in Shortcuts, Spotlight and the Action button without the user building one.
struct RakazoShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: MessageBotIntent(),
      phrases: ["Send a message with \(.applicationName)"],
      shortTitle: "Message Bot",
      systemImageName: "bubble.left")
    AppShortcut(
      intent: AskBotIntent(),
      phrases: ["Ask a question in \(.applicationName)"],
      shortTitle: "Ask Bot",
      systemImageName: "bubble.left.and.text.bubble.right")
    AppShortcut(
      intent: RunRoutineIntent(),
      phrases: ["Run a routine in \(.applicationName)"],
      shortTitle: "Run Routine",
      systemImageName: "play")
    AppShortcut(
      intent: OpenBotIntent(),
      phrases: ["Open a bot in \(.applicationName)"],
      shortTitle: "Open Bot",
      systemImageName: "arrow.up.forward.app")
    AppShortcut(
      intent: StartVoiceChatIntent(),
      phrases: ["Start a voice chat in \(.applicationName)"],
      shortTitle: "Start Voice Chat",
      systemImageName: "waveform")
  }
}

struct BotEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Bot"
  static let defaultQuery = BotQuery()

  /// The Space travels with the bot, so a saved shortcut keeps working after the app switches Space.
  var id: String { "\(spaceId)/\(botId)" }
  let botId: String
  let spaceId: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

/// Looks entities up Space by Space, since each id starts with its Space.
private func findEntities<Entity: AppEntity>(
  _ identifiers: [String],
  in list: (String, RakazoSession) async throws -> [Entity]
) async throws -> [Entity] where Entity.ID == String {
  let session = try RakazoSession.load()
  var found: [Entity] = []
  for spaceId in Set(identifiers.compactMap { $0.split(separator: "/").first.map(String.init) }) {
    found += try await list(spaceId, session).filter { identifiers.contains($0.id) }
  }
  return found
}

struct BotQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [BotEntity] {
    try await findEntities(identifiers) { try await bots(in: $0, session: $1) }
  }

  func suggestedEntities() async throws -> [BotEntity] {
    let session = try RakazoSession.load()
    return try await bots(in: session.selectedSpaceId, session: session)
  }

  private func bots(in spaceId: String?, session: RakazoSession) async throws -> [BotEntity] {
    let navigation: SpaceNavigation = try await session.rpc("spaces/list", [:], spaceId: spaceId)
    return navigation.current.bots.map {
      BotEntity(botId: $0.id, spaceId: navigation.current.id, name: $0.name)
    }
  }
}

struct RoutineEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Routine"
  static let defaultQuery = RoutineQuery()

  var id: String { "\(spaceId)/\(routineId)" }
  let routineId: String
  let spaceId: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct RoutineQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [RoutineEntity] {
    try await findEntities(identifiers) { try await routines(in: $0, session: $1) }
  }

  func suggestedEntities() async throws -> [RoutineEntity] {
    let session = try RakazoSession.load()
    return try await routines(in: session.selectedSpaceId, session: session)
  }

  private func routines(in spaceId: String?, session: RakazoSession) async throws -> [RoutineEntity] {
    let navigation: SpaceNavigation = try await session.rpc("spaces/list", [:], spaceId: spaceId)
    let botIds = navigation.current.bots.prefix(100).map(\.id)
    guard !botIds.isEmpty else { return [] }
    let lists: [BotRoutines] = try await session.rpc(
      "routines/listForMentions", ["botIds": Array(botIds)], spaceId: navigation.current.id)
    return lists.flatMap(\.routines).map {
      RoutineEntity(routineId: $0.id, spaceId: navigation.current.id, name: $0.name)
    }
  }
}

private struct RakazoSession {
  let apiBase: String
  let token: String
  let selectedSpaceId: String?
  let headers: [String: String]

  // The keys lib/session.ts, lib/server-config.ts and lib/api.ts keep in expo-secure-store.
  static func load() throws -> RakazoSession {
    guard let token = secureStoreItem("rakazo.session_token"), !token.isEmpty else {
      throw MessageBotError.signedOut
    }
    let fallback = Bundle.main.object(forInfoDictionaryKey: "RakazoDefaultApiBase") as? String
    guard let apiBase = secureStoreItem("rakazo.api_base") ?? fallback else {
      throw MessageBotError.signedOut
    }
    let space = secureStoreItem("rakazo.space_id")
    return RakazoSession(
      apiBase: apiBase.hasSuffix("/") ? String(apiBase.dropLast()) : apiBase,
      token: token,
      selectedSpaceId: space?.isEmpty == false ? space : nil,
      headers: serverHeaders(for: apiBase))
  }

  /// The headers lib/server-headers.ts saved for this server, such as an access proxy's.
  private static func serverHeaders(for apiBase: String) -> [String: String] {
    guard let stored = secureStoreItem("rakazo.server_headers")?.data(using: .utf8),
      let saved = try? JSONDecoder().decode(SavedHeaders.self, from: stored),
      saved.apiBase == apiBase
    else { return [:] }
    return saved.headers
  }

  /// The app asks before AI first sees the user's data; an action from here cannot ask.
  func requireConsent(_ target: [String: String], spaceId: String?) async throws {
    let uses = ["model", "memory"]
    var input: [String: Any] = target
    input["uses"] = uses
    let consent: ConsentStatus = try await rpc("aiConsent/status", input, spaceId: spaceId)
    guard consent.recipients.allSatisfy({ $0.allowed || !uses.contains($0.use) }) else {
      throw MessageBotError.consentRequired
    }
  }

  /// Calls an oRPC procedure the way lib/api.ts does.
  func rpc<Output: Decodable>(
    _ procedure: String, _ input: [String: Any], spaceId: String?, timeout: TimeInterval = 60
  ) async throws -> Output {
    guard let url = URL(string: "\(apiBase)/rpc/\(procedure)") else {
      throw MessageBotError.signedOut
    }
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = "POST"
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("rakazo://", forHTTPHeaderField: "origin")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let spaceId { request.setValue(spaceId, forHTTPHeaderField: "x-rakazo-space-id") }
    request.httpBody = try JSONSerialization.data(withJSONObject: ["json": input])
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { throw MessageBotError.signedOut }
    guard (200..<300).contains(status) else {
      let error = try? JSONDecoder().decode(Envelope<ServerError>.self, from: data)
      throw MessageBotError.server(error?.json.message)
    }
    return try JSONDecoder().decode(Envelope<Output>.self, from: data).json
  }
}

/// Reads an item the way expo-secure-store writes it: service "app:no-auth" ("app" before the
/// library split items by authentication), with the key as the account.
private func secureStoreItem(_ key: String) -> String? {
  for service in ["app:no-auth", "app"] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Data(key.utf8),
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: AnyObject?
    if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    {
      return String(data: data, encoding: .utf8)
    }
  }
  return nil
}

private enum MessageBotError: Error, CustomLocalizedStringResourceConvertible {
  case signedOut
  case noBot
  case needsYou
  case consentRequired
  case server(String?)

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .signedOut: "Sign in to Rakazo first."
    case .noBot: "Open a chat in Rakazo first."
    case .needsYou: "It needs you in Rakazo."
    case .consentRequired: "Review AI data sharing in Account settings before continuing."
    case .server(let message?): "\(message)"
    case .server(nil): "Something went wrong. Try again."
    }
  }
}

private struct SavedHeaders: Decodable {
  let apiBase: String
  let headers: [String: String]
}
private struct Envelope<Value: Decodable>: Decodable { let json: Value }
private struct ServerError: Decodable { let message: String? }
private struct Sent: Decodable { let runId: String }
private struct Started: Decodable {}
private struct Artifact: Decodable { let id: String }
private struct BotRoutines: Decodable {
  struct Routine: Decodable {
    let id: String
    let name: String
  }
  let routines: [Routine]
}
private struct ThreadSnapshot: Decodable {
  struct Run: Decodable {
    let id: String
    let status: String
  }
  struct Message: Decodable {
    struct Block: Decodable { let text: String? }
    let role: String
    let runId: String?
    let blocks: [Block]
  }
  let messages: [Message]
  let run: Run?
  let activeRuns: [Run]?
}
private struct ConsentStatus: Decodable {
  struct Recipient: Decodable {
    let use: String
    let allowed: Bool
  }
  let recipients: [Recipient]
}
private struct SpaceNavigation: Decodable {
  struct Current: Decodable {
    let id: String
    let bots: [Bot]
  }
  struct Bot: Decodable {
    let id: String
    let name: String
  }
  let current: Current
}
