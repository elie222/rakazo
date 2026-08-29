package com.rakazo.app.notifications

import android.content.Context
import com.rakazo.app.network.ActivityRunRecord

data class NotificationSettings(
    val liveConnection: Boolean = false,
    val messages: Boolean = true,
    val scheduledTasks: Boolean = true,
    val needsAttention: Boolean = true,
)

class NotificationSettingsStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    var settings: NotificationSettings
        get() = NotificationSettings(
            liveConnection = preferences.getBoolean(LIVE_CONNECTION, false),
            messages = preferences.getBoolean(MESSAGES, true),
            scheduledTasks = preferences.getBoolean(SCHEDULED_TASKS, true),
            needsAttention = preferences.getBoolean(NEEDS_ATTENTION, true),
        )
        set(value) {
            check(
                preferences.edit()
                    .putBoolean(LIVE_CONNECTION, value.liveConnection)
                    .putBoolean(MESSAGES, value.messages)
                    .putBoolean(SCHEDULED_TASKS, value.scheduledTasks)
                    .putBoolean(NEEDS_ATTENTION, value.needsAttention)
                    .commit(),
            ) { "Could not save notification settings" }
        }

    private companion object {
        const val PREFERENCES = "com.rakazo.app.notifications"
        const val LIVE_CONNECTION = "live_connection"
        const val MESSAGES = "messages"
        const val SCHEDULED_TASKS = "scheduled_tasks"
        const val NEEDS_ATTENTION = "needs_attention"
    }
}

internal data class NotificationCopy(val title: String, val body: String, val channel: String)

internal fun completionNotification(run: ActivityRunRecord, reply: String): NotificationCopy {
    val scheduled = run.trigger == "routine"
    return NotificationCopy(
        title = if (scheduled) "${run.botName} · Scheduled task" else "${run.botName} replied",
        body = reply.trim().ifEmpty { run.promptSnippet },
        channel = if (scheduled) NotificationChannels.SCHEDULED else NotificationChannels.MESSAGES,
    )
}

internal fun attentionNotification(run: ActivityRunRecord): NotificationCopy = when (run.status) {
    "failed" -> NotificationCopy(
        "${run.botName} hit a problem",
        run.promptSnippet,
        NotificationChannels.ATTENTION,
    )
    "waiting_takeover" -> NotificationCopy(
        "${run.botName} needs you on screen",
        run.promptSnippet,
        NotificationChannels.ATTENTION,
    )
    else -> NotificationCopy(
        "${run.botName} needs your input",
        run.promptSnippet,
        NotificationChannels.ATTENTION,
    )
}

internal object NotificationChannels {
    const val LIVE = "rakazo_live"
    const val MESSAGES = "rakazo_messages"
    const val SCHEDULED = "rakazo_scheduled"
    const val ATTENTION = "rakazo_attention"
}
