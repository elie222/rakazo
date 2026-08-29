package com.rakazo.app.notifications

import com.rakazo.app.network.ActivityRunRecord
import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationSettingsTest {
    @Test
    fun `notifications distinguish scheduled work replies and attention`() {
        val run = ActivityRunRecord(
            runId = "run-1",
            botId = "health",
            botName = "Health",
            groupId = null,
            groupName = null,
            status = "completed",
            promptSnippet = "Remind me to take medication",
            updatedAt = "2026-08-29T20:00:00Z",
            threadId = "thread-1",
            trigger = "routine",
        )

        assertEquals(
            NotificationCopy(
                title = "Health · Scheduled task",
                body = "Time to take your medication.",
                channel = NotificationChannels.SCHEDULED,
            ),
            completionNotification(run, "Time to take your medication."),
        )
        assertEquals(
            "Health needs you on screen",
            attentionNotification(run.copy(status = "waiting_takeover")).title,
        )
        assertEquals(
            "Health replied",
            completionNotification(run.copy(trigger = "user"), "Done").title,
        )
        assertEquals(
            NotificationChannels.ATTENTION,
            attentionNotification(run.copy(status = "failed")).channel,
        )
    }
}
