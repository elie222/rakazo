import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct RakazoWidgets: WidgetBundle {
  var body: some Widget { VoiceMessageLiveActivity() }
}

private typealias Status = VoiceMessageAttributes.ContentState.Status

private extension Color {
  static let botAccent = Color.orange
  static let destructive = Color.red
  static let muted = Color.white.opacity(0.66)
}

/// The expanded island's status row: mark, label and signal share this height.
private let islandRow: CGFloat = 36

/// What a voice message shows on the Lock Screen and in the Dynamic Island while it records.
struct VoiceMessageLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: VoiceMessageAttributes.self) { context in
      lockScreen(context.state)
        .padding(16)
        .activityBackgroundTint(Color(white: 0.12))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let state = context.state
      return DynamicIsland {
        // Shown when the pill is long-pressed: a status row beside the camera, then the words.
        // Listening has only its row, so it fills the height and sits centred, its mark
        // concentric with the island's curve.
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 10) {
            appMark(size: islandRow)
            Text(heading(state.status)).font(.system(size: 17, weight: .semibold))
              .foregroundStyle(labelColor(state.status))
              .fixedSize()
              .id(state.status)
              .transition(.push(from: .bottom))
          }
          .frame(height: islandRow)
          .frame(maxHeight: state.status == .listening ? .infinity : nil)
        }
        DynamicIslandExpandedRegion(.trailing) {
          activity(state.status, size: 22).frame(height: islandRow).padding(.trailing, 4)
            .frame(maxHeight: state.status == .listening ? .infinity : nil)
        }
        DynamicIslandExpandedRegion(.bottom) {
          // Listening shows only its status; the whole message appears once it is sent.
          if state.status != .listening {
            words(state).font(.system(size: 16))
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.top, 6).padding(.bottom, 4)
          }
        }
      } compactLeading: {
        appMark(size: 22).padding(.leading, 2)
      } compactTrailing: {
        // Updates never open the island (that always vibrates), so thinking is spelled out here.
        if state.status == .thinking {
          Text("Thinking…").font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
            .padding(.trailing, 4)
        } else {
          compactSignal(state.status).padding(.trailing, 2)
        }
      } minimal: {
        compactSignal(state.status)
      }
    }
  }

  // MARK: Lock Screen

  private func lockScreen(_ state: VoiceMessageAttributes.ContentState) -> some View {
    HStack(alignment: state.status == .listening ? .center : .top, spacing: 14) {
      appMark(size: 44)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          activity(state.status, size: 15)
          Text(heading(state.status)).font(.system(size: 17, weight: .semibold))
        }
        .foregroundStyle(labelColor(state.status, muted: .white))
        .id(state.status)
        .transition(.push(from: .bottom))
        words(state).font(.system(size: 15))
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if state.status == .listening { actions }
    }
  }

  // MARK: Pieces

  private func appMark(size: CGFloat) -> some View {
    Image("AppMark").resizable().frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
  }

  /// The live signal: a waveform while listening, quiet dots while the bot thinks.
  @ViewBuilder
  private func activity(_ status: Status, size: CGFloat) -> some View {
    switch status {
    case .listening:
      Image(systemName: "waveform").font(.system(size: size, weight: .semibold))
        .foregroundStyle(Color.botAccent)
        .symbolEffect(.variableColor.iterative)
    case .thinking:
      Image(systemName: "ellipsis").font(.system(size: size, weight: .bold))
        .foregroundStyle(Color.muted)
        .symbolEffect(.variableColor.iterative)
    default: EmptyView()
    }
  }

  @ViewBuilder
  private func compactSignal(_ status: Status) -> some View {
    switch status {
    case .listening, .thinking: activity(status, size: 15)
    case .sending: Image(systemName: "arrow.up.circle").foregroundStyle(.white)
    case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.black, Color.destructive)
    }
  }

  /// Always a Text, even empty, so the actions keep their trailing place before any words arrive.
  private func words(_ state: VoiceMessageAttributes.ContentState) -> some View {
    Text(state.status == .listening ? "" : state.text).lineLimit(2)
      .foregroundStyle(state.status == .thinking ? Color.white : Color.muted)
      .contentTransition(.interpolate)
  }

  /// Cancel and send while listening: 44pt circles, send as the primary.
  private var actions: some View {
    HStack(spacing: 8) {
      Button(intent: CancelVoiceMessageIntent()) {
        Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
          .frame(width: 44, height: 44)
          .background(.white.opacity(0.14), in: Circle())
      }
      .accessibilityLabel(Text("Cancel"))
      Button(intent: SendVoiceMessageIntent()) {
        Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(.black)
          .frame(width: 44, height: 44)
          .background(.white, in: Circle())
      }
      .accessibilityLabel(Text("Send"))
    }
    .buttonStyle(.plain)
  }

  // MARK: Copy and colour

  private func labelColor(_ status: Status, muted: Color = .muted) -> Color {
    switch status {
    case .listening: .botAccent
    case .failed: .destructive
    default: muted
    }
  }

  private func heading(_ status: Status) -> String {
    switch status {
    case .listening: String(localized: "Listening")
    case .sending: String(localized: "Sending")
    case .thinking: String(localized: "Thinking")
    case .failed: String(localized: "Not sent")
    }
  }
}
