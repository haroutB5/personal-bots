import { ErrorComponent, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { useEffect } from "react";

import { isChunkLoadError } from "~/lib/chunkLoadError";
import { chunkRecovery } from "~/lib/chunkLoadRecovery";
import { reloadOnceForChunkLoadError } from "~/lib/chunkReloadGuard";

/**
 * The router's default error screen for a page that fails to load or render.
 *
 * A page whose code could not be fetched (the phone has no network and has not
 * opened that page before) is not a crash: it is told so in place, inside the
 * app's own frame (banner, tab bar), and opens by itself once the server
 * answers again. Any other error keeps the router's own error screen.
 */
export function RouteLoadError({ error, reset }: ErrorComponentProps) {
  if (!isChunkLoadError(error)) return <ErrorComponent error={error} />;
  return <ScreenNotLoaded reset={reset} />;
}

function ScreenNotLoaded({ reset }: { readonly reset: () => void }) {
  const router = useRouter();
  useEffect(
    () =>
      chunkRecovery().whenServerBack(() => {
        // One guarded reload fetches the page's code fresh; if that was already
        // tried, ask the router to load the page again.
        if (reloadOnceForChunkLoadError()) return;
        reset();
        void router.invalidate();
      }),
    [reset, router],
  );
  return (
    <div
      role="status"
      className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 px-8 text-center text-[var(--personal-text,inherit)]"
    >
      <WifiOff aria-hidden="true" className="size-8" strokeWidth={1.5} />
      <h1 className="text-[19px] font-bold">This screen isn't on your phone yet</h1>
      <p className="max-w-[360px] text-[15px] leading-[1.45] text-[var(--personal-text-secondary,inherit)]">
        It needs a connection the first time you open it. It opens by itself when you're back
        online.
      </p>
      <button
        type="button"
        onClick={() => {
          reset();
          void router.invalidate();
        }}
        className="mt-2 h-11 rounded-[var(--personal-radius-button,0.5rem)] bg-[var(--personal-primary,currentColor)] px-6 text-[15px] font-semibold text-[var(--personal-primary-text,inherit)]"
      >
        Try again
      </button>
    </div>
  );
}
