package expo.modules.hbotsnotify

import android.app.NotificationManager
import org.junit.Assert.assertEquals
import org.junit.Test

class ChannelSpecTest {
  @Test fun botChannelsAreHighAndNamedAfterTheBot() {
    val spec = NotifyChannels.bot("b1", "Juno")
    assertEquals("bot.b1", spec.id)
    assertEquals("Juno", spec.name)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, spec.importance)
  }

  @Test fun workingIsLowAndAccountIsHigh() {
    assertEquals(NotificationManager.IMPORTANCE_LOW, NotifyChannels.working.importance)
    assertEquals("working", NotifyChannels.working.id)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, NotifyChannels.account.importance)
    assertEquals("account", NotifyChannels.account.id)
  }

  @Test fun everyKindMapsToAChannelThatTheRegistryCanCreate() {
    for (kind in PushKind.values()) {
      val plan = NotificationPlanner.plan(PushPayload(kind, "n", if (kind.needsChat) "b" else "", if (kind.needsChat) "t" else ""), null, NotifyPolicy.FAIL_CLOSED)
      val known = plan.channelId == "account" || plan.channelId == NotifyChannels.bot("b", "x").id
      assertEquals("kind ${kind.wire}", true, known)
    }
  }
}
