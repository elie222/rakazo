package com.rakazo.notifications

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NotificationRpcTest {
  private val limit = 16 * 1024 * 1024

  @Test
  fun `accepts a response at the byte limit`() {
    val json = "{\"json\":{\"text\":\"é\"}}".toByteArray(Charsets.UTF_8)
    withResponse(json + ByteArray(limit - json.size) { ' '.code.toByte() }) { endpoint ->
      assertEquals("é", request(endpoint).getString("text"))
    }
  }

  @Test
  fun `rejects a response one byte over the limit with content length`() {
    rejectOversizedResponse(chunked = false)
  }

  @Test
  fun `rejects a response one byte over the limit without content length`() {
    rejectOversizedResponse(chunked = true)
  }

  private fun rejectOversizedResponse(chunked: Boolean) {
    val json = "{\"json\":{\"text\":\"é\"}}".toByteArray(Charsets.UTF_8)
    withResponse(json + ByteArray(limit + 1 - json.size) { ' '.code.toByte() }, chunked) { endpoint ->
      val error = assertThrows(IOException::class.java) { request(endpoint) }
      assertEquals("Server response too large", error.message)
    }
  }

  private fun request(endpoint: String) = rpc(endpoint, "token", "space", "", "runs/list", JSONObject())

  private fun withResponse(body: ByteArray, chunked: Boolean = false, test: (String) -> Unit) {
    ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
      val executor = Executors.newSingleThreadExecutor()
      val response = executor.submit {
        server.accept().use { socket ->
          socket.soTimeout = 5_000
          val reader = socket.getInputStream().bufferedReader()
          var contentLength = 0
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
              contentLength = line.substringAfter(':').trim().toInt()
            }
          }
          repeat(contentLength) { reader.read() }
          val output = socket.getOutputStream()
          val framing = if (chunked) "Transfer-Encoding: chunked" else "Content-Length: ${body.size}"
          output.write("HTTP/1.1 200 OK\r\n$framing\r\nConnection: close\r\n\r\n".toByteArray())
          try {
            if (chunked) output.write("${body.size.toString(16)}\r\n".toByteArray())
            output.write(body)
            if (chunked) output.write("\r\n0\r\n\r\n".toByteArray())
            output.flush()
          } catch (_: IOException) {
            // The client may close the connection as soon as it reaches the limit.
          }
        }
      }
      try {
        test("http://127.0.0.1:${server.localPort}")
      } finally {
        server.close()
        executor.shutdownNow()
        response.get(10, TimeUnit.SECONDS)
      }
    }
  }
}
