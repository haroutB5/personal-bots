package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkingGateTest {
  private val a = WorkingBot("a", "Juno", "one")
  private val a2 = WorkingBot("a", "Juno", "two")
  private val b = WorkingBot("b", "Forge", null)

  @Test fun theFirstListShowsAtOnce() {
    val gate = WorkingGate()
    assertEquals(WorkingDecision.Post(listOf(a), 1_000), gate.update(1_000, listOf(a)))
  }

  @Test fun theSameListInsideTheWindowDoesNothing() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    assertEquals(WorkingDecision.Nothing, gate.update(5_000, listOf(a)))
  }

  @Test fun aChangeInsideTheWindowWaitsForTheWindowToEnd() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    assertEquals(WorkingDecision.Defer(10_000), gate.update(5_000, listOf(a, b)))
    assertEquals(WorkingDecision.Defer(5_000), gate.due(10_000))
    assertEquals(WorkingDecision.Post(listOf(a, b), 0), gate.due(15_000))
  }

  @Test fun onlyTheNewestPendingListIsPosted() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    gate.update(2_000, listOf(a, b))
    gate.update(4_000, listOf(a2))
    assertEquals(WorkingDecision.Post(listOf(a2), 0), gate.due(15_000))
  }

  @Test fun postsAreNeverCloserThanFifteenSeconds() {
    val gate = WorkingGate()
    val posts = mutableListOf<Long>()
    val timers = sortedMapOf<Long, Boolean>()
    for (second in 0L..120L) {
      val now = second * 1_000
      while (timers.isNotEmpty() && timers.firstKey() <= now) {
        val at = timers.firstKey()
        timers.remove(at)
        val d = gate.due(at)
        if (d is WorkingDecision.Post) posts += at
        if (d is WorkingDecision.Defer) timers[at + d.delayMs] = true
      }
      val d = gate.update(now, if (second % 2 == 0L) listOf(a) else listOf(a2))
      if (d is WorkingDecision.Post) posts += now
      if (d is WorkingDecision.Defer) timers[now + d.delayMs] = true
    }
    assertTrue(posts.size > 3)
    assertTrue(posts.zipWithNext().all { (x, y) -> y - x >= 15_000 })
  }

  @Test fun anIdenticalListAfterTheWindowPostsAgainToRefreshTheSafetyTimeout() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    assertEquals(WorkingDecision.Post(listOf(a), 0), gate.update(15_000, listOf(a)))
  }

  @Test fun theLastRunEndingClearsAtOnceEvenInsideTheWindow() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    assertEquals(WorkingDecision.Clear, gate.update(1_000, emptyList()))
  }

  @Test fun clearingWhenNothingShowsDoesNothing() {
    val gate = WorkingGate()
    assertEquals(WorkingDecision.Nothing, gate.update(0, emptyList()))
    assertEquals(WorkingDecision.Nothing, gate.clear())
  }

  @Test fun aClearCancelsAPendingPost() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    gate.update(2_000, listOf(a, b))
    gate.update(3_000, emptyList())
    assertEquals(WorkingDecision.Nothing, gate.due(15_000))
  }

  @Test fun aNewStretchAfterAClearRestartsTheChronometer() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    gate.update(20_000, emptyList())
    assertEquals(WorkingDecision.Post(listOf(a), 21_000), gate.update(21_000, listOf(a)))
  }

  @Test fun theChronometerKeepsTheStartOfTheStretch() {
    val gate = WorkingGate()
    gate.update(1_000, listOf(a))
    assertEquals(WorkingDecision.Post(listOf(a, b), 1_000), gate.update(20_000, listOf(a, b)))
  }

  @Test fun resetForgetsEverything() {
    val gate = WorkingGate()
    gate.update(0, listOf(a))
    gate.reset()
    assertEquals(WorkingDecision.Post(listOf(a), 2_000), gate.update(2_000, listOf(a)))
  }
}
