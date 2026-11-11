package expo.modules.hbotsdisplay

import kotlin.math.roundToInt

data class DisplayMode(val id: Int, val width: Int, val height: Int, val refreshRate: Float)

/**
 * Picks the display mode a list asks for while it scrolls (X7). Only modes at the current
 * resolution count: a different resolution would resize the whole screen. A display with a
 * single refresh rate has nothing to ask for.
 */
object RefreshPlanner {
  /** Rates that differ by less than a hertz (59.94 and 60) are the same rate. */
  private fun rateOf(mode: DisplayMode): Int = mode.refreshRate.roundToInt()

  private fun sameResolution(modes: List<DisplayMode>, currentId: Int): List<DisplayMode> {
    val current = modes.firstOrNull { it.id == currentId } ?: return emptyList()
    return modes.filter { it.width == current.width && it.height == current.height }
  }

  /** True when there is a faster mode to ask for at the current resolution. */
  fun hasHighMode(modes: List<DisplayMode>, currentId: Int): Boolean =
    sameResolution(modes, currentId).map(::rateOf).distinct().size >= 2

  /** The id of the fastest mode at the current resolution, or null when there is only one rate. */
  fun highModeId(modes: List<DisplayMode>, currentId: Int): Int? {
    val same = sameResolution(modes, currentId)
    if (same.map(::rateOf).distinct().size < 2) return null
    return same.maxByOrNull { it.refreshRate }?.id
  }

  /** 0 hands the choice back to the system. */
  const val NO_PREFERENCE = 0
}
