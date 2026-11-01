package com.rakazo.notifications

import android.app.ActivityManager
import android.app.Notification as NativeNotification
import android.content.Context
import android.app.Person
import android.graphics.drawable.Icon
import android.os.Build
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.interfaces.INotificationContent
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate

/** Keep Expo's request and tap metadata; add the sender portrait to background pushes. */
class AgentMessagingService : ExpoFirebaseMessagingService() {
  override val firebaseMessagingDelegate by lazy {
    object : FirebaseMessagingDelegate(this@AgentMessagingService) {
      override fun createNotificationRequest(identifier: String, content: INotificationContent, notificationTrigger: FirebaseNotificationTrigger): NotificationRequest {
        val data = content.body
        val rendered = if (data?.has("notificationTitle") == true) {
          NotificationContent.Builder().setTitle(data.optString("notificationTitle"))
            .setText(data.optString("notificationBody")).setBody(data).useDefaultSound()
            .setAutoDismiss(true).apply {
              if (data.has("notificationBadge")) setBadgeCount(data.optInt("notificationBadge"))
            }.build()
        } else content
        return super.createNotificationRequest(identifier, AgentNotificationContent(rendered), notificationTrigger)
      }

      override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val process = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(process)
        createAgentNotificationChannels(context)
        val notification = createNotification(remoteMessage)
        val sender = notification.notificationRequest.content.body?.optJSONObject("sender")
        if (sender == null || process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
          super.onMessageReceived(remoteMessage)
          return
        }
        AgentPresentationDelegate(this@AgentMessagingService).presentNotification(notification, null)
        runTaskManagerTasks(context.applicationContext, expo.modules.notifications.notifications.RemoteMessageSerializer.toBundle(remoteMessage))
      }
    }
  }
}

private class AgentPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  override suspend fun createNotification(notification: Notification, notificationBehavior: NotificationBehaviorRecord?): NativeNotification {
    val original = super.createNotification(notification, notificationBehavior)
    val content = notification.notificationRequest.content
    val sender = content.body?.optJSONObject("sender") ?: return original
    val name = sender.optString("name")
    val botId = sender.optString("botId")
    if (name.isBlank() || botId.isBlank()) return original
    val bitmap = senderPortrait(sender)
    val builder = NativeNotification.Builder.recoverBuilder(context, original)
      .setContentTitle(name).apply { bitmap?.let { setLargeIcon(it) } }
    if (Build.VERSION.SDK_INT >= 28) {
      val person = Person.Builder().setName(name).setKey(botId)
        .apply { bitmap?.let { setIcon(Icon.createWithBitmap(it)) } }.build()
      builder.setStyle(NativeNotification.MessagingStyle(Person.Builder().setName("Rakazo").build())
        .addMessage(content.text.orEmpty(), notification.originDate.time, person))
    }
    return builder.build()
  }
}
