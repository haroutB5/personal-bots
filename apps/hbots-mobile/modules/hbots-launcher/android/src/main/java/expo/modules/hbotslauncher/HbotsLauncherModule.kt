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

    /**
     * The widget's bots, `{botId, name, working}` each and nothing else. Safe to call often: the same
     * bots only refresh the stamp that keeps the working dots trusted, with no redraw.
     */
    Function("setWidgetFeed") { bots: List<Map<String, Any?>> ->
      val context = appContext.reactContext?.applicationContext
      if (context != null && WidgetStore.write(context, WidgetFeedCodec.parse(bots), System.currentTimeMillis())) {
        HbotsWidgetProvider.refresh(context)
      }
    }

    /** Sign-out: removes the shortcuts and returns the widget to "Open hbots". */
    Function("wipe") {
      val context = appContext.reactContext?.applicationContext
      if (context != null) {
        LauncherShortcuts.clear(context)
        WidgetStore.clear(context)
        HbotsWidgetProvider.refresh(context)
      }
    }
  }
}
