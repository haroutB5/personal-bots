package expo.modules.hbotsvoice

/**
 * How long native keeps the microphone open without hearing from JS. JS owns
 * the rules and pushes the next deadline here; native owns whether the mic is
 * open. React Native freezes every JS timer while the app is in the background,
 * so a rule that lives only in JS cannot close a mic the user cannot see.
 *
 * The clock is elapsed realtime, which keeps counting through doze and sleep.
 */
class CallLease(private val clock: () -> Long) {
  private var kind: Deadline? = null
  private var atMs = 0L
  private var ceilingAtMs = 0L

  @Synchronized
  fun begin() {
    val now = clock()
    kind = Deadline.CONNECT
    atMs = now + CONNECT_LEASE_MS
    ceilingAtMs = now + CEILING_MS
  }

  /** Moves the lease. Nothing passes the ceiling; a lease cut at it reports the limit. */
  @Synchronized
  fun set(next: Deadline, at: Long) {
    if (kind == null) return
    if (at >= ceilingAtMs) {
      kind = Deadline.LIMIT
      atMs = ceilingAtMs
    } else {
      kind = next
      atMs = at
    }
  }

  @Synchronized
  fun due(): Deadline? {
    val current = kind ?: return null
    return if (clock() >= atMs) current else null
  }

  @Synchronized
  fun clear() {
    kind = null
  }

  companion object {
    /**
     * Held from the tap until JS first pushes a lease. It must outlast the JS
     * connect wait (`VOICE_CONNECT_TIMEOUT_MS`, 20 s, in callState.ts) plus the
     * time the server takes to hand out a pass; it is `VOICE_ACCEPT_WAIT_MS`
     * there, and the two numbers change together.
     */
    const val CONNECT_LEASE_MS = 45_000L

    /** `VOICE_CALL_MAX_MINUTES` (30, in packages/contracts) plus one minute of slack. */
    const val CEILING_MS = (30L + 1L) * 60_000L
  }
}
