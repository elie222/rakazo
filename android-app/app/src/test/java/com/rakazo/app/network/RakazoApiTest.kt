package com.rakazo.app.network

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class RakazoApiTest {
    @Test
    fun `translates agent response and rejects malformed colors`() {
        assertEquals(
            listOf(AgentRecord("maya", "Maya", "Ready", "#45D8BB", true, "running", "priority", true)),
            parseAgents(
                """{"json":[{"id":"maya","name":"Maya","preview":"Ready","title":"Chief","color":"#45D8BB","pinned":true,"status":"running","sectionId":"priority","unread":true}]}""",
            ),
        )
        assertThrows(IOException::class.java) {
            parseAgents("""{"json":[{"id":"bad","name":"Bad","color":"blue"}]}""")
        }
        assertThrows(IOException::class.java) {
            parseAgents(
                """{"json":[{"id":"bad","name":"Bad","color":"#45D8BB","sectionId":12}]}""",
            )
        }
    }

    @Test
    fun `uses the real rpc shape against an offline local server`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/rpc/health") { exchange ->
            exchange.requestBody.close()
            val body = """{"json":{"ok":true}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            RakazoApi().probe("http://127.0.0.1:${server.address.port}")
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `translates thread history at the rpc boundary`() {
        val snapshot = parseThreadSnapshot(
            """{"json":{"threadId":"thread-1","messages":[{"id":"message-1","threadId":"thread-1","seq":1,"role":"user","blocks":[{"kind":"text","text":"Hello"}],"createdAt":"2026-08-29T00:00:00.000Z"},{"id":"message-2","threadId":"thread-1","seq":2,"role":"bot","blocks":[{"kind":"bot_message_received","fromBotId":"github","fromBotName":"GitHub","text":"Checked it"},{"kind":"ask","text":"Continue?","detail":"This runs a command"}],"createdAt":"2026-08-29T00:00:01.000Z"}],"olderCursor":null,"run":null}}""",
        )

        assertEquals("thread-1", snapshot.threadId)
        assertNull(snapshot.runStatus)
        assertEquals("Hello", snapshot.messages[0].blocks.single().text)
        assertEquals("Message from GitHub", snapshot.messages[1].blocks[0].label)
        assertEquals("Checked it", snapshot.messages[1].blocks[0].text)
        assertEquals("Continue?", snapshot.messages[1].blocks[1].text)
        assertEquals("This runs a command", snapshot.messages[1].blocks[1].detail)
    }

    @Test
    fun `translates activity search and rich message blocks`() {
        val activity = parseActivity(
            """{"json":{"runs":[{"runId":"run-1","botId":"maya","botName":"Maya","groupId":null,"groupName":null,"threadId":"thread-1","status":"waiting_input","trigger":"user","promptSnippet":"Check Gmail","updatedAt":"2026-08-29T00:00:00.000Z"}]}}""",
        )
        val hits = parseSearchHits(
            """{"json":{"hits":[{"kind":"message","botId":"maya","botName":"Maya","title":"Gmail result","snippet":"Found the thread","messageId":"message-2","seq":2}]}}""",
        )
        val snapshot = parseThreadSnapshot(
            """{"json":{"threadId":"thread-1","messages":[{"id":"message-2","role":"bot","runId":"run-1","blocks":[{"kind":"progress","text":"Checking mail","pendingToolNames":["gmail_search"]},{"kind":"ask","text":"Continue?","input":"secret","status":"pending","actions":[{"id":"allow","label":"Allow"}]},{"kind":"subagent","agentId":"agent-1","name":"Research","task":"Verify sources","status":"running","progress":"Reading"}]}],"olderCursor":null,"run":{"id":"run-1","status":"waiting_input","error":null}}}""",
        )

        assertEquals("waiting_input", activity.single().status)
        assertEquals("message-2", hits.single().messageId)
        assertEquals(listOf("gmail_search"), snapshot.messages.single().blocks[0].toolNames)
        assertEquals(true, snapshot.messages.single().blocks[1].secret)
        assertEquals("Allow", snapshot.messages.single().blocks[1].actions.single().label)
        assertEquals("running", snapshot.messages.single().blocks[2].status)
        assertEquals("run-1", snapshot.messages.single().runId)
    }

    @Test
    fun `sends the current thread rpc shape to an offline local server`() {
        var requestBody = ""
        var markReadBody = ""
        var answerBody = ""
        var choiceBody = ""
        var authorization = ""
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/rpc/threads/send") { exchange ->
            authorization = exchange.requestHeaders.getFirst("Authorization").orEmpty()
            requestBody = exchange.requestBody.bufferedReader().use { it.readText() }
            val body = """{"json":{"taskId":"task-1","runId":"run-1","seq":2}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.createContext("/rpc/threads/markRead") { exchange ->
            markReadBody = exchange.requestBody.bufferedReader().use { it.readText() }
            val body = """{"json":{"ok":true}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.createContext("/rpc/threads/answer") { exchange ->
            answerBody = exchange.requestBody.bufferedReader().use { it.readText() }
            val body = """{"json":{"ok":true}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.createContext("/rpc/onboarding/choose") { exchange ->
            choiceBody = exchange.requestBody.bufferedReader().use { it.readText() }
            val body = """{"json":{"ok":true}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            RakazoApi().sendMessage(
                endpoint = "http://127.0.0.1:${server.address.port}",
                token = "session-token",
                botId = "maya",
                text = "Hello",
            )
            RakazoApi().markThreadRead(
                endpoint = "http://127.0.0.1:${server.address.port}",
                token = "session-token",
                botId = "maya",
            )
            RakazoApi().answerMessage(
                endpoint = "http://127.0.0.1:${server.address.port}",
                token = "session-token",
                botId = "maya",
                runId = "run-1",
                messageId = "message-2",
                answer = "allow",
            )
            RakazoApi().chooseOnboarding(
                endpoint = "http://127.0.0.1:${server.address.port}",
                token = "session-token",
                botId = "maya",
                optionId = "chief-of-staff",
            )
        } finally {
            server.stop(0)
        }

        val json = org.json.JSONObject(requestBody).getJSONObject("json")
        assertEquals("Bearer session-token", authorization)
        assertEquals("maya", json.getString("botId"))
        assertEquals("Hello", json.getString("text"))
        assertEquals("maya", org.json.JSONObject(markReadBody).getJSONObject("json").getString("botId"))
        val answer = org.json.JSONObject(answerBody).getJSONObject("json")
        assertEquals("run-1", answer.getString("runId"))
        assertEquals("message-2", answer.getString("messageId"))
        assertEquals("allow", answer.getString("answer"))
        assertEquals(
            "chief-of-staff",
            org.json.JSONObject(choiceBody).getJSONObject("json").getString("optionId"),
        )
    }

    @Test
    fun `translates sections and sends organization updates to the current rpc routes`() {
        val requests = mutableListOf<Pair<String, org.json.JSONObject>>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/rpc/botSections/list") { exchange ->
            exchange.requestBody.close()
            val body = """{"json":[{"id":"priority","name":"Priority","position":0,"createdAt":"2026-08-29T00:00:00.000Z","updatedAt":"2026-08-29T00:00:00.000Z"}]}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.createContext("/rpc/bots/update") { exchange ->
            val request = org.json.JSONObject(exchange.requestBody.bufferedReader().use { it.readText() })
            requests += exchange.requestURI.path to request.getJSONObject("json")
            val input = request.getJSONObject("json")
            val section = if (input.has("sectionId")) input.optString("sectionId").takeIf { it.isNotBlank() } else "priority"
            val body = """{"json":{"id":"maya","name":"Maya","preview":"Ready","title":"Chief","color":"#45D8BB","pinned":${input.optBoolean("pinned")},"status":"idle","sectionId":${section?.let { "\"$it\"" } ?: "null"},"unread":false}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.createContext("/rpc/botSections/create") { exchange ->
            val request = org.json.JSONObject(exchange.requestBody.bufferedReader().use { it.readText() })
            requests += exchange.requestURI.path to request.getJSONObject("json")
            val body = """{"json":{"id":"new","name":"New","position":1,"createdAt":"2026-08-29T00:00:00.000Z","updatedAt":"2026-08-29T00:00:00.000Z"}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        val endpoint = "http://127.0.0.1:${server.address.port}"
        try {
            assertEquals(listOf(BotSectionRecord("priority", "Priority")), RakazoApi().sections(endpoint, "token"))
            RakazoApi().setAgentPinned(endpoint, "token", "maya", true)
            RakazoApi().moveAgentToSection(endpoint, "token", "maya", null)
            RakazoApi().createSection(endpoint, "token", "maya", "New")
        } finally {
            server.stop(0)
        }

        assertEquals(true, requests[0].second.getBoolean("pinned"))
        assertEquals("maya", requests[1].second.getString("botId"))
        assertEquals(org.json.JSONObject.NULL, requests[1].second.get("sectionId"))
        assertEquals("New", requests[2].second.getString("name"))
    }

    @Test
    fun `creates an agent with the desktop profile semantics`() {
        var request = org.json.JSONObject()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/rpc/bots/create") { exchange ->
            request = org.json.JSONObject(exchange.requestBody.bufferedReader().use { it.readText() })
                .getJSONObject("json")
            val body = """{"json":{"id":"research","name":"Research","preview":"","title":"Research analyst","color":"#3478F6","pinned":false,"status":"idle","sectionId":null,"unread":false}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            RakazoApi().createAgent(
                "http://127.0.0.1:${server.address.port}",
                "token",
                " Research ",
                " Research analyst ",
                " Verify primary sources. ",
            )
        } finally {
            server.stop(0)
        }

        assertEquals("Research", request.getString("name"))
        assertEquals("Research analyst", request.getString("title"))
        assertEquals("Verify primary sources.", request.getString("description"))
        assertEquals("Verify primary sources.", request.getString("instructions"))
        assertEquals("team", request.getString("computerMode"))
    }
}
