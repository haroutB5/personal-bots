package expo.modules.hbotsnetwork

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink

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

  /** Calls in flight by the caller's upload id, so JS can cancel one. */
  private val rangeCalls = ConcurrentHashMap<String, Call>()

  private fun openStream(uri: String): InputStream {
    val parsed = Uri.parse(uri)
    val file =
      when (parsed.scheme) {
        "file" -> parsed.path?.let(::File)
        "content" -> null
        else -> File(uri)
      }
    if (file != null && file.isFile) return file.inputStream()
    val resolver = app()?.contentResolver
      ?: throw IllegalStateException("No application context for the upload.")
    return resolver.openInputStream(parsed) ?: throw IllegalStateException("Could not read the upload file.")
  }

  /**
   * One byte range of a file, streamed from disk (never held in memory), with
   * progress reported at most every 150 ms. A cancelled call fails the next
   * write, which ends the loop.
   */
  private inner class RangeBody(
    private val uri: String,
    private val mediaType: MediaType?,
    private val offset: Long,
    private val length: Long,
    private val uploadId: String,
  ) : RequestBody() {
    override fun contentType(): MediaType? = mediaType

    override fun contentLength(): Long = length

    override fun writeTo(sink: BufferedSink) {
      openStream(uri).use { input ->
        var skipped = 0L
        while (skipped < offset) {
          val step = input.skip(offset - skipped)
          if (step <= 0) {
            if (input.read() < 0) throw java.io.EOFException("File shorter than the upload offset.")
            skipped += 1
          } else {
            skipped += step
          }
        }
        val buffer = ByteArray(64 * 1024)
        var sent = 0L
        var lastReport = 0L
        while (sent < length) {
          val read = input.read(buffer, 0, minOf(buffer.size.toLong(), length - sent).toInt())
          if (read < 0) throw java.io.EOFException("File ended before the upload range.")
          sink.write(buffer, 0, read)
          sent += read
          val now = System.nanoTime()
          if (now - lastReport > 150_000_000L || sent == length) {
            lastReport = now
            sendEvent("onUploadProgress", mapOf("uploadId" to uploadId, "sent" to (offset + sent).toDouble()))
          }
        }
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HbotsNetwork")

    Events("onUploadProgress")

    /**
     * POSTs `length` bytes of the file from `offset`. Large videos go up in
     * pieces because the tunnel in front of the laptop refuses bodies over
     * 100 MB. `received` is the server's count of bytes it holds, so a piece
     * at the wrong offset tells the caller where to resume.
     */
    AsyncFunction("uploadRange") {
        url: String,
        uri: String,
        mimeType: String,
        endpointHeader: String,
        offset: Double,
        length: Double,
        uploadId: String,
      ->
      val request =
        Request.Builder()
          .url(url)
          .post(RangeBody(uri, mimeType.toMediaTypeOrNull(), offset.toLong(), length.toLong(), uploadId))
          .build()
      val call = sharedUploadClient().newCall(request)
      rangeCalls[uploadId] = call
      try {
        call.execute().use { response ->
          mapOf(
            "status" to response.code,
            "endpoint" to (response.header(endpointHeader) != null),
            "received" to response.header("x-hbots-upload-received")?.toDoubleOrNull(),
          )
        }
      } catch (error: java.io.IOException) {
        if (call.isCanceled()) mapOf("status" to 0, "endpoint" to false, "cancelled" to true) else throw error
      } finally {
        rangeCalls.remove(uploadId, call)
      }
    }

    /** Synchronous on purpose: it must not wait behind the upload on the module's queue. */
    Function("cancelUpload") { uploadId: String ->
      rangeCalls[uploadId]?.cancel()
      true
    }

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
