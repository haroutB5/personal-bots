// @effect-diagnostics nodeBuiltinImport:off - compares the embedded copy with the checked-in files on disk.
/**
 * The Linux helper is compiled from `helperSource.ts`, not from the C file, so
 * a fix that lands only in `helper/pbdesk-wl.c` never reaches a release. This
 * keeps the embedded copy honest: it must be byte-identical to the sources it
 * says it was generated from.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  PB_DESK_LINUX_HELPER_SOURCE,
  VIRTUAL_KEYBOARD_XML,
  WLR_VIRTUAL_POINTER_XML,
} from "./helperSource.ts";

const read = (name: string): string =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "helper", name), "utf8");

describe("embedded Linux helper source", () => {
  it("matches helper/pbdesk-wl.c", () => {
    expect(PB_DESK_LINUX_HELPER_SOURCE).toBe(read("pbdesk-wl.c"));
  });

  it("matches the two protocol XMLs", () => {
    expect(WLR_VIRTUAL_POINTER_XML).toBe(read("wlr-virtual-pointer-unstable-v1.xml"));
    expect(VIRTUAL_KEYBOARD_XML).toBe(read("virtual-keyboard-unstable-v1.xml"));
  });

  it("keeps the fixes that the embedded copy must carry", () => {
    // B4: exact keysym lookup first, case-insensitive only as a fallback.
    expect(PB_DESK_LINUX_HELPER_SOURCE).toContain(
      "xkb_keysym_from_name(name, XKB_KEYSYM_NO_FLAGS)",
    );
    // B7: die with the server, and a signal handler that only raises a flag.
    expect(PB_DESK_LINUX_HELPER_SOURCE).toContain("prctl(PR_SET_PDEATHSIG, SIGTERM)");
    expect(PB_DESK_LINUX_HELPER_SOURCE).toContain("g_stop = 1");
  });
});
