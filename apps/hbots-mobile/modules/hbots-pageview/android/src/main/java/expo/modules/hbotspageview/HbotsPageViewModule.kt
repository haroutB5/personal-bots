package expo.modules.hbotspageview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * A page a bot showed in the chat, drawn in a locked down WebView. JavaScript
 * passes the signed page link and nothing else; the view reports the page's
 * height and any link the reader tapped, which JavaScript opens outside the app.
 */
class HbotsPageViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsPageView")

    View(HbotsPageView::class) {
      Prop("url") { view: HbotsPageView, url: String? ->
        view.pageUrl = url ?: ""
      }
      Prop("scrollable") { view: HbotsPageView, scrollable: Boolean ->
        view.scrollable = scrollable
      }

      Events("onPageLoaded", "onPageFailed", "onContentHeight", "onOpenLink")

      OnViewDestroys { view: HbotsPageView -> view.release() }
    }
  }
}
