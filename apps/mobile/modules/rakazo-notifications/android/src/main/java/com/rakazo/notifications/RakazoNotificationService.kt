package com.rakazo.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

private data class RunRecord(
  val runId: String,
  val botId: String,
  val botName: String,
  val threadId: String,
  val status: String,
  val prompt: String,
  val trigger: String,
)

private class ApiException(val status: Int) : IOException()

class RakazoNotificationService : Service() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private lateinit var manager: NotificationManager
  private var pollJob: Job? = null
  private val knownCompleted = mutableSetOf<String>()
  private val alertedAttention = mutableSetOf<String>()

  override fun onCreate() {
    super.onCreate()
    manager = getSystemService(NotificationManager::class.java)
    knownCompleted += getSharedPreferences(STATE_PREFERENCES, MODE_PRIVATE)
      .getStringSet(SEEN_RUNS, emptySet()).orEmpty()
    createChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (pollJob?.isActive != true) pollJob = scope.launch { poll() }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }

  private suspend fun poll() {
    var seeded = getSharedPreferences(STATE_PREFERENCES, MODE_PRIVATE)
      .getBoolean(SEEN_RUNS_SEEDED, false)
    var selectedAvatarStyle: String? = null
    while (scope.isActive) {
      val storage = NotificationStorage(this)
      val settings = storage.settings
      if (!settings.liveConnection || storage.endpoint.isBlank() || storage.token.isBlank()) {
        stop()
        return
      }
      try {
        val avatarStyle = selectedAvatarStyle
          ?: avatarStyle(storage.endpoint, storage.token).also { selectedAvatarStyle = it }
        val active = runs(storage.endpoint, storage.token, "active")
        val working = active.filter(::isWorking)
        val recent = runs(storage.endpoint, storage.token, "recent")
        if (working.isEmpty()) clearLive() else showLive(working, avatarStyle)
        if (!seeded) {
          knownCompleted += recent.map { it.runId }
          seeded = true
        } else {
          recent.asReversed().filter { knownCompleted.add(it.runId) }.forEach { run ->
            when {
              run.status == "failed" && settings.needsAttention -> post(run, attentionCopy(run))
              run.status != "completed" -> Unit
              run.trigger == "routine" && settings.scheduledTasks -> postCompletion(storage, run, true)
              run.trigger != "routine" && settings.messages -> postCompletion(storage, run, false)
            }
          }
        }
        knownCompleted.retainAll(recent.map { it.runId }.toSet())
        getSharedPreferences(STATE_PREFERENCES, MODE_PRIVATE).edit()
          .putStringSet(SEEN_RUNS, knownCompleted.toSet())
          .putBoolean(SEEN_RUNS_SEEDED, true)
          .apply()
        if (settings.needsAttention) {
          active.filter { it.status == "waiting_input" || it.status == "waiting_takeover" }
            .filter { alertedAttention.add("${it.runId}:${it.status}") }
            .forEach { post(it, attentionCopy(it)) }
        }
        alertedAttention.retainAll(active.map { "${it.runId}:${it.status}" }.toSet())
      } catch (error: ApiException) {
        if (error.status == 401) {
          stop()
          return
        }
        clearLive()
      } catch (_: IOException) {
        clearLive()
      } catch (_: RuntimeException) {
        clearLive()
      }
      delay(POLL_INTERVAL_MS)
    }
  }

  private fun postCompletion(storage: NotificationStorage, run: RunRecord, scheduled: Boolean) {
    val reply = runCatching { latestReply(storage.endpoint, storage.token, run.botId) }.getOrDefault("")
    post(
      run,
      NotificationCopy(
        title = if (scheduled) "${run.botName} · Scheduled task" else "${run.botName} replied",
        body = reply.ifBlank { run.prompt },
        channel = if (scheduled) Channels.SCHEDULED else Channels.MESSAGES,
      ),
    )
  }

  private fun post(run: RunRecord, copy: NotificationCopy) {
    val notification = builder(copy.channel)
      .setSmallIcon(R.drawable.ic_rakazo_notification)
      .setContentTitle(copy.title)
      .setContentText(copy.body)
      .setStyle(Notification.BigTextStyle().bigText(copy.body))
      .setContentIntent(openApp(run))
      .addExtras(Bundle().apply {
        putString("rakazo.botId", run.botId)
        putString("rakazo.threadId", run.threadId)
      })
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .build()
    manager.notify(run.runId.hashCode(), notification)
  }

  private fun showLive(active: List<RunRecord>, avatarStyle: String) {
    val primary = active.first()
    val title = when (active.size) {
      1 -> "${primary.botName} is working"
      else -> "${primary.botName} and ${active.size - 1} more are working"
    }
    val body = when {
      active.size == 1 -> primary.prompt
      else -> active.take(3).joinToString(" · ") { it.botName }
    }
    val liveBuilder = builder(Channels.LIVE)
      .setSmallIcon(
        liveStatusIcon(primary, avatarStyle),
      )
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setContentIntent(openApp(primary))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
    if (Build.VERSION.SDK_INT >= 36) {
      liveBuilder.extras.putBoolean(PROMOTED_ONGOING_EXTRA, true)
      liveBuilder.setShortCriticalText("Working")
    }
    val notification = liveBuilder.build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        LIVE_NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
      )
    } else {
      startForeground(LIVE_NOTIFICATION_ID, notification)
    }
  }

  private fun liveStatusIcon(run: RunRecord, avatarStyle: String): Icon {
    if (avatarStyle != "organic") {
      return Icon.createWithResource(this, R.drawable.ic_rakazo_notification)
    }
    val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val seed = run.botId.fold(0) { hash, character -> hash * 31 + character.code }
    val phase = (seed and 0xff) / 255.0 * PI * 2
    val lobes = 5 + (seed and 3)
    val path = Path()
    repeat(32) { index ->
      val angle = index / 32.0 * PI * 2
      val radius = 34 + sin(angle * lobes + phase) * 4 + cos(angle * 3 - phase) * 2
      val x = (48 + cos(angle) * radius).toFloat()
      val y = (48 + sin(angle) * radius).toFloat()
      if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
    canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE })
    val eyes = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    canvas.drawRoundRect(35f, 36f, 41f, 58f, 3f, 3f, eyes)
    canvas.drawRoundRect(55f, 36f, 61f, 58f, 3f, 3f, eyes)
    return Icon.createWithBitmap(bitmap)
  }

  private fun clearLive() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    manager.cancel(LIVE_NOTIFICATION_ID)
  }

  @Suppress("DEPRECATION")
  private fun builder(channel: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this)

  private fun openApp(run: RunRecord? = null): PendingIntent {
    val intent = if (run == null) {
      packageManager.getLaunchIntentForPackage(packageName) ?: Intent(Intent.ACTION_VIEW, Uri.parse("rakazo://"))
    } else {
      Intent(
        Intent.ACTION_VIEW,
        Uri.parse("rakazo://thread?botId=${Uri.encode(run.botId)}&name=${Uri.encode(run.botName)}"),
      ).setPackage(packageName)
    }.apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP }
    return PendingIntent.getActivity(
      this,
      run?.botId?.hashCode() ?: 0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    listOf(
      NotificationChannel(Channels.LIVE, "Live agent status", NotificationManager.IMPORTANCE_LOW),
      NotificationChannel(Channels.MESSAGES, "Agent messages", NotificationManager.IMPORTANCE_DEFAULT),
      NotificationChannel(Channels.SCHEDULED, "Scheduled tasks", NotificationManager.IMPORTANCE_DEFAULT),
      NotificationChannel(Channels.ATTENTION, "Needs attention", NotificationManager.IMPORTANCE_HIGH),
    ).forEach(manager::createNotificationChannel)
  }

  private fun stop() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  companion object {
    private const val LIVE_NOTIFICATION_ID = 1101
    private const val PROMOTED_ONGOING_EXTRA = "android.requestPromotedOngoing"
    private const val POLL_INTERVAL_MS = 8_000L
    private const val STATE_PREFERENCES = "com.rakazo.notification_state"
    private const val SEEN_RUNS = "seen_runs"
    private const val SEEN_RUNS_SEEDED = "seen_runs_seeded"

    fun start(context: Context) {
      val intent = Intent(context, RakazoNotificationService::class.java)
      context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, RakazoNotificationService::class.java))
    }
  }
}

