package expo.modules.hbotsvoice

import android.content.Context

object CallMarker {
  private const val FILE = "hbots_voice_marker"
  private const val KEY = "call_running"

  fun isSet(context: Context): Boolean =
    context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(KEY, false)

  fun set(context: Context) {
    context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(KEY, true).commit()
  }

  fun clear(context: Context) {
    context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().commit()
  }
}
