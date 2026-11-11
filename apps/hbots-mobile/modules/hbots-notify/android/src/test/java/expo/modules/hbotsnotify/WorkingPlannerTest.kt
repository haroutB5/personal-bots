package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkingPlannerTest {
  private val open = NotifyPolicy(false, mapOf("a" to BotInfo("Juno", false), "b" to BotInfo("Forge", false), "h" to BotInfo("Quiet", true)))
  private fun bot(id: String, name: String, note: String? = null) = WorkingBot(id, name, note)

  @Test fun nothingWorkingMeansNoNotification() {
    assertNull(WorkingPlanner.plan(emptyList(), open))
  }

  @Test fun oneBotShowsItsNameAndNote() {
    val plan = WorkingPlanner.plan(listOf(bot("a", "Juno", "Reading the repo")), open)!!
    assertEquals("1 bot working", plan.title)
    assertEquals(listOf("Juno: Reading the repo"), plan.lines)
    assertNull(plan.summary)
    assertEquals(1, plan.count)
  }

  @Test fun oneBotWithoutANoteShowsWorking() {
    assertEquals(listOf("Juno: Working…"), WorkingPlanner.plan(listOf(bot("a", "Juno")), open)!!.lines)
  }

  @Test fun manyBotsGetOneLineEach() {
    val plan = WorkingPlanner.plan(listOf(bot("a", "Juno", "Step 1"), bot("b", "Forge", "Step 2")), open)!!
    assertEquals("2 bots working", plan.title)
    assertEquals(listOf("Juno: Step 1", "Forge: Step 2"), plan.lines)
  }

  @Test fun moreThanFiveBotsFoldIntoAPlusNLine() {
    val bots = (1..8).map { bot("x$it", "Bot$it") }
    val plan = WorkingPlanner.plan(bots, open)!!
    assertEquals("8 bots working", plan.title)
    assertEquals(WorkingPlanner.MAX_LINES, plan.lines.size)
    assertEquals("+3 more", plan.summary)
  }

  @Test fun theAppLockHidesEveryNote() {
    val locked = open.copy(appLockOn = true)
    val plan = WorkingPlanner.plan(listOf(bot("a", "Juno", "Secret step")), locked)!!
    assertEquals(listOf("Juno"), plan.lines)
    assertFalse(plan.lines.joinToString().contains("Secret"))
  }

  @Test fun aBotThatHidesPreviewsShowsNoNote() {
    val plan = WorkingPlanner.plan(listOf(bot("h", "Quiet", "Secret step"), bot("a", "Juno", "Open step")), open)!!
    assertEquals(listOf("Quiet", "Juno: Open step"), plan.lines)
  }

  @Test fun anUnknownBotAndTheFailClosedPolicyHideTheNote() {
    assertEquals(listOf("Ghost"), WorkingPlanner.plan(listOf(bot("zz", "Ghost", "Secret step")), open)!!.lines)
    assertEquals(listOf("Juno"), WorkingPlanner.plan(listOf(bot("a", "Juno", "Secret step")), NotifyPolicy.FAIL_CLOSED)!!.lines)
  }

  @Test fun theLockScreenTextNeverHasANameOrANote() {
    val plan = WorkingPlanner.plan(listOf(bot("a", "Juno", "Secret step")), open)!!
    assertEquals("Bots are working", plan.publicText)
    assertFalse(plan.publicText.contains("Juno"))
  }

  @Test fun parseDropsBadRowsDuplicatesAndCleansText() {
    val bots = WorkingPlanner.parse(
      listOf(
        mapOf("botId" to "a", "name" to "  Juno\n ", "note" to "  step \t one "),
        mapOf("botId" to "a", "name" to "again"),
        mapOf("botId" to "", "name" to "x"),
        mapOf("name" to "no id"),
        mapOf("botId" to "b", "name" to " "),
      ),
    )
    assertEquals(listOf(WorkingBot("a", "Juno", "step one"), WorkingBot("b", "hbots", null)), bots)
  }

  @Test fun parseClipsLongTextAndCapsTheList() {
    val long = "n".repeat(300)
    val parsed = WorkingPlanner.parse(listOf(mapOf("botId" to "a", "name" to long, "note" to long)))
    assertTrue(parsed[0].name.length <= 40)
    assertTrue(parsed[0].note!!.length <= 80)
    val many = WorkingPlanner.parse((1..20).map { mapOf("botId" to "b$it", "name" to "n") })
    assertEquals(WorkingPlanner.MAX_BOTS, many.size)
  }

  @Test fun theStopLinkIsTheRegisteredRoute() {
    assertEquals("hbots://stop", WorkingPlanner.STOP_LINK)
  }
}
