const { withMainActivity } = require("expo/config-plugins");

// Copied from apps/mobile. predictiveBackGestureEnabled
// removes legacy KEYCODE_BACK delivery on Android 13+. react-native registers its
// own callback only on Android 16 with targetSdk 36, so on API 33-35 no callback
// exists and every back gesture backgrounds the app. This mirrors RN's shim.
const CALLBACK_PROPERTY = `
  private val predictiveBackCompatCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      isEnabled = false
      onBackPressed()
      isEnabled = true
    }
  }
`;

const CALLBACK_REGISTRATION = `
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && Build.VERSION.SDK_INT < Build.VERSION_CODES.BAKLAVA) {
      onBackPressedDispatcher.addCallback(this, predictiveBackCompatCallback)
    }`;

const INVOKE_DEFAULT_WRAPPER = `override fun invokeDefaultOnBackPressed() {
    predictiveBackCompatCallback.isEnabled = false
    try {
      invokeDefaultOnBackPressedLegacy()
    } finally {
      predictiveBackCompatCallback.isEnabled = true
    }
  }

  private fun invokeDefaultOnBackPressedLegacy() {`;

function insertAfter(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidPredictiveBackCompat: could not find ${description} in MainActivity.`,
    );
  }
  const end = index + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

module.exports = function withAndroidPredictiveBackCompat(config) {
  if (config.android?.predictiveBackGestureEnabled !== true) {
    return config;
  }

  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidPredictiveBackCompat: MainActivity must be Kotlin.");
    }
    if (contents.includes("predictiveBackCompatCallback")) {
      return nextConfig;
    }

    contents = insertAfter(
      contents,
      "import android.os.Bundle",
      "\nimport androidx.activity.OnBackPressedCallback",
      "the android.os.Bundle import",
    );
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      CALLBACK_PROPERTY,
      "the MainActivity class declaration",
    );
    contents = insertAfter(
      contents,
      "super.onCreate(null)",
      CALLBACK_REGISTRATION,
      "the super.onCreate call",
    );

    if (!contents.includes("override fun invokeDefaultOnBackPressed() {")) {
      throw new Error(
        "withAndroidPredictiveBackCompat: could not find invokeDefaultOnBackPressed.",
      );
    }
    contents = contents.replace(
      "override fun invokeDefaultOnBackPressed() {",
      INVOKE_DEFAULT_WRAPPER,
    );

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
