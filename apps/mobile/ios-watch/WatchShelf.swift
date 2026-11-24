import Foundation
import SwiftUI

/// A bot the watch face can offer, as the watch app last listed it.
struct WatchShelfChat: Codable, Hashable, Identifiable {
  let kind: String
  let id: String
  let name: String
  var color: String?
  var avatar: Data?
}

/// The bots the watch app saves for its complications, in the App Group both can read.
enum WatchShelf {
  static let complicationKind = "WatchChatComplication"

  private static var file: URL? {
    // The watch app is <app>.watchkitapp and its complications <app>.watchkitapp.complications.
    guard let bundle = Bundle.main.bundleIdentifier,
      let app = bundle.components(separatedBy: ".watchkitapp").first,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: "group.\(app)")
    else { return nil }
    return container.appending(path: "watch-chats.json")
  }

  static func load() -> [WatchShelfChat] {
    guard let file, let data = try? Data(contentsOf: file) else { return [] }
    return (try? JSONDecoder().decode([WatchShelfChat].self, from: data)) ?? []
  }

  /// Saves the list and answers whether it changed.
  @discardableResult
  static func save(_ chats: [WatchShelfChat]) -> Bool {
    guard let file, chats != load(), let data = try? JSONEncoder().encode(chats) else {
      return false
    }
    return (try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil
  }

  /// Opens the chat and starts listening.
  static func voiceURL(for chat: WatchShelfChat) -> URL? {
    var components = URLComponents()
    components.scheme = "rakazo-watch"
    components.host = "voice"
    components.queryItems = [.init(name: "kind", value: chat.kind), .init(name: "id", value: chat.id)]
    return components.url
  }

  static func voiceTarget(_ url: URL) -> (kind: String, id: String)? {
    guard url.scheme == "rakazo-watch", url.host == "voice",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      let kind = items.first(where: { $0.name == "kind" })?.value,
      let id = items.first(where: { $0.name == "id" })?.value
    else { return nil }
    return (kind, id)
  }
}

extension Color {
  /// A bot's color as the relay sends it, #RRGGBB.
  init?(hex: String) {
    guard hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    self.init(
      red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255)
  }
}
