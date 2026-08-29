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
            listOf(AgentRecord("maya", "Maya", "Ready", "#45D8BB", true, "running")),
            parseAgents(
                """{"json":[{"id":"maya","name":"Maya","preview":"Ready","title":"Chief","color":"#45D8BB","pinned":true,"status":"running"}]}""",
            ),
        )
        assertThrows(IOException::class.java) {
            parseAgents("""{"json":[{"id":"bad","name":"Bad","color":"blue"}]}""")
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
    fun `sends the current thread rpc shape to an offline local server`() {
        var requestBody = ""
        var authorization = ""
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/rpc/threads/send") { exchange ->
            authorization = exchange.requestHeaders.getFirst("Authorization").orEmpty()
            requestBody = exchange.requestBody.bufferedReader().use { it.readText() }
            val body = """{"json":{"taskId":"task-1","runId":"run-1","seq":2}}""".toByteArray()
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
        } finally {
            server.stop(0)
        }

        val json = org.json.JSONObject(requestBody).getJSONObject("json")
        assertEquals("Bearer session-token", authorization)
        assertEquals("maya", json.getString("botId"))
        assertEquals("Hello", json.getString("text"))
    }
}
