package expo.modules.hbotsnotify

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionDeliveryTest {
  /** The longest the receiver may hold the broadcast. The system kills a foreground receiver near 10 s. */
  private val receiverLimitMs = 8_000L

  private class Clock {
    var ms = 0L
  }

  /** A server that never answers: every call uses its whole timeout, then reports a network failure. */
  private class StalledServer(private val clock: Clock) : HttpGateway {
    val timeouts = ArrayList<Long>()
    val bodies = ArrayList<String?>()
    override fun execute(method: String, path: String, jsonBody: String?, timeoutMs: Long): HttpResult {
      timeouts += timeoutMs
      bodies += jsonBody
      clock.ms += timeoutMs
      return HttpResult(null, null)
    }
  }

  private val chat = "hbots://chat/bot-1/thread-1"

  private fun reply(text: String = "On my way", link: String? = chat) =
    ActionRequest(ActionType.REPLY, "n1", link, text, null, "cmd-1")

  private fun answer() = ActionRequest(ActionType.ANSWER, "n1", chat, "Two nights", "Two nights", "cmd-2")

  private class Run(val settled: ActionNotice.Settled, val posted: List<ActionNotice>, val clock: Clock)

  private fun deliver(http: (Clock) -> HttpGateway, request: ActionRequest): Run {
    val clock = Clock()
    val posted = ArrayList<ActionNotice>()
    val settled = ActionDelivery.deliver(http(clock), request, post = { posted += it }, sleep = { clock.ms += it }, now = { clock.ms })
    return Run(settled, posted, clock)
  }

  @Test fun aReplyToAServerThatNeverAnswersEndsWithinTheReceiverLimit() {
    val run = deliver({ StalledServer(it) }, reply())
    assertTrue("took ${run.clock.ms} ms", run.clock.ms <= receiverLimitMs)
  }

  @Test fun anAnswerToAServerThatNeverAnswersEndsWithinTheReceiverLimit() {
    val run = deliver({ StalledServer(it) }, answer())
    assertTrue("took ${run.clock.ms} ms", run.clock.ms <= receiverLimitMs)
  }

  @Test fun noCallIsAllowedToRunPastTheBudget() {
    var server: StalledServer? = null
    val run = deliver({ StalledServer(it).also { s -> server = s } }, reply())
    assertTrue(server!!.timeouts.all { it in 1..ActionRunner.BUDGET_MS })
    assertTrue("took ${run.clock.ms} ms", run.clock.ms <= ActionRunner.BUDGET_MS)
  }

  @Test fun theFinalStateIsTruthfulWhenTheServerNeverAnswers() {
    val run = deliver({ StalledServer(it) }, reply())
    assertEquals(ActionOutcome.Unconfirmed, run.settled.outcome)
    assertEquals(After.NOTICE_OPEN_CHAT, run.settled.presentation.after)
    assertEquals("Could not confirm. Open the chat.", run.settled.presentation.text.substringBefore(" Your reply"))
  }

  @Test fun theNoticeStartsAsSendingAndNeverEndsOnItWithoutASettledState() {
    val run = deliver({ StalledServer(it) }, reply())
    assertEquals(ActionNotice.Sending, run.posted.first())
    assertTrue(run.posted.none { it is ActionNotice.Settled })
    assertTrue(run.settled.text != ActionNotice.Sending.text)
    assertTrue(run.settled.text != ActionNotice.StillSending.text)
  }

  @Test fun theReplyTextIsKeptAsADraftInTheChatItOpens() {
    val run = deliver({ StalledServer(it) }, reply("On my way & more"))
    assertEquals("$chat?draft=On%20my%20way%20%26%20more", run.settled.chatLink)
  }

  @Test fun anAnswerThatCouldNotBeConfirmedOpensTheChatWithoutADraft() {
    val run = deliver({ StalledServer(it) }, answer())
    assertEquals(chat, run.settled.chatLink)
  }

  @Test fun aReplyWithNoChatToOpenKeepsItsRetryInsteadOfLosingTheText() {
    val run = deliver({ StalledServer(it) }, reply(link = null))
    assertEquals(After.RESTORE_WITH_RETRY, run.settled.presentation.after)
  }

  @Test fun everyAttemptCarriesTheSameCommandIdSoTheServerNeverActsTwice() {
    var server: StalledServer? = null
    deliver({ StalledServer(it).also { s -> server = s } }, reply())
    val ids = server!!.bodies.map { JSONObject(it!!).getString("commandId") }.toSet()
    assertEquals(setOf("cmd-1"), ids)
  }

  @Test fun aServerThatKeepsAnsweringInProgressEndsWithinTheLimitAndSaysStillSending() {
    val busy = HttpResult(409, "{\"ok\":false,\"error\":\"InProgress\"}")
    val run = deliver({ FakeHttp(listOf(busy)) }, reply())
    assertTrue("took ${run.clock.ms} ms", run.clock.ms <= receiverLimitMs)
    assertEquals(ActionOutcome.Unconfirmed, run.settled.outcome)
    assertTrue(run.posted.contains(ActionNotice.StillSending))
  }

  @Test fun aSlowButAnsweringServerStillEndsSent() {
    val slow = HttpGateway { _, _, _, _ -> HttpResult(200, "{\"ok\":true}") }
    val run = deliver({ slow }, reply())
    assertEquals(ActionOutcome.Sent, run.settled.outcome)
    assertEquals("Sent", run.settled.text)
    assertEquals(chat, run.settled.chatLink)
  }

  @Test fun aGatewayThatThrowsStillEndsInASettledState() {
    val broken = HttpGateway { _, _, _, _ -> throw IllegalStateException("boom") }
    val run = deliver({ broken }, reply())
    assertEquals(ActionOutcome.Unconfirmed, run.settled.outcome)
  }

  @Test fun fastNetworkFailuresStillEndAsNotSentWithARetry() {
    val run = deliver({ FakeHttp(listOf(HttpResult(null, null))) }, reply())
    assertEquals(ActionOutcome.Transient, run.settled.outcome)
    assertEquals(After.RESTORE_WITH_RETRY, run.settled.presentation.after)
  }
}
