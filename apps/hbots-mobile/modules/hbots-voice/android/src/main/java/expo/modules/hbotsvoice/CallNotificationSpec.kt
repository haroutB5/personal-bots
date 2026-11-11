package expo.modules.hbotsvoice

data class CallNotificationSpec(
  val channelId: String,
  val notificationId: Int,
  val title: String,
  val text: String,
  val hangUpLabel: String,
  val ongoing: Boolean,
  val showsOnLockScreen: Boolean,
)

data class CallChannelSpec(
  val id: String,
  val name: String,
  val description: String,
  val silent: Boolean,
  val importance: Int,
  val showsOnLockScreen: Boolean,
)

object CallNotification {
  const val CHANNEL_ID = "voice_call_v2"
  const val LEGACY_CHANNEL_ID = "voice_call"
  const val NOTIFICATION_ID = 4710
  const val ACTION_HANGUP = "expo.modules.hbotsvoice.HANGUP"
  const val ACTION_START = "expo.modules.hbotsvoice.START"
  const val IMPORTANCE_DEFAULT = 3

  val channel = CallChannelSpec(
    id = CHANNEL_ID,
    name = "Voice calls",
    description = "Shows while a voice call is running",
    silent = true,
    importance = IMPORTANCE_DEFAULT,
    showsOnLockScreen = true,
  )

  val spec = CallNotificationSpec(
    channelId = CHANNEL_ID,
    notificationId = NOTIFICATION_ID,
    title = "Call in progress",
    text = "Tap to return to the call",
    hangUpLabel = "Hang up",
    ongoing = true,
    showsOnLockScreen = true,
  )
}
