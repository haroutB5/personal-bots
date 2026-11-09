import type {
  PersonalBot,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageWindowId,
} from "@t3tools/contracts";
import type {
  TokenCostView,
  TokenUsageBot,
  TokenUsageRowView,
  TokenUsageTable,
} from "@hbots/personal-client/usage/tokenUsagePresentation";
import {
  buildTokenUsageTable,
  cacheHitShare,
  findTokenUsageWindow,
  formatBotMeta,
  formatCostCompact,
  formatShare,
  formatSplit,
  formatTokenCount,
  formatWindowSpan,
  providerColor,
  shortProviderLabel,
  TOKEN_USAGE_WINDOWS,
} from "@hbots/personal-client/usage/tokenUsagePresentation";
import { IconX } from "@tabler/icons-react-native";
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

function costText(cost: TokenCostView): string {
  const text = formatCostCompact(cost);
  return text === "" ? "n/a" : text;
}

/**
 * One bot's token use, every model in full. A bottom sheet over the chat or the
 * Team card, with the range control the card already shows.
 */
export function BotUsageSheet({
  visible,
  bot,
  usage,
  windowId,
  onWindowChange,
  onClose,
  onOpenChat,
}: {
  readonly visible: boolean;
  readonly bot: PersonalBot | null;
  readonly usage: PersonalBotTokenUsageResult | null;
  readonly windowId: PersonalBotTokenUsageWindowId;
  readonly onWindowChange: (id: PersonalBotTokenUsageWindowId) => void;
  readonly onClose: () => void;
  readonly onOpenChat: (botId: string) => void;
}) {
  const window = useMemo(() => findTokenUsageWindow(usage, windowId), [usage, windowId]);
  const table = useMemo<ReadonlyArray<TokenUsageTable> | null>(() => {
    if (window === null || bot === null) return null;
    const bots: ReadonlyArray<TokenUsageBot> = [{ botId: bot.botId, name: bot.name }];
    return [
      buildTokenUsageTable({
        window,
        bots,
        listedBotIds: new Set([bot.botId as string]),
      }),
    ];
  }, [bot, window]);
  const row: TokenUsageRowView | null =
    table?.[0]?.rows.find((candidate) => candidate.botId === bot?.botId) ??
    table?.[0]?.rows[0] ??
    null;
  const span = table === null ? null : formatWindowSpan(table[0]!.sinceDay, table[0]!.untilDay);
  const used = row !== null && row.tokens > 0;

  return (
    <SheetShell
      visible={visible && bot !== null}
      title={bot?.name ?? "Token use"}
      onClose={onClose}
    >
      {bot === null ? null : (
        <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: 12 }}>
          <View style={styles.header}>
            <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={32} label="" />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{bot.name}</Text>
              <Text style={styles.span}>Token use · {span ?? "loading…"}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.close}
            >
              <IconX size={22} color={tokens.text} strokeWidth={1.75} />
            </Pressable>
          </View>

          <View style={styles.range} accessibilityRole="tablist">
            {TOKEN_USAGE_WINDOWS.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: entry.id === windowId }}
                onPress={() => onWindowChange(entry.id)}
                style={[styles.rangeItem, entry.id === windowId ? styles.rangeItemOn : null]}
              >
                <Text style={[styles.rangeText, entry.id === windowId ? styles.rangeTextOn : null]}>
                  {entry.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {window === null || usage?.status === "warming" ? (
            <Text style={styles.empty}>Counting tokens…</Text>
          ) : usage !== null && usage.status === "unavailable" ? (
            <Text style={styles.empty}>Token use is unavailable right now.</Text>
          ) : !used || row === null || table === null ? (
            <Text style={styles.empty}>
              {bot.name} used no tokens {windowId === "today" ? "today" : "in this period"}.
            </Text>
          ) : (
            <>
              <View style={styles.tiles}>
                <Tile label="Tokens" value={formatTokenCount(row.tokens)} />
                <Tile label="API estimate" value={costText(row.cost)} />
                <Tile
                  label="Of all bots"
                  value={formatShare(row.sharePercent)}
                  note={row.rank === null ? null : `#${row.rank} this period`}
                />
              </View>
              <Text style={styles.meta}>{formatBotMeta(row)}</Text>

              <Text style={styles.section}>Providers</Text>
              {row.mix.length === 1 ? (
                <Text style={styles.providerLine}>
                  All on{" "}
                  <Text style={{ fontWeight: "600", color: tokens.text }}>
                    {shortProviderLabel(row.mix[0]!.provider)}
                  </Text>
                </Text>
              ) : (
                <>
                  <View style={styles.mixBar}>
                    {row.mix.map((segment) => (
                      <View
                        key={segment.provider}
                        style={{
                          flex: segment.tokens,
                          backgroundColor: providerColor(segment.provider),
                        }}
                      />
                    ))}
                  </View>
                  <View style={styles.legend}>
                    {row.mix.map((segment) => (
                      <View key={segment.provider} style={styles.legendItem}>
                        <View
                          style={[styles.dot, { backgroundColor: providerColor(segment.provider) }]}
                        />
                        <Text style={styles.legendText}>
                          {shortProviderLabel(segment.provider)}
                        </Text>
                        <Text style={styles.legendValue}>
                          {formatShare((segment.tokens / row.tokens) * 100)}
                        </Text>
                      </View>
                    ))}
                  </View>
                </>
              )}

              <Text style={styles.section}>Token mix</Text>
              {cacheHitShare(row.split) === null ? null : (
                <Text style={styles.cacheLine}>{cacheHitShare(row.split)}% from cache</Text>
              )}
              <View style={styles.tiles}>
                <MixFigure label="New input" value={row.split.input} />
                <MixFigure label="Cached input" value={row.split.cached} />
                <MixFigure label="Output" value={row.split.output} />
              </View>

              <Text style={styles.section}>Models</Text>
              {row.models.map((model) => (
                <View key={`${model.provider}:${model.modelId}`} style={styles.modelRow}>
                  <View style={[styles.dot, { backgroundColor: providerColor(model.provider) }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modelName}>{model.model}</Text>
                    <Text style={styles.modelMeta}>
                      {model.providerLabel} · {formatSplit(model.split)}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={styles.modelTokens}>{formatTokenCount(model.tokens)}</Text>
                    <Text style={styles.modelMeta}>{costText(model.cost)}</Text>
                  </View>
                </View>
              ))}
            </>
          )}

          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenChat(bot.botId)}
            style={({ pressed }) => [styles.openChat, pressed ? styles.pressed : null]}
          >
            <Text style={styles.openChatText}>Open {bot.name} chat</Text>
          </Pressable>
          <Text style={styles.note}>Estimates at list API prices, not money charged.</Text>
        </ScrollView>
      )}
    </SheetShell>
  );
}

