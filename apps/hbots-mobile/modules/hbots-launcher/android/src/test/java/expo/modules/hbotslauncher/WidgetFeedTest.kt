package expo.modules.hbotslauncher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetFeedTest {
  @Test fun theFeedCarriesExactlyThreeFields() {
    assertEquals(setOf("botId", "name", "working"), WidgetBot::class.java.declaredFields.map { it.name }.toSet())
  }

  @Test fun parseIgnoresEveryKeyButThreeSoNoMessageTextCanPassThrough() {
    val bots = WidgetFeedCodec.parse(
      listOf(
        mapOf("botId" to "a", "name" to "Juno", "working" to true, "note" to "secret step", "preview" to "hello", "text" to "x", "threadTitle" to "t"),
      ),
    )
    assertEquals(listOf(WidgetBot("a", "Juno", true)), bots)
    val stored = WidgetFeedCodec.encode(WidgetFeed(bots, 5))
    assertTrue(!stored.contains("secret") && !stored.contains("hello") && !stored.contains("threadTitle"))
  }

  @Test fun workingMustBeATrueBoolean() {
    val bots = WidgetFeedCodec.parse(listOf(mapOf("botId" to "a", "name" to "x", "working" to "true"), mapOf("botId" to "b", "name" to "y")))
    assertEquals(listOf(false, false), bots.map { it.working })
  }

  @Test fun parseDropsBadRowsDuplicatesAndCapsTheList() {
    val rows = listOf(mapOf("botId" to "", "name" to "x"), mapOf("name" to "no id"), mapOf("botId" to "a", "name" to " "), mapOf("botId" to "a", "name" to "dup")) +
      (1..20).map { mapOf("botId" to "b$it", "name" to "n") }
    val bots = WidgetFeedCodec.parse(rows)
    assertEquals("hbots", bots[0].name)
    assertEquals(WidgetFeedCodec.MAX_BOTS, bots.size)
  }

  @Test fun theStoredRecordRoundTrips() {
    val feed = WidgetFeed(listOf(WidgetBot("a", "Juno", true), WidgetBot("b", "Forge", false)), 42L)
    assertEquals(feed, WidgetFeedCodec.decode(WidgetFeedCodec.encode(feed)))
  }

  @Test fun noRecordOrADamagedOneIsNoFeed() {
    assertNull(WidgetFeedCodec.decode(null))
    assertNull(WidgetFeedCodec.decode(""))
    assertNull(WidgetFeedCodec.decode("{oops"))
    assertNull(WidgetFeedCodec.decode("{\"v\":2,\"bots\":[]}"))
    assertNull(WidgetFeedCodec.decode("{\"v\":1}"))
  }
}
