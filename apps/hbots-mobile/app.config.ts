import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ExpoConfig } from "expo/config";

import { BLOCKED_PERMISSIONS } from "./src/permissions.ts";
import { requireReleaseVersion } from "./scripts/versionCode.ts";

const version = requireReleaseVersion(
  NodeFS.readFileSync(
    NodePath.resolve(__dirname, "../../scripts/personal/app-version.txt"),
    "utf8",
  ).trim(),
  "app-version.txt",
).name;

export function versionCodeFor(versionName: string): number {
  return requireReleaseVersion(versionName, "app-version.txt").code;
}

const config: ExpoConfig = {
  name: "hbots",
  slug: "hbots",
  version,
  orientation: "portrait",
  scheme: "hbots",
  userInterfaceStyle: "dark",
  backgroundColor: "#0f0f0e",
  platforms: ["android"],
  androidStatusBar: {
    backgroundColor: "#00000000",
    barStyle: "light-content",
    translucent: true,
  },
  updates: { enabled: false },
  android: {
    package: "com.haroutb5.hbots",
    versionCode: versionCodeFor(version),
    userInterfaceStyle: "dark",
    blockedPermissions: [...BLOCKED_PERMISSIONS],
    permissions: ["android.permission.ACCESS_NETWORK_STATE"],
    predictiveBackGestureEnabled: true,
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: "./assets/icon/foreground.png",
      backgroundImage: "./assets/icon/background.png",
      monochromeImage: "./assets/icon/monochrome.png",
    },
  },
  plugins: [
    "expo-secure-store",
    "expo-system-ui",
    [
      "expo-build-properties",
      {
        android: {
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          minSdkVersion: 26,
          usesCleartextTraffic: false,
          buildArchs: process.env.HBOTS_QA_X86 === "1" ? ["x86_64"] : ["arm64-v8a"],
        },
      },
    ],
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidReleaseSigning.cjs",
    "./plugins/withSharedHttpClient.cjs",
  ],
};

export default config;
