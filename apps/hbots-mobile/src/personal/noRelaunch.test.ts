import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("connection recovery", () => {
  it("has no app relaunch or process restart path", () => {
    for (const file of ["./nativePersonalClient.ts", "./networkReset.ts"]) {
      expect(source(file)).not.toMatch(/relaunch/i);
    }
    expect(
      source(
        "../../modules/hbots-network/android/src/main/java/expo/modules/hbotsnetwork/HbotsNetworkModule.kt",
      ),
    ).not.toMatch(/relaunch|killProcess/i);
  });
});
