package com.rakazo.app.network

import java.net.URI

sealed interface EndpointResult {
    data class Valid(val url: String) : EndpointResult
    data class Invalid(val message: String) : EndpointResult
}

fun normalizeEndpoint(input: String): EndpointResult {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) return EndpointResult.Invalid("Enter a server URL")
    val candidate = if (SCHEME.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
    val uri = runCatching { URI(candidate) }.getOrNull()
        ?: return EndpointResult.Invalid("That doesn’t look like a URL")
    if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
        return EndpointResult.Invalid("Use an http or https URL")
    }
    if (uri.scheme == "http" && !isLocalHost(uri.host)) {
        return EndpointResult.Invalid("Public servers require https://")
    }
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return EndpointResult.Valid("${uri.scheme}://${formatHost(uri.host)}$port")
}

private fun isLocalHost(hostname: String): Boolean {
    val host = hostname.removePrefix("[").removeSuffix("]").lowercase()
    if (host == "localhost" || host.endsWith(".local")) return true
    if (host == "::1") return true
    val octets = host.split('.').map { it.toIntOrNull() ?: return false }
    if (octets.size != 4 || octets.any { it !in 0..255 }) return false
    return octets[0] == 10 || octets[0] == 127 ||
        octets[0] == 192 && octets[1] == 168 ||
        octets[0] == 172 && octets[1] in 16..31
}

private fun formatHost(host: String): String {
    val value = host.removePrefix("[").removeSuffix("]")
    return if (':' in value) "[$value]" else value
}

private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)
