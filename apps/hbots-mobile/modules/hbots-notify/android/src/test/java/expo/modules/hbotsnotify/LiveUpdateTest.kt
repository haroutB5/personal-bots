package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveUpdateTest {
  private val policy = NotifyPolicy(false, mapOf("a" to BotInfo("Juno", false), "b" to BotInfo("Forge", false)))
  private val one = WorkingPlanner.plan(listOf(WorkingBot("a", "Juno", "Reading the repo")), policy)!!
  private val two = WorkingPlanner.plan(listOf(WorkingBot("a", "Juno", "Step 1"), WorkingBot("b", "Forge", "Step 2")), policy)!!
  private val many = WorkingPlanner.plan((1..8).map { WorkingBot("a$it", "Bot$it", null) }, policy)!!

  @Test fun api36WithPromotionAllowedAsksForPromotionWithBigText() {
    val shown = LiveUpdate.presentation(two, 36, true)
    assertTrue(shown.promote)
    assertEquals(WorkingBody.BigText("Juno: Step 1\nForge: Step 2"), shown.body)
  }

  @Test fun laterThan36AlsoPromotes() {
    assertTrue(LiveUpdate.presentation(one, 37, true).promote)
  }

  @Test fun api35KeepsTheN3InboxAndAsksForNothing() {
    val shown = LiveUpdate.presentation(two, 35, true)
    assertFalse(shown.promote)
    assertEquals(WorkingBody.Inbox(two.lines, two.summary), shown.body)
  }

  @Test fun api36WithLiveUpdatesTurnedOffInSettingsFallsBack() {
    val shown = LiveUpdate.presentation(two, 36, false)
    assertFalse(shown.promote)
    assertEquals(WorkingBody.Inbox(two.lines, two.summary), shown.body)
  }

  @Test fun minimumSdkIs36() {
    assertEquals(36, LiveUpdate.MIN_SDK)
    assertFalse(LiveUpdate.presentation(one, 26, true).promote)
  }

  @Test fun bigTextAppendsTheOverflowSummary() {
    val text = LiveUpdate.bigText(many)
    val lines = text.split("\n")
    assertEquals(WorkingPlanner.MAX_LINES + 1, lines.size)
    assertEquals("+3 more", lines.last())
  }

  @Test fun bigTextKeepsLockHiddenNamesOut() {
    val locked = WorkingPlanner.plan(listOf(WorkingBot("a", "Juno", "secret step")), NotifyPolicy(true, mapOf("a" to BotInfo("Juno", false))))!!
    assertEquals("Juno", LiveUpdate.bigText(locked))
  }
}
