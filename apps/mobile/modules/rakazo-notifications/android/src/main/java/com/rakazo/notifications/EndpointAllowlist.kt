package com.rakazo.notifications

import java.net.URI

/**
 * The same decision the app makes before it saves a server URL: https anywhere, http only to
 * `isPrivateNetworkHost` from `@rakazo/contracts/network-host`. Cases shared with the JS test live
 * in src/test/resources/endpoint-allowlist-cases.json. IP literals are parsed by hand so a host
 * name is never resolved.
 */
internal fun isAllowedNotificationEndpoint(endpoint: String): Boolean {
  val uri = runCatching { URI(endpoint) }.getOrNull() ?: return false
  val scheme = uri.scheme?.lowercase() ?: return false
  val host = uri.host ?: return false
  if (host.isEmpty()) return false
  if (scheme == "https") return true
  return scheme == "http" && isLanOrLocalHost(host)
}

/** Port of `isPrivateNetworkHost`: loopback, `*.localhost`, `*.local`, and private-network IPs. */
internal fun isLanOrLocalHost(hostname: String): Boolean {
  val host = hostname.lowercase().removePrefix("[").removeSuffix("]")
  if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  val v4 = parseIpv4(host)
  if (v4 != null) {
    return v4 !in CLOUD_METADATA_IPV4 && PRIVATE_NETWORK_IPV4.any { (network, bits) ->
      v4 shr (32 - bits) == network shr (32 - bits)
    }
  }
  val v6 = parseIpv6(host) ?: return false
  // ::1, or unique-local fc00::/7 except AWS IMDS. IPv4-mapped forms are deliberately refused.
  if ((0 until 7).all { v6[it] == 0 } && v6[7] == 1) return true
  return (v6[0] and 0xfe00) == 0xfc00 && !v6.contentEquals(AWS_IMDS_IPV6)
}

// Declared before the constants below, which parse with it during initialization.
private val IPV4 = Regex("([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})")
private val IPV6_GROUP = Regex("[0-9a-f]{1,4}")
private val IPV6_ZONE = Regex("[0-9a-z._~-]+")

private val CLOUD_METADATA_IPV4 = setOf(
  ipv4("169.254.169.254"),
  ipv4("169.254.170.2"),
  ipv4("100.100.100.200"),
)

/** fd00:ec2::254 */
private val AWS_IMDS_IPV6 = intArrayOf(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)

/** Loopback, RFC 1918, and CGNAT (Tailscale). */
private val PRIVATE_NETWORK_IPV4 = listOf(
  ipv4("10.0.0.0") to 8,
  ipv4("100.64.0.0") to 10,
  ipv4("127.0.0.0") to 8,
  ipv4("172.16.0.0") to 12,
  ipv4("192.168.0.0") to 16,
)

private fun ipv4(value: String): Long = requireNotNull(parseIpv4(value))

private fun parseIpv4(value: String): Long? {
  val match = IPV4.matchEntire(value) ?: return null
  var result = 0L
  for (octet in match.groupValues.drop(1)) {
    // Leading zeros read as octal in some parsers, so they are not an IP literal here.
    if (octet.length > 1 && octet.startsWith("0")) return null
    val number = octet.toInt()
    if (number > 255) return null
    result = result * 256 + number
  }
  return result
}

private fun parseIpv6(value: String): IntArray? {
  if (!value.contains(':')) return null
  // A zone (fe80::1%en0) scopes the address to an interface; it does not change its class.
  val zone = value.indexOf('%')
  val address = if (zone == -1) value else value.substring(0, zone)
  if (zone != -1 && !IPV6_ZONE.matches(value.substring(zone + 1))) return null
  val halves = address.split("::")
  if (halves.size > 2) return null
  val parts = halves.map { if (it.isEmpty()) mutableListOf() else it.split(":").toMutableList() }
  val tail = parts.last()
  val last = tail.lastOrNull()
  if (last != null && last.contains('.')) {
    val v4 = parseIpv4(last) ?: return null
    tail[tail.lastIndex] = (v4 shr 16).toString(16)
    tail.add((v4 and 0xffffL).toString(16))
  }
  val groups = parts.flatten().map { part ->
    if (!IPV6_GROUP.matches(part)) return null
    part.toInt(16)
  }
  if (halves.size == 1) return if (groups.size == 8) groups.toIntArray() else null
  if (groups.size > 7) return null
  val left = parts[0].size
  return (groups.take(left) + List(8 - groups.size) { 0 } + groups.drop(left)).toIntArray()
}
