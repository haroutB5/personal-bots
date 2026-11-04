package expo.modules.hbotsnetwork

import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The React Native fetch and WebSocket modules share one OkHttp client for the
 * whole process. After an airplane-mode flap its pool can hold sockets bound to
 * the old network, so every new request waits on a dead connection until its
 * timeout. Evicting the pool makes the next attempt open a fresh one.
 */
class HbotsNetworkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HbotsNetwork")

    AsyncFunction("reset") {
      val client = OkHttpClientProvider.getOkHttpClient()
      client.dispatcher.cancelAll()
      client.connectionPool.evictAll()
      true
    }
  }
}
