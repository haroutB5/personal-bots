package expo.modules.hbotstile

import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log

/**
 * Quick Settings tile that opens a new chat with the CTO bot. A locked phone
 * unlocks first, then the app opens; the tile never sends anything itself.
 */
class CtoTileService : TileService() {
  override fun onStartListening() {
    val tile = qsTile ?: return
    tile.state = Tile.STATE_INACTIVE
    tile.updateTile()
  }

  override fun onClick() {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(CtoLink.read(applicationContext)))
      .setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val open = { launch(intent) }
    if (isLocked) unlockAndRun(open) else open()
  }

  /**
   * From Android 14 the tile hands the system a PendingIntent. After
   * unlockAndRun the shade is gone and the app has no window, so the creator
   * must allow the PendingIntent to start an activity from the background
   * (setPendingIntentCreatorBackgroundActivityStartMode). Before this opt-in the
   * Verifier saw "The activity is starting" and no activity start from the lock
   * screen, 3 of 3. The cause is inferred, the fix needs a device re-check.
   */
  private fun launch(intent: Intent) {
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        val options = ActivityOptions.makeBasic()
          .setPendingIntentCreatorBackgroundActivityStartMode(
            ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
          )
        val pending = PendingIntent.getActivity(
          this,
          0,
          intent,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          options.toBundle(),
        )
        startActivityAndCollapse(pending)
      } else {
        @Suppress("DEPRECATION")
        startActivityAndCollapse(intent)
      }
    } catch (failure: RuntimeException) {
      Log.w("HbotsTile", "The tile could not open the app.", failure)
    }
  }
}
