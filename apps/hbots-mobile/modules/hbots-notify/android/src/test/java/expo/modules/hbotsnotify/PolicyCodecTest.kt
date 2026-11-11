package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyCodecTest {
  @Test fun roundTrips() {
    val original = NotifyPolicy(false, mapOf("a" to BotInfo("Juno", true), "b" to BotInfo("Forge", false)))
    assertEquals(original, PolicyCodec.decode(PolicyCodec.encode(original)))
  }

  @Test fun noRecordOrADamagedOneFailsClosed() {
    assertEquals(NotifyPolicy.FAIL_CLOSED, PolicyCodec.decode(null))
    assertEquals(NotifyPolicy.FAIL_CLOSED, PolicyCodec.decode(""))
    assertEquals(NotifyPolicy.FAIL_CLOSED, PolicyCodec.decode("{oops"))
    assertEquals(NotifyPolicy.FAIL_CLOSED, PolicyCodec.decode("{\"bots\":[]}"))
    assertTrue(NotifyPolicy.FAIL_CLOSED.appLockOn)
  }

  @Test fun jsInputWithoutAHideFlagHidesPreviews() {
    val policy = PolicyCodec.fromJs(false, listOf(mapOf("id" to "a", "name" to "Juno")))
    assertTrue(policy.bots.getValue("a").hidePreviews)
  }

  @Test fun jsInputSkipsBadRowsAndTrimsNames() {
    val policy = PolicyCodec.fromJs(
      false,
      listOf(mapOf("id" to "", "name" to "x"), mapOf("name" to "no id"), mapOf("id" to "a", "name" to "  Juno  ", "hidePreviews" to false)),
    )
    assertEquals(setOf("a"), policy.bots.keys)
    assertEquals("Juno", policy.bots.getValue("a").name)
    assertFalse(policy.bots.getValue("a").hidePreviews)
  }

  @Test fun aBlankNameFallsBackToTheAppName() {
    assertEquals("hbots", PolicyCodec.fromJs(false, listOf(mapOf("id" to "a", "name" to " ", "hidePreviews" to false))).bots.getValue("a").name)
  }

  @Test fun jsInputUsesTheBotIdKeyJsSends() {
    val policy = PolicyCodec.fromJs(false, listOf(mapOf("botId" to "a", "name" to "Juno", "hidePreviews" to false)))
    assertEquals("Juno", policy.bots.getValue("a").name)
  }
}