private data class NotificationCopy(val title: String, val body: String, val channel: String)

private fun attentionCopy(run: RunRecord): NotificationCopy = when (run.status) {
  "failed" -> NotificationCopy("${run.botName} hit a problem", run.prompt, Channels.ATTENTION)
  "waiting_takeover" -> NotificationCopy(
    "${run.botName} needs you on screen",
    run.prompt,
    Channels.ATTENTION,
  )
  else -> NotificationCopy("${run.botName} needs your input", run.prompt, Channels.ATTENTION)
}

private object Channels {
  const val LIVE = "rakazo_live"
  const val MESSAGES = "rakazo_messages"
  const val SCHEDULED = "rakazo_scheduled"
  const val ATTENTION = "rakazo_attention"
}

private fun runs(endpoint: String, token: String, filter: String): List<RunRecord> {
  val root = rpc(endpoint, token, "runs/list", JSONObject().put("filter", filter))
  val rows = root.optJSONArray("runs") ?: throw IOException("Invalid activity response")
  return List(rows.length()) { index ->
    val row = rows.optJSONObject(index) ?: throw IOException("Invalid activity response")
    RunRecord(
      runId = row.requiredString("runId"),
      botId = row.requiredString("botId"),
      botName = row.requiredString("botName"),
      threadId = row.requiredString("threadId"),
      status = row.requiredString("status"),
      prompt = row.optString("promptSnippet"),
      trigger = row.requiredString("trigger"),
    )
  }
}

