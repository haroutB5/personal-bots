package expo.modules.hbotscamera

import androidx.core.content.FileProvider

/** Its own authority so the camera output never depends on expo-image-picker's manifest. */
class HbotsCameraFileProvider : FileProvider()
