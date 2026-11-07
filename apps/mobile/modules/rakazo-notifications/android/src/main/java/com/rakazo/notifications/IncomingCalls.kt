package com.rakazo.notifications

import android.app.*
import android.content.*
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.*
import android.view.Gravity
import android.widget.*
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/** Expo remains the single FCM token owner; other messages use its normal delegate unless [SenderPush] renders them. */
class RakazoMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val call = runCatching { JSONObject(message.data["body"] ?: "{}") }.getOrNull() ?: JSONObject()
    for ((key, value) in message.data) if (key != "body") call.put(key, value)
    when (call.optString("kind")) {
      "incoming_call" -> IncomingCalls.report(this, call)
      "incoming_call_ended" -> IncomingCalls.settled(this, call)
      else -> if (!SenderPush.present(this, call)) super.onMessageReceived(message)
    }
  }
}

internal object IncomingCalls {
  const val CHANGED = "com.rakazo.notifications.INCOMING_CHANGED"
  private const val CHANNEL = "incoming-call"
  private val executor = Executors.newCachedThreadPool()
  private fun prefs(context: Context) = context.getSharedPreferences("rakazo.incoming_calls", Context.MODE_PRIVATE)
  fun expiry(call: JSONObject): Long = runCatching {
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
      isLenient = false
    }.parse(call.getString("expiresAt"))?.time ?: 0L
  }.getOrDefault(0L)
  fun fresh(call: JSONObject) = expiry(call) > System.currentTimeMillis()
  private fun id(call: JSONObject) = call.optString("callId").hashCode()
  /** Calls settled while their start push was still in flight must not ring when it lands. */
  private fun ended(context: Context) = context.getSharedPreferences("rakazo.ended_calls", Context.MODE_PRIVATE)
  /** [fromApp]: the app is leaving the foreground, which the process importance may not show yet. */
  fun report(context: Context, call: JSONObject, fromApp: Boolean = false) {
    if (!fresh(call) || NotificationStorage(context).token.isBlank()) return
    if (ended(context).contains(call.optString("callId"))) return
    val known = prefs(context).contains(call.optString("callId"))
    prefs(context).edit().putString(call.optString("callId"), call.toString()).apply()
    if (!known) context.sendBroadcast(Intent(CHANGED).setPackage(context.packageName))
    val process = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(process)
    if (!fromApp && process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(CHANNEL, context.getString(R.string.rakazo_call_title), NotificationManager.IMPORTANCE_HIGH)
      channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
      channel.enableVibration(true)
      manager.createNotificationChannel(channel)
    }
    val open = PendingIntent.getActivity(context, id(call), Intent(context, IncomingCallActivity::class.java)
      .putExtra("call", call.toString()), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val answer = PendingIntent.getActivity(context, id(call) + 1, Intent(context, IncomingCallActivity::class.java)
      .putExtra("call", call.toString()).putExtra("answer", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val decline = PendingIntent.getBroadcast(context, id(call), Intent(context, DeclineIncomingCallReceiver::class.java)
      .putExtra("call", call.toString()), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    @Suppress("DEPRECATION")
    val builder = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context).setPriority(Notification.PRIORITY_MAX).setDefaults(Notification.DEFAULT_ALL))
      .setSmallIcon(R.drawable.ic_rakazo_notification).setContentTitle(call.optString("botName"))
      .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(open).setOngoing(Build.VERSION.SDK_INT >= 26).setOnlyAlertOnce(true)
    if (Build.VERSION.SDK_INT >= 26) builder.setTimeoutAfter(maxOf(1, expiry(call) - System.currentTimeMillis()))
    if (Build.VERSION.SDK_INT >= 31) builder.setStyle(Notification.CallStyle.forIncomingCall(
      Person.Builder().setName(call.optString("botName", "Rakazo")).setImportant(true).build(), decline, answer))
    else {
      builder.addAction(Notification.Action.Builder(null, context.getString(R.string.rakazo_call_decline), decline).build())
      builder.addAction(Notification.Action.Builder(null, context.getString(R.string.rakazo_call_answer), answer).build())
    }
    // CallStyle requires a full-screen intent; without full-screen access Android 14+ shows it as a heads-up.
    builder.setFullScreenIntent(open, true)
    val notification = builder.build()
    if (Build.VERSION.SDK_INT >= 26) notification.flags = notification.flags or Notification.FLAG_INSISTENT
    runCatching { manager.notify(id(call), notification) }
  }
  fun exists(context: Context, callId: String) = prefs(context).contains(callId)
  fun settled(context: Context, call: JSONObject) {
    val now = System.currentTimeMillis()
    val store = ended(context)
    val edit = store.edit()
    for ((key, expires) in store.all) if ((expires as? Long ?: 0L) <= now) edit.remove(key)
    if (fresh(call)) edit.putLong(call.optString("callId"), expiry(call))
    edit.apply()
    end(context, call.optString("callId"))
  }
  fun end(context: Context, callId: String) {
    context.getSystemService(NotificationManager::class.java).cancel(callId.hashCode())
    prefs(context).edit().remove(callId).apply()
    context.sendBroadcast(Intent(CHANGED).setPackage(context.packageName))
  }
  fun clear(context: Context) {
    for (key in prefs(context).all.keys) if (key != "pending") end(context, key)
    prefs(context).edit().clear().apply()
  }
  fun answer(activity: Activity, call: JSONObject) {
    end(activity, call.optString("callId"))
    if (fresh(call)) {
      call.put("action", "answer")
      prefs(activity).edit().putString("pending", call.toString()).commit()
      val open = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
      if (open != null) activity.startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
    }
    activity.finish()
  }
  fun ringing(context: Context): List<Map<String, String>> = prefs(context).all.entries.filter { it.key != "pending" }.mapNotNull { entry ->
    val call = runCatching { JSONObject(entry.value as String) }.getOrNull() ?: return@mapNotNull null
    if (!fresh(call)) { end(context, entry.key); return@mapNotNull null }
    call.keys().asSequence().associateWith { call.optString(it) }
  }
  fun take(context: Context): List<Map<String, String>> {
    val value = prefs(context).getString("pending", null) ?: return emptyList()
    prefs(context).edit().remove("pending").apply()
    val call = JSONObject(value)
    return listOf(call.keys().asSequence().associateWith { call.optString(it) })
  }
  fun decline(context: Context, call: JSONObject, done: () -> Unit) {
    // Remembered like a call settled elsewhere, so a re-report from the app cannot ring it again.
    settled(context, call)
    val storage = NotificationStorage(context)
    val endpoint = storage.endpoint
    val token = storage.token
    val headers = storage.headers
    executor.execute {
      try {
        if (!fresh(call) || token.isBlank() || !isAllowedNotificationEndpoint(endpoint)) return@execute
        val connection = URI("${endpoint.trimEnd('/')}/rpc/notifications/declineIncomingCall").toURL().openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        connection.requestMethod = "POST"
        connection.doOutput = true
        val custom = runCatching { JSONObject(headers) }.getOrDefault(JSONObject())
        for (key in custom.keys()) connection.setRequestProperty(key, custom.getString(key))
        connection.setRequestProperty("Authorization", "Bearer $token")
        connection.setRequestProperty("Origin", "rakazo://")
        connection.setRequestProperty("Content-Type", "application/json")
        try {
          connection.outputStream.use { it.write(JSONObject().put("json", JSONObject().put("callId", call.getString("callId"))).toString().toByteArray()) }
          connection.inputStream.close()
        } finally { connection.disconnect() }
      } catch (_: Exception) { /* The deadline still expires the call if delivery fails. */ }
      finally { done() }
    }
  }
}

class DeclineIncomingCallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val call = runCatching { JSONObject(intent.getStringExtra("call") ?: "") }.getOrNull() ?: return
    val pending = goAsync()
    IncomingCalls.decline(context, call) { pending.finish() }
  }
}

