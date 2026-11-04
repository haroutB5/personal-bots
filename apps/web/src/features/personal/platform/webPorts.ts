import type { Clock } from "@hbots/personal-client/ports/clock";
import type { Confirm } from "@hbots/personal-client/ports/confirm";
import type { Ids } from "@hbots/personal-client/ports/ids";
import type { Lifecycle, LifecycleState } from "@hbots/personal-client/ports/lifecycle";
import type { PersonalPorts } from "@hbots/personal-client/ports/personalPorts";

import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import { webKeyValueStore, whenIdle } from "./webStorage";
import { webBlobStore } from "./webBlobStore";

export { webBlobStore, webKeyValueStore };

export const webClock: Clock = {
  now: () => Date.now(),
  setTimeout: (work, delayMs) => {
    const handle = setTimeout(work, delayMs);
    return () => clearTimeout(handle);
  },
  whenIdle,
  nextFrame: (work) => {
    const handle = requestAnimationFrame(() => work());
    return () => cancelAnimationFrame(handle);
  },
};

function visibilityToLifecycle(): LifecycleState {
  return typeof document === "undefined" || document.visibilityState === "visible"
    ? "foreground"
    : "background";
}

export const webLifecycle: Lifecycle = {
  current: visibilityToLifecycle,
  subscribe: (listener) => {
    if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
    let last = visibilityToLifecycle();
    const report = (next: LifecycleState) => {
      if (next === last) return;
      last = next;
      listener(next);
    };
    const onVisibility = () => report(visibilityToLifecycle());
    const onPageHide = () => report("background");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  },
};

export const webConfirm: Confirm = {
  confirm: async ({ title, body, confirmLabel, destructive }) =>
    (await requestConfirmDialog(body === undefined ? title : `${title}\n\n${body}`, {
      variant: destructive ? "destructive" : "default",
      ...(confirmLabel === undefined ? {} : { confirmLabel }),
    })) ?? false,
};

export const webIds: Ids = { randomUUID };

export const webPorts: PersonalPorts<Blob> = {
  kv: webKeyValueStore,
  blobs: webBlobStore,
  clock: webClock,
  lifecycle: webLifecycle,
  confirm: webConfirm,
  ids: webIds,
};
