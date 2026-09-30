import { RouterProvider } from "@tanstack/react-router";
import { lazy } from "react";

import { isElectron } from "./env";
import { DeferredMount } from "./lib/DeferredMount";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Off the boot path (1.59.4): none of these draws anything for the first
// paint, and evaluating them (browser preview automation, the Electron
// webview host) held up the first rows. DeferredMount loads them once the
// app has settled.
const PreviewAutomationHosts = lazy(() =>
  import("./components/preview/PreviewAutomationHosts").then((module) => ({
    default: module.PreviewAutomationHosts,
  })),
);
const ElectronBrowserHost = lazy(() =>
  import("./browser/ElectronBrowserHost").then((module) => ({
    default: module.ElectronBrowserHost,
  })),
);
const QuitHoldOverlay = lazy(() =>
  import("./components/QuitHoldOverlay").then((module) => ({ default: module.QuitHoldOverlay })),
);

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      {/* All three need the desktop bridge and render nothing without it, so
          the browser and the phone PWA never load them. */}
      {isElectron ? (
        <DeferredMount>
          <PreviewAutomationHosts />
          <ElectronBrowserHost />
          <QuitHoldOverlay />
        </DeferredMount>
      ) : null}
    </AppAtomRegistryProvider>
  );
}
