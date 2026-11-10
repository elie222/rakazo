package com.rakazo.notifications

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointAllowlistTest {
  @Test
  fun `matches the shared JS endpoint cases`() {
    val cases =
      JSONArray(requireNotNull(javaClass.getResource("/endpoint-allowlist-cases.json")).readText())
    assertTrue(cases.length() > 0)
    for (index in 0 until cases.length()) {
      val case = cases.getJSONArray(index)
      val endpoint = case.getString(0)
      assertEquals(endpoint, case.getBoolean(1), isAllowedNotificationEndpoint(endpoint))
    }
  }
}
