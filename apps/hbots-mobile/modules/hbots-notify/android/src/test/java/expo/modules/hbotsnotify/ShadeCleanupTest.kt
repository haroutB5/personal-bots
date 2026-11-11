package expo.modules.hbotsnotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShadeCleanupTest {
  private fun policy(lock: Boolean = false, vararg bots: Pair<String, Boolean>) =
    NotifyPolicy(lock, bots.associate { (id, hide) -> id to BotInfo(id, hide) })

  @Test fun openingAChatClearsOnlyThatChatsMessages() {
    val tag = NotificationSender.tagFor("n1")
    assertTrue(ShadeCleanup.belongsToChat(tag, "chat.t1", "t1"))
    assertFalse(ShadeCleanup.belongsToChat(tag, "chat.t2", "t1"))
    assertFalse(ShadeCleanup.belongsToChat(tag, null, "t1"))
    assertFalse(ShadeCleanup.belongsToChat(tag, "chat.", ""))
  }

  @Test fun theWorkingNoticeIsNeverCleared() {
    // It has no tag and no chat group.
    assertFalse(ShadeCleanup.isMessage(null))
    assertFalse(ShadeCleanup.belongsToChat(null, "chat.t1", "t1"))
    assertFalse(ShadeCleanup.belongsToBot(null, NotificationPlanner.botChannelId("b1"), "b1"))
  }

  @Test fun aBotsMessagesAreFoundByTheirChannel() {
    val tag = NotificationSender.tagFor("n1")
    assertTrue(ShadeCleanup.belongsToBot(tag, "bot.b1", "b1"))
    assertFalse(ShadeCleanup.belongsToBot(tag, "bot.b2", "b1"))
    assertFalse(ShadeCleanup.belongsToBot(tag, "account", "b1"))
  }

  @Test fun turningTheLockOnClearsEverything() {
    assertEquals(ShadeCleanup.Scope.Everything, ShadeCleanup.scopeAfter(policy(false, "b1" to false), policy(true, "b1" to false)))
  }

  @Test fun aLockThatWasAlreadyOnOrIsTurnedOffClearsNothing() {
    assertEquals(ShadeCleanup.Scope.Nothing, ShadeCleanup.scopeAfter(policy(true, "b1" to false), policy(true, "b1" to false)))
    assertEquals(ShadeCleanup.Scope.Nothing, ShadeCleanup.scopeAfter(policy(true, "b1" to false), policy(false, "b1" to false)))
    assertEquals(ShadeCleanup.Scope.Nothing, ShadeCleanup.scopeAfter(NotifyPolicy.FAIL_CLOSED, policy(true)))
  }

  @Test fun switchingHidePreviewsOnClearsThatBotOnly() {
    val before = policy(false, "b1" to false, "b2" to false, "b3" to true)
    val after = policy(false, "b1" to true, "b2" to false, "b3" to true)
    assertEquals(ShadeCleanup.Scope.Bots(setOf("b1")), ShadeCleanup.scopeAfter(before, after))
  }

  @Test fun switchingItOffOrAddingABotClearsNothing() {
    assertEquals(ShadeCleanup.Scope.Nothing, ShadeCleanup.scopeAfter(policy(false, "b1" to true), policy(false, "b1" to false)))
    assertEquals(ShadeCleanup.Scope.Nothing, ShadeCleanup.scopeAfter(policy(false), policy(false, "new" to true)))
  }
}
