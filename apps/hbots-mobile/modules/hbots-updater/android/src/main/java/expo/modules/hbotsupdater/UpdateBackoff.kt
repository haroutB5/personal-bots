package expo.modules.hbotsupdater

object UpdateBackoff {
  const val MAX_DELAY_MS = 6 * 60 * 60 * 1000L

  fun delayMs(attempt: Int, baseMs: Long): Long {
    var delay = baseMs.coerceAtLeast(1L)
    repeat(attempt.coerceIn(0, 20)) {
      delay = (delay * 2).coerceAtMost(MAX_DELAY_MS)
    }
    return delay.coerceAtMost(MAX_DELAY_MS)
  }
}
