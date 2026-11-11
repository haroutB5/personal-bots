package expo.modules.hbotsnotify

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JS face of phone notifications. It never touches Firebase when the build has none:
 * `FcmGatewayImpl` is then a stub that answers "no token".
 */
class HbotsNotifyModule : Module() {
  private fun app(): Context =
    appContext.reactContext?.applicationContext ?: throw IllegalStateException("no context")

  private fun launchSettings(intent: Intent) {
    val context = app()
    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  override fun definition() = ModuleDefinition {
    Name("HbotsNotify")
    Events("tokenRefresh")

    OnCreate { TokenEvents.listener = { token -> sendEvent("tokenRefresh", mapOf("token" to token)) } }
    OnDestroy { TokenEvents.listener = null }

    /** True only when Firebase classes are compiled into this build. */
    Function("isFcmConfigured") { FcmGatewayImpl.configured }

    AsyncFunction("fcmToken") { promise: Promise ->
      if (!FcmGatewayImpl.configured) {
        promise.resolve(null)
        return@AsyncFunction
      }
      FcmGatewayImpl.token { result ->
        result.fold({ promise.resolve(it) }, { promise.reject("ERR_FCM_TOKEN", it.message ?: "FCM token failed", it) })
      }
    }

    AsyncFunction("deleteFcmToken") { promise: Promise ->
      if (!FcmGatewayImpl.configured) {
        promise.resolve(null)
        return@AsyncFunction
      }
      FcmGatewayImpl.deleteToken { result ->
        result.fold({ promise.resolve(null) }, { promise.reject("ERR_FCM_DELETE", it.message ?: "FCM delete failed", it) })
      }
    }

    /** The lock flag and the bot list the push service needs while JS is not running. */
    Function("syncPolicy") { appLockOn: Boolean, bots: List<Map<String, Any?>> ->
      val policy = PolicyCodec.fromJs(appLockOn, bots)
      // Notices already in the shade were drawn under the old policy; take out the ones the new one forbids.
      val leftBehind = ShadeCleanup.scopeAfter(PolicyStore.read(app()), policy)
      PolicyStore.write(app(), policy)
      ShadeCleanup.cancelScope(app(), leftBehind)
      NotifyChannels.syncBots(app(), policy.bots)
      if (BuildConfig.FCM_CONFIGURED) NotifyChannels.ensureBots(app(), policy.bots)
    }

    Function("notificationsEnabled") { NotificationManagerCompat.from(app()).areNotificationsEnabled() }

    Function("openNotificationSettings") {
      launchSettings(
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, app().packageName),
      )
    }

    Function("openChannelSettings") { channelId: String ->
      launchSettings(
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, app().packageName)
          .putExtra(Settings.EXTRA_CHANNEL_ID, channelId),
      )
    }

    /** The chat was opened: its notifications are read, so they leave the shade. */
    Function("cancelForChat") { threadId: String -> ShadeCleanup.cancelChat(app(), threadId) }

    Function("channelStates") { NotifyChannels.states(app()) }

    /** The bots that are running now. Native throttles to one change per 15 s and expires after 45 s. */
    Function("setWorking") { bots: List<Map<String, Any?>> ->
      WorkingController.update(app(), WorkingPlanner.parse(bots))
    }

    Function("clearWorking") { WorkingController.clear(app()) }

    /** Sign-out and revoke: nothing of the old session stays on screen or on disk. */
    Function("wipe") {
      val context = app()
      WorkingController.reset(context)
      NotificationSender.cancelAll(context)
      NotifyChannels.deleteAll(context)
      PolicyStore.clear(context)
      PendingStore.clearAll()
    }
  }
}
