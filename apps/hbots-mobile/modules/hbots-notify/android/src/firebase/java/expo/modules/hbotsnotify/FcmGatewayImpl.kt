package expo.modules.hbotsnotify

import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

object FcmGatewayImpl : FcmGateway {
  override val configured = true

  override fun token(onResult: (Result<String?>) -> Unit) {
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      onResult(
        if (task.isSuccessful) Result.success(task.result)
        else Result.failure(task.exception ?: IllegalStateException("FCM token failed")),
      )
    }
  }

  override fun deleteToken(onResult: (Result<Unit>) -> Unit) {
    FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { task ->
      onResult(
        if (task.isSuccessful) Result.success(Unit)
        else Result.failure(task.exception ?: IllegalStateException("FCM delete failed")),
      )
    }
  }
}

class HbotsMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    PushIngest.handle(applicationContext, message.data)
  }

  override fun onNewToken(token: String) {
    TokenEvents.listener?.invoke(token)
  }
}
