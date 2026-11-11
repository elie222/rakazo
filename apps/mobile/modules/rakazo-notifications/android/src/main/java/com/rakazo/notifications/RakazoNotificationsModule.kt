package com.rakazo.notifications

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RakazoNotificationsModule : Module() {
  private var incomingReceiver: android.content.BroadcastReceiver? = null
  override fun definition() = ModuleDefinition {
    Name("RakazoNotifications")
    Constants("supportsSenderAvatars" to true)
    Events("onIncomingCallChanged")
    OnStartObserving {
      val receiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { sendEvent("onIncomingCallChanged", emptyMap<String, String>()) }
      }
      incomingReceiver = receiver
      val filter = android.content.IntentFilter(IncomingCalls.CHANGED)
      if (Build.VERSION.SDK_INT >= 33) context().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else context().registerReceiver(receiver, filter)
    }
    OnStopObserving {
      incomingReceiver?.let { context().unregisterReceiver(it) }
      incomingReceiver = null
    }

    AsyncFunction("configureIncomingSession") { endpoint: String, headers: Map<String, String> ->
      if (!isAllowedNotificationEndpoint(endpoint)) throw IllegalArgumentException("Invalid notification endpoint")
      val storage = NotificationStorage(context())
      storage.endpoint = endpoint
      storage.token = headers["authorization"]?.removePrefix("Bearer ") ?: ""
      storage.headers = org.json.JSONObject(headers.filterKeys { it.lowercase() != "authorization" && it.lowercase() != "x-rakazo-space-id" }).toString()
    }
    AsyncFunction("reportIncomingCall") { call: Map<String, String> ->
      IncomingCalls.report(context(), org.json.JSONObject(call), fromApp = true)
    }
    AsyncFunction("endIncomingCall") { id: String -> IncomingCalls.end(context(), id) }
    AsyncFunction("finishAnswer") { id: String, success: Boolean -> IncomingCalls.end(context(), id) }
    AsyncFunction("clearIncomingCalls") { IncomingCalls.clear(context()) }
    AsyncFunction("incomingState") { mapOf("token" to "", "actions" to IncomingCalls.take(context()), "ringing" to IncomingCalls.ringing(context())) }

    AsyncFunction("getSettings") {
      NotificationStorage(context()).settings.toMap()
    }

    AsyncFunction("setSettings") { value: Map<String, Boolean>, endpoint: String, token: String, spaceId: String, locale: String, headers: String ->
      val context = context()
      val storage = NotificationStorage(context)
      if (endpoint.isNotBlank() && !isAllowedNotificationEndpoint(endpoint)) {
        throw IllegalArgumentException("Public servers need https://. HTTP only works on your local network.")
      }
      storage.endpoint = endpoint
      storage.token = token
      storage.headers = headers
      storage.spaceId = spaceId
      storage.locale = locale
      storage.settings = NotificationSettings.fromMap(value)
      if (storage.settings.liveConnection && endpoint.isNotBlank() && token.isNotBlank()) {
        RakazoNotificationService.start(context)
      } else {
        RakazoNotificationService.stop(context)
      }
    }

    AsyncFunction("resume") { endpoint: String, token: String, spaceId: String, locale: String, headers: String ->
      resume(endpoint, token, spaceId, locale, headers)
    }

    AsyncFunction("resumeAfterMute") { endpoint: String, token: String, spaceId: String, locale: String, headers: String, botId: String ->
      resume(endpoint, token, spaceId, locale, headers, mutedBotId = botId)
    }

    AsyncFunction("resumeAfterGroupMute") { endpoint: String, token: String, spaceId: String, locale: String, headers: String, groupId: String ->
      resume(endpoint, token, spaceId, locale, headers, mutedGroupId = groupId)
    }

    AsyncFunction("stop") { clearSession: Boolean ->
      val context = context()
      if (clearSession) {
        RakazoNotificationService.clearSession(context)
        val storage = NotificationStorage(context)
        storage.token = ""
        storage.headers = ""
        storage.spaceId = ""
      } else {
        RakazoNotificationService.stop(context)
      }
    }

    AsyncFunction("setOpenThread") { botId: String?, threadId: String? ->
      RakazoNotificationService.setOpenThread(context(), botId, threadId)
    }

    AsyncFunction("startCall") { title: String, promise: Promise ->
      RakazoCallService.start(context(), title) { started -> promise.resolve(started) }
    }

    AsyncFunction("stopCall") {
      RakazoCallService.stop(context())
    }

    AsyncFunction("openSettings") {
      val context = context()
      context.startActivity(
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    AsyncFunction("canPostPromotedNotifications") {
      if (Build.VERSION.SDK_INT < 36) {
        true
      } else {
        val manager = context().getSystemService(NotificationManager::class.java)
        runCatching {
          manager.javaClass.getMethod("canPostPromotedNotifications").invoke(manager) as Boolean
        }.getOrDefault(false)
      }
    }

    Function("hasPromotedSettings") {
      Build.VERSION.SDK_INT >= 36 && runCatching {
        val context = context()
        promotedSettingsIntent(context).resolveActivity(context.packageManager) != null
      }.getOrDefault(false)
    }

    AsyncFunction("openPromotedSettings") {
      val context = context()
      val promoted = promotedSettingsIntent(context)
      runCatching { context.startActivity(promoted) }.getOrElse {
        context.startActivity(
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
    }
  }

  private fun resume(
    endpoint: String,
    token: String,
    spaceId: String,
    locale: String,
    headers: String,
    mutedBotId: String? = null,
    mutedGroupId: String? = null,
  ) {
    val context = context()
    if (endpoint.isNotBlank() && !isAllowedNotificationEndpoint(endpoint)) {
      RakazoNotificationService.stop(context)
    } else {
      val storage = NotificationStorage(context)
      storage.endpoint = endpoint
      storage.token = token
      storage.headers = headers
      storage.spaceId = spaceId
      storage.locale = locale
      if (storage.settings.liveConnection && endpoint.isNotBlank() && token.isNotBlank()) {
        RakazoNotificationService.start(context, mutedBotId = mutedBotId, mutedGroupId = mutedGroupId)
      }
    }
  }

  private fun promotedSettingsIntent(context: Context) =
    Intent("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS")
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  private fun context() = appContext.reactContext
    ?: throw IllegalStateException("Android application context is unavailable")
}
