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
    val sectionId: String?,
    val unread: Boolean,
)

data class BotSectionRecord(val id: String, val name: String)

data class ActivityRunRecord(
    val runId: String,
    val botId: String,
    val botName: String,
    val groupId: String?,
    val groupName: String?,
    val status: String,
    val promptSnippet: String,
    val updatedAt: String,
)

data class SearchHitRecord(
    val key: String,
    val kind: String,
    val botId: String?,
    val botName: String?,
    val groupId: String?,
    val groupName: String?,
    val title: String,
    val snippet: String,
    val messageId: String?,
)

data class MessageActionRecord(val id: String, val label: String)

data class MessageBlockRecord(
    val kind: String,
    val text: String,
    val label: String? = null,
    val detail: String? = null,
    val status: String? = null,
    val actions: List<MessageActionRecord> = emptyList(),
    val toolNames: List<String> = emptyList(),
    val secret: Boolean = false,
    val peerBotId: String? = null,
)

data class ThreadMessageRecord(
    val id: String,
    val role: String,
    val blocks: List<MessageBlockRecord>,
    val runId: String? = null,
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

    fun activity(endpoint: String, token: String, filter: String): List<ActivityRunRecord> {
        require(filter == "active" || filter == "recent")
        val response = request(
            endpoint,
            "/rpc/runs/list",
            token,
            rpcBody(JSONObject().put("filter", filter)),
        )
        if (response.status !in 200..299) throw response.error("Could not load activity")
        return parseActivity(response.body)
    }

    fun search(endpoint: String, token: String, query: String): List<SearchHitRecord> {
        val response = request(
            endpoint,
            "/rpc/search/query",
            token,
            rpcBody(JSONObject().put("q", query.trim())),
        )
        if (response.status !in 200..299) throw response.error("Could not search workspace")
        return parseSearchHits(response.body)
    }

    fun createAgent(
        endpoint: String,
        token: String,
        name: String,
        title: String,
        description: String,
    ): AgentRecord {
        val input = JSONObject()
            .put("name", name.trim())
            .put("title", title.trim())
            .put("description", description.trim())
            .put("instructions", description.trim())
            .put("notifyOnFinish", true)
            .put("computerMode", "team")
        val response = request(endpoint, "/rpc/bots/create", token, rpcBody(input))
        if (response.status !in 200..299) throw response.error("Could not create agent")
        return parseAgentResponse(response.body)
    }

    fun sections(endpoint: String, token: String): List<BotSectionRecord> {
        val response = request(endpoint, "/rpc/botSections/list", token)
        if (response.status !in 200..299) throw response.error("Could not load sections")
        return parseSections(response.body)
    }

    fun setAgentPinned(endpoint: String, token: String, botId: String, pinned: Boolean): AgentRecord =
        updateAgent(endpoint, token, JSONObject().put("botId", botId).put("pinned", pinned))

    fun moveAgentToSection(
        endpoint: String,
        token: String,
        botId: String,
        sectionId: String?,
    ): AgentRecord = updateAgent(
        endpoint,
        token,
        JSONObject().put("botId", botId).put("sectionId", sectionId ?: JSONObject.NULL),
    )

    fun createSection(
        endpoint: String,
        token: String,
        botId: String,
        name: String,
    ): BotSectionRecord {
        val input = JSONObject().put("botId", botId).put("name", name.trim())
        val response = request(endpoint, "/rpc/botSections/create", token, rpcBody(input))
        if (response.status !in 200..299) throw response.error("Could not create section")
        return parseSection(response.body)
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

    fun markThreadRead(endpoint: String, token: String, botId: String) {
        val input = JSONObject().put("botId", botId)
        val response = request(endpoint, "/rpc/threads/markRead", token, rpcBody(input))
        if (response.status !in 200..299) throw response.error("Could not mark chat as read")
    }

    fun answerMessage(
        endpoint: String,
        token: String,
        botId: String,
        runId: String,
        messageId: String,
        answer: String,
    ) {
        val input = JSONObject()
            .put("botId", botId)
            .put("runId", runId)
            .put("messageId", messageId)
            .put("answer", answer)
        val response = request(endpoint, "/rpc/threads/answer", token, rpcBody(input))
        if (response.status !in 200..299) throw response.error("Could not answer")
    }

    fun chooseOnboarding(endpoint: String, token: String, botId: String, optionId: String) {
        val input = JSONObject().put("botId", botId).put("optionId", optionId)
        val response = request(endpoint, "/rpc/onboarding/choose", token, rpcBody(input))
        if (response.status !in 200..299) throw response.error("Could not save this choice")
    }

    fun signOut(endpoint: String, token: String) {
        request(endpoint, "/api/auth/sign-out", token)
    }

    private fun updateAgent(endpoint: String, token: String, input: JSONObject): AgentRecord {
        val response = request(endpoint, "/rpc/bots/update", token, rpcBody(input))
        if (response.status !in 200..299) throw response.error("Could not update chat")
        return parseAgentResponse(response.body)
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
            parseAgent(value)
        }
    } catch (error: IOException) {
        throw error
    } catch (_: RuntimeException) {
        throw IOException("Invalid agent response")
    }
}

