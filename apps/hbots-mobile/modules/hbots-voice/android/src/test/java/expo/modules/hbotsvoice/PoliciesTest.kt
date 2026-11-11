package expo.modules.hbotsvoice

import android.media.AudioDeviceInfo
import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioFocusPolicyTest {
  @Test
  fun aPermanentLossEndsTheCall() {
    assertEquals(CallEvent.Stop(EndReason.FOCUS_LOST), AudioFocusPolicy.eventFor(AudioManager.AUDIOFOCUS_LOSS))
  }

  @Test
  fun aTransientLossHoldsAndGainResumes() {
    assertEquals(CallEvent.FocusLostTransient, AudioFocusPolicy.eventFor(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
    assertEquals(CallEvent.FocusRegained, AudioFocusPolicy.eventFor(AudioManager.AUDIOFOCUS_GAIN))
  }

  @Test
  fun aDuckRequestAndUnknownCodesAreIgnored() {
    assertNull(AudioFocusPolicy.eventFor(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
    assertNull(AudioFocusPolicy.eventFor(99))
  }

  @Test
  fun aFocusLossEndsALiveCallThroughTheRuntime() {
    val ended = mutableListOf<EndReason>()
    val runtime = CallRuntime(object : CallEffects {
      override fun startService(botName: String) {}
      override fun stopService() {}
      override fun holdAudio() {}
      override fun resumeAudio() {}
      override fun writeMarker() {}
      override fun clearMarker() {}
      override fun ended(reason: EndReason) { ended.add(reason) }
    })
    runtime.dispatch(CallEvent.StartRequested("CTO", true, true, true))
    runtime.dispatch(CallEvent.ServiceStarted)
    runtime.dispatch(AudioFocusPolicy.eventFor(AudioManager.AUDIOFOCUS_LOSS)!!)
    assertEquals(listOf(EndReason.FOCUS_LOST), ended)
  }
}

class RoutePolicyTest {
  @Test
  fun aWiredHeadsetBeatsBluetoothAndTheSpeaker() {
    assertEquals(Route.WIRED, RoutePolicy.choose(listOf(DeviceKind.SPEAKER, DeviceKind.BLUETOOTH, DeviceKind.WIRED)))
  }

  @Test
  fun bluetoothBeatsTheSpeaker() {
    assertEquals(Route.BLUETOOTH, RoutePolicy.choose(listOf(DeviceKind.SPEAKER, DeviceKind.BLUETOOTH)))
  }

  @Test
  fun withNoHeadsetTheCallUsesTheSpeakerLikeTheWeb() {
    assertEquals(Route.SPEAKER, RoutePolicy.choose(listOf(DeviceKind.SPEAKER, DeviceKind.OTHER)))
    assertEquals(Route.SPEAKER, RoutePolicy.choose(emptyList()))
  }

  @Test
  fun androidDeviceTypesMapToKinds() {
    assertEquals(DeviceKind.WIRED, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_WIRED_HEADSET))
    assertEquals(DeviceKind.WIRED, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_WIRED_HEADPHONES))
    assertEquals(DeviceKind.WIRED, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_USB_HEADSET))
    assertEquals(DeviceKind.BLUETOOTH, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO))
    assertEquals(DeviceKind.BLUETOOTH, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_BLE_HEADSET))
    assertEquals(DeviceKind.SPEAKER, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER))
    assertEquals(DeviceKind.OTHER, RoutePolicy.kindOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE))
  }
}

class CallNotificationTest {
  @Test
  fun theOldLowImportanceChannelIsRetiredAndCannotBeReused() {
    assertEquals("voice_call", CallNotification.LEGACY_CHANNEL_ID)
    assertTrue(CallNotification.CHANNEL_ID != CallNotification.LEGACY_CHANNEL_ID)
  }

  @Test
  fun theCallChannelDoesNotCollideWithTheNotifyChannels() {
    assertTrue(CallNotification.CHANNEL_ID !in listOf("working", "account") && !CallNotification.CHANNEL_ID.startsWith("bot."))
  }
}
