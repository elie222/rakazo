import AppIntents
import SwiftUI
import WidgetKit

/// A watch face complication for one bot: a tap opens its chat and starts listening.
@main
struct ChatComplication: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: WatchShelf.complicationKind, intent: ChatComplicationIntent.self,
      provider: ChatComplicationProvider()
    ) { entry in
      ChatComplicationView(chat: entry.chat)
        .containerBackground(.clear, for: .widget)
    }
    .configurationDisplayName("Bot")
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
  }
}

struct ChatEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Bot"
  static let defaultQuery = ChatEntityQuery()
  let chat: WatchShelfChat

  var id: String { chat.id }
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(chat.name)") }
}

struct ChatEntityQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [ChatEntity] {
    WatchShelf.load().filter { identifiers.contains($0.id) }.map(ChatEntity.init)
  }

  func suggestedEntities() async throws -> [ChatEntity] {
    WatchShelf.load().map(ChatEntity.init)
  }
}

struct ChatComplicationIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Bot"

  @Parameter(title: "Bot") var bot: ChatEntity?

  init() {}
  init(bot: ChatEntity) { self.bot = bot }
}

struct ChatComplicationEntry: TimelineEntry {
  let date: Date
  let chat: WatchShelfChat?
}

struct ChatComplicationProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> ChatComplicationEntry {
    ChatComplicationEntry(date: .now, chat: nil)
  }

  func snapshot(for configuration: ChatComplicationIntent, in context: Context) async
    -> ChatComplicationEntry
  {
    entry(for: configuration)
  }

  func timeline(for configuration: ChatComplicationIntent, in context: Context) async
    -> Timeline<ChatComplicationEntry>
  {
    // The watch app reloads complications when its list of bots changes.
    Timeline(entries: [entry(for: configuration)], policy: .never)
  }

  /// The watch face editor offers one complication per bot; picking one makes it the main bot.
  func recommendations() -> [AppIntentRecommendation<ChatComplicationIntent>] {
    WatchShelf.load().map {
      AppIntentRecommendation(intent: ChatComplicationIntent(bot: ChatEntity(chat: $0)), description: $0.name)
    }
  }

  /// The latest name and picture, and nothing once the bot is gone or the account signed out.
  private func entry(for configuration: ChatComplicationIntent) -> ChatComplicationEntry {
    let id = configuration.bot?.id
    return ChatComplicationEntry(date: .now, chat: WatchShelf.load().first { $0.id == id })
  }
}

struct ChatComplicationView: View {
  let chat: WatchShelfChat?
  @Environment(\.widgetFamily) private var family

  var body: some View {
    content
      .widgetURL(chat.flatMap(WatchShelf.voiceURL(for:)))
      .accessibilityLabel(chat?.name ?? "Rakazo")
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryInline:
      Label(chat?.name ?? "Rakazo", systemImage: "mic.fill")
    case .accessoryRectangular:
      HStack(spacing: 8) {
        ChatComplicationAvatar(chat: chat).frame(width: 36, height: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text(chat?.name ?? "Rakazo").font(.headline).lineLimit(1).widgetAccentable()
          Image(systemName: "mic.fill").font(.footnote).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }
    case .accessoryCorner:
      ChatComplicationAvatar(chat: chat)
        .widgetLabel { Text(chat?.name ?? "Rakazo") }
    default:
      ChatComplicationAvatar(chat: chat)
    }
  }
}

private struct ChatComplicationAvatar: View {
  let chat: WatchShelfChat?
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    if let data = chat?.avatar, let image = UIImage(data: data) {
      Image(uiImage: image).resizable().scaledToFill()
        .clipShape(Circle())
    } else {
      ZStack {
        if renderingMode == .fullColor, let color = chat?.color.flatMap(Color.init(hex:)) {
          Circle().fill(color)
        } else {
          AccessoryWidgetBackground().clipShape(Circle())
        }
        if let chat {
          Text(chat.name.prefix(1).uppercased())
            .font(.system(size: 20, weight: .semibold, design: .rounded))
            .minimumScaleFactor(0.5)
            .widgetAccentable()
        } else {
          Image(systemName: "mic.fill").font(.system(size: 18, weight: .semibold)).widgetAccentable()
        }
      }
    }
  }
}

