package com.rakazo.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps a voice call alive with a microphone foreground service. The app's call
 * UI uses this instead of holding the display on, so the screen can sleep while
 * the microphone, recognition, and reply feed continue.
 */
class RakazoCallService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      report(started = false)
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf(String::isNotBlank) ?: getString(
      R.string.rakazo_call_title,
    )
    createChannel()
    try {
      startForegroundCompat(title)
    } catch (_: Exception) {
      report(started = false)
      stopSelf()
      return START_NOT_STICKY
    }
    acquireWakeLock()
    // Starting the service only queues this call, so the caller learns about
    // success here, once the notification is up and the wake lock is held.
    report(started = wakeLock?.isHeld == true)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun startForegroundCompat(title: String) {
    val notification = builder()
      .setSmallIcon(R.drawable.ic_rakazo_notification)
      .setContentTitle(title)
      .setContentText(getString(R.string.rakazo_call_text))
      .setContentIntent(openApp())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_CALL)
      .build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  @Suppress("DEPRECATION")
  private fun builder(): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
    else Notification.Builder(this)

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
      setReferenceCounted(false)
      // No timeout: a call has no fixed length, and the lock is released when the
      // service stops or the process dies.
      acquire()
    }
  }

  private fun report(started: Boolean) {
    val pending = pendingStart
    pendingStart = null
    pending?.invoke(started)
  }

  private fun openApp(): PendingIntent {
    val intent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(Intent.ACTION_VIEW, android.net.Uri.parse("rakazo://"))
    intent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    return PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, getString(R.string.rakazo_call_channel), NotificationManager.IMPORTANCE_LOW),
    )
  }

  companion object {
    private const val CHANNEL_ID = "rakazo_call"
    private const val NOTIFICATION_ID = 1102
    private const val EXTRA_TITLE = "com.rakazo.notifications.CALL_TITLE"
    private const val WAKE_LOCK_TAG = "rakazo:call"

    /** Answers the start request that is still waiting for [onStartCommand]. */
    private var pendingStart: ((Boolean) -> Unit)? = null

    fun start(context: Context, title: String, onResult: (Boolean) -> Unit) {
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        onResult(false)
        return
      }
      pendingStart = onResult
      val intent = Intent(context, RakazoCallService::class.java)
        .putExtra(EXTRA_TITLE, title)
      val queued = runCatching {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
        else context.startService(intent)
        true
      }.getOrDefault(false)
      if (!queued) {
        pendingStart = null
        onResult(false)
      }
    }

    fun stop(context: Context) {
      pendingStart = null
      context.stopService(Intent(context, RakazoCallService::class.java))
    }
  }
}
