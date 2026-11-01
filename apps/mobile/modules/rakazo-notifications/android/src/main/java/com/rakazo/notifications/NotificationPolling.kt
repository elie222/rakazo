package com.rakazo.notifications

internal data class RunRecord(
  val runId: String,
  val spaceId: String,
  val botId: String,
  val botName: String,
  val groupId: String?,
  val groupName: String?,
  val threadId: String,
  val status: String,
  val prompt: String,
  val trigger: String,
  val notificationsEnabled: Boolean,
)

internal class PollCompletions(private val seen: MutableSet<String>) {
  private data class Session(val endpoint: String, val spaceId: String, val token: String, val epoch: Long)
  private var session: Session? = null
  private val pending = linkedMapOf<String, RunRecord>()

  // The discard must reach storage before the poller can stop: a restart reloads
  // only what persisted, and would repost the muted reply once the bot is unmuted.
  fun muteBot(botId: String, persistSeen: () -> Unit) {
    val muted = pending.values.filter { it.botId == botId && it.groupId == null }
    muted.forEach { run ->
      pending.remove(run.runId)
      seen.add(run.runId)
    }
    if (muted.isNotEmpty()) persistSeen()
  }

  fun useSession(endpoint: String, spaceId: String, token: String, epoch: Long) {
    val next = Session(endpoint, spaceId, token, epoch)
    if (session != next) {
      pending.clear()
      session = next
    }
  }

  fun prepare(
    recent: List<RunRecord>,
    seeded: Boolean,
    settings: NotificationSettings,
    isOpenThread: (RunRecord) -> Boolean,
    attention: (RunRecord) -> Unit,
  ): List<RunRecord> {
    val candidates = LinkedHashMap(pending)
    recent.asReversed().forEach { candidates[it.runId] = it }
    pending.clear()
    if (!seeded) {
      seen += recent.map { it.runId }
    } else {
      candidates.values.forEach { run ->
        handleUnseenCompletion(run.runId, seen) {
          when {
            !run.notificationsEnabled || isOpenThread(run) -> true
            run.status == "failed" && settings.needsAttention -> {
              attention(run)
              true
            }
            run.status != "completed" -> true
            run.trigger == "routine" && !settings.scheduledTasks -> true
            run.trigger != "routine" && !settings.messages -> true
            else -> {
              pending[run.runId] = run
              false
            }
          }
        }
      }
    }
    // Retain at most 100 reply records across generations, independently of the recent page.
    while (pending.size > 100) {
      val oldest = pending.keys.first()
      pending.remove(oldest)
      seen.add(oldest)
    }
    seen.retainAll(recent.map { it.runId }.toSet())
    return pending.values.toList()
  }

  fun complete(run: RunRecord, alreadyPosted: () -> Boolean, post: () -> Unit) {
    if (run.runId !in pending) return
    handleUnseenCompletion(run.runId, seen) {
      if (!alreadyPosted()) post()
      true
    }
    pending.remove(run.runId)
  }
}

internal fun handleUnseenCompletion(
  runId: String,
  seen: MutableSet<String>,
  handle: () -> Boolean,
) {
  // Deferred reply lookups return false; only a posted or deliberately skipped run is seen.
  if (runId !in seen && handle()) seen.add(runId)
}

internal class PollTokenCache {
  @Volatile private var token: String? = null

  // The service commits under its generation lock after the expensive read.
  fun getOrLoad(load: () -> String, commit: (() -> Unit) -> Boolean): String? {
    token?.let { return it }
    val loaded = load()
    return if (commit { token = loaded }) loaded else null
  }

  fun reset() {
    token = null
  }
}

internal class PollHistoryWrites {
  private var persistedSeen: Set<String>? = null

  fun persistIfChanged(seeded: Boolean, seen: Set<String>, persist: (Set<String>) -> Unit) {
    if (!seeded || seen != persistedSeen) {
      val snapshot = seen.toSet()
      persist(snapshot)
      persistedSeen = snapshot
    }
  }

  fun reset() {
    persistedSeen = null
  }
}

internal class PollCadence {
  private var failures = 0
  val hasFailures: Boolean get() = failures > 0

  fun failure() {
    failures = (failures + 1).coerceAtMost(3)
  }

  fun success() {
    failures = 0
  }

  fun delayMs(elapsedMs: Long, recentPageBusy: Boolean, jitterMs: Long): Long =
    if (hasFailures) {
      minOf(120_000L, 30_000L * (1L shl failures)) + jitterMs
    } else {
      // A reopened app or a bounded page filling with new completions polls quickly.
      if (recentPageBusy || elapsedMs < 60_000L) 8_000L else 30_000L
    }
}
