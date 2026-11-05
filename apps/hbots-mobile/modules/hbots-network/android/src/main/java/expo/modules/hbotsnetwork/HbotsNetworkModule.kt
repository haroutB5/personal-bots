package expo.modules.hbotsnetwork

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The React Native fetch and WebSocket modules share one OkHttp client for the
 * whole process. After an airplane-mode flap its pool can hold sockets bound to
 * the old network, so every new request waits on a dead connection until its
 * timeout. Evicting the pool lets the next attempt build a fresh one. The
 * reconnect loop recovers in place; it never restarts the app.
 */
class HbotsNetworkModule : Module() {
  companion object {
    /**
     * The upload client shares the RN pool and dispatcher, so a socket the
     * reconnect loop already dropped cannot be reused, while the chat socket
     * keeps its own. Read and write are bounded: a connection left over from
     * the previous network fails the transfer in 15 s instead of a minute.
     */
    private const val UPLOAD_TIMEOUT_SECONDS = 15L
    private var uploadClient: OkHttpClient? = null

    private fun sharedUploadClient(): OkHttpClient =
      uploadClient
        ?: OkHttpClientProvider.getOkHttpClient()
          .newBuilder()
          .connectTimeout(UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
          .readTimeout(UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
          .writeTimeout(UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
          .build()
          .also { uploadClient = it }
  }

  private fun app(): Context? =
    appContext.currentActivity?.applicationContext ?: appContext.reactContext?.applicationContext

  /**
   * The picker hands us a file URI; a document copy is a file too, so the
   * common path is a plain File body. A content URI is read through the
   * resolver, which keeps a rarely used picker path working.
   */
  private fun requestBody(uri: String, mimeType: String): RequestBody {
    val mediaType = mimeType.toMediaTypeOrNull()
    val parsed = Uri.parse(uri)
    val file =
      when (parsed.scheme) {
        "file" -> parsed.path?.let(::File)
        "content" -> null
        else -> File(uri)
      }
    if (file != null && file.isFile) {
      return file.asRequestBody(mediaType)
    }
    val resolver = app()?.contentResolver
      ?: throw IllegalStateException("No application context for the upload.")
    val bytes =
      resolver.openInputStream(parsed)?.use { it.readBytes() }
        ?: throw IllegalStateException("Could not read the upload file.")
    return bytes.toRequestBody(mediaType)
  }

  override fun definition() = ModuleDefinition {
    Name("HbotsNetwork")

    AsyncFunction("reset") {
      val client = OkHttpClientProvider.getOkHttpClient()
      client.dispatcher.cancelAll()
      client.connectionPool.evictAll()
      true
    }

    AsyncFunction("evictPool") {
      OkHttpClientProvider.getOkHttpClient().connectionPool.evictAll()
      true
    }

    /**
     * POSTs one attachment and reports whether the answer came from our upload
     * route. `endpoint` is the marker header the route sets on every answer; a
     * gateway error has none, so the caller treats it as a network failure.
     */
    AsyncFunction("uploadFile") { url: String, uri: String, mimeType: String, endpointHeader: String ->
      val request =
        Request.Builder()
          .url(url)
          .post(requestBody(uri, mimeType))
          .build()
      sharedUploadClient().newCall(request).execute().use { response ->
        mapOf(
          "status" to response.code,
          "endpoint" to (response.header(endpointHeader) != null),
        )
      }
    }

    AsyncFunction("canReachNetwork") {
      try {
        val client =
          OkHttpClient.Builder()
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
  }
}
