import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { MANAGED_AUTH_SKIPPED } from "./cloud/managedAuthBoot";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { chunkRecovery } from "./lib/chunkLoadRecovery";
import { clearChunkReloadGuard } from "./lib/chunkReloadGuard";
import { installRouterChunkReloadGuard } from "./lib/routerChunkReloadGuard";
import {
  isStandaloneDisplay,
  registerPersonalServiceWorker,
} from "./features/personal/serviceWorker";
import { checkStaleReleaseAtBoot } from "./features/personal/staleRelease";
import { keepBotsBehindChats } from "./features/personal/botsBackStack";
import {
  browserLocalStorage,
  resumeLastChatAtBoot,
  trackLastChat,
} from "./features/personal/resumeLastChat";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const baseHistory = isElectron ? createHashHistory() : createBrowserHistory();
// Personal: a relaunch of the installed app at /bots reopens the chat that was
// open when iOS evicted it, before anything renders.
const resumedChat = isElectron
  ? null
  : resumeLastChatAtBoot(baseHistory, {
      storage: browserLocalStorage(),
      now: Date.now(),
      standalone: isStandaloneDisplay(),
    });
// Personal: going back from any bot chat lands on /bots, whatever opened it.
const history = keepBotsBehindChats(baseHistory);
if (!isElectron) {
  trackLastChat(history, { storage: browserLocalStorage(), now: Date.now, document, window });
}

const router = getRouter(history);

// Production builds on secure origins only: offline app shell + push clicks.
registerPersonalServiceWorker((path) => router.history.push(path), {
  // Route template only (no ids): where cold boots land.
  route: router.matchRoutes(router.history.location.pathname, {}).at(-1)?.fullPath ?? null,
  resumed: resumedChat !== null,
});

// Set when a reload is on its way, so the boot below skips painting this page.
let reloadScheduled = false;

// The first open after a release boots the previous client from the service
// worker's saved shell; go straight to the new one instead of loading the old.
if (!isElectron) {
  void checkStaleReleaseAtBoot(() => {
    reloadScheduled = true;
  });
}

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html. Only while the
// server answers: with no network (or no laptop) a reload would boot the saved
// shell into the root "Laptop offline" screen and take the open chat with it,
// so the page stays where it is and nothing reloads (lib/chunkLoadRecovery).
let chunkLoadFailed = false;
let reloadStarted = false;
window.addEventListener("vite:preloadError", () => {
  chunkLoadFailed = true;
  const outcome = chunkRecovery().onPreloadError();
  if (outcome.kind !== "check") return;
  reloadScheduled = true;
  void outcome.settled.then((result) => {
    if (result === "reloaded") reloadStarted = true;
    else if (!reloadStarted) reloadScheduled = false;
  });
});

// The router's own reload for a missing route chunk gets the same rule.
installRouterChunkReloadGuard(() => chunkRecovery().away());

const app = <AppRoot router={router} />;

// Managed auth is cloud-only, and the Electron Clerk provider bundles the full
// clerk-js runtime. Loading only the selected runtime as a split chunk keeps
// every Clerk byte out of the startup graph for local-mode users, and keeps
// the bundled clerk-js out of the browser build entirely.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig() && !MANAGED_AUTH_SKIPPED
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

// The index.html boot splash lives inside #root, and React's first commit
// clears it. Resolve everything that first commit needs, the selected
// managed-auth runtime and the initial route's split chunks, before
// rendering, so the splash holds until real UI paints instead of dropping to
// a blank window while chunks download.
export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
])
  .then(async ([ManagedAuthShell]) => {
    // A chunk that failed while the page loaded is still being judged (stale
    // deploy, or no network): paint only once it is known whether a reload is coming.
    await chunkRecovery().idle();
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary. Skip the
    // paint when a reload is on its way, and only re-arm the guard after a boot
    // that fetched every chunk it asked for.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    // Let the bootstrap entry show the error unless a reload is already scheduled.
    if (reloadScheduled) return;
    throw error;
  });
