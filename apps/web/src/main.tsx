import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { MANAGED_AUTH_SKIPPED } from "./cloud/managedAuthBoot";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { checkStaleReleaseAtBoot } from "./features/personal/staleRelease";
import { chunkRecovery } from "./lib/chunkLoadRecovery";
import { installRouterChunkReloadGuard } from "./lib/routerChunkReloadGuard";
import { whenLocaleReady } from "./i18n/runtime";

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// Set when a reload is on its way, so the boot below skips painting this page.
let reloadScheduled = false;

// The first open after a release boots the previous client from the saved shell; go straight to the new one.
if (!isElectron) {
  void checkStaleReleaseAtBoot(() => {
    reloadScheduled = true;
  });
}

// A failed chunk usually means a deploy went stale; reload only while the server answers (lib/chunkLoadRecovery).
let reloadStarted = false;
window.addEventListener("vite:preloadError", () => {
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

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig() && !MANAGED_AUTH_SKIPPED
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(async ([ManagedAuthShell]) => {
    // A chunk that failed during load is still being judged: paint once it is known whether a reload is coming.
    await chunkRecovery().idle();
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
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
    if (reloadScheduled) return;
    throw error;
  });
