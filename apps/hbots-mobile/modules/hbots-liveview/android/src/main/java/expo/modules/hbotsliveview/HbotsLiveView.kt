package expo.modules.hbotsliveview

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * A native live view of the bots' shared browser or the owner's desktop.
 *
 * Kotlin owns the socket, the JPEG decode and the drawing. JavaScript sends
 * only input messages through `send` and never sees frame bytes. Exactly one
 * bitmap is held in memory while the view is attached; a new frame replaces
 * and recycles the previous one. Nothing is ever written to disk, a cache or
 * shared preferences.
 */
class HbotsLiveView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val frameView = LiveFrameView(context)
  private var socket: WebSocket? = null
  private var opened = false
  private var frameAcks = false
  private var generation = 0
  private var modeValue = "browser"

  private val onLiveOpen by EventDispatcher()
  private val onFrame by EventDispatcher()
  private val onRejected by EventDispatcher()
  private val onHidden by EventDispatcher()
  private val onFocusChanged by EventDispatcher()
  private val onClosed by EventDispatcher()
  private val onViewState by EventDispatcher()
  private val onControl by EventDispatcher()
  private val onInputRefused by EventDispatcher()
  private val onScrollEndWanted by EventDispatcher()

  var sourceUrl: String = ""
    set(value) {
      if (field == value) return
      field = value
      restart()
    }

  var mode: String = "browser"
    set(value) {
      if (field == value) return
      field = value
      modeValue = value
      restart()
    }

  var paused: Boolean = false
    set(value) {
      if (field == value) return
      field = value
      if (value) closeSocket() else restart()
    }

  var attemptKey: Int = 0
    set(value) {
      if (field == value) return
      field = value
      restart()
    }

  var interactive: Boolean = false
    set(value) {
      field = value
      frameView.isInteractive = value
    }

  init {
    addView(
      frameView,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    restart()
  }

  override fun onDetachedFromWindow() {
    closeSocket()
    frameView.clear()
    super.onDetachedFromWindow()
  }

  /** Sends one JSON input message on the open socket; false when it is not open. */
  fun send(message: String): Boolean = socket?.send(message) ?: false

  private fun restart() {
    closeSocket()
    if (sourceUrl.isEmpty() || paused || !isAttachedToWindow) return
    val attempt = ++generation
    frameAcks = false
    opened = false
    val request = Request.Builder().url(sourceUrl).build()
    socket =
      client.newWebSocket(
        request,
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) {
            if (attempt != generation) return
            opened = true
            post { if (attempt == generation) onLiveOpen(emptyMap()) }
          }

          override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (attempt != generation) return
            val data = bytes.toByteArray()
            val meta = LiveFrameHeader.parse(data) ?: return
            val bitmap =
              BitmapFactory.decodeByteArray(
                data,
                LiveFrameHeader.BYTES,
                data.size - LiveFrameHeader.BYTES,
              ) ?: return
            post {
              if (attempt != generation) {
                bitmap.recycle()
                return@post
              }
              frameView.setFrame(bitmap, meta)
              ackFrame(webSocket, attempt)
              onFrame(
                mapOf(
                  "width" to meta.width,
                  "height" to meta.height,
                  "scale" to meta.deviceScaleFactor,
                ),
              )
            }
          }

          override fun onMessage(webSocket: WebSocket, text: String) {
            if (attempt != generation) return
            dispatch(text)
          }

          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
          }

          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            finish(attempt)
          }

          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            finish(attempt)
          }
        },
      )
  }

  private fun finish(attempt: Int) {
    if (attempt != generation) return
    generation += 1
    socket = null
    val wasOpen = opened
    opened = false
    post {
      frameView.clear()
      onClosed(mapOf("opened" to wasOpen))
    }
  }

  private fun closeSocket() {
    generation += 1
    socket?.close(1000, null)
    socket = null
    opened = false
    frameAcks = false
  }

  private fun ackFrame(webSocket: WebSocket, attempt: Int) {
    if (attempt != generation) return
    if (modeValue == "desktop") {
      webSocket.send(LiveMessages.desktopAck())
    } else if (frameAcks) {
      webSocket.send(LiveMessages.browserFrameAck())
    }
  }

  private fun dispatch(text: String) {
    val json = try {
      JSONObject(text)
    } catch (_: Throwable) {
      return
    }
    when (json.optString("_tag")) {
      "FrameAcks" -> frameAcks = true
      "InputRejected" ->
        post { onRejected(mapOf("reason" to json.optString("reason"))) }
      "FramesHidden" ->
        post { onHidden(mapOf("reason" to json.optString("reason"))) }
      "ScrollEndWanted" ->
        post { onScrollEndWanted(emptyMap<String, Any>()) }
      "FocusChanged" -> {
        val payload = mutableMapOf<String, Any>("editable" to json.optBoolean("editable"))
        if (json.has("field")) payload["field"] = json.optString("field")
        if (json.has("seq")) payload["seq"] = json.optInt("seq")
        post { onFocusChanged(payload) }
      }
      "ViewState" -> {
        val payload = mutableMapOf<String, Any>("state" to json.optString("state"))
        if (json.has("detail")) payload["detail"] = json.optString("detail")
        post { onViewState(payload) }
      }
      "Control" -> {
        val payload = mutableMapOf<String, Any>("on" to json.optBoolean("on"))
        if (json.has("detail")) payload["detail"] = json.optString("detail")
        post { onControl(payload) }
      }
      "InputRefused" ->
        post { onInputRefused(mapOf("detail" to json.optString("detail"))) }
      else -> Unit
    }
  }

  private class LiveFrameView(context: Context) : View(context) {
    private var bitmap: Bitmap? = null
    private var frameWidth = 1
    private var frameHeight = 1
    private val matrix = Matrix()
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG)
    var isInteractive: Boolean = false
      set(value) {
        field = value
        isClickable = value
      }

    init {
      setWillNotDraw(false)
      setBackgroundColor(Color.BLACK)
    }

    fun setFrame(next: Bitmap, meta: LiveFrameMeta) {
      val previous = bitmap
      bitmap = next
      frameWidth = meta.width
      frameHeight = meta.height
      layoutMatrix()
      invalidate()
      previous?.recycle()
    }

    fun clear() {
      val previous = bitmap
      bitmap = null
      invalidate()
      previous?.recycle()
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
      super.onSizeChanged(width, height, oldWidth, oldHeight)
      layoutMatrix()
    }

    private fun layoutMatrix() {
      matrix.reset()
      if (frameWidth <= 0 || frameHeight <= 0 || width <= 0 || height <= 0) return
      val scale = minOf(width.toFloat() / frameWidth, height.toFloat() / frameHeight)
      val drawnWidth = frameWidth * scale
      val drawnHeight = frameHeight * scale
      matrix.setScale(scale, scale)
      matrix.postTranslate((width - drawnWidth) / 2f, (height - drawnHeight) / 2f)
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val current = bitmap ?: return
      canvas.drawBitmap(current, matrix, paint)
    }
  }

  private companion object {
    val client: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    }
  }
}
