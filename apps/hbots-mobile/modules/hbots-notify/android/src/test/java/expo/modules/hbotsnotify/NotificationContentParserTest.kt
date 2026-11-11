package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationContentParserTest {
  private fun json(text: String = "\"Hi\"", question: String = "null", extra: String = "") =
    """{"notificationId":"n1","kind":"chat-reply","botId":"b","threadId":"t","text":$text,"question":$question$extra}"""

  @Test fun readsAMessage() {
    val parsed = NotificationContentParser.parse(json())!!
    assertEquals("Hi", parsed.text)
    assertNull(parsed.question)
  }

  @Test fun hiddenPreviewsComeBackAsNulls() {
    val parsed = NotificationContentParser.parse(json(text = "null"))!!
    assertNull(parsed.text)
    assertNull(parsed.question)
  }

  @Test fun readsAQuestionWithOptions() {
    val q = """{"requestId":"r1","question":"How many nights?","inlineOptions":["Two","Three"]}"""
    val parsed = NotificationContentParser.parse(json(text = "null", question = q))!!
    assertEquals(listOf("Two", "Three"), parsed.question!!.inlineOptions)
    assertEquals("r1", parsed.question!!.requestId)
  }

  @Test fun noInlineOptionsMeansOpenTheApp() {
    val q = """{"requestId":"r1","question":"Pick one","inlineOptions":null}"""
    assertNull(NotificationContentParser.parse(json(text = "null", question = q))!!.question!!.inlineOptions)
  }

  @Test fun moreThanThreeOptionsIsNotAnInlineQuestion() {
    val q = """{"requestId":"r1","question":"Pick","inlineOptions":["a","b","c","d"]}"""
    assertNull(NotificationContentParser.parse(json(text = "null", question = q))!!.question!!.inlineOptions)
  }

  @Test fun anUnknownKindOrBrokenBodyIsRefused() {
    assertNull(NotificationContentParser.parse("""{"notificationId":"n1","kind":"nope"}"""))
    assertNull(NotificationContentParser.parse("not json"))
    assertNull(NotificationContentParser.parse("""{"kind":"chat-reply"}"""))
  }

  @Test fun longTextIsCapped() {
    val parsed = NotificationContentParser.parse(json(text = "\"" + "x".repeat(5000) + "\""))!!
    assertEquals(4000, parsed.text!!.length)
  }
}
