import {
  isServerUpdateFinished,
  serverUpdatePollMs,
  UPDATED_SHOWN_MS,
  visibleServerUpdate,
  type ServerUpdate,
} from "@hbots/personal-client/update/serverUpdate";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useBotShells } from "../personal/useBotShells";
import { tokens } from "./tokens";

interface Polled {
  readonly update: ServerUpdate | null;
  readonly answeredAtMs: number | null;
  readonly reachable: boolean;
  readonly nowMs: number;
}

// When this app run first showed "Updated to x", by version. The banner sits on several
// screens, so the ten seconds are counted once for all of them.
const updatedFirstShown = new Map<string, number>();

function updatedShownAt(update: ServerUpdate | null, nowMs: number): number | null {
  if (!isServerUpdateFinished(update) || nowMs === 0) return null;
  const version = update?.version ?? "";
  const known = updatedFirstShown.get(version);
  if (known !== undefined) return known;
  updatedFirstShown.set(version, nowMs);
  return nowMs;
}

const START: Polled = { update: null, answeredAtMs: null, reachable: true, nowMs: 0 };

/**
 * Two lines about a server update while one is under way: what stage it is at,
 * and who it waits for or how long is left. Nothing when no update runs.
 */
export function ServerUpdateBanner({ native }: { readonly native: NativePersonal }) {
  const [polled, setPolled] = useState<Polled>(START);
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const { shells } = useBotShells(native, native.environmentId);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: ServerUpdate | null = null;
    const ask = async () => {
      const answer = await native.readServerUpdate();
      if (stopped) return;
      const nowMs = Date.now();
      if (answer !== null) last = answer;
      setPolled((previous) =>
        answer === null
          ? { ...previous, reachable: false, nowMs }
          : { update: answer, answeredAtMs: nowMs, reachable: true, nowMs },
      );
      timer = setTimeout(() => void ask(), serverUpdatePollMs(last, answer !== null));
    };
    void ask();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [native]);

  const names = useMemo(() => {
    const botNames = new Map((list.data?.bots ?? []).map((bot) => [bot.botId as string, bot.name]));
    const titles = new Map(shells.map((shell) => [shell.id as string, shell.title]));
    const byThread = new Map<string, string>();
    for (const link of list.data?.threads ?? []) {
      const bot = botNames.get(link.botId);
      if (bot === undefined) continue;
      const title = titles.get(link.threadId)?.trim() ?? "";
      byThread.set(link.threadId, title.length > 0 ? `${bot} in ${title}` : bot);
    }
    return byThread;
  }, [list.data, shells]);

  const shownAt = updatedShownAt(polled.update, polled.nowMs);
  // The note leaves on time, not at the next poll a minute later.
  useEffect(() => {
    if (shownAt === null) return;
    const left = shownAt + UPDATED_SHOWN_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(
      () => setPolled((previous) => ({ ...previous, nowMs: Date.now() })),
      left + 50,
    );
    return () => clearTimeout(timer);
  }, [shownAt]);

  const lines = visibleServerUpdate({
    update: polled.update,
    updatedFirstShownMs: shownAt,
    answeredAtMs: polled.answeredAtMs,
    reachable: polled.reachable,
    nowMs: polled.nowMs,
    nameOfThread: (threadId) => names.get(threadId) ?? null,
  });
  if (lines === null) return null;
  return (
    <View
      style={[styles.banner, lines.tone === "problem" ? styles.problem : null]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="server-update-banner"
    >
      <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={1.3}>
        {lines.title}
      </Text>
      {lines.detail === null ? null : (
        <Text style={styles.detail} numberOfLines={2} maxFontSizeMultiplier={1.3}>
          {lines.detail}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 40,
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 20,
    paddingVertical: 8,
    gap: 2,
  },
  problem: { backgroundColor: tokens.reviewBg, borderBottomColor: tokens.reviewBorder },
  title: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  detail: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
});
