package expo.modules.hbotslauncher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetFeedTest {
  private val full = WidgetFeed(
    bots = listOf(
      WidgetBot("a", "Builder", true, activity = "Avatar poses", sinceMs = 900L, color = "#3987e5"),
      WidgetBot("p", "Poteto", false, waiting = true),
      WidgetBot("c", "CFO", false, unread = 3),
    ),
    updatedAt = 42L,
    usage = WidgetUsage("Claude", 62, 38, "17:10"),
    laptop = WidgetMachine(23, 11, 32, tempC = 54, diskFreeGB = 212),
    gamingPc = WidgetMachine(32, 12, 16, gpuPct = 4, users = listOf("Builder")),
    today = WidgetToday(4, 1, 2, listOf(WidgetEvent(false, "hbots is live", "Shipper", 500L), WidgetEvent(true, "Review failed", "Verifier", 400L)), "Tennis Friday", 9_000L),
    question = WidgetQuestion("p", "Poteto", "Hbots", "Ship now, or wait?", listOf("Ship now", "Wait"), "hbots://chat/p/t-1", 300L),
  )

  @Test fun theStoredRecordRoundTrips() {
    assertEquals(full, WidgetFeedCodec.decode(WidgetFeedCodec.encode(full)))
    val bare = WidgetFeed(listOf(WidgetBot("a", "Juno", true), WidgetBot("b", "Forge", false)), 42L)
    assertEquals(bare, WidgetFeedCodec.decode(WidgetFeedCodec.encode(bare)))
  }

  @Test fun aVersionOneRecordStillReads() {
    val old = "{\"v\":1,\"updatedAt\":7,\"bots\":[{\"botId\":\"a\",\"name\":\"Juno\",\"working\":true}]}"
    assertEquals(WidgetFeed(listOf(WidgetBot("a", "Juno", true)), 7L), WidgetFeedCodec.decode(old))
  }

  @Test fun theFirstWidgetsListEntryPointStillReadsThreeFieldsOnly() {
    val bots = WidgetFeedCodec.parse(listOf(mapOf("botId" to "a", "name" to "Juno", "working" to true, "activity" to "secret step", "text" to "x")))
    assertEquals(listOf(WidgetBot("a", "Juno", true)), bots)
  }

  @Test fun whatJsSendsIsStampedWithNativeTime() {
    val feed = WidgetFeedCodec.fromJs("{\"v\":2,\"updatedAt\":999999,\"bots\":[]}", 5L)
    assertEquals(5L, feed?.updatedAt)
  }

  @Test fun noRecordADamagedOneOrAnUnknownVersionIsNoFeed() {
    assertNull(WidgetFeedCodec.decode(null))
    assertNull(WidgetFeedCodec.decode(""))
    assertNull(WidgetFeedCodec.decode("{oops"))
    assertNull(WidgetFeedCodec.decode("{\"v\":3,\"bots\":[]}"))
    assertNull(WidgetFeedCodec.decode("{\"v\":2}"))
    assertNull(WidgetFeedCodec.fromJs("[]", 1L))
  }

  @Test fun workingMustBeATrueBooleanAndAWorkingBotIsNotWaiting() {
    val feed = WidgetFeedCodec.decode("{\"v\":2,\"bots\":[{\"botId\":\"a\",\"name\":\"x\",\"working\":\"true\"},{\"botId\":\"b\",\"name\":\"y\",\"working\":true,\"waiting\":true}]}")!!
    assertFalse(feed.bots[0].working)
    assertTrue(feed.bots[1].working)
    assertFalse(feed.bots[1].waiting)
  }

  @Test fun badRowsAndDuplicatesAreDroppedAndTheListIsCapped() {
    val rows = listOf(mapOf("botId" to "", "name" to "x"), mapOf("name" to "no id"), mapOf("botId" to "a", "name" to " "), mapOf("botId" to "a", "name" to "dup")) +
      (1..20).map { mapOf("botId" to "b$it", "name" to "n") }
    val bots = WidgetFeedCodec.parse(rows)
    assertEquals("hbots", bots[0].name)
    assertEquals(WidgetFeedCodec.MAX_BOTS, bots.size)
  }

  @Test fun everyStringIsCleanedAndCutToItsCapWhateverJsSent() {
    val long = "x".repeat(500)
    val raw = org.json.JSONObject()
      .put("v", 2)
      .put("bots", org.json.JSONArray().put(org.json.JSONObject().put("botId", "a").put("name", long).put("working", true).put("activity", "line one\nline\u0000two  $long").put("color", "red").put("unread", 5000)))
      .put("question", org.json.JSONObject().put("botId", "a").put("botName", long).put("chatTitle", long).put("text", "a\tb\n$long").put("link", "hbots://chat/a/t").put("choices", org.json.JSONArray(listOf(long, "B", "", "C", "D"))))
      .put("today", org.json.JSONObject().put("done", 1).put("events", org.json.JSONArray((1..9).map { org.json.JSONObject().put("kind", "done").put("title", long).put("bot", long).put("atMs", it) })))
      .put("gamingPc", org.json.JSONObject().put("cpuPct", 250).put("users", org.json.JSONArray((1..9).map { long })))
      .toString()
    val feed = WidgetFeedCodec.decode(raw)!!
    val bot = feed.bots.single()
    assertEquals(40, bot.name.length)
    assertEquals(WidgetFeedCodec.MAX_ACTIVITY, bot.activity.length)
    assertTrue(bot.activity.startsWith("line one line two x"))
    assertEquals("", bot.color)
    assertEquals(99, bot.unread)
    val question = feed.question!!
    assertEquals(WidgetFeedCodec.MAX_QUESTION, question.text.length)
    assertTrue(question.text.startsWith("a b x"))
    assertEquals(WidgetFeedCodec.MAX_CHOICES, question.choices.size)
    assertEquals(WidgetFeedCodec.MAX_CHOICE, question.choices[0].length)
    assertEquals(WidgetFeedCodec.MAX_EVENTS, feed.today!!.events.size)
    assertEquals(WidgetFeedCodec.MAX_TITLE, feed.today!!.events[0].title.length)
    assertEquals(100, feed.gamingPc!!.cpuPct)
    assertEquals(WidgetFeedCodec.MAX_USERS, feed.gamingPc!!.users.size)
    val stored = WidgetFeedCodec.encode(feed)
    assertFalse(stored.contains(long))
    assertFalse(stored.contains("\\n") || stored.contains("\\u0000"))
  }

  @Test fun aQuestionWhoseLinkIsNotAChatLinkIsRefused() {
    fun question(link: String) = WidgetFeedCodec.decode(
      org.json.JSONObject().put("v", 2).put("bots", org.json.JSONArray())
        .put("question", org.json.JSONObject().put("botId", "a").put("botName", "A").put("link", link)).toString(),
    )!!.question
    assertEquals("hbots://chat/a/t-1", question("hbots://chat/a/t-1")?.link)
    for (bad in listOf("https://evil.example/x", "hbots://settings", "hbots://chat/a", "hbots://chat/a/t?draft=x", "hbots://chat/a/t/../x", "intent://chat/a/t", "hbots://chat/a/t b")) {
      assertNull(bad, question(bad))
    }
  }

  @Test fun aPartThatIsMissingOrEmptyIsLeftOut() {
    val feed = WidgetFeedCodec.decode("{\"v\":2,\"bots\":[],\"usage\":{\"title\":\"Claude\",\"sessionPct\":null,\"weekPct\":null},\"today\":\"nope\"}")!!
    assertNull(feed.usage)
    assertNull(feed.today)
    assertNull(feed.laptop)
    assertNull(feed.gamingPc)
    assertNull(feed.question)
  }
}
