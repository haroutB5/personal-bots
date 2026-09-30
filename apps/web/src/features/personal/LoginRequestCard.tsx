import type { JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { PersonalLoginRequest } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { Check, Eye, EyeOff, KeyRound } from "lucide-react";

export type ProvideLogin = (
  requestId: string,
  username: Redacted.Redacted<string>,
  password: Redacted.Redacted<string>,
  save: boolean,
) => void;

const BUTTON_CLASS = "personal-login-button";
const INPUT_CLASS = "personal-login-input";

export function LoginRequestCard({
  request,
  botName,
  onProvide,
  onCancel,
}: {
  request: PersonalLoginRequest;
  botName: string;
  onProvide: ProvideLogin;
  onCancel: (requestId: string) => void;
}): JSX.Element {
  const [expired, setExpired] = useState(() => Date.parse(request.expiresAt) <= Date.now());
  useEffect(() => {
    const remaining = Date.parse(request.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [request.expiresAt]);
  const host = new URL(request.origin).host;
  if (request.status === "pending" && !expired) {
    return (
      <PendingLoginRequestCard
        request={request}
        botName={botName}
        onProvide={onProvide}
        onCancel={onCancel}
      />
    );
  }
  const status = request.status === "pending" ? "expired" : request.status;
  const text = {
    filling: `Sending details to ${request.origin}…`,
    filled: `Details sent to ${request.origin}${request.saved ? " · saved" : ""}`,
    cancelled: "Cancelled",
    expired: "This sign-in request expired.",
    "origin-mismatch": "The browser left this site. Request sign-in again on the matching site.",
    "fill-failed": "Couldn’t fill the sign-in form. The bot can ask for browser help.",
  }[status];
  return (
    <section
      aria-label={`Sign in to ${host}`}
      className="personal-login-card personal-login-settled"
    >
      <p role="status" className="personal-login-status">
        {status === "filled" ? (
          <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0" />
        ) : null}
        <span>{text}</span>
      </p>
    </section>
  );
}

function PendingLoginRequestCard({
  request,
  botName,
  onProvide,
  onCancel,
}: {
  request: PersonalLoginRequest;
  botName: string;
  onProvide: ProvideLogin;
  onCancel: (requestId: string) => void;
}): JSX.Element {
  // Credentials never enter drafts, query caches or conversation messages.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(true);
  const [visible, setVisible] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const claimed = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldId = useId();
  const host = new URL(request.origin).host;
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const reveal = () => {
      if (formRef.current?.contains(document.activeElement)) {
        actionsRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
    };
    viewport.addEventListener("resize", reveal);
    return () => viewport.removeEventListener("resize", reveal);
  }, []);

  const clear = () => {
    setUsername("");
    setPassword("");
    setVisible(false);
    setSubmitted(true);
  };
  return (
    <section aria-label={`${botName} needs a sign-in`} className="personal-login-card">
      <p className="personal-login-title">
        <KeyRound aria-hidden="true" className="size-4 shrink-0" />
        {botName} needs a sign-in
      </p>
      <p className="personal-login-origin">{request.origin}</p>
      {request.reason.trim() ? <p className="personal-login-help">{request.reason}</p> : null}
      {submitted ? (
        <p role="status" className="personal-login-status mt-3">
          Sending your response…
        </p>
      ) : (
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              claimed.current ||
              username.length === 0 ||
              password.length === 0 ||
              Date.parse(request.expiresAt) <= Date.now()
            )
              return;
            claimed.current = true;
            const providedUsername = Redacted.make(username);
            const providedPassword = Redacted.make(password);
            clear();
            onProvide(request.requestId, providedUsername, providedPassword, save);
          }}
        >
          <label htmlFor={`${fieldId}-username`} className="personal-login-label">
            Username or email
          </label>
          <input
            id={`${fieldId}-username`}
            name="username"
            autoComplete="username"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="next"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className={INPUT_CLASS}
          />
          <label htmlFor={`${fieldId}-password`} className="personal-login-label">
            Password
          </label>
          <div className="relative">
            <input
              id={`${fieldId}-password`}
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="current-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={`${INPUT_CLASS} personal-login-password`}
            />
            <button
              type="button"
              aria-label={visible ? "Hide password" : "Show password"}
              aria-pressed={visible}
              onClick={() => setVisible((current) => !current)}
              className="personal-login-visibility"
            >
              {visible ? (
                <EyeOff aria-hidden="true" className="size-4" />
              ) : (
                <Eye aria-hidden="true" className="size-4" />
              )}
            </button>
          </div>
          <label className="personal-login-save">
            Save for next time
            <input
              type="checkbox"
              role="switch"
              aria-label="Save for next time"
              checked={save}
              onChange={(event) => setSave(event.target.checked)}
              className="personal-login-switch"
            />
          </label>
          <p className="personal-login-help">
            Your details are used only for {host}. {botName} never sees them.
          </p>
          <div ref={actionsRef} className="mt-3 flex items-center gap-2 scroll-mb-4">
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => {
                if (claimed.current) return;
                claimed.current = true;
                clear();
                onCancel(request.requestId);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={username.length === 0 || password.length === 0}
              className={`${BUTTON_CLASS} personal-login-submit`}
            >
              Sign in
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
