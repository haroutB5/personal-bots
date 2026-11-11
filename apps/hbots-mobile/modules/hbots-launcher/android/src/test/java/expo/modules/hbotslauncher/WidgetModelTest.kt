package expo.modules.hbotslauncher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetModelTest {
  private val now = 1_000_000L
  private fun feed(vararg bots: WidgetBot, at: Long = now) = WidgetFeed(bots.toList(), at)

  @Test fun noFeedIsTheSignedOutState() {
    assertEquals(WidgetState.SignedOut, WidgetModel.build(null, now))
    assertEquals("Open hbots", WidgetModel.SIGNED_OUT_TEXT)
  }

  @Test fun aSignedInFeedWithNoBotsIsTheEmptyState() {
    assertEquals(WidgetState.Empty, WidgetModel.build(feed(), now))
  }

  @Test fun aWorkingBotGetsTheWorkingDotAndComesFirst() {
    val state = WidgetModel.build(feed(WidgetBot("a", "Juno", false), WidgetBot("b", "Forge", true)), now) as WidgetState.Bots
    assertEquals(listOf("Forge", "Juno"), state.rows.map { it.name })
    assertTrue(state.rows[0].working)
    assertFalse(state.rows[1].working)
    assertEquals("Forge, working", state.rows[0].description)
    assertEquals("Juno", state.rows[1].description)
  }

  @Test fun everyRowOpensItsBotThroughTheApp() {
    val state = WidgetModel.build(feed(WidgetBot("a b", "Juno", false)), now) as WidgetState.Bots
    assertEquals("hbots://bot/a%20b", state.rows.single().link)
  }

  @Test fun moreThanFiveBotsFoldIntoAPlusN() {
    val bots = (1..8).map { WidgetBot("b$it", "Bot$it", false) }
    val state = WidgetModel.build(WidgetFeed(bots, now), now) as WidgetState.Bots
    assertEquals(WidgetModel.MAX_ROWS, state.rows.size)
    assertEquals(3, state.more)
  }

  @Test fun anOldFeedNeverClaimsABotIsStillWorking() {
    val old = feed(WidgetBot("a", "Juno", true), at = now - WidgetModel.WORKING_FRESH_MS - 1)
    val state = WidgetModel.build(old, now) as WidgetState.Bots
    assertFalse(state.rows.single().working)
    val fresh = feed(WidgetBot("a", "Juno", true), at = now - WidgetModel.WORKING_FRESH_MS)
    assertTrue((WidgetModel.build(fresh, now) as WidgetState.Bots).rows.single().working)
  }

  @Test fun aFeedStampedInTheFutureIsNotTrusted() {
    val state = WidgetModel.build(feed(WidgetBot("a", "Juno", true), at = now + 5_000), now) as WidgetState.Bots
    assertFalse(state.rows.single().working)
  }

  @Test fun theRowCarriesNoTextBeyondTheNameAndTheDot() {
    val fields = WidgetRow::class.java.declaredFields.map { it.name }.toSet()
    assertEquals(setOf("botId", "name", "working", "link", "description"), fields)
  }

  @Test fun aLitDotAsksForARedrawJustAfterItGoesStale() {
    val lit = feed(WidgetBot("a", "Juno", true))
    assertEquals(now + WidgetModel.WORKING_FRESH_MS + 1_000, WidgetModel.nextRefreshAt(lit, now))
    // The moment it fires, the dot is gone.
    val fires = WidgetModel.nextRefreshAt(lit, now)!!
    assertFalse((WidgetModel.build(lit, fires) as WidgetState.Bots).rows.single().working)
  }

  @Test fun noLitDotMeansNoAlarm() {
    assertNull(WidgetModel.nextRefreshAt(null, now))
    assertNull(WidgetModel.nextRefreshAt(feed(WidgetBot("a", "Juno", false)), now))
    assertNull(WidgetModel.nextRefreshAt(feed(WidgetBot("a", "Juno", true), at = now - WidgetModel.WORKING_FRESH_MS - 1), now))
    assertNull(WidgetModel.nextRefreshAt(feed(WidgetBot("a", "Juno", true), at = now + 5_000), now))
  }

  @Test fun aHeartbeatThatChangesNothingVisibleSkipsTheRedraw() {
    val before = feed(WidgetBot("a", "Juno", true), at = now)
    val after = feed(WidgetBot("a", "Juno", true), at = now + 15_000)
    assertFalse(WidgetModel.needsRedraw(before, after, now + 15_000))
  }

  @Test fun aHeartbeatAfterTheDotWentGreyBringsItBack() {
    val stale = feed(WidgetBot("a", "Juno", true), at = now)
    val later = now + WidgetModel.WORKING_FRESH_MS + 30_000
    val heartbeat = feed(WidgetBot("a", "Juno", true), at = later)
    assertTrue(WidgetModel.needsRedraw(stale, heartbeat, later))
  }

  @Test fun aChangedBotListRedraws() {
    assertTrue(WidgetModel.needsRedraw(null, feed(), now))
    assertTrue(WidgetModel.needsRedraw(feed(WidgetBot("a", "Juno", false)), feed(WidgetBot("a", "Juno", true)), now))
  }
}
