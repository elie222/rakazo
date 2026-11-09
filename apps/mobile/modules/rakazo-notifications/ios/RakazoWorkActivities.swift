import ActivityKit
import Foundation

/// Starts the phone's live status card when the user sends, and hands its push token to the app,
/// which gives it to the server. The server updates and ends the card, and starts one by push when
/// the user's bots get to work from another device. It runs on the main queue.
@available(iOS 18.0, *)
final class WorkActivities {
  static let shared = WorkActivities()

  /// Receives the card's push token, again whenever iOS changes it.
  var onToken: ((_ token: String) -> Void)?
  /// Receives the phone's token for starting a card by push, again whenever iOS changes it.
  var onStartToken: ((_ token: String) -> Void)?

  /// Tokens are watched per card, once, for as long as this launch of the app runs.
  private var watched = Set<String>()
  /// Cards being ended: a send meanwhile starts a new one instead of reusing them.
  private var ending = Set<String>()
  private var observing = false

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

  /// Follows cards the server starts by push, and the token that lets it. Called once.
  func observe() {
    guard !observing else { return }
    observing = true
    Task { @MainActor [weak self] in
      for await token in Activity<WorkActivityAttributes>.pushToStartTokenUpdates {
        self?.onStartToken?(hex(token))
      }
    }
    Task { @MainActor [weak self] in
      for await activity in Activity<WorkActivityAttributes>.activityUpdates {
        guard let self else { return }
        // One card for all of the user's work: one started by push as this phone started its own
        // goes again, and the card the server already follows stays.
        let others = Activity<WorkActivityAttributes>.activities.filter {
          $0.id != activity.id && $0.activityState == .active && !self.ending.contains($0.id)
        }
        if !others.isEmpty {
          self.ending.insert(activity.id)
          await activity.end(nil, dismissalPolicy: .immediate)
          self.ending.remove(activity.id)
          continue
        }
        self.watch(activity)
      }
    }
  }

  /// Hands the phone's token for starting cards to the app again, such as for a new sign-in.
  func refreshStartToken() {
    if let token = Activity<WorkActivityAttributes>.pushToStartToken { onStartToken?(hex(token)) }
  }

  /// Hands the showing card's token to the app again, so the server confirms it still follows
  /// work, such as when the app opens after its last update went missing. False with no card.
  @discardableResult
  func refresh() -> Bool {
    guard let current = Activity<WorkActivityAttributes>.activities.first(where: {
      $0.activityState == .active && !ending.contains($0.id)
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
      ending.insert(activity.id)
      Task { @MainActor [weak self] in
        await activity.end(nil, dismissalPolicy: .immediate)
        self?.ending.remove(activity.id)
      }
    }
  }
}

private func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}
