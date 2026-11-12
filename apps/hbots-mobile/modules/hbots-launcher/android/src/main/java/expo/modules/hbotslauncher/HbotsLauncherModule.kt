package expo.modules.hbotslauncher

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HbotsLauncherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsLauncher")

    /** The pinned bots, `{botId, name}` each. Replaces the dynamic launcher shortcuts. */
    Function("setShortcuts") { bots: List<Map<String, Any?>> ->
      val context = appContext.reactContext?.applicationContext
      if (context != null) LauncherShortcuts.publish(context, ShortcutPlanner.parse(bots))
    }

    /** The first widget's entry point, `{botId, name, working}` each. Kept for an older JS bundle. */
    Function("setWidgetFeed") { bots: List<Map<String, Any?>> ->
      publish(WidgetFeed(WidgetFeedCodec.parse(bots), System.currentTimeMillis()))
    }

    /**
     * Everything the eight widgets draw, as one JSON string. Safe to call often: a widget is redrawn
     * only when its picture changed, and the same feed only refreshes the stamp that keeps it "now".
     */
    Function("setWidgetFeedJson") { json: String ->
      WidgetFeedCodec.fromJs(json, System.currentTimeMillis())?.let { publish(it) }
    }

    /** Sign-out: removes the shortcuts and returns every widget to "Open hbots". */
    Function("wipe") {
      val context = appContext.reactContext?.applicationContext
      if (context != null) {
        LauncherShortcuts.clear(context)
        WidgetStore.clear(context)
        HbotsWidgets.refresh(context)
      }
    }
  }

  private fun publish(feed: WidgetFeed) {
    val context = appContext.reactContext?.applicationContext ?: return
    WidgetStore.write(context, feed)
    HbotsWidgets.refresh(context)
  }
}