internal fun parseSections(body: String): List<BotSectionRecord> = try {
    val array = JSONObject(body).optJSONArray("json") ?: throw IOException("Invalid section response")
    List(array.length()) { index -> parseSection(array.requiredObject(index)) }
} catch (error: IOException) {
    throw error
} catch (_: RuntimeException) {
    throw IOException("Invalid section response")
}

internal fun parseActivity(body: String): List<ActivityRunRecord> = try {
    val root = JSONObject(body).optJSONObject("json") ?: throw IOException("Invalid activity response")
    val runs = root.optJSONArray("runs") ?: throw IOException("Invalid activity response")
    List(runs.length()) { index ->
        val value = runs.requiredObject(index)
        val status = value.requiredString("status")
        if (status !in RUN_STATUSES) throw IOException("Invalid activity response")
        ActivityRunRecord(
            runId = value.requiredString("runId"),
            botId = value.requiredString("botId"),
            botName = value.requiredString("botName"),
            groupId = value.optionalString("groupId"),
            groupName = value.optionalString("groupName"),
            status = status,
            promptSnippet = value.optString("promptSnippet"),
            updatedAt = value.requiredString("updatedAt"),
        )
    }
} catch (error: IOException) {
    throw error
} catch (_: RuntimeException) {
    throw IOException("Invalid activity response")
}

internal fun parseSearchHits(body: String): List<SearchHitRecord> = try {
    val root = JSONObject(body).optJSONObject("json") ?: throw IOException("Invalid search response")
    val hits = root.optJSONArray("hits") ?: throw IOException("Invalid search response")
    List(hits.length()) { index ->
        val value = hits.requiredObject(index)
        val botId = value.optionalString("botId")
        val groupId = value.optionalString("groupId")
        val kind = value.requiredString("kind")
        if ((botId == null) == (groupId == null)) throw IOException("Invalid search response")
        if (kind !in SEARCH_KINDS) throw IOException("Invalid search response")
        SearchHitRecord(
            key = listOf("messageId", "artifactId", "routineId", "url")
                .firstNotNullOfOrNull(value::optionalString)
                ?: "${value.requiredString("title")}:${value.optString("snippet")}",
            kind = kind,
            botId = botId,
            botName = value.optionalString("botName"),
            groupId = groupId,
            groupName = value.optionalString("groupName"),
            title = value.requiredString("title"),
            snippet = value.requiredString("snippet"),
            messageId = value.optionalString("messageId"),
        )
    }
} catch (error: IOException) {
    throw error
} catch (_: RuntimeException) {
    throw IOException("Invalid search response")
}

private fun parseAgentResponse(body: String): AgentRecord = try {
    parseAgent(JSONObject(body).optJSONObject("json") ?: throw IOException("Invalid agent response"))
} catch (error: IOException) {
    throw error
} catch (_: RuntimeException) {
    throw IOException("Invalid agent response")
}

private fun parseAgent(value: JSONObject): AgentRecord {
    val color = value.requiredString("color")
    if (!HEX_COLOR.matches(color)) throw IOException("Invalid agent color")
    val sectionId = when {
        !value.has("sectionId") || value.isNull("sectionId") -> null
        value.opt("sectionId") is String -> value.requiredString("sectionId")
        else -> throw IOException("Invalid agent response")
    }
    return AgentRecord(
        id = value.requiredString("id"),
        name = value.requiredString("name"),
        summary = value.optString("preview").ifBlank { value.optString("title") },
        color = color,
        pinned = value.optBoolean("pinned"),
        status = value.optString("status"),
        sectionId = sectionId,
        unread = value.opt("unread") as? Boolean ?: throw IOException("Invalid agent response"),
    )
}

private fun parseSection(body: String): BotSectionRecord = try {
    parseSection(JSONObject(body).optJSONObject("json") ?: throw IOException("Invalid section response"))
} catch (error: IOException) {
    throw error
} catch (_: RuntimeException) {
    throw IOException("Invalid section response")
}

