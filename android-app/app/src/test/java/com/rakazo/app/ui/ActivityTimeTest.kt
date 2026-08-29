package com.rakazo.app.ui

import com.rakazo.app.network.MessageBlockRecord
import com.rakazo.app.network.ThreadMessageRecord
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityTimeTest {
    @Test
    fun `formats current activity without device clock dependence`() {
        val now = Instant.parse("2026-08-29T12:00:00Z")

        assertEquals("just now", relativeActivityTime("2026-08-29T11:59:30Z", now))
        assertEquals("5m ago", relativeActivityTime("2026-08-29T11:55:00Z", now))
        assertEquals("2h ago", relativeActivityTime("2026-08-29T10:00:00Z", now))
    }

    @Test
    fun `received agent message is not rendered as a human message`() {
        val peerMessage = ThreadMessageRecord(
            id = "message-1",
            role = "user",
            blocks = listOf(
                MessageBlockRecord(kind = "steps", text = "Message bot", label = "Tools"),
                MessageBlockRecord(
                    kind = "bot_message_received",
                    text = "Private agent payload",
                    label = "Message from Gmail",
                    peerBotId = "gmail",
                ),
            ),
        )
        assertTrue(peerMessage.isPeerTraffic())
        assertEquals(listOf("bot_message_received"), peerMessage.blocksForDisplay().map(MessageBlockRecord::kind))
        assertFalse(
            ThreadMessageRecord(
                id = "message-2",
                role = "user",
                blocks = listOf(MessageBlockRecord(kind = "text", text = "Hello")),
            ).isPeerTraffic(),
        )
    }

    @Test
    fun `keeps refreshing an idle open thread`() {
        assertEquals(5_000L, threadRefreshDelayMillis(null))
        assertEquals(1_500L, threadRefreshDelayMillis("running"))
    }
}
