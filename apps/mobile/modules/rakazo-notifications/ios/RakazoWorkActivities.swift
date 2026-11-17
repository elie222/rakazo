import ActivityKit
import Foundation
import UIKit

/// Starts the phone's live status card when the user sends, and hands its push token to the app,
/// which gives it to the server. The server updates and ends the card, and starts one by push when
/// the user's bots get to work from another device. It runs on the main queue.
@available(iOS 18.0, *)
final class WorkActivities {
  static let shared = WorkActivities()

  /// Receives the card's push token, again whenever iOS changes it, with the request it starts.
  var onToken: ((_ token: String, _ request: Int) -> Void)?
  /// Receives the phone's token for starting a card by push, again whenever iOS changes it.
  var onStartToken: ((_ token: String) -> Void)?

  /// Tokens are watched per card, once, for as long as this launch of the app runs.
  private var watched = Set<String>()
  /// Cards being ended: a send meanwhile starts a new one instead of reusing them.
  private var ending = Set<String>()
  private var observing = false
  /// The latest request asking the server whether it follows the card, from the app or from here.
  /// Only its answer may end the card: an older one can land after a newer one restarted the work.
  private var request = 0

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

  /// Follows cards the server starts by push, and the token that lets it. Called at launch, which
  /// may be iOS waking the app in the background for a card it just started.
  func observe() {
    guard !observing else { return }
    observing = true
    for activity in Activity<WorkActivityAttributes>.activities where activity.activityState == .active {
      watch(activity)
    }
    Task { @MainActor [weak self] in
      for await token in Activity<WorkActivityAttributes>.pushToStartTokenUpdates {
        self?.deliverStart(hex(token))
      }
    }
    Task { @MainActor [weak self] in
      for await activity in Activity<WorkActivityAttributes>.activityUpdates {
        guard let self else { return }
        guard activity.activityState == .active, !self.ending.contains(activity.id) else { continue }
        // One card for all of the user's work, and the newest stays: the server starts one only
        // on a phone where it follows none, so a card already here is out of its reach, such as one
        // it started while the app could not run to hand over its token. Nothing would end it.
        self.endOthers(than: activity)
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
    // iOS lists cards oldest first, so the newest stays. Either way the server follows the one kept
    // from its token and brings it up to date.
    guard let current = Activity<WorkActivityAttributes>.activities.last(where: {
      $0.activityState == .active && !ending.contains($0.id)
    }) else { return false }
    // Cards left from work the server could not follow would show it forever.
    endOthers(than: current)
    if let token = current.pushToken, let onToken {
      request += 1
      onToken(hex(token), request)
    }
    // A card from an earlier launch may still change its token.
    watch(current)
    return true
  }

  /// Ends every card but `kept` straight away.
  private func endOthers(than kept: Activity<WorkActivityAttributes>) {
    for other in Activity<WorkActivityAttributes>.activities
    where other.id != kept.id && other.activityState == .active && !ending.contains(other.id) {
      ending.insert(other.id)
      Task { @MainActor [weak self] in
        await other.end(nil, dismissalPolicy: .immediate)
        self?.ending.remove(other.id)
      }
    }
  }

  private func watch(_ activity: Activity<WorkActivityAttributes>) {
    guard watched.insert(activity.id).inserted else { return }
    Task { @MainActor [weak self] in
      for await token in activity.pushTokenUpdates { self?.deliver(hex(token)) }
    }
  }

  /// Like a card's token, a new start token may arrive while the app runs in the background.
  private func deliverStart(_ token: String) {
    if UIApplication.shared.applicationState == .active, let onStartToken {
      onStartToken(token)
      return
    }
    IncomingCalls.shared.send("notifications/registerWorkActivityStarts", ["token": token])
  }

  /// A card the server starts wakes the app in the background, where its JavaScript may not run
  /// in time, so the token goes to the server from here with the saved session.
  private func deliver(_ token: String) {
    request += 1
    let request = self.request
    if UIApplication.shared.applicationState == .active, let onToken {
      onToken(token, request)
      return
    }
    IncomingCalls.shared.send("notifications/followWorkActivity", ["token": token]) { [weak self] output in
      // Nothing would update it: no bot is at work or this server cannot reach the phone.
      if output?["following"] as? Bool == false { self?.endUnfollowed(request) }
    }
  }

  /// Ends the card for the server's answer to a request, unless a newer request was made since.
  func endUnfollowed(_ answered: Int) {
    if answered == request { end() }
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