private fun parseSection(value: JSONObject) = BotSectionRecord(
    id = value.requiredString("id"),
    name = value.requiredString("name"),
)

private fun rpcBody(input: JSONObject) = JSONObject().put("json", input).toString()

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
        runId = value.optionalString("runId"),
    )
}

private fun parseMessageBlock(value: JSONObject): MessageBlockRecord {
    val kind = value.requiredString("kind")
    return when (kind) {
        "text" -> MessageBlockRecord(kind, value.requiredString("text"))
        "bot_message_sent" -> MessageBlockRecord(
            kind = kind,
            text = value.requiredString("text"),
            label = "Messaged ${value.requiredString("toBotName")}",
            peerBotId = value.requiredString("toBotId"),
        )
        "bot_message_received" -> MessageBlockRecord(
            kind = kind,
            text = value.requiredString("text"),
            label = "Message from ${value.requiredString("fromBotName")}",
            peerBotId = value.requiredString("fromBotId"),
        )
        "handoff" -> MessageBlockRecord(kind, value.requiredString("text"), "Agent handoff")
        "ask" -> MessageBlockRecord(
            kind,
            value.requiredString("text"),
            if (value.has("approvalEffectId") || value.has("actions")) "Approval needed" else "Input needed",
            value.optString("detail").takeIf { it.isNotBlank() },
            value.optString("status").takeIf { it.isNotBlank() },
            parseActions(value.optJSONArray("actions")),
            secret = value.optString("input") == "secret",
        )
        "choice" -> MessageBlockRecord(
            kind = kind,
            text = value.requiredString("question"),
            label = "Choice",
            detail = value.optString("subtitle").takeIf { it.isNotBlank() },
            status = if (value.optionalString("answerId") == null) "pending" else "answered",
            actions = parseChoiceOptions(value.optJSONArray("options")),
        )
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
            value.optString("task").takeIf { it.isNotBlank() },
            value.requiredString("status"),
        )
        "child_bot" -> MessageBlockRecord(
            kind,
            value.optString("title"),
            value.requiredString("name"),
            status = value.requiredString("status"),
        )
        "skill_draft" -> MessageBlockRecord(kind, value.requiredString("goal"), value.requiredString("name"))
        "chart" -> MessageBlockRecord(kind, value.requiredString("name"), "Chart")
        "mcp_approval" -> MessageBlockRecord(kind, value.requiredString("name"), "Approval needed")
        "card" -> MessageBlockRecord(kind, parseCardLines(value.optJSONArray("lines")), "Details")
        "steps" -> MessageBlockRecord(kind, parseSteps(value.optJSONArray("steps")), "Tools")
        "image", "file" -> MessageBlockRecord(kind, value.requiredString("name"), "Attachment")
        "progress" -> MessageBlockRecord(
            kind = kind,
            text = value.requiredString("text"),
            label = "Working",
            toolNames = parseStrings(value.optJSONArray("pendingToolNames")),
        )
        "computer", "meta" -> MessageBlockRecord(kind, value.requiredString("text"), null)
        else -> MessageBlockRecord(
            kind = kind,
            text = value.optString("text"),
            label = kind.replace('_', ' ').replaceFirstChar(Char::uppercase),
        )
    }
}

private fun parseActions(actions: JSONArray?): List<MessageActionRecord> {
    if (actions == null) return emptyList()
    return List(actions.length()) { index ->
        val action = actions.requiredObject(index)
        MessageActionRecord(action.requiredString("id"), action.requiredString("label"))
    }
}

private fun parseChoiceOptions(options: JSONArray?): List<MessageActionRecord> {
    if (options == null) throw IOException("Invalid message choice")
    return List(options.length()) { index ->
        val option = options.requiredObject(index)
        MessageActionRecord(option.requiredString("id"), option.requiredString("label"))
    }
}

private fun parseStrings(values: JSONArray?): List<String> {
    if (values == null) return emptyList()
    return List(values.length()) { index ->
        values.optString(index).takeIf { it.isNotBlank() } ?: throw IOException("Invalid message block")
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

private fun JSONObject.optionalString(name: String): String? = when {
    !has(name) || isNull(name) -> null
    opt(name) is String -> optString(name).takeIf { it.isNotBlank() }
    else -> throw IOException("Invalid server response")
}

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
private val RUN_STATUSES = setOf(
    "queued",
    "leased",
    "running",
    "waiting_input",
    "waiting_takeover",
    "completed",
    "failed",
    "cancelled",
)
private val SEARCH_KINDS = setOf("conversation", "message", "file", "link", "routine")

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
