import ActivityKit
import SwiftUI
import WidgetKit

private typealias State = WorkActivityAttributes.ContentState
private typealias Row = WorkActivityAttributes.ContentState.Row

/// The user's bots at work, on the Lock Screen and in the Dynamic Island: one bot in full, more
/// as a row each. A tap opens that bot's chat; elsewhere on the card, the first row's.
struct WorkLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: WorkActivityAttributes.self) { context in
      lockScreen(context.state)
        .padding(16)
        .activityBackgroundTint(Color(white: 0.12))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(context.state.rows.first?.link)
    } dynamicIsland: { context in
      let state = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 10) {
            appMark(size: islandRow)
            Text(heading(state)).font(.system(size: 17, weight: .semibold)).lineLimit(1)
          }
          .frame(height: islandRow)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if let row = state.rows.first, state.count == 1 {
            status(row).frame(height: islandRow).padding(.trailing, 4)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          Group {
            if state.count == 1, let row = state.rows.first {
              if !row.line.isEmpty { line(row).font(.system(size: 16)) }
            } else {
              rows(Array(state.rows.prefix(3)))
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.top, 6).padding(.bottom, 4)
        }
      } compactLeading: {
        appMark(size: 22).padding(.leading, 2)
      } compactTrailing: {
        // Updates never open the island, so a question is spelled out here.
        if state.waiting > 0 {
          Text("Needs you").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
            .padding(.trailing, 4)
        } else {
          working(size: 15).padding(.trailing, 2)
        }
      } minimal: {
        state.waiting > 0
          ? AnyView(Image(systemName: "exclamationmark").font(.system(size: 13, weight: .bold)))
          : AnyView(working(size: 13))
      }
      .widgetURL(state.rows.first?.link)
    }
  }

  @ViewBuilder
  private func lockScreen(_ state: State) -> some View {
    if state.count == 1, let row = state.rows.first {
      HStack(alignment: row.line.isEmpty ? .center : .top, spacing: 14) {
        appMark(size: 44)
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .firstTextBaseline) {
            Text(row.title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 8)
            status(row)
          }
          .foregroundStyle(.white)
          if !row.line.isEmpty { line(row).font(.system(size: 15)) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          appMark(size: 24)
          Text(heading(state)).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
        }
        rows(state.rows)
      }
    }
  }

  private func rows(_ rows: [Row]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        Link(destination: row.link ?? URL(string: "rakazo://")!) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            // A long name gives way to the status, never the other way round.
            Text(row.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
              .lineLimit(1).layoutPriority(1)
            line(row, limit: 1).font(.system(size: 15))
            Spacer(minLength: 8)
            status(row)
          }
        }
      }
    }
  }

  /// One bot is named on its own row; more are counted, and the rows name them.
  private func heading(_ state: State) -> String {
    state.count == 1
      ? state.rows.first?.title ?? ""
      : String(localized: "\(state.count) bots")
  }

  @ViewBuilder
  private func status(_ row: Row) -> some View {
    if row.status == .waiting {
      Text("Needs you").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
        .fixedSize()
    } else {
      working(size: 15)
    }
  }

  private func working(size: CGFloat) -> some View {
    Image(systemName: "ellipsis").font(.system(size: size, weight: .bold))
      .foregroundStyle(Color.muted)
      .symbolEffect(.variableColor.iterative)
  }

  private func line(_ row: Row, limit: Int = 2) -> some View {
    Text(row.line).lineLimit(limit).foregroundStyle(Color.muted)
      .contentTransition(.interpolate)
      .privacySensitive()
  }
}
