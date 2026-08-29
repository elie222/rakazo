package com.rakazo.app.network

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

data class AgentRecord(
    val id: String,
    val name: String,
    val summary: String,
    val color: String,
    val pinned: Boolean,
    val status: String,
)

data class MessageBlockRecord(
    val kind: String,
    val text: String,
    val label: String? = null,
    val detail: String? = null,
)

data class ThreadMessageRecord(
    val id: String,
    val role: String,
    val blocks: List<MessageBlockRecord>,
)

data class ThreadSnapshotRecord(
    val threadId: String,
    val messages: List<ThreadMessageRecord>,
    val runStatus: String?,
    val runError: String?,
)

class ApiException(val status: Int, message: String) : IOException(message)

class RakazoApi {
    fun probe(endpoint: String) {
        val response = request(endpoint, "/rpc/health", null)
        val healthy = runCatching {
            JSONObject(response.body).optJSONObject("json")?.optBoolean("ok") == true
        }.getOrDefault(false)
        if (response.status !in 200..299 || !healthy) {
            throw IOException("That URL did not look like a Rakazo server")
        }
    }

    fun signIn(endpoint: String, email: String, password: String): String {
        val body = JSONObject().put("email", email).put("password", password).toString()
        val response = request(endpoint, "/api/auth/sign-in/email", null, body)
        if (response.status !in 200..299) throw response.error("Could not sign in")
        return tokenFrom(response).ifEmpty { throw IOException("Sign-in did not return a session") }
    }

    fun agents(endpoint: String, token: String): List<AgentRecord> {
        val response = request(endpoint, "/rpc/bots/list", token)
        if (response.status !in 200..299) throw response.error("Could not load agents")
        return parseAgents(response.body)
    }

    fun thread(endpoint: String, token: String, botId: String): ThreadSnapshotRecord {
        val body = JSONObject().put("json", JSONObject().put("botId", botId)).toString()
        val response = request(endpoint, "/rpc/threads/get", token, body)
        if (response.status !in 200..299) throw response.error("Could not load messages")
        return parseThreadSnapshot(response.body)
    }

    fun sendMessage(endpoint: String, token: String, botId: String, text: String) {
        val input = JSONObject().put("botId", botId).put("text", text.trim())
        val response = request(
            endpoint,
            "/rpc/threads/send",
            token,
            JSONObject().put("json", input).toString(),
        )
        if (response.status !in 200..299) throw response.error("Could not send message")
    }

    fun signOut(endpoint: String, token: String) {
        request(endpoint, "/api/auth/sign-out", token)
    }

    private fun request(endpoint: String, path: String, token: String?, body: String = "{\"json\":{}}"):
        Response {
        val connection = URL(endpoint + path).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 8_000
            connection.readTimeout = 15_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Origin", "rakazo://")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            Response(status, stream?.bufferedReader()?.use { it.readLimitedText() }.orEmpty(), connection.headerFields)
        } finally {
            connection.disconnect()
        }
    }
}

internal fun parseAgents(body: String): List<AgentRecord> {
    return try {
        val array = JSONObject(body).optJSONArray("json") ?: throw IOException("Invalid agent response")
        List(array.length()) { index ->
            val value = array.optJSONObject(index) ?: throw IOException("Invalid agent response")
            val id = value.requiredString("id")
            val name = value.requiredString("name")
            val color = value.requiredString("color")
            if (!HEX_COLOR.matches(color)) throw IOException("Invalid agent color")
            AgentRecord(
                id = id,
                name = name,
                summary = value.optString("preview").ifBlank { value.optString("title") },
                color = color,
                pinned = value.optBoolean("pinned"),
                status = value.optString("status"),
            )
        }
    } catch (error: IOException) {
        throw error
    } catch (_: RuntimeException) {
        throw IOException("Invalid agent response")
    }
}

internal fun parseThreadSnapshot(body: String): ThreadSnapshotRecord {
    return try {
        val value = JSONObject(body).optJSONObject("json") ?: throw IOException("Invalid thread response")
        val messages = value.optJSONArray("messages") ?: throw IOException("Invalid thread response")
        val run = value.optJSONObject("run")
        ThreadSnapshotRecord(
            threadId = value.requiredString("threadId"),
            messages = List(messages.length()) { index -> parseThreadMessage(messages.requiredObject(index)) },
            runStatus = run?.requiredString("status"),
            runError = run?.optString("error", "")?.takeIf { it.isNotBlank() },
        )
    } catch (error: IOException) {
        throw error
    } catch (_: RuntimeException) {
        throw IOException("Invalid thread response")
    }
}

private fun parseThreadMessage(value: JSONObject): ThreadMessageRecord {
    val role = value.requiredString("role")
    if (role !in MESSAGE_ROLES) throw IOException("Invalid message role")
    val blocks = value.optJSONArray("blocks") ?: throw IOException("Invalid thread response")
    return ThreadMessageRecord(
        id = value.requiredString("id"),
        role = role,
        blocks = List(blocks.length()) { index -> parseMessageBlock(blocks.requiredObject(index)) },
    )
}

