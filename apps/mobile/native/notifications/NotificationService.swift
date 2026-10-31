import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private let lock = NSLock()
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    fallback = request.content
    let data = request.content.userInfo["body"] as? [AnyHashable: Any] ?? request.content.userInfo
    guard let sender = data["sender"] as? [String: Any],
          let botId = sender["botId"] as? String,
          let name = sender["name"] as? String,
          !botId.isEmpty, !name.isEmpty else {
      finish(request.content)
      return
    }
    let encoded = sender["avatar"] as? String ?? ""
    let image = encoded.count <= 1400 ? Data(base64Encoded: encoded).map { INImage(imageData: $0) } : nil
    let person = INPerson(
      personHandle: INPersonHandle(value: botId, type: .unknown),
      nameComponents: nil, displayName: name, image: image,
      contactIdentifier: nil, customIdentifier: botId
    )
    let intent = INSendMessageIntent(
      recipients: nil, outgoingMessageType: .outgoingMessageText,
      content: request.content.body, speakableGroupName: nil,
      conversationIdentifier: data["threadId"] as? String,
      serviceName: nil, sender: person, attachments: nil
    )
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] _ in
      guard let self else { return }
      self.finish((try? request.content.updating(from: intent)) ?? request.content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let fallback { finish(fallback) }
  }

  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let completion = handler
    handler = nil
    lock.unlock()
    completion?(content)
  }
}
