package expo.modules.hbotsliveview

/** What the activity's picture-in-picture params should say. */
data class PipRequest(val autoEnter: Boolean, val ratioWidth: Int, val ratioHeight: Int)

/**
 * Picture-in-picture for the Computer live view, as data. Auto enter exists from API 31; a phone
 * without the feature, or an older Android, gets no request at all, so nothing can throw there.
 */
object PipPlan {
  const val MIN_SDK = 31
  private const val DEFAULT_WIDTH = 16
  private const val DEFAULT_HEIGHT = 9

  /** Android refuses a ratio outside 1:2.39 to 2.39:1. */
  private const val LIMIT_NUM = 239
  private const val LIMIT_DEN = 100

  /** Null means do nothing: this phone cannot do it. Otherwise the params to apply. */
  fun plan(sdkInt: Int, hasPipFeature: Boolean, enabled: Boolean, frameWidth: Int, frameHeight: Int): PipRequest? {
    if (sdkInt < MIN_SDK || !hasPipFeature) return null
    val (w, h) = ratio(frameWidth, frameHeight)
    return PipRequest(autoEnter = enabled, ratioWidth = w, ratioHeight = h)
  }

  fun ratio(frameWidth: Int, frameHeight: Int): Pair<Int, Int> {
    if (frameWidth <= 0 || frameHeight <= 0) return DEFAULT_WIDTH to DEFAULT_HEIGHT
    return when {
      frameWidth * LIMIT_DEN > frameHeight * LIMIT_NUM -> LIMIT_NUM to LIMIT_DEN
      frameHeight * LIMIT_DEN > frameWidth * LIMIT_NUM -> LIMIT_DEN to LIMIT_NUM
      else -> frameWidth to frameHeight
    }
  }
}
