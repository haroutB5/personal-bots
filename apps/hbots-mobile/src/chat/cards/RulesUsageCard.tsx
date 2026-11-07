import type { PersonalMemoryRulesUsage } from "@t3tools/contracts";
import { rulesUsageCardModel } from "@hbots/personal-client/memory/presentation";
import { StyleSheet, Text, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";

/**
 * The rules limit warning, as the Memory screen shows it on the web. On the
 * phone it also shows above the chat when the bot's rules are near the limit,
 * because that is the turn the limit applies to.
 */
export function RulesUsageCard({ usage }: { readonly usage: PersonalMemoryRulesUsage }) {
  const model = rulesUsageCardModel(usage);
  if (model === null) return null;
  return (
    <View style={cardStyles.card} accessibilityLabel="Rules limit">
      <Text style={cardStyles.headline}>{model.headline}</Text>
      <Text style={cardStyles.secondary}>{model.detail}</Text>
      <View style={{ marginTop: 10, gap: 10 }}>
        {model.rows.map((row) => (
          <View key={row.key}>
            <Text style={{ color: tokens.text, fontSize: 13, fontWeight: "500" }}>{row.label}</Text>
            <Text style={{ color: tokens.textSecondary, fontSize: 12 }}>{row.line}</Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${Math.round(row.share * 100)}%`,
                    opacity: row.share >= 1 ? 1 : 0.6,
                  },
                ]}
              />
            </View>
          </View>
        ))}
      </View>
      {model.leftOut.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <Text style={cardStyles.label}>Would be left out</Text>
          <View style={{ marginTop: 4, gap: 6 }}>
            {model.leftOut.map((rule) => (
              <Text
                key={rule.memoryId}
                style={{
                  borderLeftWidth: 2,
                  borderLeftColor: tokens.border,
                  paddingLeft: 8,
                  color: tokens.text,
                  fontSize: 13,
                  lineHeight: 18,
                }}
              >
                {rule.content}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    marginTop: 4,
    height: 3,
    width: "100%",
    borderRadius: 2,
    backgroundColor: tokens.fillMuted,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: tokens.text,
  },
});
