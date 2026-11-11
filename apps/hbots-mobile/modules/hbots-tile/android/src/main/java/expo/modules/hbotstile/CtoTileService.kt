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
 * From Android 14 the system does the unlock inside the PendingIntent start,
 * so the tile makes one call; see unlockFirst for why it must not ask twice.
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
    if (unlockFirst(isLocked, Build.VERSION.SDK_INT)) unlockAndRun(open) else open()
  }

  /**
   * From Android 14 the tile hands SystemUI a PendingIntent and SystemUI
   * dismisses the keyguard before it sends it. SystemUI sends with its own
   * background-start privilege; the creator opt-in below keeps the start allowed
   * on versions where the creator's mode is also checked. The app is not shown
   * over the lock screen: the activity does not set showWhenLocked.
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
