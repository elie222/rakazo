package com.rakazo.app.network

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RakazoApiTest {
    @Test
    fun `translates agent response and rejects malformed colors`() {
        assertEquals(
            listOf(AgentRecord("maya", "Maya", "Ready", "#45D8BB", true)),
            parseAgents(
                """{"json":[{"id":"maya","name":"Maya","preview":"Ready","title":"Chief","color":"#45D8BB","pinned":true}]}""",
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
}