function Tile({
  label,
  value,
  note = null,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | null;
}) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, value.length > 8 ? styles.tileValueSmall : null]}>
        {value}
      </Text>
      {note === null ? null : <Text style={styles.tileNote}>{note}</Text>}
    </View>
  );
}

function MixFigure({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{formatTokenCount(value)}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  name: {
    color: tokens.text,
    fontSize: 17,
    fontWeight: "600",
  },
  span: {
    color: tokens.textTertiary,
    fontSize: 13,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  range: {
    flexDirection: "row",
    gap: 6,
    paddingVertical: 4,
  },
  rangeItem: {
    flex: 1,
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: tokens.border,
    alignItems: "center",
    justifyContent: "center",
  },
  rangeItemOn: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  },
  rangeText: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  rangeTextOn: {
    color: tokens.primaryText,
  },
  empty: {
    marginTop: 12,
    color: tokens.textSecondary,
    fontSize: 15,
  },
  tiles: {
    marginTop: 10,
    flexDirection: "row",
    gap: 8,
  },
  tile: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tileLabel: {
    color: tokens.textSecondary,
    fontSize: 12,
  },
  tileValue: {
    color: tokens.text,
    fontSize: 20,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  tileValueSmall: {
    fontSize: 16,
  },
  tileNote: {
    color: tokens.textSecondary,
    fontSize: 11,
  },
  meta: {
    marginTop: 6,
    color: tokens.textSecondary,
    fontSize: 12,
  },
  section: {
    marginTop: 14,
    color: tokens.text,
    fontSize: 13,
    fontWeight: "600",
  },
  providerLine: {
    marginTop: 4,
    color: tokens.textSecondary,
    fontSize: 13,
  },
  mixBar: {
    marginTop: 6,
    height: 10,
    flexDirection: "row",
    overflow: "hidden",
    borderRadius: 4,
    backgroundColor: tokens.track,
  },
  legend: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendText: {
    color: tokens.textSecondary,
    fontSize: 13,
  },
  legendValue: {
    color: tokens.text,
    fontSize: 13,
    fontWeight: "600",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cacheLine: {
    marginTop: 2,
    color: tokens.textSecondary,
    fontSize: 12,
  },
  modelRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 8,
  },
  modelName: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "600",
  },
  modelMeta: {
    color: tokens.textSecondary,
    fontSize: 12,
  },
  modelTokens: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  openChat: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  openChatText: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "500",
  },
  pressed: {
    opacity: 0.7,
  },
  note: {
    marginTop: 8,
    color: tokens.textSecondary,
    fontSize: 12,
  },
});