private fun isWorking(run: RunRecord): Boolean =
  run.status == "queued" || run.status == "leased" || run.status == "running"

private fun avatarStyle(endpoint: String, token: String): String =
  rpc(endpoint, token, "me", JSONObject()).optString("avatarStyle", "robot")

private fun latestReply(endpoint: String, token: String, botId: String): String {
  val root = rpc(endpoint, token, "threads/get", JSONObject().put("botId", botId))
  val messages = root.optJSONArray("messages") ?: return ""
  for (messageIndex in messages.length() - 1 downTo 0) {
    val message = messages.optJSONObject(messageIndex) ?: continue
    if (message.optString("role") != "bot") continue
    val blocks = message.optJSONArray("blocks") ?: return ""
    return List(blocks.length()) { index -> blocks.optJSONObject(index)?.optString("text").orEmpty() }
      .filter(String::isNotBlank)
      .joinToString("\n")
  }
  return ""
}

private fun rpc(endpoint: String, token: String, procedure: String, input: JSONObject): JSONObject {
  val connection = URL("$endpoint/rpc/$procedure").openConnection() as HttpURLConnection
  return try {
    connection.requestMethod = "POST"
    connection.connectTimeout = 8_000
    connection.readTimeout = 15_000
    connection.doOutput = true
    connection.setRequestProperty("Content-Type", "application/json")
    connection.setRequestProperty("Origin", "rakazo://")
    connection.setRequestProperty("Authorization", "Bearer $token")
    connection.outputStream.use {
      it.write(JSONObject().put("json", input).toString().toByteArray(Charsets.UTF_8))
    }
    val status = connection.responseCode
    if (status !in 200..299) throw ApiException(status)
    val body = connection.inputStream.bufferedReader().use { it.readText() }
    JSONObject(body).optJSONObject("json") ?: throw IOException("Invalid server response")
  } finally {
    connection.disconnect()
  }
}

private fun JSONObject.requiredString(name: String): String =
  optString(name).takeIf(String::isNotBlank) ?: throw IOException("Invalid server response")
