import { systemStatParts, type SystemSummary } from "@hbots/personal-client/computer/systemStats";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "./tokens";

const POLL_MS = 10_000;
const RETRY_MS = 30_000;

/**
 * The PC at a glance under the Bots header: CPU, RAM and free disk, a busy
 * figure inked amber. Keeps its 16px row from the first paint so the list
 * never jumps, exactly as the web line does.
 */
export function SystemStatsLine({ native }: { readonly native: NativePersonal }) {
  const [summary, setSummary] = useState<SystemSummary | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = (delay: number) => {
      if (!mounted.current) return;
      timer = setTimeout(() => void ask(), delay);
    };

    const ask = async () => {
      if (!mounted.current || inFlight) return;
      inFlight = true;
      const next = await native.readSystemSummary();
      inFlight = false;
      if (!mounted.current) return;
      if (next === null) {
        schedule(RETRY_MS);
        return;
      }
      setSummary(next);
      schedule(POLL_MS);
    };

    void ask();
    return () => {
      mounted.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [native]);

  const parts = summary === null ? [] : systemStatParts(summary);
  return (
    <View style={styles.line}>
      {parts.length > 0 ? (
        <Text
          style={styles.text}
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          ellipsizeMode="tail"
        >
          {parts.map((part, index) => (
            <Text key={part.key} style={part.busy ? styles.busy : undefined}>
              {index > 0 ? " · " : ""}
              {part.text}
            </Text>
          ))}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    minHeight: 16,
    marginTop: -6,
    marginBottom: 4,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  text: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  busy: { color: tokens.reviewText },
});
