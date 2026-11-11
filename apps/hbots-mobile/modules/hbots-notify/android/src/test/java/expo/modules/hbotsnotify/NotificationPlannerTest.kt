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
    assertEquals(listOf("Reply"), plan.actions.map { it.label })
    val shown = listOf(plan.title, plan.text, plan.errorLine.orEmpty()) + plan.actions.map { it.label + it.choice.orEmpty() }
    assertFalse(shown.any { it.contains("Dinner") || it.contains("Juno") })
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
