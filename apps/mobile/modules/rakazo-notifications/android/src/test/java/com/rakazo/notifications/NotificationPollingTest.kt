package com.rakazo.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPollingTest {
  @Test
  fun `restart retains a reply missing from the next full recent page and posts it once`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    assertEquals(listOf(reply), completions.page(listOf(reply)))
    // No completion: the old job is still fetching when the next generation polls.
    val nextPage = (1..20).map { run("new-$it") }
    val pending = completions.page(nextPage)
    assertTrue("the replacement poller must retain the displaced reply", reply in pending)
    assertFalse("reply" in seen)
    var notifications = 0
    completions.complete(reply, alreadyPosted = { false }) {
      assertFalse("reply" in seen)
      notifications++
    }
    assertTrue("reply" in seen)
    assertFalse(reply in completions.page(nextPage))
    completions.complete(reply, alreadyPosted = { false }) { notifications++ }
    assertEquals(1, notifications)
  }

  @Test
  fun `active notification after process death suppresses another alert and records the run seen`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    completions.page(listOf(reply))
    var notifications = 0
    completions.complete(reply, alreadyPosted = { true }) { notifications++ }
    assertEquals(0, notifications)
    assertTrue("reply" in seen)
    assertTrue(completions.page(listOf(reply)).isEmpty())
  }

  @Test
  fun `pending replies are bounded and the oldest is skipped on overflow`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val replies = (1..101).map { run("reply-$it") }
    var pending = emptyList<RunRecord>()
    for (reply in replies) pending = completions.page(listOf(reply))
    assertEquals(100, pending.size)
    assertFalse(replies.first() in pending)
    assertTrue(replies.last() in pending)
    var notifications = 0
    completions.complete(replies.first(), alreadyPosted = { false }) { notifications++ }
    assertEquals(0, notifications)
  }

  @Test
  fun `pending replies stay in the same session and clear on each session boundary`() {
    val changes = listOf(
      listOf("https://other.test", "space", "token", "0"),
      listOf("https://example.test", "other-space", "token", "0"),
      listOf("https://example.test", "space", "other-token", "0"),
      listOf("https://example.test", "space", "token", "1"),
    )
    for ((endpoint, spaceId, token, epoch) in changes) {
      val completions = PollCompletions(mutableSetOf())
      completions.useSession("https://example.test", "space", "token", 0)
      val reply = run("reply")
      completions.page(listOf(reply))
      completions.useSession("https://example.test", "space", "token", 0)
      assertEquals(listOf(reply), completions.page(emptyList()))
      completions.useSession(endpoint, spaceId, token, epoch.toLong())
      assertTrue(completions.page(emptyList()).isEmpty())
    }
  }

  @Test
  fun `history seeding suppresses old replies and pending replies honour settings and open threads`() {
    val settings = listOf(
      NotificationSettings(messages = false) to run("message"),
      NotificationSettings(scheduledTasks = false) to run("routine").copy(trigger = "routine"),
    )
    for ((disabled, reply) in settings) {
      val seen = mutableSetOf<String>()
      val completions = PollCompletions(seen)
      assertTrue(completions.page(listOf(reply), seeded = false).isEmpty())
      assertTrue(completions.page(listOf(reply)).isEmpty())
      assertTrue(reply.runId in seen)
      val pending = reply.copy(runId = "new")
      completions.page(listOf(pending))
      assertTrue(completions.page(listOf(pending), settings = disabled).isEmpty())
      assertTrue("new" in seen)
      val open = reply.copy(runId = "open")
      completions.page(listOf(open))
      assertTrue(completions.page(listOf(open), openThreadId = open.threadId).isEmpty())
      assertTrue("open" in seen)
    }
  }

  @Test
  fun `muting drops a pending direct reply missing from recent but preserves groups and other bots`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val direct = run("muted")
    val group = run("group").copy(groupId = "group-1")
    val other = run("other").copy(botId = "other-bot")
    completions.page(listOf(direct, group, other))
    val recent = (1..20).map { run("new-$it").copy(botId = "other-bot") }
    assertTrue(direct in completions.page(recent))

    completions.muteBot("bot") {}
    val afterMute = completions.page(recent)
    assertFalse("the muted reply must be discarded even when absent from recent", direct in afterMute)
    assertTrue(group in afterMute)
    assertTrue(other in afterMute)
    val posted = mutableListOf<String>()
    // The pre-mute fetch may still return with its old RunRecord.
    completions.complete(direct, alreadyPosted = { false }) { posted += direct.runId }
    completions.complete(group, alreadyPosted = { false }) { posted += group.runId }
    completions.complete(other, alreadyPosted = { false }) { posted += other.runId }
    assertEquals(listOf("group", "other"), posted)
  }

  @Test
  fun `muting persists the discarded reply so a restart cannot repost it after unmute`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val history = PollHistoryWrites()
    val writes = mutableListOf<Set<String>>()
    val persistSeen = { history.persistIfChanged(true, seen) { writes.add(it) } }
    val muted = run("muted")
    // The completed run waits for its reply lookup; the poll iteration persisted.
    assertEquals(listOf(muted), completions.page(listOf(muted)))
    persistSeen()

    // The user mutes the bot; the poller can stop before another iteration persists.
    completions.muteBot("bot", persistSeen)

    // A restart rebuilds the seen set from the last persisted snapshot, and the
    // unmuted bot's run returns on the recent page with notificationsEnabled=true.
    val restarted = PollCompletions(mutableSetOf<String>().apply { addAll(writes.last()) })
    assertTrue("restart must keep the muted reply suppressed", restarted.page(listOf(muted)).isEmpty())
    var notifications = 0
    restarted.complete(muted, alreadyPosted = { false }) { notifications++ }
    assertEquals(0, notifications)
  }

  @Test
  fun `muting with no discarded direct reply writes no history`() {
    val completions = PollCompletions(mutableSetOf())
    completions.page(listOf(run("group").copy(groupId = "group-1")))
    var writes = 0
    completions.muteBot("bot") { writes++ }
    assertEquals(0, writes)
  }

  @Test
  fun `failed post keeps the pending reply available outside the recent page`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    completions.page(listOf(reply))
    assertThrows(IllegalStateException::class.java) {
      completions.complete(reply, alreadyPosted = { false }) { error("notification failed") }
    }
    assertFalse("reply" in seen)
    assertEquals(listOf(reply), completions.page(emptyList()))
    completions.complete(reply, alreadyPosted = { false }) {}
    assertTrue("reply" in seen)
    assertTrue(completions.page(emptyList()).isEmpty())
  }

  @Test
  fun `completion is remembered only after posting and is not handled again`() {
    val seen = mutableSetOf<String>()
    var notifications = 0
    handleUnseenCompletion("reply", seen) {
      assertFalse("reply" in seen)
      notifications++
      true
    }
    assertEquals(setOf("reply"), seen)
    handleUnseenCompletion("reply", seen) { error("already posted") }
    assertEquals(1, notifications)
  }

  @Test
  fun `failed posting leaves the completion unseen`() {
    val seen = mutableSetOf<String>()
    assertThrows(IllegalStateException::class.java) {
      handleUnseenCompletion("reply", seen) { error("notification failed") }
    }
    assertTrue(seen.isEmpty())
    handleUnseenCompletion("reply", seen) { true }
    assertEquals(setOf("reply"), seen)
  }

  @Test
  fun `deliberately skipped completion is remembered without posting`() {
    val seen = mutableSetOf<String>()
    handleUnseenCompletion("reply", seen) { true }
    assertEquals(setOf("reply"), seen)
    handleUnseenCompletion("reply", seen) { error("already skipped") }
  }

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

  private fun run(id: String) = RunRecord(
    runId = id,
    spaceId = "space",
    botId = "bot",
    botName = "Bot",
    groupId = null,
    groupName = null,
    threadId = "thread-$id",
    status = "completed",
    prompt = "Prompt",
    trigger = "message",
    notificationsEnabled = true,
  )

  private fun PollCompletions.page(
    recent: List<RunRecord>,
    seeded: Boolean = true,
    settings: NotificationSettings = NotificationSettings(),
    openThreadId: String? = null,
  ): List<RunRecord> = prepare(recent, seeded, settings, { it.threadId == openThreadId }) {
    error("unexpected attention notification")
  }
}
