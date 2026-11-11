package expo.modules.hbotsvoice

data class CallNotificationSpec(
  val channelId: String,
  val notificationId: Int,
  val title: String,
  val text: String,
  val publicTitle: String,
  val publicText: String,
  val hangUpLabel: String,
  val ongoing: Boolean,
)

data class CallChannelSpec(val id: String, val name: String, val description: String, val silent: Boolean)

object CallNotification {
  const val CHANNEL_ID = "voice_call"
  const val NOTIFICATION_ID = 4710
  const val ACTION_HANGUP = "expo.modules.hbotsvoice.HANGUP"
  const val ACTION_START = "expo.modules.hbotsvoice.START"
  const val EXTRA_BOT_NAME = "botName"

  val channel = CallChannelSpec(CHANNEL_ID, "Voice calls", "Shows while a voice call is running", silent = true)

  fun spec(botName: String): CallNotificationSpec = CallNotificationSpec(
    channelId = CHANNEL_ID,
    notificationId = NOTIFICATION_ID,
    title = "Call with ${botName.ifBlank { "your bot" }}",
    text = "Tap to return to the call",
    publicTitle = "hbots",
    publicText = "Call in progress",
    hangUpLabel = "Hang up",
    ongoing = true,
  )
}
