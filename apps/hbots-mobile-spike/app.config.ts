import type { ExpoConfig } from "expo/config";

/**
 * Throwaway phase 0 spike. Not a shipping app: no OTA updates, no Axiom
 * tracing, no relay push. The upstream mobile project keeps all three.
 */
const config: ExpoConfig = {
  name: "hbots spike",
  slug: "hbots-mobile-spike",
  version: "0.0.1",
  orientation: "portrait",
  scheme: "hbots-spike",
  userInterfaceStyle: "dark",
  platforms: ["android"],
  updates: {
    enabled: false,
  },
  android: {
    package: "com.harout.hbots.spike",
    userInterfaceStyle: "dark",
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    "expo-secure-store",
    [
      "expo-build-properties",
      {
        android: {
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          minSdkVersion: 26,
          // Spike-only: the emulator pairs with the live server over the
          // host loopback (http://10.0.2.2:38472). Production must keep
          // usesCleartextTraffic=false (plan section 5.6).
          usesCleartextTraffic: true,
        },
      },
    ],
    "./plugins/withAndroidPredictiveBackCompat.cjs",
  ],
};

export default config;
