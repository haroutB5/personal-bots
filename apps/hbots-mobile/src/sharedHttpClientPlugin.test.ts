import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { applyToMainApplication } = require("../plugins/withSharedHttpClient.cjs") as {
  applyToMainApplication: (contents: string) => string;
};

const TEMPLATE = `package com.haroutb5.hbots

import android.app.Application
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

describe("withSharedHttpClient", () => {
  it("installs the shared client before React Native starts", () => {
    const output = applyToMainApplication(TEMPLATE);
    expect(output).toContain("private val sharedHttpClient: OkHttpClient by lazy {");
    expect(output).toContain("private class RememberingDns : Dns {");
    expect(output).toContain("if (cached != null && cached.isNotEmpty())");
    expect(output).toContain("refresh.execute");
    expect(output.indexOf("setOkHttpClientFactory")).toBeGreaterThan(-1);
    expect(output.indexOf("setOkHttpClientFactory")).toBeLessThan(
      output.indexOf("loadReactNative(this)"),
    );
    expect(output).toContain(".connectTimeout(3, TimeUnit.SECONDS)");
  });

  it("leaves an already patched file alone", () => {
    const once = applyToMainApplication(TEMPLATE);
    expect(applyToMainApplication(once)).toBe(once);
  });
});
