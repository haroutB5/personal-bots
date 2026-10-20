import type { JSX, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import type { EnvironmentId, ProviderAuthState, ProviderInstanceId } from "@t3tools/contracts";
import { ClipboardPaste, Copy, ExternalLink, Laptop, Lock } from "lucide-react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import { checkPastedAddress, minutesLeft } from "./signInAddress";
import {
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  BUTTON_QUIET,
  FIELD,
  FOCUS,
  ProviderNote,
} from "./providerUi";

/** A numbered mini step: a 22 px disc and the words. */
function Mini({ n, children }: { readonly n: number; readonly children: ReactNode }): JSX.Element {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[12px] font-semibold text-[var(--personal-text)]"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
        {children}
      </div>
    </li>
  );
}

/** The small drawing of Safari's address bar with the address selected. */
function SafariBar(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="mt-2 rounded-[12px] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-2"
    >
      <div className="flex items-center gap-2 rounded-[10px] bg-[var(--personal-fill-muted)] px-2 py-1.5">
        <Lock className="size-3.5 shrink-0 text-[var(--personal-text-secondary)]" />
        <span
          className="min-w-0 truncate rounded-xs px-1 text-[13px] text-white"
          style={{ backgroundColor: "#0b5fcc" }}
        >
          127.0.0.1:51121/oauth-callback?code=4%2F0A…
        </span>
      </div>
      <p className="mt-1.5 px-1 text-[12px] text-[var(--personal-text-secondary)]">
        Safari can't connect to the server.
      </p>
    </div>
  );
}

/**
 * Step 2 of the setup card for a sign-in that ends on the laptop's own address
 * (Antigravity today): open the Google link, copy the address Safari then
 * shows and paste it here, or sign in on the laptop itself. The flow runs on
 * the server; this only draws its state and sends the pasted address. Nothing
 * pasted here is logged, and the field is dropped with the flow.
 */
