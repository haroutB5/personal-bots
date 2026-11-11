package expo.modules.hbotsvoice

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BuiltCallNotificationTest {
  private val context: Context = RuntimeEnvironment.getApplication()
  private val notification: Notification = VoiceCallService.buildNotification(context)

  @Test
  fun theNotificationIsAnOngoingCallThatShowsOnTheLockScreen() {
    assertEquals(Notification.CATEGORY_CALL, notification.category)
    assertEquals(Notification.VISIBILITY_PUBLIC, notification.visibility)
    assertEquals(CallNotification.CHANNEL_ID, notification.channelId)
    assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
  }

  @Test
  fun theNotificationUsesTheOngoingCallStyle() {
    val extras = notification.extras
    assertEquals("android.app.Notification\$CallStyle", extras.getString(Notification.EXTRA_TEMPLATE))
    assertEquals(Notification.CallStyle.CALL_TYPE_ONGOING, extras.getInt(Notification.EXTRA_CALL_TYPE))
  }

  @Test
  fun theLockScreenReadsCallInProgressAndNamesNoBotAndNoChat() {
    assertEquals("Call in progress", notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
    assertEquals("Tap to return to the call", notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
  }

  @Test
  fun hangUpIsTheOnlyActionAndItReachesTheCallService() {
    val action = notification.actions.single()
    val saved = shadowOf(action.actionIntent).savedIntent
    assertTrue(shadowOf(action.actionIntent).isService)
    assertEquals(CallNotification.ACTION_HANGUP, saved.action)
    assertEquals(VoiceCallService::class.java.name, saved.component?.className)
    assertTrue(PendingIntent.FLAG_IMMUTABLE and shadowOf(action.actionIntent).flags != 0)
  }

  @Test
  fun theCallChannelIsDefaultImportanceSilentAndPublicAndTheOldChannelIsGone() {
    val manager = context.getSystemService(NotificationManager::class.java)
    val channel = manager.getNotificationChannel(CallNotification.CHANNEL_ID)
    assertNotNull(channel)
    assertEquals(NotificationManager.IMPORTANCE_DEFAULT, channel.importance)
    assertEquals(Notification.VISIBILITY_PUBLIC, channel.lockscreenVisibility)
    assertNull(channel.sound)
    assertNull(manager.getNotificationChannel(CallNotification.LEGACY_CHANNEL_ID))
  }
}
