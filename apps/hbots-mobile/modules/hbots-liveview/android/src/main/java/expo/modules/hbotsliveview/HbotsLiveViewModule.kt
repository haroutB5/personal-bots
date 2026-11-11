package expo.modules.hbotsliveview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Computer tab's live view. The view owns the WebSocket and the frames;
 * JavaScript passes the URL, whether the socket should run, and input JSON.
 * The hosting screen sets FLAG_SECURE while the tab is mounted.
 */
class HbotsLiveViewModule : Module() {
  private val pip = PipController { inPip -> sendEvent("onPipChanged", mapOf("inPip" to inPip)) }

  override fun definition() = ModuleDefinition {
    Name("HbotsLiveView")

    Events("onPipChanged")

    /**
     * PiP auto enter on while the live view plays, off otherwise. Width and height are the last
     * frame, for the window's shape. Returns false when this phone cannot do PiP.
     */
    Function("setPip") { enabled: Boolean, width: Int, height: Int ->
      pip.apply(appContext.currentActivity, enabled, width, height)
    }

    OnDestroy { pip.unwatch() }

    View(HbotsLiveView::class) {
      Prop("url") { view: HbotsLiveView, url: String? ->
        view.sourceUrl = url ?: ""
      }
      Prop("mode") { view: HbotsLiveView, mode: String ->
        view.mode = mode
      }
      Prop("paused") { view: HbotsLiveView, paused: Boolean ->
        view.paused = paused
      }
      Prop("attemptKey") { view: HbotsLiveView, key: Int ->
        view.attemptKey = key
      }
      Prop("interactive") { view: HbotsLiveView, interactive: Boolean ->
        view.interactive = interactive
      }

      Events(
        "onLiveOpen",
        "onFrame",
        "onRejected",
        "onHidden",
        "onFocusChanged",
        "onClosed",
        "onViewState",
        "onControl",
        "onInputRefused",
        "onScrollEndWanted",
      )

      AsyncFunction("send") { view: HbotsLiveView, message: String ->
        view.send(message)
      }
    }
  }
}
