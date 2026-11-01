import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ExpoConfig } from "expo/config";

const version = NodeFS.readFileSync(
  NodePath.resolve(__dirname, "../../scripts/personal/app-version.txt"),
  "utf8",
).trim();

const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);

const config: ExpoConfig = {
  name: "hbots",
  slug: "hbots",
  version,
  orientation: "portrait",
  scheme: "hbots",
  userInterfaceStyle: "dark",
  platforms: ["android"],
  updates: { enabled: false },
  android: {
    package: "com.haroutb5.hbots",
    versionCode: major * 1_000_000 + minor * 1_000 + patch,
    userInterfaceStyle: "dark",
    predictiveBackGestureEnabled: true,
    allowBackup: false,
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
          usesCleartextTraffic: false,
        },
      },
    ],
    "./plugins/withAndroidPredictiveBackCompat.cjs",
  ],
};

export default config;
