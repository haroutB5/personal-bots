package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentFetcherTest {
  private val good = """{"notificationId":"n1","kind":"chat-reply","botId":"bot-1","threadId":"t1","text":"Hi","question":null}"""

  @Test fun readsTheContentWithAGetToTheContentPath() {
    val http = FakeHttp(listOf(HttpResult(200, good)))
    val result = ContentFetcher.fetch(http, payload())
    assertEquals("Hi", (result as FetchOutcome.Found).content.text)
    assertEquals("GET" to "/api/personal/notifications/n1/content", http.calls[0].first to http.calls[0].second)
  }

  @Test fun anythingButACleanOkIsUnavailable() {
    for (answer in listOf(HttpResult(401, null), HttpResult(404, null), HttpResult(500, null), HttpResult(null, null), HttpResult(200, "junk"), HttpResult(200, null))) {
      assertTrue(ContentFetcher.fetch(FakeHttp(listOf(answer)), payload()) is FetchOutcome.Unavailable)
    }
  }

  @Test fun aContentBodyForAnotherNotificationIsRefused() {
    val other = good.replace("\"n1\"", "\"n2\"")
    assertTrue(ContentFetcher.fetch(FakeHttp(listOf(HttpResult(200, other))), payload()) is FetchOutcome.Unavailable)
  }

  @Test fun aBodyForAnotherBotChatOrKindIsRefused() {
    for (swap in listOf("\"bot-1\"" to "\"bot-9\"", "\"t1\"" to "\"t9\"", "\"chat-reply\"" to "\"question\"")) {
      val forged = good.replace(swap.first, swap.second)
      assertTrue(swap.toString(), ContentFetcher.fetch(FakeHttp(listOf(HttpResult(200, forged))), payload()) is FetchOutcome.Unavailable)
    }
  }

  @Test fun theIdIsEncodedIntoTheRequestPath() {
    assertEquals("/api/personal/notifications/a%3Ab%2Fc/content", ContentFetcher.contentPath("a:b/c"))
    assertEquals("/api/personal/notifications/a%3Ab%2Fc/reply", ActionRunner.replyPath("a:b/c"))
    assertEquals("/api/personal/notifications/a%3Ab%2Fc/answer", ActionRunner.answerPath("a:b/c"))
    assertEquals("/api/personal/notifications/n.1_x-y/content", ContentFetcher.contentPath("n.1_x-y"))
    assertEquals("%C3%A9%20.", PathSegment.encode("\u00e9 ."))
  }
}
