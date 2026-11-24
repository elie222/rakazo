package com.rakazo.clock

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RakazoClockModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RakazoClock")

    AsyncFunction("startTimer") { durationSeconds: Double, label: String? ->
      if (!wholeNumber(durationSeconds, 1..86_400)) {
        return@AsyncFunction "unavailable"
      }
      handoff(
        Intent(AlarmClock.ACTION_SET_TIMER)
          .putExtra(AlarmClock.EXTRA_LENGTH, durationSeconds.toInt()),
        label,
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setAlarm") { hour: Double, minute: Double, label: String? ->
      if (!wholeNumber(hour, 0..23) || !wholeNumber(minute, 0..59)) {
        return@AsyncFunction "unavailable"
      }
      handoff(
        Intent(AlarmClock.ACTION_SET_ALARM)
          .putExtra(AlarmClock.EXTRA_HOUR, hour.toInt())
          .putExtra(AlarmClock.EXTRA_MINUTES, minute.toInt()),
        label,
      )
    }.runOnQueue(Queues.MAIN)
  }

  private fun wholeNumber(value: Double, range: IntRange): Boolean =
    value >= range.first && value <= range.last && value == value.toInt().toDouble()

  private fun handoff(intent: Intent, label: String?): String {
    val activity = appContext.currentActivity ?: return "unavailable"
    // The confirmation dialog can still be dismissing while the chat Activity is resumed.
    if (activity.isFinishing || activity.isDestroyed || activity !is LifecycleOwner ||
      !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    ) {
      return "unavailable"
    }
    val message = label?.trim()
    if (message != null && message.length > 80) return "unavailable"
    if (!message.isNullOrEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, message)
    intent.putExtra(AlarmClock.EXTRA_SKIP_UI, false)

    // Direct launch works even when package visibility hides matching apps from queries.
    return try {
      activity.startActivity(intent)
      "dispatched"
    } catch (_: ActivityNotFoundException) {
      "unavailable"
    } catch (_: SecurityException) {
      "unavailable"
    } catch (_: RuntimeException) {
      "uncertain"
    }
  }
}
