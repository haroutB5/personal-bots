package expo.modules.hbotspageview

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream

/**
 * One bot page in a WebView that is cut off from the app.
 *
 * The page is untrusted HTML. The server serves it with a sandbox policy, which
 * gives it an opaque origin: no cookies, no storage, no same-origin calls. This
 * view adds the native half of the same rule:
 *
 * - no JavaScript interface is ever added, so the page has no bridge to the app;
 * - files, content URIs, storage, the form and password stores, geolocation,
 *   new windows and every permission request are off;
 * - cookies are refused for this view's third parties, and nothing on the
 *   app's own server is served to the page except the page itself;
 * - the view loads the one link it was given. A tapped web link is reported to
 *   JavaScript, which opens it outside the app; any other scheme is dropped.
 *
 * The page's own scripts run, as they do in the web chat.
 */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class HbotsPageView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean
    get() = true

  private val onPageLoaded by EventDispatcher()
  private val onPageFailed by EventDispatcher()
  private val onContentHeight by EventDispatcher()
  private val onOpenLink by EventDispatcher()

  private val main = Handler(Looper.getMainLooper())
  private var web: WebView? = null
  private var lastHeight = 0
  private var released = false

  var pageUrl: String = ""
    set(value) {
      // The frame keeps the first link it loads: a re-signed link must not reload the page.
      if (field.isNotEmpty() || value.isEmpty() || released) return
      if (!PageNavigationPolicy.isLoadable(value)) {
        onPageFailed(mapOf("reason" to "scheme"))
        return
      }
      field = value
      ensureWeb().loadUrl(value)
    }

  var scrollable: Boolean = false
    set(value) {
      field = value
      web?.let(::applyScroll)
    }

  private fun applyScroll(view: WebView) {
    view.isVerticalScrollBarEnabled = scrollable
    view.isHorizontalScrollBarEnabled = false
    view.overScrollMode = OVER_SCROLL_NEVER
    // Inline, the frame is as tall as the page: the chat list owns the scroll.
    view.isNestedScrollingEnabled = scrollable
  }

  private fun ensureWeb(): WebView {
    web?.let { return it }
    val view = WebView(context)
    view.setBackgroundColor(Color.TRANSPARENT)
    view.settings.apply {
      javaScriptEnabled = true
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      allowFileAccess = false
      allowContentAccess = false
      @Suppress("DEPRECATION")
      allowFileAccessFromFileURLs = false
      @Suppress("DEPRECATION")
      allowUniversalAccessFromFileURLs = false
      domStorageEnabled = false
      @Suppress("DEPRECATION")
      databaseEnabled = false
      @Suppress("DEPRECATION")
      saveFormData = false
      setGeolocationEnabled(false)
      mediaPlaybackRequiresUserGesture = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      cacheMode = WebSettings.LOAD_NO_CACHE
      builtInZoomControls = false
      displayZoomControls = false
      setSupportZoom(false)
      if (android.os.Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = true
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    view.setDownloadListener { _, _, _, _, _ -> }
    view.isLongClickable = false
    view.setOnLongClickListener { true }
    view.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) = request.deny()
    }
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val target = request.url.toString()
        return when (PageNavigationPolicy.decide(pageUrl, target, request.isForMainFrame)) {
          PageNavigation.LOAD -> false
          PageNavigation.OPEN_OUTSIDE -> {
            // Only a tap leaves the app; a script cannot send the reader away.
            if (request.hasGesture()) onOpenLink(mapOf("url" to target))
            true
          }
          PageNavigation.BLOCK -> true
        }
      }

      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? {
        if (PageNavigationPolicy.allowsSubresource(pageUrl, request.url.toString())) return null
        return WebResourceResponse(
          "text/plain",
          "utf-8",
          403,
          "Forbidden",
          emptyMap(),
          ByteArrayInputStream(ByteArray(0)),
        )
      }

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        if (request.isForMainFrame) onPageFailed(mapOf("reason" to "load"))
      }

      override fun onPageFinished(view: WebView, url: String) {
        onPageLoaded(mapOf<String, Any>())
        reportHeight()
        // Fonts and images settle after the load event; look again a few times.
        for (delay in longArrayOf(250, 800, 2000)) main.postDelayed(::reportHeight, delay)
      }
    }
    applyScroll(view)
    addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    web = view
    return view
  }

  /** The page's height in CSS pixels, read natively: the page itself is never asked. */
  private fun reportHeight() {
    val view = web ?: return
    if (released) return
    val height = view.contentHeight
    if (height <= 0 || height == lastHeight) return
    lastHeight = height
    onContentHeight(mapOf("height" to height))
  }

  fun release() {
    if (released) return
    released = true
    main.removeCallbacksAndMessages(null)
    web?.let { view ->
      view.stopLoading()
      view.loadUrl("about:blank")
      removeView(view)
      view.destroy()
    }
    web = null
  }
}
