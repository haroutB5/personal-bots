import type { PersonalBot, PersonalBotTokenUsageWindowId } from "@t3tools/contracts";
import {
  DEFAULT_TOKEN_USAGE_WINDOW,
  TOKEN_USAGE_WINDOWS,
  buildTokenUsageModelRows,
  formatCostCompact,
  formatIdleBots,
  formatModelsAndShare,
  formatShare,
  formatTokenCount,
  providerColor,
  tokenUsageBotButtonLabel,
} from "@hbots/personal-client/usage/tokenUsagePresentation";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotUsageSheet } from "../sheets/BotUsageSheet";
import { tokens } from "../shell/tokens";
import { teamUsageModel } from "./teamScreenModel";

/** Keep the open card current without asking on every render. */
const REFRESH_MS = 10 * 60_000;
/** The first scan after a restart can take a minute, so poll while it counts. */
const POLL_MS = 4_000;
const MAX_POLLS = 30;

const USAGE_VIEWS = [
  { id: "bot", label: "By bot" },
  { id: "model", label: "By model" },
] as const;

type UsageView = (typeof USAGE_VIEWS)[number]["id"];

/**
 * Token usage under the team cards, the phone form of the web Team page's
 * table: the range, the total and each provider's share. The list shows one
 * row per bot or, switched, one row per provider and model. A bot row opens
 * that bot's sheet on the same range.
 */
