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
    val scheme = uri.scheme.lowercase()
    if (scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
        return EndpointResult.Invalid("Use an http or https URL")
    }
    if (scheme == "http" && !isCleartextDevelopmentHost(uri.host)) {
        return EndpointResult.Invalid("Use https:// for servers outside this device")
    }
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return EndpointResult.Valid("$scheme://${formatHost(uri.host)}$port")
}

private fun isCleartextDevelopmentHost(hostname: String): Boolean {
    val host = hostname.removePrefix("[").removeSuffix("]").lowercase()
    return host == "localhost" || host == "127.0.0.1"
}

private fun formatHost(host: String): String {
    val value = host.removePrefix("[").removeSuffix("]")
    return if (':' in value) "[$value]" else value
}

private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)
