package com.rakazo.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointAllowlistTest {
  @Test
  fun `accepts https and local http endpoints`() {
    assertTrue(isAllowedNotificationEndpoint("https://app.example.test"))
    assertTrue(isAllowedNotificationEndpoint("http://127.0.0.1:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://localhost:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://[::1]:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://192.168.1.20:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://10.0.0.2:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://172.16.4.2:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://100.64.0.2:3100"))
    assertTrue(isAllowedNotificationEndpoint("http://rakazo.local:3100"))
  }

  @Test
  fun `rejects public http and unsupported schemes`() {
    assertFalse(isAllowedNotificationEndpoint("http://app.example.test"))
    assertFalse(isAllowedNotificationEndpoint("http://8.8.8.8"))
    assertFalse(isAllowedNotificationEndpoint("ftp://192.168.1.20"))
    assertFalse(isAllowedNotificationEndpoint("not a url"))
    assertFalse(isAllowedNotificationEndpoint(""))
  }
}
