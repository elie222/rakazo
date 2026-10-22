package com.rakazo.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPollingTest {
  @Test
  fun `token is loaded once until reset`() {
    val cache = PollTokenCache()
    var reads = 0
    val load = { reads++; "token-$reads" }
    val commit: (() -> Unit) -> Boolean = { it(); true }

    assertEquals("token-1", cache.getOrLoad(load, commit))
    repeat(5) { assertEquals("token-1", cache.getOrLoad(load, commit)) }
    assertEquals(1, reads)
    cache.reset()
    assertEquals("token-2", cache.getOrLoad(load, commit))
    assertEquals(2, reads)
  }

  @Test
  fun `obsolete generation cannot cache a token loaded during reset`() {
    val cache = PollTokenCache()
    assertNull(cache.getOrLoad({ cache.reset(); "obsolete" }) { false })
    assertEquals("current", cache.getOrLoad({ "current" }) { it(); true })
    assertEquals("current", cache.getOrLoad({ error("must reuse token") }) { it(); true })
  }

  @Test
  fun `blank tokens remain cached until reset`() {
    val cache = PollTokenCache()
    assertEquals("", cache.getOrLoad({ "" }) { it(); true })
    assertEquals("", cache.getOrLoad({ error("must reuse blank token") }) { it(); true })
    cache.reset()
    assertEquals("new", cache.getOrLoad({ "new" }) { it(); true })
  }

  @Test
  fun `unchanged history is not rewritten but added and removed runs are`() {
    val history = PollHistoryWrites()
    val writes = mutableListOf<Set<String>>()
    val persist: (Set<String>) -> Unit = { writes.add(it) }

    history.persistIfChanged(false, setOf("a", "b"), persist)
    repeat(5) { history.persistIfChanged(true, setOf("b", "a"), persist) }
    assertEquals(listOf(setOf("a", "b")), writes)
    history.persistIfChanged(true, setOf("a", "b", "c"), persist)
    history.persistIfChanged(true, setOf("c"), persist)
    history.persistIfChanged(true, emptySet(), persist)
    history.persistIfChanged(true, emptySet(), persist)
    assertEquals(listOf(setOf("a", "b"), setOf("a", "b", "c"), setOf("c"), emptySet<String>()), writes)
  }

  @Test
  fun `history snapshots survive caller mutation and reset for a new space`() {
    val history = PollHistoryWrites()
    val writes = mutableListOf<Set<String>>()
    val persist: (Set<String>) -> Unit = { writes.add(it) }
    val seen = mutableSetOf("a")
    history.persistIfChanged(true, seen, persist)
    seen.add("b")
    history.persistIfChanged(true, seen, persist)
    assertEquals(listOf(setOf("a"), setOf("a", "b")), writes)
    history.reset()
    history.persistIfChanged(true, seen, persist)
    assertEquals(3, writes.size)
    history.persistIfChanged(false, seen, persist)
    assertEquals(4, writes.size)
  }

  @Test
  fun `failed history write is retried`() {
    val history = PollHistoryWrites()
    try {
      history.persistIfChanged(true, setOf("a")) { throw IllegalStateException() }
    } catch (_: IllegalStateException) {
      // A failed persistence attempt must not advance the snapshot.
    }
    var writes = 0
    history.persistIfChanged(true, setOf("a")) { writes++ }
    assertEquals(1, writes)
  }

  @Test
  fun `failures grow backoff to its cap and success resets it`() {
    val cadence = PollCadence()
    assertFalse(cadence.hasFailures)
    cadence.failure()
    assertTrue(cadence.hasFailures)
    assertEquals(60_000L, cadence.delayMs(0, true, 0))
    cadence.failure()
    assertEquals(120_000L, cadence.delayMs(0, true, 0))
    repeat(20) {
      cadence.failure()
      assertEquals(120_999L, cadence.delayMs(90_000, false, 999))
    }
    cadence.success()
    assertFalse(cadence.hasFailures)
    assertEquals(30_000L, cadence.delayMs(90_000, false, 999))
    cadence.failure()
    assertEquals(60_000L, cadence.delayMs(90_000, false, 0))
    cadence.success()
    assertEquals(8_000L, cadence.delayMs(0, false, 0))
  }

  @Test
  fun `success uses fast window or busy recent page then slow cadence`() {
    val cadence = PollCadence()
    assertEquals(8_000L, cadence.delayMs(59_999, false, 0))
    assertEquals(30_000L, cadence.delayMs(60_000, false, 0))
    assertEquals(8_000L, cadence.delayMs(90_000, true, 0))
  }
}
