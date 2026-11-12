import { selectUsageCards } from "@hbots/personal-client/usage/usagePresentation";
import { DateTime } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import { useSystemSummary } from "../computer/useSystemSummary";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { useBotShells } from "../personal/useBotShells";
import { buildShortcutFeed, shortcutFeedKey } from "../shortcuts";
import { HEARTBEAT_MS } from "../working/workingFeed";
import { useWorkingThreads } from "../working/useWorkingThreads";
import { buildWidgetFeed, widgetFeedIsLive, type WidgetUsageInput } from "../widgetFeed";
import { nativeLauncher, type WidgetFeed } from "./nativeLauncher";

const ms = (value: string | DateTime.Utc | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const at = typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * Mounted while a session is ready. Keeps the launcher shortcuts and the home screen widgets in step
 * with the shared stores the screens read: on a change, on foreground, and on the 15 s working beat
 * (native ignores a repeat, except to stamp the feed as fresh).
 */
export function LauncherBridge({ native }: { readonly native: NativePersonal }) {
  const environmentId = native.environmentId as EnvironmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const working = useWorkingThreads(native);
  const botShells = useBotShells(native, environmentId);
  const providers = native.useProviders();
  const hiddenUsage = native.bots.useHiddenUsageProviders(environmentId);
  const tasks = native.automation.usePersonalTasks(environmentId).tasks;
  const routines = native.automation.usePersonalRoutines(environmentId).data;
  const system = useSystemSummary(native);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const bots = list.data?.bots ?? null;
  const links = list.data?.threads ?? null;
  const shortcuts = useMemo(() => (bots === null ? null : buildShortcutFeed(bots)), [bots]);

  const usage = useMemo((): WidgetUsageInput | null => {
    const card = selectUsageCards(providers, now, hiddenUsage).find(
      (entry) => entry.status === "ready" && (entry.session !== null || entry.weeklies.length > 0),
    );
    if (card === undefined) return null;
    return {
      title: card.title,
      sessionPct: card.session?.usedPercent ?? null,
      weekPct: card.weeklies[0]?.usedPercent ?? null,
      resets: card.session?.resetTimeLabel ?? null,
    };
  }, [providers, hiddenUsage, now]);

  const widget = useMemo((): WidgetFeed | null => {
    if (bots === null || links === null || working.status !== "ready") return null;
    const shellById = new Map(botShells.shells.map((shell) => [shell.id as string, shell]));
    return buildWidgetFeed({
      bots,
      threads: working.threads.map((thread) => {
        const since = ms(shellById.get(thread.threadId)?.latestTurn?.startedAt);
        return { ...thread, ...(since === null ? {} : { sinceMs: since }) };
      }),
      notes: working.notes,
      messages: links.flatMap((link) => {
        const message = link.newestMessage;
        if (link.archivedAt !== null || message === null || message === undefined) return [];
        if (message.hidden === true) return [];
        return [
          {
            threadId: link.threadId as string,
            botId: link.botId as string,
            role: message.role,
            text: message.text,
            atMs: ms(link.lastActivityAt ?? link.createdAt) ?? 0,
            chatTitle: shellById.get(link.threadId as string)?.title ?? "",
          },
        ];
      }),
      ...(tasks === null
        ? {}
        : {
            tasks: [...tasks.values()].map((task) => ({
              title: task.title,
              botId: task.botId as string,
              status: task.status,
              completedAtMs: ms(task.completedAt),
            })),
          }),
      ...(routines === null
        ? {}
        : {
            routines: routines.routines.map((routine) => ({
              title: routine.title,
              enabled: routine.enabled,
              nextDueAtMs: ms(routine.nextDueAt),
            })),
          }),
      usage,
      system,
      now,
    });
  }, [bots, links, working, botShells.shells, tasks, routines, usage, system, now]);

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

  const anyWorking = widgetFeedIsLive(widget);
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

function sendWidget(feed: WidgetFeed | null): void {
  if (feed === null || nativeLauncher === null) return;
  try {
    // Re-sent on purpose when nothing changed: native only stamps the time then.
    if (typeof nativeLauncher.setWidgetFeedJson === "function") {
      nativeLauncher.setWidgetFeedJson(JSON.stringify(feed));
      return;
    }
    // An APK from before the widget set: it knows the first widget's three fields only.
    nativeLauncher.setWidgetFeed(
      feed.bots.map((bot) => ({ botId: bot.botId, name: bot.name, working: bot.working })),
    );
  } catch (cause) {
    console.warn("Could not update the widgets.", cause);
  }
}
