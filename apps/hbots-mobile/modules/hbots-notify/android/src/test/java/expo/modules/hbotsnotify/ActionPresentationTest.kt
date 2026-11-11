package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionPresentationTest {
  private fun of(outcome: ActionOutcome, type: ActionType = ActionType.ANSWER, choice: String? = "Two") =
    ActionPresentations.of(outcome, type, choice)

  @Test fun aSentAnswerNamesTheChoiceAndGoesAway() {
    val p = of(ActionOutcome.Sent)
    assertEquals(After.NOTICE_THEN_CANCEL, p.after)
    assertEquals("Answered: Two", p.text)
  }

  @Test fun aSentReplyNeverEchoesTheTypedText() {
    val p = of(ActionOutcome.Sent, ActionType.REPLY, null)
    assertEquals("Sent", p.text)
  }

  @Test fun aStale409DismissesTheQuestionWithoutSayingWhere() {
    assertEquals(After.NOTICE_THEN_CANCEL, of(ActionOutcome.Stale).after)
    assertEquals("Already answered", of(ActionOutcome.Stale).text)
    assertEquals(After.NOTICE_THEN_CANCEL, of(ActionOutcome.Stale, ActionType.REPLY).after)
    assertFalse(of(ActionOutcome.Stale).text.contains("laptop"))
  }

  @Test fun anUnsettledCommandKeepsTheNotificationAndPointsAtTheChat() {
    assertEquals(After.NOTICE_OPEN_CHAT, of(ActionOutcome.InProgress).after)
    assertEquals("Still sending", of(ActionOutcome.InProgress).text)
    assertEquals(After.NOTICE_OPEN_CHAT, of(ActionOutcome.Unconfirmed).after)
    assertEquals("Could not confirm. Open the chat.", of(ActionOutcome.Unconfirmed).text)
  }

  @Test fun a422KeepsTheQuestionAndShowsAnError() {
    val p = of(ActionOutcome.Refused)
    assertEquals(After.RESTORE_WITH_ERROR, p.after)
    assertTrue(p.text.contains("Open hbots"))
  }

  @Test fun a404GoesAway() {
    assertEquals(After.NOTICE_THEN_CANCEL, of(ActionOutcome.NotFound).after)
  }

  @Test fun a401And403LeaveALineThatOpensTheApp() {
    assertEquals(After.NOTICE_OPEN_APP, of(ActionOutcome.SignedOut).after)
    assertEquals(After.NOTICE_OPEN_APP, of(ActionOutcome.Forbidden).after)
  }

  @Test fun aTransientFailureOffersRetry() {
    assertEquals(After.RESTORE_WITH_RETRY, of(ActionOutcome.Transient).after)
  }

  @Test fun noPresentationEchoesAChoiceExceptASentAnswer() {
    for (outcome in listOf(ActionOutcome.Stale, ActionOutcome.InProgress, ActionOutcome.Unconfirmed, ActionOutcome.Refused, ActionOutcome.NotFound, ActionOutcome.SignedOut, ActionOutcome.Forbidden, ActionOutcome.Transient)) {
      assertFalse(of(outcome, ActionType.ANSWER, "SECRET-LABEL").text.contains("SECRET-LABEL"))
    }
  }
}
