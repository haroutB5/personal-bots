import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { PersonalPushPreferences } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { ChevronLeft } from "lucide-react";

import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { formatRelativeTime } from "./relativeTime";
import { applicationServerKeyFrom, isStandaloneDisplay, readyServiceWorker } from "./serviceWorker";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "./TaskDetailScreen";
import {
  personalPushSetPreferences,
  personalPushSubscribe,
  personalPushTest,
  personalPushUnsubscribe,
  usePersonalPushSettings,
} from "./usePersonalAutomation";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import { useMinuteNow } from "./useMinuteNow";

const CARD =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4";

const EVENTS: ReadonlyArray<{
  readonly key: keyof PersonalPushPreferences;
  readonly label: string;
}> = [
  { key: "taskCompleted", label: "A bot finishes a task" },
  { key: "taskNeedsInput", label: "A bot needs your input or approval" },
  { key: "taskFailed", label: "A task fails" },
  { key: "routineResult", label: "A routine finishes" },
  { key: "chatReply", label: "A bot replies in a chat you are not reading" },
];

/** A short, non-identifying name for this device in the device list. */
export function deviceLabelFrom(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  return "This device";
}

type Support = "checking" | "not-installed" | "no-worker" | "ready";

/** Settings > Notifications: opt in on this device, per-event toggles, test send. */
export function NotificationsScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const settings = usePersonalPushSettings(environmentId);
  const subscribe = useAtomCommand(personalPushSubscribe);
  const unsubscribe = useAtomCommand(personalPushUnsubscribe);
  const sendTest = useAtomCommand(personalPushTest);
  const setPreferences = useAtomCommand(personalPushSetPreferences);
  const [support, setSupport] = useState<Support>("checking");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // What this device can do: installed PWA, registered worker, existing subscription.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isStandaloneDisplay()) {
        if (!cancelled) setSupport("not-installed");
        return;
      }
      const registration = await readyServiceWorker();
      if (registration === null || !("pushManager" in registration)) {
        if (!cancelled) setSupport("no-worker");
        return;
      }
      const existing = await registration.pushManager.getSubscription();
      if (!cancelled) {
        setEndpoint(existing?.endpoint ?? null);
        setSupport("ready");
      }
    })().catch(() => {
      if (!cancelled) setSupport("no-worker");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    if (environmentId === null || settings.data === null) return;
    setBusy(true);
    setMessage(null);
    try {
      // The permission prompt only ever comes from this tap.
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") {
        setMessage("Notifications are blocked. Allow them for Bots in your phone's Settings.");
        return;
      }
      const registration = await readyServiceWorker();
      if (registration === null) {
        setMessage("The app's background worker is not running. Reopen Bots and try again.");
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKeyFrom(settings.data.publicKey),
        }));
      const json = subscription.toJSON();
      if (
        json.endpoint === undefined ||
        json.keys?.p256dh === undefined ||
        json.keys.auth === undefined
      ) {
        setMessage("This browser returned an incomplete subscription.");
        return;
      }
      const result = await subscribe({
        environmentId,
        input: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          deviceLabel: deviceLabelFrom(navigator.userAgent),
        },
      });
      const failure = commandFailureMessage(result, "Could not turn on notifications.");
      if (failure === null) setEndpoint(json.endpoint);
      setMessage(failure);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not turn on notifications.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (environmentId === null || endpoint === null) return;
    setBusy(true);
    setMessage(null);
    try {
      // Remove the server registration first so a failed RPC leaves this
      // device's working subscription available for a retry.
      const result = await unsubscribe({ environmentId, input: { endpoint } });
      const failure = commandFailureMessage(result, "Could not turn off notifications.");
      setMessage(failure);
      if (failure !== null) return;
      setEndpoint(null);
      const registration = await readyServiceWorker();
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not turn off notifications.");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (environmentId === null || endpoint === null) return;
    setBusy(true);
    const result = await sendTest({ environmentId, input: { endpoint } });
    setBusy(false);
    setMessage(
      commandFailureMessage(result, "Could not send a test notification.") ??
        "Test notification sent. It should arrive within a few seconds.",
    );
  };

  const toggle = async (key: keyof PersonalPushPreferences, value: boolean) => {
    if (environmentId === null || settings.data === null) return;
    const result = await setPreferences({
      environmentId,
      input: { ...settings.data.preferences, [key]: value },
    });
    setMessage(commandFailureMessage(result, "Could not save that setting."));
  };

  const now = useMinuteNow();
  return (
    <div className="flex flex-col gap-5 px-5 pb-8">
      <header className="flex h-14 items-center gap-1">
        <Link
          to="/bots/settings"
          aria-label="Back to Settings"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="text-[19px] font-bold text-[var(--personal-text)]">Notifications</h1>
      </header>

      <section className={CARD}>
        <h2 className="text-[15px] font-semibold text-[var(--personal-text)]">This device</h2>
        {support === "checking" ? (
          <p className="mt-1 text-[14px] text-[var(--personal-text-secondary)]">Checking…</p>
        ) : support === "not-installed" ? (
          <p className="mt-1 text-[14px] leading-snug text-[var(--personal-text-secondary)]">
            Add Bots to your Home Screen first. In Safari, tap Share, then Add to Home Screen, and
            open Bots from the new icon. Phones only allow notifications for installed apps.
          </p>
        ) : support === "no-worker" ? (
          <p className="mt-1 text-[14px] leading-snug text-[var(--personal-text-secondary)]">
            Notifications need the installed production app opened over HTTPS (your T3 Connect
            address). This copy of the app cannot receive them.
          </p>
        ) : endpoint === null ? (
          <>
            <p className="mt-1 text-[14px] leading-snug text-[var(--personal-text-secondary)]">
              Get a notification when a bot finishes, fails, or needs you. It only says which bot
              and which task, never message text.
            </p>
            {permission === "denied" ? (
              <p className="mt-2 text-[14px] text-[var(--personal-error)]">
                Notifications are blocked for Bots. Allow them in your phone's Settings, then come
                back here.
              </p>
            ) : null}
            <button
              type="button"
              className={`${PRIMARY_BUTTON} mt-3 w-full`}
              disabled={busy || settings.data === null || permission === "denied"}
              onClick={() => void enable()}
            >
              Enable notifications
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-[14px] text-[var(--personal-text-secondary)]">
              Notifications are on for this device.
            </p>
            <div className="mt-3 flex gap-2.5">
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={busy}
                onClick={() => void test()}
              >
                Send test notification
              </button>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={() => void disable()}
              >
                Turn off
              </button>
            </div>
          </>
        )}
        {message !== null ? (
          <p role="status" className="mt-3 text-[14px] text-[var(--personal-text)]">
            {message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="notify-events">
        <h2
          id="notify-events"
          className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-section-label)] uppercase"
        >
          Notify me when
        </h2>
        <ul className={`${CARD} divide-y divide-[var(--personal-border)] py-0`}>
          {EVENTS.map((event) => (
            <li key={event.key}>
              <label className="flex min-h-12 items-center justify-between gap-3 text-[15px] text-[var(--personal-text)]">
                {event.label}
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--personal-primary)]"
                  disabled={settings.data === null}
                  checked={settings.data?.preferences[event.key] ?? true}
                  onChange={(change) => void toggle(event.key, change.target.checked)}
                />
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
          These apply to every device that has notifications on.
        </p>
      </section>

      {settings.data !== null && settings.data.devices.length > 0 ? (
        <section aria-labelledby="notify-devices">
          <h2
            id="notify-devices"
            className="mb-2 px-1 text-[13px] font-semibold tracking-wide text-[var(--personal-section-label)] uppercase"
          >
            Devices
          </h2>
          <ul className={`${CARD} divide-y divide-[var(--personal-border)] py-0`}>
            {settings.data.devices.map((device) => (
              <li
                key={device.subscriptionId}
                className="flex min-h-12 flex-col justify-center py-2"
              >
                <span className="text-[15px] text-[var(--personal-text)]">
                  {device.deviceLabel || "Device"} · {device.endpointHost}
                </span>
                <span className="text-[13px] text-[var(--personal-text-secondary)]">
                  {device.lastError !== null && device.lastFailureAt !== null
                    ? `Last attempt failed ${formatRelativeTime(DateTime.toEpochMillis(device.lastFailureAt), now)}: ${device.lastError}`
                    : device.lastSuccessAt !== null
                      ? `Last delivered ${formatRelativeTime(DateTime.toEpochMillis(device.lastSuccessAt), now)}`
                      : "Nothing sent yet"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
