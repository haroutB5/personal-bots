package expo.modules.hbotsvoice

import android.media.AudioDeviceInfo

enum class DeviceKind { WIRED, BLUETOOTH, SPEAKER, OTHER }

enum class Route(val wire: String) {
  WIRED("wired"),
  BLUETOOTH("bluetooth"),
  SPEAKER("speaker"),
}

object RoutePolicy {
  fun kindOf(audioDeviceType: Int): DeviceKind = when (audioDeviceType) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    -> DeviceKind.WIRED
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    -> DeviceKind.BLUETOOTH
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> DeviceKind.SPEAKER
    else -> DeviceKind.OTHER
  }

  fun choose(available: Collection<DeviceKind>): Route = when {
    DeviceKind.WIRED in available -> Route.WIRED
    DeviceKind.BLUETOOTH in available -> Route.BLUETOOTH
    else -> Route.SPEAKER
  }
}
