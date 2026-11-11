package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPlannerTest {
  @Test fun showsTheMessageOnTheBotChannel() {
    val plan = NotificationPlanner.plan(payload(), content(), policy())
    assertEquals("bot.bot-1", plan.channelId)
    assertEquals("Juno", plan.title)
    assertEquals("Dinner at 8?", plan.text)
    assertFalse(plan.contentFree)
    assertEquals("hbots://chat/bot-1/t1", plan.deepLink)
    assertEquals("chat.t1", plan.groupKey)
    assertEquals(listOf("Reply to Juno"), plan.actions.map { it.label })
  }

  @Test fun aBotThatHidesPreviewsShowsNoContentButStillReplies() {
    val plan = NotificationPlanner.plan(payload(), content(), policy(hide = true))
    assertTrue(plan.contentFree)
    assertEquals("New message", plan.text)
    assertEquals("Juno", plan.title)
    assertEquals(listOf(InlineAction.REPLY), plan.actions.map { it.kind })
  }

  @Test fun theAppLockHidesEverythingAboutTheBot() {
    val plan = NotificationPlanner.plan(payload(), content(), policy(lock = true))
    assertTrue(plan.contentFree)
    assertEquals("hbots", plan.title)
    assertEquals("New message", plan.text)
    val shown = listOf(plan.title, plan.text, plan.errorLine.orEmpty()) + plan.actions.map { it.label + it.choice.orEmpty() }
    assertFalse(shown.any { it.contains("Dinner") || it.contains("Juno") })
  }

  @Test fun theAppLockLeavesNoButtonsAndTheTapOpensTheChat() {
    val reply = NotificationPlanner.plan(payload(), content(), policy(lock = true))
    assertTrue(reply.actions.isEmpty())
    assertEquals("hbots://chat/bot-1/t1", reply.deepLink)
    val c = content(PushKind.QUESTION, null, question(listOf("Two", "Three")))
    val ask = NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy(lock = true))
    assertTrue(ask.actions.isEmpty())
    assertEquals("hbots://chat/bot-1/t1?request=req-1", ask.deepLink)
    // Without an auth-capable system the lock still wins.
    assertTrue(NotificationPlanner.plan(payload(), content(), policy(lock = true), authActions = false).actions.isEmpty())
  }

  @Test fun beforeAndroid12ReplyAndAnswerOnlyOpenTheChat() {
    val reply = NotificationPlanner.plan(payload(), content(), policy(), authActions = false)
    assertEquals(listOf(InlineAction.OPEN), reply.actions.map { it.kind })
    assertEquals(listOf("Reply to Juno"), reply.actions.map { it.label })
    val c = content(PushKind.QUESTION, null, question(listOf("Two", "Three")))
    val ask = NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy(), authActions = false)
    assertEquals(listOf(InlineAction.OPEN), ask.actions.map { it.kind })
    assertEquals(listOf("Answer"), ask.actions.map { it.label })
    assertTrue(ask.actions.all { it.choice == null })
  }

  @Test fun fromAndroid12TheButtonsStayInline() {
    assertEquals(31, NotificationPlanner.AUTH_ACTION_SDK)
    val c = content(PushKind.QUESTION, null, question(listOf("Two", "Three")))
    assertEquals(listOf("Two", "Three"), NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy(), authActions = true).actions.map { it.label })
  }

  @Test fun twoServerIdsNeverShareASlot() {
    // "Aa" and "BB" have the same String.hashCode(), so a hash would have made them one notification.
    assertEquals("Aa".hashCode(), "BB".hashCode())
    assertTrue(NotificationSender.tagFor("Aa") != NotificationSender.tagFor("BB"))
    assertTrue(NotificationSender.buttonKey("Aa", "a0") != NotificationSender.buttonKey("BB", "a0"))
    assertTrue(NotificationSender.buttonKey("n1", "a0") != NotificationSender.buttonKey("n1", "a1"))
  }

  @Test fun aFailedFetchStillShowsSomething() {
    val plan = NotificationPlanner.plan(payload(), null, policy())
    assertTrue(plan.contentFree)
    assertEquals("New message", plan.text)
    assertEquals("hbots://chat/bot-1/t1", plan.deepLink)
  }

  @Test fun anUnknownBotFailsClosed() {
    val plan = NotificationPlanner.plan(payload(botId = "other"), content(), policy())
    assertTrue(plan.contentFree)
    assertEquals("hbots", plan.title)
    assertEquals("bot.other", plan.channelId)
  }

  @Test fun aMissingPolicyFailsClosed() {
    val plan = NotificationPlanner.plan(payload(), content(), NotifyPolicy.FAIL_CLOSED)
    assertTrue(plan.contentFree)
    assertEquals("hbots", plan.title)
  }

  @Test fun theServersInlineOptionsBecomeButtons() {
    val c = content(PushKind.QUESTION, null, question(listOf("Two", "Three")))
    val plan = NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy())
    assertEquals("How many nights?", plan.text)
    assertEquals(listOf("Two", "Three"), plan.actions.map { it.choice })
    assertTrue(plan.actions.all { it.kind == InlineAction.OPTIONS })
    assertEquals("hbots://chat/bot-1/t1?request=req-1", plan.deepLink)
  }

  @Test fun noInlineOptionsMeansNoButtons() {
    val c = content(PushKind.QUESTION, null, question(null))
    val plan = NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy())
    assertTrue(plan.actions.isEmpty())
    assertEquals("How many nights?", plan.text)
  }

  @Test fun optionsNeverShowWhenLockedOrHidden() {
    val c = content(PushKind.QUESTION, null, question(listOf("Two")))
    assertTrue(NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy(lock = true)).actions.isEmpty())
    assertTrue(NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy(hide = true)).actions.isEmpty())
    assertEquals("Needs your answer", NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy(lock = true)).text)
  }

  @Test fun approvalSecretAndSignInOfferNoActionAndOpenTheChat() {
    for (kind in listOf(PushKind.APPROVAL, PushKind.SECRET, PushKind.SIGN_IN)) {
      val plan = NotificationPlanner.plan(payload(kind), content(kind, "approve me", null), policy())
      assertTrue(plan.actions.isEmpty())
      assertEquals("hbots://chat/bot-1/t1", plan.deepLink)
    }
  }

  @Test fun theTestPushUsesTheAccountChannelAndOpensTheApp() {
    val plan = NotificationPlanner.plan(PushPayload(PushKind.TEST, "n1", "", ""), null, policy())
    assertEquals("account", plan.channelId)
    assertNull(plan.deepLink)
    assertNull(plan.groupKey)
    assertEquals("hbots", plan.title)
  }

  @Test fun aRequestIdWithUnsafeCharactersIsLeftOutOfTheLink() {
    val c = content(PushKind.QUESTION, null, QuestionContent("a&b=c", "Q?", null))
    assertEquals("hbots://chat/bot-1/t1", NotificationPlanner.plan(payload(PushKind.QUESTION), c, policy()).deepLink)
  }

  @Test fun contentIsOnlyFetchedWhenItCanBeShown() {
    assertTrue(PushIngest.wantsContent(policy(), payload()))
    assertFalse(PushIngest.wantsContent(policy(lock = true), payload()))
    assertFalse(PushIngest.wantsContent(policy(hide = true), payload()))
    assertFalse(PushIngest.wantsContent(policy(), payload(botId = "other")))
    assertFalse(PushIngest.wantsContent(NotifyPolicy.FAIL_CLOSED, payload()))
  }
}
