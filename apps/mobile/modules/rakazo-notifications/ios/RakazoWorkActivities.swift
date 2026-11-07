import ActivityKit
import Foundation

/// Starts the phone's live status card when the user sends, and hands its push token to the app,
/// which gives it to the server. The server updates and ends the card. It runs on the main queue.
@available(iOS 18.0, *)
final class WorkActivities {
  static let shared = WorkActivities()

  /// Receives the card's push token, again whenever iOS changes it.
  var onToken: ((_ token: String) -> Void)?

  /// Tokens are watched per card, once, for as long as this launch of the app runs.
  private var watched = Set<String>()

  func start(_ row: WorkActivityAttributes.ContentState.Row) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    // One card for all of the user's work: a send while it shows only re-registers it.
    if refresh() { return }
    let content = ActivityContent(
      state: WorkActivityAttributes.ContentState(count: 1, waiting: 0, rows: [row]),
      staleDate: nil)
    guard
      let activity = try? Activity.request(
        attributes: WorkActivityAttributes(), content: content, pushType: .token)
    else { return }
    watch(activity)
  }

  /// Hands the showing card's token to the app again, so the server confirms it still follows
  /// work, such as when the app opens after its last update went missing. False with no card.
  @discardableResult
  func refresh() -> Bool {
    guard let current = Activity<WorkActivityAttributes>.activities.first(where: {
      $0.activityState == .active
    }) else { return false }
    if let token = current.pushToken { onToken?(hex(token)) }
    // A card from an earlier launch may still change its token.
    watch(current)
    return true
  }

  private func watch(_ activity: Activity<WorkActivityAttributes>) {
    guard watched.insert(activity.id).inserted else { return }
    Task { @MainActor [weak self] in
      for await token in activity.pushTokenUpdates { self?.onToken?(hex(token)) }
    }
  }

  /// Ends the card straight away, such as when the server cannot update it.
  func end() {
    for activity in Activity<WorkActivityAttributes>.activities {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }
}

private func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}
