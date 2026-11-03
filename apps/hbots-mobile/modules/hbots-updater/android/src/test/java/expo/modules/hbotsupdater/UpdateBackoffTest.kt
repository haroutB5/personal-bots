package expo.modules.hbotsupdater

import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateBackoffTest {
  private val base = 60_000L

  @Test
  fun `the first retry waits one idle delay`() {
    assertEquals(60_000L, UpdateBackoff.delayMs(0, base))
  }

  @Test
  fun `each attempt doubles the wait`() {
    assertEquals(120_000L, UpdateBackoff.delayMs(1, base))
    assertEquals(240_000L, UpdateBackoff.delayMs(2, base))
    assertEquals(480_000L, UpdateBackoff.delayMs(3, base))
  }

  @Test
  fun `the wait stops at six hours`() {
    assertEquals(6 * 60 * 60 * 1000L, UpdateBackoff.delayMs(40, base))
  }

  @Test
  fun `a production idle delay caps at the same ceiling`() {
    assertEquals(600_000L, UpdateBackoff.delayMs(0, 600_000L))
    assertEquals(9_600_000L, UpdateBackoff.delayMs(4, 600_000L))
    assertEquals(6 * 60 * 60 * 1000L, UpdateBackoff.delayMs(20, 600_000L))
  }
}