private fun parseMessageBlock(value: JSONObject): MessageBlockRecord {
    val kind = value.requiredString("kind")
    return when (kind) {
        "text" -> MessageBlockRecord(kind, value.requiredString("text"))
        "bot_message_sent" -> MessageBlockRecord(
            kind,
            value.requiredString("text"),
            "Messaged ${value.requiredString("toBotName")}",
        )
        "bot_message_received" -> MessageBlockRecord(
            kind,
            value.requiredString("text"),
            "Message from ${value.requiredString("fromBotName")}",
        )
        "handoff" -> MessageBlockRecord(kind, value.requiredString("text"), "Agent handoff")
        "ask" -> MessageBlockRecord(
            kind,
            value.requiredString("text"),
            if (value.has("approvalEffectId") || value.has("actions")) "Approval needed" else "Input needed",
            value.optString("detail").takeIf { it.isNotBlank() },
        )
        "choice" -> MessageBlockRecord(kind, value.requiredString("question"), "Choice")
        "app_connect" -> MessageBlockRecord(
            kind,
            value.requiredString("description"),
            value.requiredString("name"),
        )
        "connect" -> MessageBlockRecord(kind, value.requiredString("initial"), value.requiredString("name"))
        "subagent" -> MessageBlockRecord(
            kind,
            value.optString("result").ifBlank { value.optString("progress") }.ifBlank { value.optString("task") },
            value.optString("name").ifBlank { "Subagent" },
        )
        "child_bot" -> MessageBlockRecord(
            kind,
            value.optString("title"),
            value.requiredString("name"),
        )
        "skill_draft" -> MessageBlockRecord(kind, value.requiredString("goal"), value.requiredString("name"))
        "chart" -> MessageBlockRecord(kind, value.requiredString("name"), "Chart")
        "mcp_approval" -> MessageBlockRecord(kind, value.requiredString("name"), "Approval needed")
        "card" -> MessageBlockRecord(kind, parseCardLines(value.optJSONArray("lines")), "Details")
        "steps" -> MessageBlockRecord(kind, parseSteps(value.optJSONArray("steps")), "Steps")
        "image", "file" -> MessageBlockRecord(kind, value.requiredString("name"), "Attachment")
        "progress" -> MessageBlockRecord(kind, value.requiredString("text"), "Working")
        "computer", "meta" -> MessageBlockRecord(kind, value.requiredString("text"), null)
        else -> MessageBlockRecord(
            kind = kind,
            text = value.optString("text"),
            label = kind.replace('_', ' ').replaceFirstChar(Char::uppercase),
        )
    }
}

private fun parseCardLines(lines: JSONArray?): String {
    if (lines == null) throw IOException("Invalid message card")
    return List(lines.length()) { index ->
        val line = lines.requiredObject(index)
        "${line.requiredString("k")}: ${line.requiredString("v")}"
    }.joinToString("\n")
}

private fun parseSteps(steps: JSONArray?): String {
    if (steps == null) throw IOException("Invalid message steps")
    return List(steps.length()) { index -> steps.requiredObject(index).requiredString("label") }.joinToString("\n")
}

private fun JSONArray.requiredObject(index: Int): JSONObject =
    optJSONObject(index) ?: throw IOException("Invalid thread response")

private fun JSONObject.requiredString(name: String): String =
    optString(name).takeIf { it.isNotBlank() } ?: throw IOException("Invalid server response")

private fun tokenFrom(response: Response): String {
    val json = runCatching { JSONObject(response.body) }.getOrNull()
    json?.optString("token")?.takeIf { it.isNotEmpty() }?.let { return it }
    json?.optJSONObject("session")?.optString("token")?.takeIf { it.isNotEmpty() }?.let { return it }
    val cookie = response.headers.entries.firstOrNull { it.key?.equals("set-cookie", true) == true }
        ?.value?.joinToString(",").orEmpty()
    val encoded = Regex("better-auth\\.session_token=([^;]+)").find(cookie)?.groupValues?.get(1).orEmpty()
    return URLDecoder.decode(encoded, Charsets.UTF_8.name())
}

private fun Response.error(fallback: String): ApiException {
    val message = runCatching {
        val json = JSONObject(body)
        json.optJSONObject("error")?.optString("message").orEmpty().ifEmpty { json.optString("message") }
    }.getOrNull().orEmpty()
    return ApiException(status, message.ifEmpty { fallback })
}

private data class Response(
    val status: Int,
    val body: String,
    val headers: Map<String?, List<String>>,
)

private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
private val MESSAGE_ROLES = setOf("user", "bot", "system")

private fun java.io.Reader.readLimitedText(): String {
    val result = StringBuilder()
    val buffer = CharArray(8_192)
    while (true) {
        val count = read(buffer)
        if (count == -1) return result.toString()
        if (result.length + count > MAX_RESPONSE_CHARS) throw IOException("Server response was too large")
        result.append(buffer, 0, count)
    }
}

private const val MAX_RESPONSE_CHARS = 2_000_000
