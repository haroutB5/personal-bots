package expo.modules.hbotsupdater

import android.app.NotificationManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateChannelsTest {
  @Test
  fun actionChannelIsNotSilent() {
    assertEquals(NotificationManager.IMPORTANCE_DEFAULT, UpdateChannels.action.importance)
    assertFalse(UpdateChannels.action.silent)
  }

  @Test
  fun actionChannelUsesANewId() {
    assertNotEquals(UpdateChannels.LEGACY_ID, UpdateChannels.action.id)
    assertEquals("app_updates_actions", UpdateChannels.action.id)
  }

  @Test
  fun receiptChannelStaysSilent() {
    assertEquals(NotificationManager.IMPORTANCE_LOW, UpdateChannels.receipt.importance)
    assertTrue(UpdateChannels.receipt.silent)
    assertEquals("app_updates", UpdateChannels.receipt.id)
  }
}
