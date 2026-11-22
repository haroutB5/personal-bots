import { systemStatParts } from "@hbots/personal-client/computer/systemStats";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import {
  laptopSummary,
  serverAppsParts,
  serverAriaLabel,
  serverStatParts,
  type ServerLinePart,
} from "../computer/serverStats";
import { useSystemSummary } from "../computer/useSystemSummary";
import { tokens } from "./tokens";

function PartsText({ parts }: { readonly parts: ReadonlyArray<ServerLinePart> }) {
  return (
    <Text
      style={styles.text}
      numberOfLines={1}
      maxFontSizeMultiplier={1.2}
      ellipsizeMode="tail"
      importantForAccessibility="no"
    >
      {parts.map((part, index) => (
        <Text key={part.key} style={part.busy ? styles.busy : undefined}>
          {index > 0 ? " · " : ""}
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The laptop line (16px from first paint so the list never jumps), then the
 * app server's stats and Coolify health lines, which take no room when the
 * server sends nothing. Busy figures are amber.
 */
export function SystemStatsLine({ native }: { readonly native: NativePersonal }) {
  const summary = useSystemSummary(native);
  const parts = summary === null ? [] : systemStatParts(laptopSummary(summary));
  const server = summary?.server ?? null;
  const apps = summary?.serverApps ?? null;
  const serverParts = serverStatParts(server);
  const appParts = serverAppsParts(apps);
  return (
    <>
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
      {serverParts.length > 0 || appParts.length > 0 ? (
        <View
          style={styles.serverBlock}
          accessible
          accessibilityRole="text"
          accessibilityLabel={serverAriaLabel(server, apps) ?? undefined}
        >
          {serverParts.length > 0 ? <PartsText parts={serverParts} /> : null}
          {appParts.length > 0 ? <PartsText parts={appParts} /> : null}
        </View>
      ) : null}
    </>
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
  serverBlock: { marginBottom: 4, paddingHorizontal: 20 },
  text: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  busy: { color: tokens.reviewText },
});
