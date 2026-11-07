// @effect-diagnostics nodeBuiltinImport:off - inspects the process environment the setup file wrote.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(process.env.T3CODE_TEST_KEEP_PROVIDER_ENV === "1")(
  "provider test environment",
  () => {
    it("points XDG_DATA_HOME at an empty directory under the temp folder", () => {
      const dataHome = process.env.XDG_DATA_HOME ?? "";
      expect(dataHome.startsWith(NodePath.resolve(NodeOS.tmpdir()))).toBe(true);
      expect(NodeFS.readdirSync(dataHome)).toEqual([]);
    });

    it("carries no OpenCode credentials or data directory from the host", () => {
      expect(Object.keys(process.env).filter((key) => key.startsWith("OPENCODE_"))).toEqual([]);
    });
  },
);
