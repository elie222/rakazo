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

/// A chat as the list shows it. Requests name the chat alone, so they stay small.
struct WatchChatRow: Codable, Identifiable {
  let chat: WatchChat
  let preview: String
  let updatedAt: String
  var color: String?
  var avatar: Data?

  var id: String { chat.id }
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
  var chats: [WatchChatRow]?
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
  /// Who wrote it, when that is someone other than the user in a group.
  var author: String?
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
