package expo.modules.hbotsnetwork

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Process
import com.facebook.react.modules.network.OkHttpClientProvider
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The React Native fetch and WebSocket modules share one OkHttp client for the
 * whole process. After an airplane-mode flap its pool can hold sockets bound to
 * the old network, so every new request waits on a dead connection until its
 * timeout. Evicting the pool helps; when it does not, the app relaunches itself
 * once the phone reports working internet, which rebuilds the client while the
 * saved session and outbox survive the restart.
 */
class HbotsNetworkModule : Module() {
  private fun app(): Context? =
    appContext.currentActivity?.applicationContext ?: appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("HbotsNetwork")

    AsyncFunction("reset") {
      val client = OkHttpClientProvider.getOkHttpClient()
      client.dispatcher.cancelAll()
      client.connectionPool.evictAll()
      true
    }

    AsyncFunction("canReachNetwork") {
      try {
        val client = OkHttpClient.Builder()
          .connectTimeout(3, TimeUnit.SECONDS)
          .readTimeout(3, TimeUnit.SECONDS)
          .build()
        val request = Request.Builder().url("https://www.cloudflare.com/cdn-cgi/trace").build()
        client.newCall(request).execute().use { it.isSuccessful }
      } catch (_: Exception) {
        false
      }
    }

    Function("isOnline") {
      // A thrown check crosses the bridge as a rejected promise and takes the
      // caller's whole recovery path with it. Without the network-state
      // permission this throws, so answer "unknown" instead.
      try {
        val context = app() ?: return@Function false
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
          ?: return@Function false
        val network = manager.activeNetwork ?: return@Function false
        val capabilities = manager.getNetworkCapabilities(network) ?: return@Function false
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      } catch (_: SecurityException) {
        false
      }
    }

    AsyncFunction("relaunch") {
      val context = app() ?: return@AsyncFunction false
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: return@AsyncFunction false
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      context.startActivity(intent)
      Process.killProcess(Process.myPid())
      true
    }
  }
}
