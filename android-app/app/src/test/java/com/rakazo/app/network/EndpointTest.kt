package com.rakazo.app.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointTest {
    @Test
    fun `normalizes origins and strips paths and credentials`() {
        assertEquals(
            EndpointResult.Valid("https://app.example.com"),
            normalizeEndpoint(" https://user:pass@app.example.com/rpc "),
        )
        assertEquals(
            EndpointResult.Valid("http://192.168.1.20:3100"),
            normalizeEndpoint("http://192.168.1.20:3100/api"),
        )
        assertEquals(
            EndpointResult.Valid("http://[::1]:3100"),
            normalizeEndpoint("http://[::1]:3100/api"),
        )
    }

    @Test
    fun `rejects malformed schemes and public cleartext`() {
        listOf("", "ftp://example.com", "http://", "http://example.com").forEach {
            assertTrue(normalizeEndpoint(it) is EndpointResult.Invalid)
        }
    }
}