export function TeamTokenUsage({
  native,
  bots,
  listedBotIds,
  modelNames,
  nowMs,
  onOpenChats,
}: {
  readonly native: NativePersonal;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly listedBotIds: ReadonlySet<string>;
  readonly modelNames: ReadonlyMap<string, string>;
  readonly nowMs: number;
  readonly onOpenChats: (botId: string) => void;
}) {
  const usage = native.bots.usePersonalTokenUsage(native.environmentId);
  const [windowId, setWindowId] = useState<PersonalBotTokenUsageWindowId>(
    DEFAULT_TOKEN_USAGE_WINDOW,
  );
  const [view, setView] = useState<UsageView>("bot");
  const [openBotId, setOpenBotId] = useState<string | null>(null);
  const [openModelKey, setOpenModelKey] = useState<string | null>(null);
  const model = teamUsageModel({
    result: usage.data,
    windowId,
    bots,
    listedBotIds,
    modelNames,
    nowMs,
  });
  const modelRows = model.table === null ? [] : buildTokenUsageModelRows(model.table);
  const sheetBot =
    openBotId === null ? null : (bots.find((bot) => bot.botId === openBotId) ?? null);
  const selectWindow = (id: PersonalBotTokenUsageWindowId) => {
    setWindowId(id);
    setOpenModelKey(null);
  };
  const selectView = (id: UsageView) => {
    setView(id);
    setOpenModelKey(null);
  };

  useEffect(() => {
    const timer = setInterval(usage.refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [usage.refresh]);

  const pending = model.pending;
  useEffect(() => {
    if (!pending) return;
    let polls = 0;
    const timer = setInterval(() => {
      if (polls >= MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      polls += 1;
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh is stable from the usage view
      usage.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, usage.refresh]);

  const retry = () => {
    usage.refresh();
  };

  return (
    <View style={styles.card} accessibilityLabel="Token usage">
      <View style={styles.header}>
        <Text style={styles.heading} accessibilityRole="header" maxFontSizeMultiplier={1.4}>
          Token usage
        </Text>
        {model.span === null ? null : (
          <Text style={styles.span} maxFontSizeMultiplier={1.3}>
            {model.span}
          </Text>
        )}
      </View>

      <View style={styles.ranges}>
        {TOKEN_USAGE_WINDOWS.map((range) => {
          const selected = range.id === windowId;
          return (
            <Pressable
              key={range.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={range.label}
              onPress={() => selectWindow(range.id)}
              style={[styles.range, selected ? styles.rangeSelected : null]}
            >
              <Text
                style={[styles.rangeText, selected ? styles.rangeTextSelected : null]}
                maxFontSizeMultiplier={1.4}
              >
                {range.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {model.table !== null ? (
        model.table.total === 0 ? (
          <View style={styles.block}>
            <Text style={styles.total} maxFontSizeMultiplier={1.3}>
              0
            </Text>
            <Text style={styles.muted} maxFontSizeMultiplier={1.4}>
              {`tokens ${model.periodWord}`}
            </Text>
            <Text style={styles.note} maxFontSizeMultiplier={1.4}>
              {`No bot used tokens ${model.periodWord}.`}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.hero}>
              <Text style={styles.total} maxFontSizeMultiplier={1.3}>
                {formatTokenCount(model.table.total)}
              </Text>
              <Text style={styles.muted} maxFontSizeMultiplier={1.4}>
                tokens, all providers
              </Text>
              <Text style={styles.cost} maxFontSizeMultiplier={1.3}>
                {`${formatCostCompact(model.table.totalCost)} API estimate`}
              </Text>
            </View>

            <View style={styles.providers}>
              {model.table.providers.map((provider) => (
                <View key={provider.provider} style={styles.providerRow}>
                  <Text style={styles.providerName} maxFontSizeMultiplier={1.4}>
                    {provider.label}
                  </Text>
                  <Text style={styles.providerValue} maxFontSizeMultiplier={1.3}>
                    {`${formatTokenCount(provider.tokens)} · ${formatShare(provider.sharePercent)}`}
                  </Text>
                </View>
              ))}
            </View>

            <View style={styles.sectionLine} />
            <View style={styles.viewHeader}>
              <View style={styles.viewSwitch} accessibilityRole="tablist">
                {USAGE_VIEWS.map((option) => {
                  const selected = option.id === view;
                  return (
                    <Pressable
                      key={option.id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      accessibilityLabel={option.label}
                      onPress={() => selectView(option.id)}
                      style={[styles.viewOption, selected ? styles.viewOptionSelected : null]}
                    >
                      <Text
                        style={[
                          styles.viewOptionText,
                          selected ? styles.viewOptionTextSelected : null,
                        ]}
                        maxFontSizeMultiplier={1.3}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {view === "bot" ? (
                <Text style={styles.viewHint} maxFontSizeMultiplier={1.3}>
                  Tap a bot for its models
                </Text>
              ) : null}
            </View>
            {view === "bot" ? (
              <View style={styles.botRows}>
                {model.table.rows.map((row) => (
                  <Pressable
                    key={row.botId}
                    accessibilityRole="button"
                    accessibilityLabel={tokenUsageBotButtonLabel(row)}
                    onPress={() => setOpenBotId(row.botId)}
                    style={({ pressed }) => [styles.botRow, pressed ? styles.pressed : null]}
                  >
                    <View style={styles.botRank}>
                      {row.rank === null ? null : (
                        <Text style={styles.rankText} maxFontSizeMultiplier={1.3}>
                          {String(row.rank)}
                        </Text>
                      )}
                    </View>
                    <View style={styles.botText}>
                      <Text style={styles.botName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                        {row.name}
                      </Text>
                      <Text style={styles.botMeta} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                        {row.tokens === 0 ? "No use" : formatModelsAndShare(row)}
                      </Text>
                    </View>
                    <View style={styles.botNumbers}>
                      <Text style={styles.botTokens} maxFontSizeMultiplier={1.3}>
                        {formatTokenCount(row.tokens)}
                      </Text>
                      <Text style={styles.botMeta} maxFontSizeMultiplier={1.3}>
                        {formatCostCompact(row.cost)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : (
              <>
                <View style={styles.modelRows}>
                  {modelRows.map((row) => {
                    const expanded = openModelKey === row.key;
                    const cost = formatCostCompact(row.cost);
                    const botsLabel = `${String(row.bots.length)} ${
                      row.bots.length === 1 ? "bot" : "bots"
                    }`;
                    return (
                      <View key={row.key}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ expanded }}
                          accessibilityLabel={`${row.label}, ${formatTokenCount(row.tokens)} tokens, ${formatShare(row.sharePercent)} of bots, ${botsLabel}${cost === "" ? "" : `, ${cost}`}. ${expanded ? "Hide bots" : "Show bots"}`}
                          onPress={() => setOpenModelKey(expanded ? null : row.key)}
                          style={({ pressed }) => [
                            styles.modelRow,
                            pressed ? styles.pressed : null,
                          ]}
                        >
                          <View
                            style={[styles.dot, { backgroundColor: providerColor(row.provider) }]}
                          />
                          <View style={styles.modelText}>
                            <Text
                              style={styles.modelName}
                              numberOfLines={1}
                              maxFontSizeMultiplier={1.4}
                            >
                              {row.model}
                            </Text>
                            <Text
                              style={styles.modelMeta}
                              numberOfLines={1}
                              maxFontSizeMultiplier={1.3}
                            >
                              {`${row.providerLabel} · ${botsLabel} · ${formatShare(row.sharePercent)}`}
                            </Text>
                          </View>
                          <View style={styles.modelNumbers}>
                            <Text style={styles.modelTokens} maxFontSizeMultiplier={1.3}>
                              {formatTokenCount(row.tokens)}
                            </Text>
                            {cost === "" ? null : (
                              <Text style={styles.modelMeta} maxFontSizeMultiplier={1.3}>
                                {cost}
                              </Text>
                            )}
                          </View>
                        </Pressable>
                        {expanded ? (
                          <View style={styles.modelBots}>
                            {row.bots.map((bot) => (
                              <View key={bot.botId} style={styles.modelBotRow}>
                                <Text
                                  style={styles.modelBotName}
                                  numberOfLines={1}
                                  maxFontSizeMultiplier={1.4}
                                >
                                  {bot.name}
                                </Text>
                                <Text style={styles.modelBotTokens} maxFontSizeMultiplier={1.3}>
                                  {formatTokenCount(bot.tokens)}
                                </Text>
                              </View>
                            ))}
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
                <Text style={styles.modelNote} maxFontSizeMultiplier={1.4}>
                  By model counts bot chats only. Outside Bots has no model split.
                </Text>
              </>
            )}

            {model.table.idleBotNames.length === 0 ? null : (
              <Text style={styles.idle} maxFontSizeMultiplier={1.4}>
                {formatIdleBots(model.table.idleBotNames)}
              </Text>
            )}

            {model.split === null ? null : (
              <>
                <View style={styles.sectionLine} />
                <Text style={styles.split} maxFontSizeMultiplier={1.3}>
                  {model.split}
                </Text>
              </>
            )}
          </>
        )
      ) : usage.error !== null ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} maxFontSizeMultiplier={1.4}>
            Couldn&apos;t load token usage.
          </Text>
          <RetryButton onPress={retry} />
        </View>
      ) : usage.data?.status === "unavailable" ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} maxFontSizeMultiplier={1.4}>
            Couldn&apos;t count tokens just now.
          </Text>
          <RetryButton onPress={retry} />
        </View>
      ) : (
        <View style={styles.loading}>
          <ActivityIndicator color={tokens.textSecondary} />
          <Text style={styles.note} maxFontSizeMultiplier={1.4}>
            Counting tokens…
          </Text>
        </View>
      )}

      {model.table === null || model.updated === null ? null : (
        <Text style={styles.updated} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3}>
          {model.pending ? `${model.updated} · Updating…` : model.updated}
        </Text>
      )}

      <BotUsageSheet
        visible={openBotId !== null}
        bot={sheetBot}
        usage={usage.data}
        windowId={windowId}
        onWindowChange={selectWindow}
        onClose={() => setOpenBotId(null)}
        onOpenChat={(botId) => {
          setOpenBotId(null);
          onOpenChats(botId);
        }}
      />
    </View>
  );
}

function RetryButton({ onPress }: { readonly onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={onPress}>
      <Text style={styles.retryText} maxFontSizeMultiplier={1.4}>
        Try again
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 10,
    padding: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  heading: { color: tokens.text, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  span: { color: tokens.textSecondary, fontSize: 13 },
  ranges: { flexDirection: "row", gap: 8 },
  range: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  rangeSelected: { backgroundColor: tokens.primary },
  rangeText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
  rangeTextSelected: { color: tokens.primaryText },
  block: { gap: 2 },
  hero: { gap: 2 },
  total: { color: tokens.text, fontSize: 32, lineHeight: 38, fontWeight: "700" },
  muted: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  cost: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "600", marginTop: 4 },
  note: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21 },
  providers: { gap: 4 },
  providerRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  providerName: { color: tokens.text, fontSize: 14 },
  providerValue: { color: tokens.textSecondary, fontSize: 13 },
  sectionLine: { height: StyleSheet.hairlineWidth, backgroundColor: tokens.border, marginTop: 2 },
  viewHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  viewSwitch: {
    flexDirection: "row",
    gap: 2,
    borderRadius: 18,
    padding: 2,
    backgroundColor: tokens.fillMuted,
  },
  viewOption: {
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  viewOptionSelected: { backgroundColor: tokens.primary },
  viewOptionText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
  viewOptionTextSelected: { color: tokens.primaryText },
  viewHint: { flex: 1, color: tokens.textTertiary, fontSize: 11, textAlign: "right" },
  botRows: { gap: 10 },
  botRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  botRank: { width: 16 },
  rankText: { color: tokens.textTertiary, fontSize: 12, fontWeight: "700" },
  botText: { flex: 1, minWidth: 0 },
  botName: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  botMeta: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  botNumbers: { alignItems: "flex-end" },
  botTokens: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  modelRows: { gap: 0 },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  modelText: { flex: 1, minWidth: 0 },
  modelName: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  modelMeta: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  modelNumbers: { alignItems: "flex-end" },
  modelTokens: {
    color: tokens.text,
    fontSize: 14,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  modelBots: { gap: 3, paddingLeft: 16, paddingBottom: 8 },
  modelBotRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  modelBotName: { flex: 1, color: tokens.textSecondary, fontSize: 13 },
  modelBotTokens: { color: tokens.text, fontSize: 13, fontVariant: ["tabular-nums"] },
  modelNote: { color: tokens.textTertiary, fontSize: 12, lineHeight: 16 },
  pressed: { opacity: 0.7 },
  idle: { color: tokens.textTertiary, fontSize: 12, lineHeight: 16 },
  split: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  errorText: { flex: 1, color: tokens.text, fontSize: 15, lineHeight: 21 },
  retryText: { color: tokens.text, fontSize: 15, fontWeight: "600", paddingVertical: 8 },
  loading: { flexDirection: "row", alignItems: "center", gap: 10 },
  updated: { color: tokens.textSecondary, fontSize: 12 },
});
