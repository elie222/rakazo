package com.rakazo.notifications

import java.net.URI

internal fun isAllowedNotificationEndpoint(endpoint: String): Boolean {
  val uri = runCatching { URI(endpoint) }.getOrNull() ?: return false
  val scheme = uri.scheme?.lowercase() ?: return false
  val host = uri.host?.trim()?.lowercase()?.removeSurrounding("[", "]") ?: return false
  if (host.isBlank()) return false
  if (scheme == "https") return true
  if (scheme != "http") return false
  return isLanOrLocalHost(host)
}

private fun isLanOrLocalHost(host: String): Boolean {
  if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true
  if (host.endsWith(".local")) return true
  if (Regex("""^10(?:\.\d{1,3}){3}$""").matches(host)) return true
  if (Regex("""^192\.168(?:\.\d{1,3}){2}$""").matches(host)) return true
  if (Regex("""^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$""").matches(host)) return true
  if (Regex("""^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])(?:\.\d{1,3}){2}$""").matches(host)) return true
  return false
}
