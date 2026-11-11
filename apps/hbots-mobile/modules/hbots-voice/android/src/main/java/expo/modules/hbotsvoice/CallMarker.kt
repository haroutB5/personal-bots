package expo.modules.hbotsvoice

import android.content.Context

object CallMarker {
  private const val FILE = "hbots_voice_marker"
  private const val KEY = "call_running"
  private const val LAST_END_REASON = "last_end_reason"
  private const val LAST_END_ELAPSED = "last_end_elapsed_ms"
  private const val LAST_END_WALL = "last_end_wall_ms"

  private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun isSet(context: Context): Boolean = prefs(context).getBoolean(KEY, false)

  fun set(context: Context) {
    prefs(context).edit().putBoolean(KEY, true).commit()
  }

  /** The call is over. The record of how it ended stays until JS takes it. */
  fun clear(context: Context) {
    prefs(context).edit().remove(KEY).commit()
  }

  /** Signing out: nothing about any call is kept. */
  fun wipe(context: Context) {
    prefs(context).edit().clear().commit()
  }

  fun setLastEnd(context: Context, reason: String, elapsedMs: Long, wallMs: Long) {
    prefs(context).edit()
      .putString(LAST_END_REASON, reason)
      .putLong(LAST_END_ELAPSED, elapsedMs)
      .putLong(LAST_END_WALL, wallMs)
      .commit()
  }

  /** Reads and forgets how the last call ended, or null when nothing is waiting. */
  fun takeLastEnd(context: Context): Map<String, Any?>? {
    val prefs = prefs(context)
    val reason = prefs.getString(LAST_END_REASON, null) ?: return null
    val taken = mapOf(
      "reason" to reason,
      "atElapsedMs" to prefs.getLong(LAST_END_ELAPSED, 0L).toDouble(),
      "wallMs" to prefs.getLong(LAST_END_WALL, 0L).toDouble(),
    )
    prefs.edit().remove(LAST_END_REASON).remove(LAST_END_ELAPSED).remove(LAST_END_WALL).commit()
    return taken
  }
}
