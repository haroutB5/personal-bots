package expo.modules.hbotslauncher

import android.content.Context

/** The widgets' one record, in app-private storage. No feed means signed out. */
object WidgetStore {
  private const val PREFS = "hbots_launcher"
  private const val KEY = "widget_feed"

  fun read(context: Context): WidgetFeed? =
    WidgetFeedCodec.decode(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))

  fun write(context: Context, feed: WidgetFeed) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString(KEY, WidgetFeedCodec.encode(feed)).apply()
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
  }
}
