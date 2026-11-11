package expo.modules.hbotslauncher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShortcutPlannerTest {
  private fun pins(count: Int) = (1..count).map { PinnedBot("b$it", "Bot $it") }

  @Test fun noPinsMeansNoShortcuts() {
    assertTrue(ShortcutPlanner.plan(emptyList()).isEmpty())
  }

  @Test fun onePinMakesOneShortcutThatOpensANewChat() {
    val specs = ShortcutPlanner.plan(listOf(PinnedBot("b1", "Juno")))
    assertEquals(1, specs.size)
    val spec = specs.single()
    assertEquals("bot_b1", spec.id)
    assertEquals("Juno", spec.shortLabel)
    assertEquals("New chat with Juno", spec.longLabel)
    assertEquals("hbots://bot/b1?new=1", spec.link)
    assertEquals(0, spec.rank)
  }

  @Test fun fourPinsMakeFourShortcutsInOrder() {
    val specs = ShortcutPlanner.plan(pins(4))
    assertEquals(listOf("bot_b1", "bot_b2", "bot_b3", "bot_b4"), specs.map { it.id })
    assertEquals(listOf(0, 1, 2, 3), specs.map { it.rank })
  }

  @Test fun moreThanFourPinsAreCappedAtFour() {
    val specs = ShortcutPlanner.plan(pins(9))
    assertEquals(4, specs.size)
    assertEquals(listOf("bot_b1", "bot_b2", "bot_b3", "bot_b4"), specs.map { it.id })
  }

  @Test fun aLauncherThatAllowsFewerGetsFewer() {
    assertEquals(2, ShortcutPlanner.plan(pins(4), limit = 2).size)
    assertTrue(ShortcutPlanner.plan(pins(4), limit = 0).isEmpty())
    assertTrue(ShortcutPlanner.plan(pins(4), limit = -3).isEmpty())
    assertEquals(4, ShortcutPlanner.plan(pins(9), limit = 50).size)
  }

  @Test fun signOutIsAnEmptyListSoNothingStays() {
    assertTrue(ShortcutPlanner.plan(ShortcutPlanner.parse(emptyList())).isEmpty())
  }

  @Test fun dynamicIdsNeverCollideWithTheStaticCtoShortcut() {
    val ids = ShortcutPlanner.plan(pins(4) + PinnedBot(ShortcutPlanner.STATIC_CTO_ID, "x")).map { it.id }
    assertFalse(ShortcutPlanner.STATIC_CTO_ID in ids)
    assertTrue(ids.all { it.startsWith(ShortcutPlanner.ID_PREFIX) })
  }

  @Test fun longNamesAreClipped() {
    val spec = ShortcutPlanner.plan(listOf(PinnedBot("b1", "n".repeat(100)))).single()
    assertTrue(spec.shortLabel.length <= 12)
    assertTrue(spec.longLabel.length <= 40)
  }

  @Test fun linksEscapeUnsafeIdsLikeTheTileDoes() {
    assertEquals("hbots://bot/a%2Fb%20c?new=1", ShortcutPlanner.newChatLink("a/b c"))
    assertEquals("hbots://bot/ab-1._~?new=1", ShortcutPlanner.newChatLink("ab-1._~"))
  }

  @Test fun parseDropsBadRowsAndDuplicatesAndCleansNames() {
    val bots = ShortcutPlanner.parse(
      listOf(
        mapOf("botId" to "a", "name" to "  Juno\n "),
        mapOf("botId" to "a", "name" to "again"),
        mapOf("botId" to "", "name" to "x"),
        mapOf("name" to "no id"),
        mapOf("botId" to "b", "name" to " "),
        mapOf("botId" to 5, "name" to "wrong type"),
      ),
    )
    assertEquals(listOf(PinnedBot("a", "Juno"), PinnedBot("b", "hbots")), bots)
  }
}
