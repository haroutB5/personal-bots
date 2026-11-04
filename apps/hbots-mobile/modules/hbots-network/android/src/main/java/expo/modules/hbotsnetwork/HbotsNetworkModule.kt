package expo.modules.hbotsnetwork

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.provider.OpenableColumns
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
 * timeout. Evicting the pool lets the next attempt build a fresh one. The
 * reconnect loop recovers in place; it never restarts the app.
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

    AsyncFunction("displayName") { uri: String ->
      val context = app() ?: return@AsyncFunction null
      try {
        val parsed = Uri.parse(uri)
        if (parsed.scheme == "content") {
          context.contentResolver
            .query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
              if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return@use cursor.getString(index)
              }
              null
            }
            ?.let { return@AsyncFunction it }
        }
        parsed.lastPathSegment
      } catch (_: Exception) {
        null
      }
    }
  }
}
