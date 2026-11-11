import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { buildShortcutFeed, shortcutFeedKey } from "../shortcuts";
import { HEARTBEAT_MS } from "../working/workingFeed";
import { useWorkingThreads } from "../working/useWorkingThreads";
import { buildWidgetFeed } from "../widgetFeed";
import { nativeLauncher } from "./nativeLauncher";

/**
 * Mounted while a session is ready. It keeps the launcher shortcuts and the home screen widget in
 * step with the pins and with which bots are working: when either changes, when the app comes to
 * the foreground, and on the same 15 s beat as the "bots working" notification while a bot runs
 * (native ignores a repeat, except to stamp the widget's working dots as fresh).
 */
export function LauncherBridge({ native }: { readonly native: NativePersonal }) {
  const environmentId = native.environmentId as EnvironmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const working = useWorkingThreads(native);

  const bots = list.data?.bots ?? null;
  const shortcuts = useMemo(() => (bots === null ? null : buildShortcutFeed(bots)), [bots]);
  const widget = useMemo(() => {
    if (bots === null || working.status !== "ready") return null;
    return buildWidgetFeed(bots, new Set(working.threads.map((thread) => thread.botId)));
  }, [bots, working]);

  const lastShortcuts = useRef<string | null>(null);
  useEffect(() => {
    if (shortcuts === null) return;
    const key = shortcutFeedKey(shortcuts);
    if (key === lastShortcuts.current) return;
    lastShortcuts.current = key;
    try {
      nativeLauncher?.setShortcuts(shortcuts.map((bot) => ({ ...bot })));
    } catch (cause) {
      console.warn("Could not update the launcher shortcuts.", cause);
    }
  }, [shortcuts]);

  const widgetRef = useRef(widget);
  useEffect(() => {
    widgetRef.current = widget;
    sendWidget(widget);
  }, [widget]);

  const anyWorking = widget?.some((bot) => bot.working) ?? false;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") sendWidget(widgetRef.current);
    });
    const timer = anyWorking
      ? setInterval(() => sendWidget(widgetRef.current), HEARTBEAT_MS)
      : null;
    return () => {
      subscription.remove();
      if (timer !== null) clearInterval(timer);
    };
  }, [anyWorking]);

  return null;
}

function sendWidget(feed: ReturnType<typeof buildWidgetFeed> | null): void {
  if (feed === null) return;
  try {
    // Re-sent on purpose when nothing changed: native only stamps the time then.
    nativeLauncher?.setWidgetFeed(feed.map((bot) => ({ ...bot })));
  } catch (cause) {
    console.warn("Could not update the widget.", cause);
  }
}
