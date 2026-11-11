package expo.modules.hbotstile

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

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

  private fun launch(intent: Intent) {
    if (Build.VERSION.SDK_INT >= 34) {
      val pending = PendingIntent.getActivity(
        this,
        0,
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      startActivityAndCollapse(pending)
    } else {
      @Suppress("DEPRECATION")
      startActivityAndCollapse(intent)
    }
  }
}
