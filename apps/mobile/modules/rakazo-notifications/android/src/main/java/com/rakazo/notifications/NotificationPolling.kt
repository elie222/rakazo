package com.rakazo.notifications

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