/** Native lock-screen surface; answering opens the existing React Native call flow. */
class IncomingCallActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private val expire = Runnable { finish() }
  private var receiver: BroadcastReceiver? = null
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
    else {
      @Suppress("DEPRECATION")
      window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    val call = runCatching { JSONObject(intent.getStringExtra("call") ?: "") }.getOrNull()
    // A tap can race the push that ended the call; only a call still ringing here may open.
    if (call == null || !IncomingCalls.fresh(call) || !IncomingCalls.exists(this, call.optString("callId"))) { if (call != null) IncomingCalls.end(this, call.optString("callId")); finish(); return }
    if (intent.getBooleanExtra("answer", false)) { IncomingCalls.answer(this, call); return }
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(32, 32, 32, 32) }
    layout.addView(TextView(this).apply { text = call.optString("botName"); textSize = 28f; gravity = Gravity.CENTER })
    layout.addView(Button(this).apply { setText(R.string.rakazo_call_decline); setOnClickListener { IncomingCalls.decline(this@IncomingCallActivity, call) {}; finish() } })
    layout.addView(Button(this).apply { setText(R.string.rakazo_call_answer); setOnClickListener { IncomingCalls.answer(this@IncomingCallActivity, call) } })
    setContentView(layout)
    val closed = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        if (!IncomingCalls.exists(context, call.optString("callId"))) finish()
      }
    }
    receiver = closed
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(closed, IntentFilter(IncomingCalls.CHANGED), Context.RECEIVER_NOT_EXPORTED)
    else registerReceiver(closed, IntentFilter(IncomingCalls.CHANGED))
    handler.postDelayed(expire, maxOf(0, IncomingCalls.expiry(call) - System.currentTimeMillis()))
  }
  override fun onDestroy() { receiver?.let { unregisterReceiver(it) }; handler.removeCallbacks(expire); super.onDestroy() }
}
