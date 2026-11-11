package expo.modules.hbotslauncher

import android.content.Context

/** The widget's one record, in app-private storage. No feed means signed out. */
object WidgetStore {
  private const val PREFS = "hbots_launcher"
  private const val KEY = "widget_feed"

  fun read(context: Context): WidgetFeed? =
    WidgetFeedCodec.decode(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))

  /**
   * Saves the bots and stamps native's clock. Returns true when the visible content changed, so
   * a heartbeat with the same bots only refreshes the stamp and costs no redraw.
   */
  fun write(context: Context, bots: List<WidgetBot>, now: Long): Boolean {
    val before = read(context)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString(KEY, WidgetFeedCodec.encode(WidgetFeed(bots, now))).apply()
    return before?.bots != bots
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
  }
}
