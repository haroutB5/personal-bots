package expo.modules.hbotslauncher

import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetModelTest {
  private val utc = ZoneId.of("UTC")
  // 2026-11-12 14:44:00 UTC
  private val now = 1_794_494_640_000L
  private fun feed(vararg bots: WidgetBot, at: Long = now) = WidgetFeed(bots.toList(), at)
  private fun board(feed: WidgetFeed, at: Long = now) = WidgetModel.build(feed, at, utc) as WidgetState.Board

  @Test fun noFeedIsTheSignedOutState() {
    assertEquals(WidgetState.SignedOut, WidgetModel.build(null, now, utc))
    assertEquals("Open hbots", WidgetCommon.SIGNED_OUT_TEXT)
  }

  @Test fun aSignedInFeedWithNoBotsIsTheEmptyState() {
    assertEquals(WidgetState.Empty, WidgetModel.build(feed(), now, utc))
  }

  @Test fun busyBotsAreRowsWithWhatTheyDoAndForHowLong() {
    val state = board(
      feed(
        WidgetBot("a", "Assistant", false),
        WidgetBot("p", "Poteto", false, waiting = true),
        WidgetBot("b", "Builder", true, activity = "Avatar poses", sinceMs = now - 18 * 60_000L, color = "#3987e5"),
      ),
    )
    assertEquals("hbots · 1 working", state.title)
    assertEquals(listOf("Builder", "Poteto"), state.rows.map { it.name })
    assertEquals(listOf("Avatar poses", "Waiting for your answer"), state.rows.map { it.sub })
    assertEquals("18 min", state.rows[0].time)
    assertEquals(WidgetFace("B", 0xFF3987E5.toInt()), state.rows[0].face)
    assertEquals("Builder, working, Avatar poses", state.rows[0].description)
    assertEquals(listOf("Assistant"), state.idle.map { it.name })
    assertEquals(0, state.moreIdle)
  }

  @Test fun withNobodyBusyThePinnedBotsAreTheRows() {
    val state = board(WidgetFeed((1..8).map { WidgetBot("b$it", "Bot$it", false) }, now))
    assertEquals("hbots", state.title)
    assertEquals(WidgetModel.MAX_ROWS, state.rows.size)
    assertEquals(4, state.idle.size)
    assertEquals(0, state.moreIdle)
    assertEquals("Idle", state.rows[0].sub)
  }

  @Test fun idleBotsBeyondTheStripFoldIntoAPlusN() {
    val bots = listOf(WidgetBot("w", "Worker", true)) + (1..7).map { WidgetBot("b$it", "Bot$it", false) }
    val state = board(WidgetFeed(bots, now))
    assertEquals(1, state.rows.size)
    assertEquals(WidgetModel.MAX_IDLE, state.idle.size)
    assertEquals(2, state.moreIdle)
  }

  @Test fun everyRowOpensItsBotThroughTheApp() {
    assertEquals("hbots://bot/a%20b", board(feed(WidgetBot("a b", "Juno", false))).rows.single().link)
  }

  @Test fun anOldFeedNeverClaimsABotIsStillWorkingAndSaysWhenItWasRead() {
    val bot = WidgetBot("a", "Juno", true, activity = "Editing files", sinceMs = now - 600_000L)
    val old = board(feed(bot, at = now - WidgetCommon.FRESH_MS - 1))
    assertEquals(BotTone.IDLE, old.rows.single().tone)
    assertEquals("Last seen working", old.rows.single().sub)
    assertEquals("", old.rows.single().time)
    assertEquals("hbots", old.title)
    assertEquals("as of 14:42", old.asOf)
    val fresh = board(feed(bot, at = now - WidgetCommon.FRESH_MS))
    assertEquals(BotTone.WORKING, fresh.rows.single().tone)
    assertEquals("", fresh.asOf)
  }

  @Test fun aWaitingBotStaysWaitingOnAnOldFeed() {
    val old = board(feed(WidgetBot("p", "Poteto", false, waiting = true), at = now - 3_600_000L))
    assertEquals(BotTone.WAITING, old.rows.single().tone)
  }

  @Test fun usageBarsAppearOnlyWhenTheFeedHasThem() {
    assertNull(board(feed(WidgetBot("a", "A", false))).usage)
    val usage = board(feed(WidgetBot("a", "A", false)).copy(usage = WidgetUsage("Claude", 82, null, ""))).usage!!
    assertEquals(WidgetGauge("Session", "82%", 82, true), usage.session)
    assertNull(usage.week)
  }

  @Test fun aHeartbeatWithTheSameFeedRedrawsNothingButAMinuteTickRedrawsWhoShowsIt() {
    val a = feed(WidgetBot("a", "Juno", true, sinceMs = now - 60_000L))
    val drawn = WidgetPictures.all(a, now, utc).mapValues { WidgetPictures.signature(it.value) }
    assertEquals(8, drawn.size)
    assertTrue(WidgetPictures.changed(drawn, a.copy(updatedAt = now + 15_000L), now + 15_000L, utc).isEmpty())
    val tick = WidgetPictures.changed(drawn, a.copy(updatedAt = now + 60_000L), now + 60_000L, utc)
    assertEquals(setOf(WidgetPictures.BOARD, WidgetPictures.NEEDS, WidgetPictures.TILES, WidgetPictures.BOT), tick)
    assertEquals(setOf(WidgetPictures.USAGE), WidgetPictures.changed(drawn, a.copy(usage = WidgetUsage("Claude", 5, null, "")), now, utc) - WidgetPictures.BOARD - WidgetPictures.TILES)
    assertEquals(drawn.keys, WidgetPictures.changed(emptyMap(), a, now, utc))
    // Sign-out changes every picture.
    assertEquals(drawn.keys, WidgetPictures.changed(drawn, null, now, utc))
  }

  @Test fun aResizedWidgetShowsTheRowsItHasRoomFor() {
    assertEquals(4, WidgetFit.rows(0, 100, 48, 4))
    assertEquals(4, WidgetFit.rows(300, 100, 48, 4))
    assertEquals(2, WidgetFit.rows(200, 100, 48, 4))
    assertEquals(1, WidgetFit.rows(110, 100, 48, 4))
    assertEquals(0, WidgetFit.rows(110, 100, 48, 4, min = 0))
    assertEquals(0, WidgetFit.rows(300, 100, 48, 0))
  }

  @Test fun theOnlySelfInflictedRedrawIsTheMomentTheFeedGoesStale() {
    val a = feed(WidgetBot("a", "Juno", false))
    assertEquals(now + WidgetCommon.FRESH_MS + 1_000L, WidgetCommon.nextRefreshAt(a, now))
    assertNull(WidgetCommon.nextRefreshAt(a, now + WidgetCommon.FRESH_MS + 1_000L))
    assertNull(WidgetCommon.nextRefreshAt(null, now))
  }

  @Test fun elapsedTimeReadsInMinutesThenHours() {
    assertEquals("", WidgetCommon.elapsed(0L, now))
    assertEquals("now", WidgetCommon.elapsed(now - 30_000L, now))
    assertEquals("59 min", WidgetCommon.elapsed(now - 59 * 60_000L, now))
    assertEquals("2 h 5 min", WidgetCommon.elapsed(now - 125 * 60_000L, now))
    assertEquals("", WidgetCommon.elapsed(now + 1, now))
  }

  @Test fun aBadColourFallsBackToTheDefault() {
    assertEquals(WidgetCommon.DEFAULT_COLOR, WidgetCommon.color(""))
    assertEquals(WidgetCommon.DEFAULT_COLOR, WidgetCommon.color("#zzzzzz"))
    assertEquals(0xFFFFFFFF.toInt(), WidgetCommon.color("#ffffff"))
  }
}
