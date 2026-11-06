package expo.modules.hbotsupdater

import android.app.NotificationManager

/**
 * Channel data without framework calls, so the importance policy is testable.
 * Android fixes a channel's importance when it is created, so a notification
 * that needs attention gets a new id rather than an edit to the old channel.
 */
internal data class UpdateChannelSpec(
  val id: String,
  val name: String,
  val description: String,
  val importance: Int,
  val silent: Boolean,
)

internal object UpdateChannels {
  /** The silent channel shipped through 1.66.118; kept for update receipts. */
  const val LEGACY_ID = "app_updates"
  const val ACTIONS_ID = "app_updates_actions"

  val receipt = UpdateChannelSpec(
    id = LEGACY_ID,
    name = "App updates",
    description = "Silent hbots updates",
    importance = NotificationManager.IMPORTANCE_LOW,
    silent = true,
  )

  /** Needs permission and needs a tap to finish: a heads-up, not shade-only. */
  val action = UpdateChannelSpec(
    id = ACTIONS_ID,
    name = "App update actions",
    description = "Updates that need you to allow or finish them",
    importance = NotificationManager.IMPORTANCE_DEFAULT,
    silent = false,
  )

  val all: List<UpdateChannelSpec> = listOf(receipt, action)
}
