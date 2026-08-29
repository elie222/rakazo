package com.rakazo.app.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.rakazo.app.MainActivity
import com.rakazo.app.R
import com.rakazo.app.network.ActivityRunRecord
import com.rakazo.app.network.AndroidSessionStore
import com.rakazo.app.network.ApiException
import com.rakazo.app.network.RakazoApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

class RakazoNotificationService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val api = RakazoApi()
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
        startForegroundNotification(emptyList())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stop()
            return START_NOT_STICKY
        }
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
        while (scope.isActive) {
            val session = AndroidSessionStore(this)
            val settings = NotificationSettingsStore(this).settings
            if (!settings.liveConnection || session.endpoint.isBlank() || session.token.isBlank()) {
                stop()
                return
            }
            try {
                val active = api.activity(session.endpoint, session.token, "active")
                val recent = api.activity(session.endpoint, session.token, "recent")
                startForegroundNotification(active)
                if (!seeded) {
                    knownCompleted += recent.map { it.runId }
                    seeded = true
                } else {
                    recent.asReversed().filter { knownCompleted.add(it.runId) }.forEach { run ->
                        when {
                            run.status == "failed" && settings.needsAttention -> post(run, attentionNotification(run))
                            run.status != "completed" -> Unit
                            run.trigger == "routine" && settings.scheduledTasks ->
                                postCompletion(session.endpoint, session.token, run)
                            run.trigger != "routine" && settings.messages ->
                                postCompletion(session.endpoint, session.token, run)
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
                        .forEach { post(it, attentionNotification(it)) }
                }
                alertedAttention.retainAll(active.map { "${it.runId}:${it.status}" }.toSet())
            } catch (error: ApiException) {
                if (error.status == 401) {
                    stop()
                    return
                }
                showOffline()
            } catch (_: IOException) {
                showOffline()
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    private fun showOffline() {
        val notification = Notification.Builder(this, NotificationChannels.LIVE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Rakazo is offline")
            .setContentText("Live connection will retry")
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
        manager.notify(LIVE_NOTIFICATION_ID, notification)
    }

    private fun postCompletion(endpoint: String, token: String, run: ActivityRunRecord) {
        val reply = runCatching {
            api.thread(endpoint, token, run.botId).messages.asReversed()
                .firstOrNull { it.role == "bot" }
                ?.blocks
                ?.joinToString("\n") { it.text }
                .orEmpty()
        }.getOrDefault("")
        post(run, completionNotification(run, reply))
    }

    private fun post(run: ActivityRunRecord, copy: NotificationCopy) {
        val notification = Notification.Builder(this, copy.channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(copy.title)
            .setContentText(copy.body)
            .setStyle(Notification.BigTextStyle().bigText(copy.body))
            .setContentIntent(openApp(run.botId))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        manager.notify(run.runId.hashCode(), notification)
    }

    private fun startForegroundNotification(active: List<ActivityRunRecord>) {
        val title = when (active.size) {
            0 -> "Rakazo is idle"
            1 -> "${active.single().botName} is working"
            else -> "${active.size} agents are working"
        }
        val body = when {
            active.isEmpty() -> "Live connection ready"
            active.size == 1 -> active.single().promptSnippet
            else -> active.take(3).joinToString(" · ") { it.botName }
        }
        val builder = Notification.Builder(this, NotificationChannels.LIVE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
        if (
            Build.VERSION.SDK_INT >= 36 && Build.VERSION.SDK_INT_FULL >= 3_600_001 &&
            active.isNotEmpty()
        ) {
            builder.setRequestPromotedOngoing(true)
        }
        val notification = builder.build()
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

    private fun openApp(botId: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            botId?.let { putExtra(MainActivity.EXTRA_BOT_ID, it) }
        }
        return PendingIntent.getActivity(
            this,
            botId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun createChannels() {
        listOf(
            NotificationChannel(NotificationChannels.LIVE, "Live agent status", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(NotificationChannels.MESSAGES, "Agent messages", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(NotificationChannels.SCHEDULED, "Scheduled tasks", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(NotificationChannels.ATTENTION, "Needs attention", NotificationManager.IMPORTANCE_HIGH),
        ).forEach(manager::createNotificationChannel)
    }

    private fun stop() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        const val ACTION_STOP = "com.rakazo.app.notifications.STOP"
        private const val LIVE_NOTIFICATION_ID = 1101
        private const val POLL_INTERVAL_MS = 8_000L
        private const val STATE_PREFERENCES = "com.rakazo.app.notification_state"
        private const val SEEN_RUNS = "seen_runs"
        private const val SEEN_RUNS_SEEDED = "seen_runs_seeded"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, RakazoNotificationService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RakazoNotificationService::class.java))
        }
    }
}
