const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require("expo/config-plugins");

// The app is dark only. The Expo template ships a white splash: a placeholder
// bitmap as the launch window background, and a white splashscreen_background
// colour. Android 12 and later draw their own splash from
// windowSplashScreenBackground, or from the window background when that is not
// set, and the bitmap made it white. This plugin makes both the launch theme
// and the window before React mounts (AppTheme, set by expo-system-ui from
// backgroundColor) the app's dark background, on every supported version.
const SPLASH_COLOR = "splashscreen_background";
const SPLASH_THEME = "Theme.App.SplashScreen";
const SPLASH_THEME_PARENT = "AppTheme";

function styleItem(name, value) {
  return { $: { name }, _: value };
}

/** Sets the splash colour in a parsed colors.xml. Returns the same object. */
function applySplashColor(colors, hex) {
  return AndroidConfig.Colors.assignColorValue(colors, { name: SPLASH_COLOR, value: hex });
}

/**
 * Points the launch theme at the splash colour: windowBackground for Android 8
 * to 11, and windowSplashScreenBackground for Android 12 and later (an
 * attribute older versions ignore). No bitmap and no animated icon is set, so
 * the system keeps the launcher icon on a dark field.
 */
function applySplashTheme(styles) {
  for (const [name, value] of [
    ["android:windowBackground", `@color/${SPLASH_COLOR}`],
    ["android:windowSplashScreenBackground", `@color/${SPLASH_COLOR}`],
  ]) {
    AndroidConfig.Styles.setStylesItem({
      xml: styles,
      parent: { name: SPLASH_THEME, parent: SPLASH_THEME_PARENT },
      item: styleItem(name, value),
    });
  }
  return styles;
}

function withDarkSplash(config) {
  const hex = config.backgroundColor;
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(hex)) {
    throw new Error("withDarkSplash: set backgroundColor to a #rrggbb colour.");
  }
  config = withAndroidColors(config, (next) => {
    next.modResults = applySplashColor(next.modResults, hex);
    return next;
  });
  config = withAndroidColorsNight(config, (next) => {
    next.modResults = applySplashColor(next.modResults, hex);
    return next;
  });
  return withAndroidStyles(config, (next) => {
    next.modResults = applySplashTheme(next.modResults);
    return next;
  });
}

module.exports = withDarkSplash;
module.exports.applySplashColor = applySplashColor;
module.exports.applySplashTheme = applySplashTheme;
module.exports.SPLASH_COLOR = SPLASH_COLOR;
module.exports.SPLASH_THEME = SPLASH_THEME;
