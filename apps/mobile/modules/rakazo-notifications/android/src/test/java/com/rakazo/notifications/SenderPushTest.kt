package com.rakazo.notifications

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SenderPushTest {
  private fun push(kind: String = "message") = JSONObject(
    mapOf(
      "notificationTitle" to "Bot",
      "notificationBody" to "Reply preview",
      "botId" to "bot",
      "threadId" to "thread",
      "kind" to kind,
    )
  )

  @Test
  fun `a Rakazo push without a session is dropped instead of handed to Expo`() {
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(push(), hasSession = { false }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `a push with a session posts`() {
    assertEquals(
      PushDisposition.POST,
      SenderPush.disposition(push(), hasSession = { true }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `a message without the Rakazo push copy still goes to Expo without a session`() {
    assertEquals(
      PushDisposition.EXPO,
      SenderPush.disposition(JSONObject(mapOf("kind" to "other")), hasSession = { false }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `an open thread and finished foreground work stay quiet`() {
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(push(), hasSession = { true }, openThread = { true }, foreground = { false }),
    )
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(push("completion"), hasSession = { true }, openThread = { false }, foreground = { true }),
    )
    assertEquals(
      PushDisposition.POST,
      SenderPush.disposition(push("completion"), hasSession = { true }, openThread = { false }, foreground = { false }),
    )
  }
}