export function SignInRedirect({
  environmentId,
  instanceId,
  auth,
  providerLabel,
  canOpenOnLaptop,
  autoStart = false,
  onFinished,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly auth: ProviderAuthState | null;
  readonly providerLabel: string;
  readonly canOpenOnLaptop: boolean;
  /** Start the flow as soon as the screen opens (the list's Sign in button). */
  readonly autoStart?: boolean;
  /** The flow ended in success: the page re-reads the provider. */
  readonly onFinished?: () => void;
}): JSX.Element {
  const options = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const openOnLaptop = useAtomCommand(serverEnvironment.openProviderAuthOnLaptop, options);

  const [busy, setBusy] = useState<"start" | "send" | "cancel" | "laptop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [draft, setDraft] = useState({ flowId: null as string | null, value: "" });
  const [copied, setCopied] = useState(false);
  const [openedOnLaptop, setOpenedOnLaptop] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pasteRing, setPasteRing] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  const flowId = auth?.flowId ?? null;
  const phase = auth?.phase ?? "idle";
  const url = phase === "waiting" ? (auth?.authorizationUrl ?? null) : null;
  const value = draft.flowId === flowId ? draft.value : "";

  useEffect(() => {
    if (url === null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [url]);

  // Back from Safari: focus the field and ring Paste. The clipboard is never
  // read until the Paste button is tapped.
  useEffect(() => {
    if (url === null) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setPasteRing(true);
      fieldRef.current?.focus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [url]);

  useEffect(() => {
    if (phase === "succeeded") onFinished?.();
  }, [phase, onFinished]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current || auth === null || phase !== "idle") return;
    autoStarted.current = true;
    void startAuth({ environmentId, input: { instanceId } });
  }, [autoStart, auth, phase, startAuth, environmentId, instanceId]);

  const run = async (
    kind: NonNullable<typeof busy>,
    request: () => Promise<Parameters<typeof commandFailureMessage>[0]>,
    fallback: string,
  ): Promise<boolean> => {
    if (busy !== null) return false;
    setBusy(kind);
    setError(null);
    const result = await request();
    setBusy(null);
    const failure = commandFailureMessage(result, fallback);
    if (failure !== null) setError(failure);
    return failure === null;
  };

  const start = async () => {
    setDenied(false);
    setFieldError(null);
    setOpenedOnLaptop(false);
    await run(
      "start",
      () => startAuth({ environmentId, input: { instanceId } }),
      `Couldn't start the ${providerLabel} sign-in.`,
    );
  };

  const openPage = () => {
    if (url === null) return;
    // A real tap opens it, so iOS hands it to Safari.
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened === null) setError("Couldn't open the sign-in page. Tap the copy button instead.");
  };

  const copyLink = async () => {
    if (url === null) return;
    try {
      await writeTextToClipboard(url, "Sign-in link");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy the link. Tap Open sign-in page instead.");
    }
  };

  const paste = async () => {
    setPasteRing(false);
    try {
      const text = await navigator.clipboard.readText();
      setDraft({ flowId, value: text });
      setFieldError(null);
    } catch {
      setFieldError("Couldn't read the clipboard. Press and hold in the box, then tap Paste.");
    }
  };

  const send = async () => {
    if (flowId === null) return;
    const checked = checkPastedAddress(value, url);
    if (!checked.ok) {
      setFieldError(checked.message);
      setDenied(checked.kind === "denied");
      return;
    }
    setFieldError(null);
    const ok = await run(
      "send",
      () =>
        completeAuth({
          environmentId,
          input: { instanceId, flowId, callbackUrl: checked.address },
        }),
      `Couldn't finish the ${providerLabel} sign-in.`,
    );
    if (ok) setDraft({ flowId: null, value: "" });
  };

  const cancel = async () => {
    if (flowId === null) return;
    await run(
      "cancel",
      () => cancelAuth({ environmentId, input: { instanceId, flowId } }),
      "Couldn't cancel the sign-in.",
    );
  };

  const onLaptop = async () => {
    if (flowId === null) return;
    const ok = await run(
      "laptop",
      () => openOnLaptop({ environmentId, input: { instanceId, flowId } }),
      "Couldn't open the sign-in page on the laptop.",
    );
    if (ok) setOpenedOnLaptop(true);
  };

  const left = minutesLeft(auth?.expiresAt ?? null, nowMs);

  // Not started, ended or expired: one button.
  if (phase === "idle" || phase === "cancelled" || phase === "succeeded" || phase === "failed") {
    return (
      <div className="flex flex-col gap-3" data-signin="start">
        {phase === "failed" ? (
          <ProviderNote
            tone="danger"
            title={`${providerLabel} sign-in failed`}
            actions={
              <button type="button" onClick={() => void start()} className={BUTTON_PRIMARY}>
                Start again
              </button>
            }
          >
            {auth?.message ?? "Nothing was saved. Start again for a new link."}
          </ProviderNote>
        ) : (
          <>
            <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
              Sign in with your {providerLabel} account. hbots shows you a link, and you bring one
              address back.
            </p>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy !== null}
              aria-busy={busy === "start"}
              className={`${BUTTON_PRIMARY} w-full`}
            >
              {busy === "start" ? "Starting sign-in…" : `Sign in with ${providerLabel}`}
            </button>
          </>
        )}
        {error !== null ? (
          <p role="alert" className="text-sm text-[var(--personal-error)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (phase === "starting") {
    return (
      <p role="status" className="text-[15px] text-[var(--personal-text-secondary)]">
        Starting {providerLabel} sign-in…
      </p>
    );
  }

  if (phase === "verifying") {
    return (
      <p role="status" className="text-[15px] text-[var(--personal-text-secondary)]">
        Checking the sign-in and the available models…
      </p>
    );
  }

  // waiting
  if (url === null) {
    // Another client owns this flow: nothing to open here.
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-[15px] text-[var(--personal-text-secondary)]">
          Sign-in is open on another device. Finish it there, or start again here.
        </p>
        <button type="button" onClick={() => void cancel()} className={BUTTON_OUTLINE}>
          Cancel sign-in
        </button>
      </div>
    );
  }

  if (left === 0) {
    return (
      <ProviderNote
        tone="danger"
        title="The sign-in link expired"
        actions={
          <button type="button" onClick={() => void start()} className={BUTTON_PRIMARY}>
            Start again
          </button>
        }
      >
        Links work for 10 minutes. Start again for a new one.
      </ProviderNote>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-signin="redirect">
      <ol className="flex flex-col gap-4">
        <Mini n={1}>
          <span className="font-medium text-[var(--personal-text)]">
            Open the {providerLabel} sign-in page
          </span>{" "}
          and choose your account.
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={openPage} className={`${BUTTON_PRIMARY} min-w-0 flex-1`}>
              <ExternalLink aria-hidden="true" className="mr-2 size-[18px]" strokeWidth={1.75} />
              Open sign-in page
            </button>
            <button
              type="button"
              onClick={() => void copyLink()}
              aria-label={copied ? "Link copied" : "Copy the sign-in link"}
              className={`${BUTTON_OUTLINE} w-11 px-0`}
            >
              <Copy aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
            </button>
          </div>
          {copied ? (
            <p role="status" className="mt-1 text-[13px] text-[var(--personal-text-secondary)]">
              Link copied
            </p>
          ) : null}
        </Mini>
        <Mini n={2}>
          Safari then says it{" "}
          <span className="font-medium text-[var(--personal-text)]">can't connect</span>. That's
          expected: the page is meant for your laptop.{" "}
          <span className="font-medium text-[var(--personal-text)]">
            Tap the address bar and copy the address.
          </span>
          <SafariBar />
        </Mini>
        <Mini n={3}>
          <span className="font-medium text-[var(--personal-text)]">Paste the address</span>
          <div className="mt-2 flex gap-2">
            <input
              ref={fieldRef}
              value={value}
              onChange={(event) => {
                setDraft({ flowId, value: event.target.value });
                setFieldError(null);
                setDenied(false);
              }}
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={16_384}
              aria-label="The address from Safari"
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError !== null ? "signin-address-error" : undefined}
              placeholder="http://127.0.0.1…"
              className={`${FIELD} flex-1 font-mono text-[14px]`}
            />
            <button
              type="button"
              onClick={() => void paste()}
              className={`${BUTTON_OUTLINE} ${pasteRing ? "ring-2 ring-[var(--personal-text)]" : ""}`}
            >
              <ClipboardPaste
                aria-hidden="true"
                className="mr-1.5 size-[18px]"
                strokeWidth={1.75}
              />
              Paste
            </button>
          </div>
          {fieldError !== null ? (
            <p
              id="signin-address-error"
              role="alert"
              className="mt-2 text-[14px] leading-5 text-[var(--personal-error)]"
            >
              {fieldError}
            </p>
          ) : null}
        </Mini>
      </ol>

      {denied ? (
        <ProviderNote
          tone="danger"
          title="Google says you said no"
          actions={
            <button type="button" onClick={() => void start()} className={BUTTON_PRIMARY}>
              Start again
            </button>
          }
        >
          Start again to try once more.
        </ProviderNote>
      ) : (
        <button
          type="button"
          onClick={() => void send()}
          disabled={value.trim().length === 0 || busy !== null}
          aria-busy={busy === "send"}
          className={`${BUTTON_PRIMARY} w-full`}
        >
          {busy === "send" ? "Signing in…" : "Sign in"}
        </button>
      )}

      {canOpenOnLaptop ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void onLaptop()}
            disabled={busy !== null}
            className={`${BUTTON_QUIET} w-full justify-start gap-3 px-0 text-left text-[15px] font-medium`}
          >
            <Laptop aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0">Or sign in on this laptop, no copying</span>
          </button>
          {openedOnLaptop ? (
            <p
              role="status"
              className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]"
            >
              Opened in the laptop's own browser. Choose your account there. This page moves on by
              itself when you're done.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-[var(--personal-text-tertiary)]">
          {left === null
            ? ""
            : left === 0
              ? "The link has expired."
              : `The link works for ${left} more ${left === 1 ? "minute" : "minutes"}.`}
        </p>
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={busy !== null}
          className={`${BUTTON_QUIET} ${FOCUS}`}
        >
          Cancel
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
