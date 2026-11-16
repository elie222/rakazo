import ActivityKit
import Foundation

/// The phone's one live status card for every bot of the user's at work. The server updates and
/// ends it by push, so the state's fields match that payload. Compiled into this module and the
/// widget extension.
struct WorkActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    struct Row: Codable, Hashable {
      enum Status: String, Codable { case working, waiting }
      var status: Status
      /// The bot's name.
      var title: String
      /// The bot's latest step, or empty.
      var line: String
      var spaceId: String
      var botId: String?
      var groupId: String?
    }
    /// Bots at work, including those past the rows shown.
    var count: Int
    /// Bots waiting on the user.
    var waiting: Int
    /// Bots waiting on the user first, then the newest work.
    var rows: [Row]
  }
}

extension WorkActivityAttributes.ContentState.Row {
  /// Opens this bot's chat.
  var link: URL? {
    var parts = URLComponents()
    parts.scheme = "rakazo"
    parts.host = groupId == nil ? "thread" : "group-thread"
    parts.queryItems = [
      groupId.map { URLQueryItem(name: "groupId", value: $0) }
        ?? URLQueryItem(name: "botId", value: botId),
      URLQueryItem(name: "spaceId", value: spaceId),
    ]
    return parts.url
  }
}
