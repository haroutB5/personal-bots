// @effect-diagnostics nodeBuiltinImport:off - Loads the CommonJS Expo config plugin.
import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { signRelease } = require("../plugins/withAndroidReleaseSigning.cjs") as {
  readonly signRelease: (contents: string) => string;
};

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
        }
    }
}
`;

describe("withAndroidReleaseSigning", () => {
  it("signs release with the keystore from the environment", () => {
    const signed = signRelease(TEMPLATE);
    expect(signed).toContain("storeFile file(keystorePath)");
    expect(signed).toContain('storePassword System.getenv("HBOTS_KEYSTORE_PASSWORD")');
    expect(signed).toContain('keyAlias System.getenv("HBOTS_KEY_ALIAS")');
    expect(signed).toContain("signingConfig signingConfigs.release");
  });

  it("leaves the debug build on the template debug key", () => {
    const signed = signRelease(TEMPLATE);
    expect(signed.match(/signingConfig signingConfigs\.debug/gu)).toHaveLength(1);
    expect(signed.match(/signingConfig signingConfigs\.release/gu)).toHaveLength(1);
  });

  it("does not double the signing config when prebuild runs twice", () => {
    const once = signRelease(TEMPLATE);
    expect(signRelease(once)).toBe(once);
  });

  it("refuses a template whose release build it cannot find", () => {
    expect(() => signRelease("android {\n}\n")).toThrow(/no signingConfigs block/u);
  });
});
