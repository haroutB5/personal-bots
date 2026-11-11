package expo.modules.hbotsshare

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HbotsShareModule : Module() {
  private fun app() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("HbotsShare")

    /** The payload JSON the share activity wrote for this id, or null. */
    Function("read") { id: String ->
      val context = app()
      if (context == null) null else ShareStore.read(context, id)
    }

    /** Drops the copied files once they are queued or the picker closes. */
    Function("discard") { id: String ->
      val context = app()
      if (context != null) ShareStore.discard(context, id)
    }

    /** App start: drops every intake an earlier run left, keeping the one this launch opens. */
    Function("discardAllExcept") { keep: String? ->
      val context = app()
      if (context != null) ShareStore.discardAllExcept(context, keep)
    }
  }
}
