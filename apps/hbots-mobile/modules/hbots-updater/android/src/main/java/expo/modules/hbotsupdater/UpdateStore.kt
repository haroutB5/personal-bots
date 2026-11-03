package expo.modules.hbotsupdater

import android.content.Context

class UpdateStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun load(): UpdateRecord = UpdateRecordCodec.load(prefs.getString(KEY_RECORD, null))

  fun save(record: UpdateRecord) {
    prefs.edit().putString(KEY_RECORD, UpdateRecordCodec.encode(record)).commit()
  }

  private companion object {
    const val PREFS = "hbots-updater"
    const val KEY_RECORD = "record"
  }
}
