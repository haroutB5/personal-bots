package expo.modules.hbotsnotify

import android.content.Context
import android.util.Log
import expo.modules.hbotsupdater.DpopKeySource
import expo.modules.hbotsupdater.DpopProof
import expo.modules.hbotsupdater.SecureStoreSource
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Authenticated calls to the paired server from native code. It reads the session the JS side
 * stored (through the same Keystore key) and signs with the same DPoP key. The token lives for
 * one call and goes nowhere else: not a log, not a preference, not an intent extra.
 */
class ApiGateway(private val context: Context) : HttpGateway {
  private data class Session(val base: String, val token: String, val dpop: Boolean)

  private fun session(): Session? = runCatching {
    val raw = SecureStoreSource.readString(context, SESSION_KEY) ?: return null
    val json = JSONObject(raw)
    val base = json.optString("httpBaseUrl").trimEnd('/')
    val token = json.optString("accessToken")
    if (!base.startsWith("https://") || token.isBlank()) return null
    Session(base, token, json.optString("authMethod") == "dpop")
  }.getOrNull()

  override fun execute(method: String, path: String, jsonBody: String?): HttpResult {
    val session = session() ?: return HttpResult(401, null)
    val url = session.base + path
    val builder = Request.Builder().url(url).header("Accept", "application/json")
    if (session.dpop) {
      val key = DpopKeySource.read(context) ?: return HttpResult(401, null)
      val proof = DpopProof.create(key, method, url, session.token) ?: return HttpResult(null, null)
      builder.header("Authorization", "DPoP ${session.token}").header("DPoP", proof)
    } else {
      builder.header("Authorization", "Bearer ${session.token}")
    }
    if (method == "POST") builder.post((jsonBody ?: "{}").toRequestBody(JSON)) else builder.get()
    val client = if (method == "GET") fetchClient else postClient
    return try {
      client.newCall(builder.build()).execute().use { response ->
        HttpResult(response.code, readCapped(response))
      }
    } catch (error: Throwable) {
      Log.i(TAG, "request failed ${error.javaClass.simpleName}")
      HttpResult(null, null)
    }
  }

  private fun readCapped(response: okhttp3.Response): String? {
    if (response.code !in 200..299) return null
    val body = response.body ?: return null
    val source = body.source()
    source.request(MAX_BODY_BYTES + 1)
    if (source.buffer.size > MAX_BODY_BYTES) return null
    return source.buffer.readUtf8()
  }

  companion object {
    private const val TAG = "HbotsNotify"
    private const val SESSION_KEY = "hbots.session.v1"
    private const val MAX_BODY_BYTES = 64L * 1024
    private val JSON = "application/json".toMediaType()

    private val base by lazy {
      OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()
    }
    /** The brief's budget for a content fetch is 8 s; after it the content-free version shows. */
    private val fetchClient by lazy { base.newBuilder().callTimeout(8, TimeUnit.SECONDS).build() }
    private val postClient by lazy { base.newBuilder().callTimeout(10, TimeUnit.SECONDS).build() }
  }
}
