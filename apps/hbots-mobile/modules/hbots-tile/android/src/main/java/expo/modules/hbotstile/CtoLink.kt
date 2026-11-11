package expo.modules.hbotstile

import android.content.Context

/**
 * The link the tile opens. The app publishes the CTO bot's link after it loads
 * the bot list; until then, or when there is no CTO bot, the tile opens the
 * alias link and the app answers it. The same alias backs the launcher shortcut.
 */
internal object CtoLink {
  const val ALIAS = "hbots://bot/cto?new=1"
  private const val PREFS = "hbots_tile"
  private const val KEY = "cto_link"
  private const val PREFIX = "hbots://bot/"
  private const val SUFFIX = "?new=1"

  /** Only a new-chat link for a bot is accepted; anything else falls back to the alias. */
  fun valid(link: String?): Boolean =
    link != null &&
      link.length > PREFIX.length + SUFFIX.length &&
      link.startsWith(PREFIX) &&
      link.endsWith(SUFFIX) &&
      !link.substring(PREFIX.length, link.length - SUFFIX.length).contains('/')

  fun read(context: Context): String {
    val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    return if (valid(stored)) stored!! else ALIAS
  }

  fun write(context: Context, link: String?) {
    val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    if (valid(link)) editor.putString(KEY, link) else editor.remove(KEY)
    editor.apply()
  }
}
