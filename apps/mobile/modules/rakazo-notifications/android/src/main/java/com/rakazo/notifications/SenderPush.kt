package com.rakazo.notifications

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import org.json.JSONObject

/** What the messaging service does with a message push that is not a call. */
internal enum class PushDisposition { EXPO, DROP, POST }

/**
 * Builds that register sender support get message pushes as data only, because Expo's
 * notification messages bypass app code in the background. Anything without that copy is
 * left to Expo.
 */
internal object SenderPush {
  private const val MAX_AVATAR_CHARS = 1400
  private const val MAX_AVATAR_PIXELS = 96
  private const val SILENT_GROUP = "rakazo.silent"

  /** Its own ID per thread, as Expo's had, so the poller's fallback post never replaces it. */
  fun notificationId(threadId: String) = "push:$threadId".hashCode()

  /**
   * Decides a message push without Android calls, so the policy stays unit-testable. A Rakazo
   * push with no stored session belongs to an account that signed out or left for another
   * server; it is dropped here, because handing it back to Expo would still show it.
   */
  fun disposition(
    data: JSONObject,
    hasSession: () -> Boolean,
    openThread: () -> Boolean,
    foreground: () -> Boolean,
  ): PushDisposition {
    val botId = data.optString("botId")
    val threadId = data.optString("threadId")
    if (data.optString("notificationTitle").isBlank()) {
      return if (botId.isNotBlank() && threadId.isNotBlank()) PushDisposition.DROP else PushDisposition.EXPO
    }
    if (botId.isBlank()) return PushDisposition.EXPO
    if (threadId.isBlank()) return PushDisposition.EXPO
    if (!hasSession()) return PushDisposition.DROP
    if (openThread()) return PushDisposition.DROP
    // Matches the app's foreground handler: finished work is already on screen.
    if (data.optString("kind") == "completion" && foreground()) return PushDisposition.DROP
    return PushDisposition.POST
  }

  fun present(context: Context, data: JSONObject): Boolean {
    val foreground by lazy { inForeground() }
    return when (
      disposition(
        data,
        { NotificationStorage(context).token.isNotBlank() },
        { RakazoNotificationService.isOpenThread(data.optString("botId"), data.optString("threadId")) },
        { foreground },
      )
    ) {
      PushDisposition.EXPO -> false
      PushDisposition.DROP -> true
      PushDisposition.POST ->
        runCatching {
            post(context, data, data.optString("notificationTitle"), data.optString("botId"), data.optString("threadId"), foreground)
          }
          .onFailure { Log.w("RakazoSenderPush", "Could not post push", it) }
          .isSuccess
    }
  }

  private fun post(
    context: Context,
    data: JSONObject,
    title: String,
    botId: String,
    threadId: String,
    foreground: Boolean,
  ) {
    val body = data.optString("notificationBody")
    // Like the app's foreground handler, a push that arrives while the app is open stays quiet.
    val channel = when {
      foreground && Build.VERSION.SDK_INT < 31 -> Channels.LIVE
      data.optString("kind") in setOf("help", "takeover", "failure") -> Channels.ATTENTION
      else -> Channels.MESSAGES
    }
    createRakazoChannels(context)
    @Suppress("DEPRECATION")
    val builder = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel) else Notification.Builder(context))
      .setSmallIcon(R.drawable.ic_rakazo_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setContentIntent(openThread(context, data, botId, threadId))
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .apply { if (data.has("notificationBadge")) setNumber(data.optInt("notificationBadge")) }
      // Notification.Builder has no setSilent; this is what NotificationCompat's setSilent does:
      // a child of a group that alerts only for its summary posts without sound or heads-up.
      .apply {
        if (foreground && Build.VERSION.SDK_INT >= 31) {
          setGroup(SILENT_GROUP)
          setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
        }
      }
      .addExtras(Bundle().apply {
        putString("rakazo.botId", botId)
        putString("rakazo.threadId", threadId)
        data.optString("runId").takeIf(String::isNotBlank)?.let { putString(RakazoNotificationService.EXTRA_RUN_ID, it) }
        data.optString("groupId").takeIf(String::isNotBlank)?.let { putString("rakazo.groupId", it) }
      })
    runCatching { addSender(context, builder, data, title, body) }
      .onFailure { Log.w("RakazoSenderPush", "Posting without the sender", it) }
    context.getSystemService(NotificationManager::class.java).notify(notificationId(threadId), builder.build())
  }

  private fun addSender(context: Context, builder: Notification.Builder, data: JSONObject, title: String, body: String) {
    val sender = data.optJSONObject("sender") ?: return
    val name = sender.optString("name").takeIf(String::isNotBlank) ?: return
    val portrait = portrait(sender.optString("avatar"))
    portrait?.let(builder::setLargeIcon)
    if (Build.VERSION.SDK_INT < 28) return
    val person = Person.Builder()
      .setName(name)
      .setKey(sender.optString("botId").ifBlank { name })
      .apply { portrait?.let { setIcon(Icon.createWithBitmap(it)) } }
      .build()
    val user = Person.Builder().setName(context.applicationInfo.loadLabel(context.packageManager)).build()
    // The title says why it alerted ("… failed"), so it stays as the heading above the sender.
    val style = Notification.MessagingStyle(user).addMessage(body, System.currentTimeMillis(), person)
      .setConversationTitle(title).setGroupConversation(true)
    builder.setStyle(style)
  }

  private fun portrait(encoded: String): Bitmap? = runCatching {
    if (encoded.isBlank() || encoded.length > MAX_AVATAR_CHARS) return@runCatching null
    val bytes = Base64.decode(encoded, Base64.DEFAULT)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth !in 1..MAX_AVATAR_PIXELS || bounds.outHeight !in 1..MAX_AVATAR_PIXELS) null
    else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
  }.getOrNull()

  private fun openThread(context: Context, data: JSONObject, botId: String, threadId: String): PendingIntent {
    val groupId = data.optString("groupId")
    val owner = if (groupId.isNotBlank()) "group-thread?groupId=${Uri.encode(groupId)}" else "thread?botId=${Uri.encode(botId)}"
    val link = "rakazo://$owner&spaceId=${Uri.encode(data.optString("spaceId"))}&threadId=${Uri.encode(threadId)}"
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(
      context,
      threadId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun inForeground(): Boolean {
    val process = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(process)
    return process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }
}
