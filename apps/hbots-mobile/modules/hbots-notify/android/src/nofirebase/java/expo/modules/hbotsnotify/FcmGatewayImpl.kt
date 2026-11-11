package expo.modules.hbotsnotify

import android.app.Service
import android.content.Intent
import android.os.IBinder

/** This build has no Firebase config. Nothing here touches a Firebase class. */
object FcmGatewayImpl : FcmGateway {
  override val configured = false
  override fun token(onResult: (Result<String?>) -> Unit) = onResult(Result.success(null))
  override fun deleteToken(onResult: (Result<Unit>) -> Unit) = onResult(Result.success(Unit))
}

/** Keeps the manifest entry from a prebuild that had a config valid when the build has none. It does nothing. */
class HbotsMessagingService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
}
