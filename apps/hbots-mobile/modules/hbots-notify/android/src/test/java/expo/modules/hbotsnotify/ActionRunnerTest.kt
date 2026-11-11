package expo.modules.hbotsnotify

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionRunnerTest {
  private val ok = HttpResult(200, "{\"ok\":true}")
  private val down = HttpResult(null, null)
  private val path = ActionRunner.replyPath("n1")
  private val body = ActionRunner.replyBody("cmd-1", "On my way")

  private fun run(vararg answers: HttpResult, sleeps: MutableList<Long> = ArrayList()): Pair<ActionOutcome, FakeHttp> {
    val http = FakeHttp(answers.toList())
    return ActionRunner.run(http, path, body, sleep = { sleeps += it }) to http
  }

  @Test fun sendsOnceOnSuccess() {
    val (outcome, http) = run(ok)
    assertEquals(ActionOutcome.Sent, outcome)
    assertEquals(1, http.calls.size)
    assertEquals("POST", http.calls[0].first)
    assertEquals("/api/personal/notifications/n1/reply", http.calls[0].second)
  }

  @Test fun retriesATransientFailureWithTheSameCommandId() {
    val sleeps = ArrayList<Long>()
    val (outcome, http) = run(down, HttpResult(503, null), ok, sleeps = sleeps)
    assertEquals(ActionOutcome.Sent, outcome)
    assertEquals(3, http.calls.size)
    val ids = http.calls.map { JSONObject(it.third!!).getString("commandId") }.toSet()
    assertEquals(setOf("cmd-1"), ids)
    assertEquals(listOf(1000L, 2000L), sleeps)
  }

  @Test fun givesUpAfterThreeAttemptsAndKeepsTheCommandRetryable() {
    val (outcome, http) = run(down)
    assertEquals(ActionOutcome.Transient, outcome)
    assertEquals(ActionRunner.MAX_ATTEMPTS, http.calls.size)
  }

  @Test fun aFinalAnswerStopsTheLoop() {
    for ((status, expected) in listOf(
      401 to ActionOutcome.SignedOut,
      403 to ActionOutcome.Forbidden,
      404 to ActionOutcome.NotFound,
      422 to ActionOutcome.Refused,
      400 to ActionOutcome.Refused,
    )) {
      val (outcome, http) = run(HttpResult(status, "{\"ok\":false}"))
      assertEquals("status $status", expected, outcome)
      assertEquals("status $status", 1, http.calls.size)
    }
  }

  @Test fun serverErrorsAndRateLimitsAreTransient() {
    for (status in listOf(500, 502, 408, 429)) {
      assertEquals(ActionOutcome.Transient, ActionOutcomes.classify(HttpResult(status, null)))
    }
  }

  @Test fun bodiesCarryTheCommandIdAndTheValue() {
    val reply = JSONObject(ActionRunner.replyBody("c", "Hello"))
    assertEquals("c", reply.getString("commandId"))
    assertEquals("Hello", reply.getString("text"))
    val answer = JSONObject(ActionRunner.answerBody("c", "Two nights"))
    assertEquals("Two nights", answer.getString("choice"))
    assertEquals("/api/personal/notifications/n1/answer", ActionRunner.answerPath("n1"))
  }

  @Test fun textWithQuotesAndNewlinesStaysValidJson() {
    val tricky = "He said \"hi\"\nand left \\ ok"
    assertEquals(tricky, JSONObject(ActionRunner.replyBody("c", tricky)).getString("text"))
  }

  private val stale = HttpResult(409, "{\"ok\":false,\"error\":\"Stale\"}")
  private val busy = HttpResult(409, "{\"ok\":false,\"error\":\"InProgress\"}")

  @Test fun a409IsStaleOnlyWhenTheBodySaysStale() {
    assertEquals(ActionOutcome.Stale, ActionOutcomes.classify(stale))
    assertEquals(ActionOutcome.InProgress, ActionOutcomes.classify(busy))
    assertEquals(ActionOutcome.InProgress, ActionOutcomes.classify(HttpResult(409, null)))
    assertEquals(ActionOutcome.InProgress, ActionOutcomes.classify(HttpResult(409, "<html>")))
  }

  @Test fun staleEndsAtOnce() {
    val (outcome, http) = run(stale)
    assertEquals(ActionOutcome.Stale, outcome)
    assertEquals(1, http.calls.size)
  }

  @Test fun inProgressIsAskedAgainWithTheSameCommandIdAndEndsSent() {
    val sleeps = ArrayList<Long>()
    var waiting = 0
    val http = FakeHttp(listOf(busy, busy, ok))
    val outcome = ActionRunner.run(http, path, body, sleep = { sleeps += it }, onWaiting = { waiting++ })
    assertEquals(ActionOutcome.Sent, outcome)
    assertEquals(3, http.calls.size)
    assertEquals(setOf("cmd-1"), http.calls.map { JSONObject(it.third!!).getString("commandId") }.toSet())
    assertEquals(listOf(1000L, 2000L), sleeps)
    assertEquals(2, waiting)
  }

  @Test fun inProgressThatNeverSettlesEndsUnconfirmed() {
    val sleeps = ArrayList<Long>()
    val http = FakeHttp(listOf(busy))
    val outcome = ActionRunner.run(http, path, body, sleep = { sleeps += it })
    assertEquals(ActionOutcome.Unconfirmed, outcome)
    assertEquals(ActionRunner.MAX_IN_PROGRESS_ATTEMPTS, http.calls.size)
    assertEquals(listOf(1000L, 2000L, 3000L, 4000L), sleeps)
  }

  @Test fun theBudgetStopsTheRetries() {
    var clock = 0L
    val http = FakeHttp(listOf(busy))
    val outcome = ActionRunner.run(http, path, body, sleep = { clock += 20_000 }, now = { clock })
    assertEquals(ActionOutcome.Unconfirmed, outcome)
    assertEquals(2, http.calls.size)
  }

  @Test fun aTimeoutThenInProgressStillEndsWithTheSameId() {
    val http = FakeHttp(listOf(down, busy, ok))
    assertEquals(ActionOutcome.Sent, ActionRunner.run(http, path, body, sleep = {}))
    assertEquals(setOf("cmd-1"), http.calls.map { JSONObject(it.third!!).getString("commandId") }.toSet())
  }
}
