package expo.modules.hbotspageview

/** What the page view does with a URL the page asks for. Pure, so it is unit tested. */
enum class PageNavigation {
  /** The page itself: the one document this view was given. */
  LOAD,

  /** A web link: handed to JavaScript, which opens it outside the app. */
  OPEN_OUTSIDE,

  /** Everything else is dropped. */
  BLOCK,
}

object PageNavigationPolicy {
  private fun withoutFragment(url: String): String = url.substringBefore('#')

  /**
   * [pageUrl] is the signed link this view was given. A main-frame request is
   * allowed only for that exact document; a fragment change stays on the page.
   * Any other http or https target leaves the app. Other schemes (intent, file,
   * content, javascript, data, blob and the app's own) never run.
   */
  fun decide(pageUrl: String, requested: String, mainFrame: Boolean): PageNavigation {
    if (pageUrl.isEmpty()) return PageNavigation.BLOCK
    if (withoutFragment(requested) == withoutFragment(pageUrl)) return PageNavigation.LOAD
    if (!mainFrame) return PageNavigation.BLOCK
    val lower = requested.trim().lowercase()
    return if (lower.startsWith("https://") || lower.startsWith("http://")) {
      PageNavigation.OPEN_OUTSIDE
    } else {
      PageNavigation.BLOCK
    }
  }

  /**
   * A subresource the page asks for. The page's own server is the app's server:
   * nothing on that host is served to the page except the page itself, so a
   * script in the page cannot call the app's API from inside the app. Other
   * hosts (an image, a font, a chart library) load as they would in a browser.
   */
  fun allowsSubresource(pageUrl: String, requested: String): Boolean {
    if (withoutFragment(requested) == withoutFragment(pageUrl)) return true
    val pageHost = hostOf(pageUrl) ?: return false
    val lower = requested.trim().lowercase()
    if (lower.startsWith("data:") || lower.startsWith("blob:")) return true
    val host = hostOf(requested) ?: return false
    return host != pageHost
  }

  /** scheme://host:port in lower case, or null when the URL is not http or https. */
  private fun hostOf(url: String): String? {
    val lower = url.trim().lowercase()
    val rest = when {
      lower.startsWith("https://") -> lower.removePrefix("https://")
      lower.startsWith("http://") -> lower.removePrefix("http://")
      else -> return null
    }
    val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
    val host = authority.substringAfterLast('@')
    return if (host.isEmpty()) null else host
  }

  /** Only an https page, or plain http for a paired server on the local network. */
  fun isLoadable(pageUrl: String): Boolean {
    val lower = pageUrl.trim().lowercase()
    return lower.startsWith("https://") || lower.startsWith("http://")
  }
}
