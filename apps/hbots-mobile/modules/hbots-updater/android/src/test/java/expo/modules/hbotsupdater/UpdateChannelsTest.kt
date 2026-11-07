package expo.modules.hbotsupdater

import android.app.NotificationManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateChannelsTest {
  @Test
  fun actionChannelHasSoundAndVibration() {
    assertEquals(NotificationManager.IMPORTANCE_DEFAULT, UpdateChannels.action.importance)
    assertFalse(UpdateChannels.action.silent)
    assertTrue(UpdateChannels.action.vibrate)
  }

  @Test
  fun actionChannelUsesANewId() {
    assertNotEquals(UpdateChannels.LEGACY_ID, UpdateChannels.action.id)
    assertNotEquals(UpdateChannels.PREVIOUS_ACTIONS_ID, UpdateChannels.action.id)
    assertEquals("app_updates_actions_v2", UpdateChannels.action.id)
  }

  @Test
  fun receiptChannelStaysSilent() {
    assertEquals(NotificationManager.IMPORTANCE_LOW, UpdateChannels.receipt.importance)
    assertTrue(UpdateChannels.receipt.silent)
    assertFalse(UpdateChannels.receipt.vibrate)
    assertEquals("app_updates", UpdateChannels.receipt.id)
  }

  @Test
  fun everyChannelThatIsNotSilentVibrates() {
    assertTrue(UpdateChannels.all.filter { !it.silent }.all { it.vibrate })
    assertTrue(UpdateChannels.all.filter { it.silent }.none { it.vibrate })
  }
}
