package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushPayloadParserTest {
  private fun accepted(map: Map<String, String?>) = (PushPayloadParser.parse(map) as PayloadResult.Accepted).payload
  private fun rejected(map: Map<String, String?>) = (PushPayloadParser.parse(map) as PayloadResult.Rejected).reason

  @Test fun acceptsTheServersIdsOnlyMessage() {
    val parsed = accepted(data())
    assertEquals(PushKind.CHAT_REPLY, parsed.kind)
    assertEquals("n1", parsed.notificationId)
    assertEquals("bot-1", parsed.botId)
    assertEquals("t1", parsed.threadId)
  }

  @Test fun everyServerKindHasARow() {
    val wire = listOf("question", "approval", "sign-in", "secret", "chat-reply", "failure", "task", "test")
    assertEquals(wire.sorted(), PushKind.values().map { it.wire }.sorted())
    wire.forEach { assertTrue(PushPayloadParser.parse(data(kind = it)) is PayloadResult.Accepted) }
  }

  @Test fun versionIsTheString1() {
    assertEquals("unsupported version", rejected(data(v = "2")))
    assertEquals("unsupported version", rejected(data(v = null)))
    assertEquals("unsupported version", rejected(data(v = "")))
  }

  @Test fun unknownKindIsDropped() {
    assertEquals("unknown kind", rejected(data(kind = "wipe-phone")))
    assertEquals("unknown kind", rejected(data(kind = null)))
  }

  @Test fun idsWithPathOrQueryCharactersAreDropped() {
    assertEquals("bad notification id", rejected(data(notificationId = "a/b")))
    assertEquals("bad notification id", rejected(data(notificationId = "")))
    assertEquals("bad chat id", rejected(data(botId = "x?y")))
    assertEquals("bad chat id", rejected(data(threadId = "t 1")))
    assertEquals("bad chat id", rejected(data(botId = "")))
    assertEquals("bad notification id", rejected(data(notificationId = "n".repeat(257))))
  }

  @Test fun aTestPushNeedsNoChat() {
    val parsed = accepted(data(kind = "test", botId = "", threadId = ""))
    assertEquals(PushKind.TEST, parsed.kind)
    assertEquals("bad chat id", rejected(data(kind = "test", botId = "a/b", threadId = "")))
  }

  @Test fun extraFieldsAreIgnored() {
    assertEquals("n1", accepted(data() + ("title" to "secret text")).notificationId)
  }
}
