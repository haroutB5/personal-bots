const { withMainApplication } = require("expo/config-plugins");

const IMPORTS = `
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import okhttp3.OkHttpClient`;

const DNS_CLASS = `
/**
 * The system resolver answers "no address" for a while after a network change.
 * Keep the last good answer so a reconnect can still reach the laptop, and
 * prefer IPv4 because a phone can keep an unreachable IPv6 route. After a
 * network change the resolver can also take longer than one connect attempt,
 * so a known hostname answers from the cache at once and the cache refreshes
 * in the background for the next attempt.
 */
private class RememberingDns : Dns {
  private val cache = ConcurrentHashMap<String, List<InetAddress>>()
  private val refreshing = ConcurrentHashMap<String, Boolean>()
  private val refresh = java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "hbots-dns").apply { isDaemon = true }
  }

  override fun lookup(hostname: String): List<InetAddress> {
    val cached = cache[hostname]
    if (cached != null && cached.isNotEmpty()) {
      if (refreshing.putIfAbsent(hostname, true) == null) {
        refresh.execute {
          try {
            runCatching { Dns.SYSTEM.lookup(hostname) }
              .onSuccess { if (it.isNotEmpty()) cache[hostname] = it }
          } finally {
            refreshing.remove(hostname)
          }
        }
      }
      return cached.sortedBy { if (it is Inet6Address) 1 else 0 }
    }
    val addresses = Dns.SYSTEM.lookup(hostname)
    if (addresses.isEmpty()) throw UnknownHostException(hostname)
    cache[hostname] = addresses
    return addresses.sortedBy { if (it is Inet6Address) 1 else 0 }
  }
}

`;

const CLIENT_PROPERTY = `
  /**
   * React Native's fetch builds its own OkHttp client, so the network reset
   * evicted a different pool and a reconnect kept reusing a dead socket. One
   * shared client puts the reset on the same connections fetch uses.
   * It has no disk cache, so authenticated responses never reach the disk.
   */
  private val sharedHttpClient: OkHttpClient by lazy {
    OkHttpClientProvider.createClientBuilder(this)
      // React Native installs a disk cache in the app cache folder by default.
      // Chat replies are authenticated and private: they stay out of it.
      .cache(null)
      .dns(RememberingDns())
      .connectTimeout(3, TimeUnit.SECONDS)
      .build()
  }
`;

const FACTORY = `
    OkHttpClientProvider.setOkHttpClientFactory(
      object : OkHttpClientFactory {
        override fun createNewNetworkModuleClient(): OkHttpClient = sharedHttpClient
      },
    )`;

function insertAfter(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(`withSharedHttpClient: could not find ${description} in MainApplication.`);
  }
  const end = index + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

function applyToMainApplication(contents) {
  if (contents.includes("sharedHttpClient")) return contents;
  let next = insertAfter(
    contents,
    "import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint",
    IMPORTS,
    "the React Native defaults import",
  );
  next = insertAfter(
    next,
    "class MainApplication : Application(), ReactApplication {",
    CLIENT_PROPERTY,
    "the MainApplication class declaration",
  );
  next = next.replace(
    "class MainApplication : Application(), ReactApplication {",
    `${DNS_CLASS}class MainApplication : Application(), ReactApplication {`,
  );
  return insertAfter(next, "    super.onCreate()", FACTORY, "the super.onCreate call");
}

module.exports = function withSharedHttpClient(config) {
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withSharedHttpClient: MainApplication must be Kotlin.");
    }
    nextConfig.modResults.contents = applyToMainApplication(nextConfig.modResults.contents);
    return nextConfig;
  });
};

module.exports.applyToMainApplication = applyToMainApplication;
