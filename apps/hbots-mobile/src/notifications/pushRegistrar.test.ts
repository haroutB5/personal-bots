import { describe, expect, it } from "vite-plus/test";

import { TOO_OLD } from "./pushController";
import {
  parseRegisterResult,
  registerFailureMessage,
  REGISTER_TAG,
  UNREGISTER_TAG,
} from "./pushRegistrar";

describe("push registrar", () => {
  it("uses the wire names the server registers", () => {
    expect(REGISTER_TAG).toBe("personalPush.registerFcm");
    expect(UNREGISTER_TAG).toBe("personalPush.unregisterFcm");
  });

  it("reads ready and disabled", () => {
    expect(parseRegisterResult({ delivery: "ready" })).toEqual({ kind: "ready" });
    expect(parseRegisterResult({ delivery: "disabled" })).toEqual({ kind: "disabled" });
  });

  it("refuses an answer it does not know instead of guessing ready", () => {
    for (const value of [null, undefined, {}, { delivery: "maybe" }, { delivery: true }, "ready"]) {
      expect(parseRegisterResult(value).kind).toBe("failed");
    }
  });

  it("explains an old server in plain words", () => {
    expect(registerFailureMessage(new Error("Unknown request tag personalPush.registerFcm"))).toBe(
      TOO_OLD,
    );
    expect(registerFailureMessage({ message: "Method not found" })).toBe(TOO_OLD);
  });

  it("passes the server's own message through", () => {
    expect(registerFailureMessage({ message: "Not allowed." })).toBe("Not allowed.");
  });

  it("falls back when there is nothing to show", () => {
    expect(registerFailureMessage({})).toBe("Could not register this phone.");
    expect(registerFailureMessage({ message: "  " })).toBe("Could not register this phone.");
    expect(registerFailureMessage(null)).toBe("Could not register this phone.");
  });
});
