package com.rakazo.app.network

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionManagerTest {
    @Test
    fun `changing endpoint and signing out clear credentials`() {
        val store = MemorySessionStore("https://one.example", "secret")
        val session = SessionManager(store)

        session.useEndpoint("https://two.example")
        assertEquals("", session.token)
        session.signedIn("next-secret")
        assertEquals("next-secret", session.token)
        session.signedOut()
        assertEquals("", session.token)
    }

    @Test
    fun `keeping endpoint preserves credentials`() {
        val store = MemorySessionStore("https://one.example", "secret")
        SessionManager(store).useEndpoint("https://one.example")
        assertEquals("secret", store.token)
    }
}

private data class MemorySessionStore(
    override var endpoint: String,
    override var token: String,
) : SessionStore
