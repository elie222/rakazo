import Foundation

struct WatchChat: Codable, Identifiable, Hashable {
  let kind: Kind
  let id: String
  let name: String

  enum Kind: String, Codable {
    case bot, group

    var targetKey: String { self == .bot ? "botId" : "groupId" }
  }
}

struct WatchRequest: Codable {
  enum Action: String, Codable { case chats, thread, send, answer }
  let action: Action
  var scope: UUID?
  var chat: WatchChat?
  var text: String?
  var nonce: UUID?
  var messageId: String?
  var prompt: WatchPrompt?
}

struct WatchReply: Codable {
  var scope: UUID?
  var chats: [WatchChat]?
  var messages: [WatchMessage]?
  var botWorking: Bool?
  var error: WatchFailure?
}

enum WatchFailure: String, Codable, Error {
  case unlockPhone, signIn, consent, unavailable, reload, rejected, sendRejected
  case sendUnconfirmed, answerUnconfirmed
}

struct WatchMessage: Codable, Identifiable {
  let id: String
  let fromUser: Bool
  let text: String
  let prompt: WatchPrompt?
}

struct WatchPrompt: Codable, Equatable {
  struct Option: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    let outcome: String?
  }

  enum Kind: String, Codable { case question, approval, phone }
  let kind: Kind
  let title: String
  let detail: String?
  let options: [Option]
  var approvalEffectId: String?
}
