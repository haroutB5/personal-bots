const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING_ANCHOR = "    signingConfigs {\n";
const RELEASE_BLOCK_START = "\n        release {\n";
const DEBUG_SIGNING = "signingConfig signingConfigs.debug";
const RELEASE_SIGNING = "signingConfig signingConfigs.release";

// Read the keystore only when Gradle configures the release variant. Nothing
// secret is written into android/, which prebuild regenerates from scratch.
const RELEASE_SIGNING_CONFIG = `        release {
            def keystorePath = System.getenv("HBOTS_KEYSTORE_PATH") ?: (System.getProperty("user.home") + "/.config/hbots-android/hbots-release.jks")
            storeFile file(keystorePath)
            storePassword System.getenv("HBOTS_KEYSTORE_PASSWORD")
            keyAlias System.getenv("HBOTS_KEY_ALIAS") ?: "hbots-release"
            keyPassword System.getenv("HBOTS_KEY_PASSWORD")
            storeType System.getenv("HBOTS_KEYSTORE_TYPE") ?: "pkcs12"
        }
`;

const RELEASE_GUARD = `
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name == "packageRelease" }) {
        def keystorePath = System.getenv("HBOTS_KEYSTORE_PATH")
        if (keystorePath == null || keystorePath.isEmpty() || !file(keystorePath).isFile()) {
            throw new GradleException("Release keystore not found. Run scripts/build-android.sh.")
        }
        ["HBOTS_KEYSTORE_PASSWORD", "HBOTS_KEY_PASSWORD"].each { name ->
            def value = System.getenv(name)
            if (value == null || value.isEmpty()) {
                throw new GradleException("Missing " + name + ". Run scripts/build-android.sh.")
            }
        }
    }
}
`;

function signRelease(contents) {
  if (contents.includes('keyAlias System.getenv("HBOTS_KEY_ALIAS")')) {
    return contents;
  }
  const signingConfigs = contents.indexOf(SIGNING_ANCHOR);
  if (signingConfigs === -1) {
    throw new Error("withAndroidReleaseSigning: no signingConfigs block in app/build.gradle");
  }
  const insertAt = signingConfigs + SIGNING_ANCHOR.length;
  const withReleaseConfig =
    contents.slice(0, insertAt) + RELEASE_SIGNING_CONFIG + contents.slice(insertAt);
  const releaseBlock = withReleaseConfig.indexOf(
    RELEASE_BLOCK_START,
    insertAt + RELEASE_SIGNING_CONFIG.length,
  );
  if (releaseBlock === -1) {
    throw new Error("withAndroidReleaseSigning: no release build type in app/build.gradle");
  }
  const signingLine = withReleaseConfig.indexOf(DEBUG_SIGNING, releaseBlock);
  if (signingLine === -1) {
    throw new Error("withAndroidReleaseSigning: release does not use the template debug key");
  }
  const signed =
    withReleaseConfig.slice(0, signingLine) +
    RELEASE_SIGNING +
    withReleaseConfig.slice(signingLine + DEBUG_SIGNING.length);
  return signed + RELEASE_GUARD;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    nextConfig.modResults.contents = signRelease(nextConfig.modResults.contents);
    return nextConfig;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.signRelease = signRelease;
