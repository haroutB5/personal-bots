package expo.modules.hbotsvoice

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

class AudioRouter(context: Context, private val onRoute: (Route) -> Unit) {
  private val manager = context.getSystemService(AudioManager::class.java)
  private val handler = Handler(Looper.getMainLooper())
  private var entered = false
  private var current: Route? = null

  private val callback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
  }

  fun route(): Route = current ?: RoutePolicy.choose(kinds())

  private fun kinds(): List<DeviceKind> =
    manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { RoutePolicy.kindOf(it.type) }

  fun enter() {
    if (entered) return
    entered = true
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    manager.registerAudioDeviceCallback(callback, handler)
    refresh()
  }

  fun refresh() {
    if (!entered) return
    val next = RoutePolicy.choose(kinds())
    apply(next)
    if (next != current) {
      current = next
      onRoute(next)
    }
  }

  @Suppress("DEPRECATION")
  private fun apply(route: Route) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val wanted = when (route) {
        Route.WIRED -> DeviceKind.WIRED
        Route.BLUETOOTH -> DeviceKind.BLUETOOTH
        Route.SPEAKER -> DeviceKind.SPEAKER
      }
      val device = manager.availableCommunicationDevices.firstOrNull { RoutePolicy.kindOf(it.type) == wanted }
      if (device != null) manager.setCommunicationDevice(device) else manager.clearCommunicationDevice()
    } else {
      when (route) {
        Route.BLUETOOTH -> {
          manager.isSpeakerphoneOn = false
          manager.startBluetoothSco()
          manager.isBluetoothScoOn = true
        }
        Route.WIRED -> {
          manager.isBluetoothScoOn = false
          manager.stopBluetoothSco()
          manager.isSpeakerphoneOn = false
        }
        Route.SPEAKER -> {
          manager.isBluetoothScoOn = false
          manager.stopBluetoothSco()
          manager.isSpeakerphoneOn = true
        }
      }
    }
  }

  @Suppress("DEPRECATION")
  fun leave() {
    if (!entered) return
    entered = false
    manager.unregisterAudioDeviceCallback(callback)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else {
      manager.stopBluetoothSco()
      manager.isBluetoothScoOn = false
      manager.isSpeakerphoneOn = false
    }
    manager.mode = AudioManager.MODE_NORMAL
    current = null
  }
}
