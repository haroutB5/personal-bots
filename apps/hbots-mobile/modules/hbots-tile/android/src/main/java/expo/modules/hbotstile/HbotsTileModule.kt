package expo.modules.hbotstile

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HbotsTileModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsTile")

    /** The new-chat link for the CTO bot, or null when there is none. */
    Function("setCtoLink") { link: String? ->
      val context = appContext.reactContext?.applicationContext
      if (context != null) CtoLink.write(context, link)
    }
  }
}
