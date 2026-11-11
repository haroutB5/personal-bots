package expo.modules.hbotsnotify

sealed interface WorkingDecision {
  data object Nothing : WorkingDecision
  /** Show these bots now. `startedAt` is when the current working stretch began (the chronometer). */
  data class Post(val bots: List<WorkingBot>, val startedAt: Long) : WorkingDecision
  /** Hold the newest list and call [WorkingGate.due] after this long. */
  data class Defer(val delayMs: Long) : WorkingDecision
  data object Clear : WorkingDecision
}

/**
 * The 15 second rule, with no clock of its own. The notification changes at most once per
 * [minGapMs]: the first list shows at once, a change inside the window waits for the window to
 * end, and a list that equals the one on screen only refreshes the safety timeout once the window
 * has passed. When the last bot stops the notification clears at once, whatever the window says.
 */
class WorkingGate(private val minGapMs: Long = MIN_GAP_MS) {
  private var lastPostAt: Long? = null
  private var shown: List<WorkingBot> = emptyList()
  private var pending: List<WorkingBot>? = null
  private var startedAt = 0L

  @Synchronized
  fun update(now: Long, bots: List<WorkingBot>): WorkingDecision {
    if (bots.isEmpty()) return clear()
    val last = lastPostAt
    if (last == null) {
      startedAt = now
      return post(now, bots)
    }
    val elapsed = now - last
    if (elapsed >= minGapMs) return post(now, bots)
    if (bots == shown) {
      pending = null
      return WorkingDecision.Nothing
    }
    pending = bots
    return WorkingDecision.Defer(minGapMs - elapsed)
  }

  /** The deferred timer fired. */
  @Synchronized
  fun due(now: Long): WorkingDecision {
    val next = pending ?: return WorkingDecision.Nothing
    val last = lastPostAt ?: return WorkingDecision.Nothing
    if (now - last < minGapMs) return WorkingDecision.Defer(minGapMs - (now - last))
    return post(now, next)
  }

  @Synchronized
  fun clear(): WorkingDecision {
    val wasShowing = lastPostAt != null
    reset()
    return if (wasShowing) WorkingDecision.Clear else WorkingDecision.Nothing
  }

  @Synchronized
  fun reset() {
    lastPostAt = null
    shown = emptyList()
    pending = null
    startedAt = 0L
  }

  private fun post(now: Long, bots: List<WorkingBot>): WorkingDecision {
    lastPostAt = now
    shown = bots
    pending = null
    return WorkingDecision.Post(bots, startedAt)
  }

  companion object {
    const val MIN_GAP_MS = 15_000L
  }
}
