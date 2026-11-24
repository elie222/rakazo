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

struct WatchBot: Codable {
  let id: String
  let name: String
  var color: String?
}

struct WatchRequest: Codable {
  /// `wait` answers once the chat may have changed, so the watch hears replies while the
  /// iPhone app is suspended and cannot publish a revision.
  enum Action: String, Codable { case chats, thread, wait, send, answer, transcribe }
  let action: Action
  var scope: UUID?
  var chat: WatchChat?
  var text: String?
  var nonce: UUID?
  var messageId: String?
  var prompt: WatchPrompt?
  /// A recording travels in parts that each fit one message; the nonce names the recording.
  var audio: Data?
  var part: Int?
  var parts: Int?
}

struct WatchReply: Codable {
  var scope: UUID?
  var chats: [WatchChatRow]?
  /// The open bots the watch face can offer; the chat list may leave older ones out.
  var bots: [WatchBot]?
  var messages: [WatchMessage]?
  var botWorking: Bool?
  /// Whether the server can turn a recording into text; nil when it could not say.
  var transcribe: Bool?
  var text: String?
  /// For `wait`: the chat may have changed. Absent when the wait ran out first.
  var changed: Bool?
  var error: WatchFailure?
}

enum WatchFailure: String, Codable, Error {
  case unlockPhone, signIn, consent, unavailable, reload, rejected, sendRejected
  case sendUnconfirmed, answerUnconfirmed, noVoice, voiceFailed, voiceAccount
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
