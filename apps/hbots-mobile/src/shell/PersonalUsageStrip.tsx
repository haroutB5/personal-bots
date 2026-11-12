import type {
  EnvironmentId,
  ProviderConsumeResetCreditOutcome,
  UsageProviderKind,
} from "@t3tools/contracts";
import { isLowProviderBalance } from "@t3tools/contracts";
import {
  deepSeekSpendText,
  formatBalanceAmount,
  resetCreditConfirm,
  resetCreditFailureText,
  resetCreditRedeemLabel,
  resetCreditsExpiresIn,
  resetCreditsHeadline,
  RESET_CREDIT_PAIR_AGAIN_TEXT,
  selectOpenCodeSpendLine,
  selectUsageCards,
  usageAutoProbeDue,
  usageCardEmptyText,
  usageNeedsRefreshOnOpen,
  usageRefreshFailureText,
  usageSheetDescription,
  type UsageCard,
  type UsageWindowRow,
} from "@hbots/personal-client/usage/usagePresentation";
import {
  formatStripPercent,
  selectUsageStripCells,
  stripBindingWindow,
  stripCellBarPercent,
  usageStripAriaLabel,
  type UsageStripCell,
} from "@hbots/personal-client/usage/usageStrip";
import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import { useAtomValue } from "@effect/atom-react";
import { IconRefresh, IconX } from "@tabler/icons-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "./tokens";
import { sendUsageRefresh } from "./usageRefresh";

const PROVIDER_DOT: Record<UsageProviderKind, string> = {
  claude: "#c98500",
  opencode: "#d55181",
  antigravity: "#3987e5",
  codex: "#008300",
  deepseek: "#4d6bfe",
  cursor: "#8c8c88",
  grok: "#8c8c88",
  muse: "#8c8c88",
  pi: "#8c8c88",
};

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

function usageProviderOfDriver(driver: UsageCard["driver"]): UsageProviderKind {
  return driver === "claudeAgent" ? "claude" : driver;
}

function barColor(usedPercent: number): string {
  return usedPercent >= 80 ? tokens.needs : tokens.textTertiary;
}

function bindingInk(cell: UsageStripCell, window: "session" | "weekly"): { color?: string } {
  return stripBindingWindow(cell) === window ? { color: tokens.reviewText } : {};
}

function StripCellBar({ percent }: { readonly percent: number | null }) {
  return (
    <View style={styles.stripTrack}>
      {percent !== null && percent > 0 ? (
        <View
          style={[styles.stripFill, { width: `${percent}%`, backgroundColor: barColor(percent) }]}
        />
      ) : null}
    </View>
  );
}

function WindowRow({
  label,
  usedPercent,
  resetLabel,
  resetTimeLabel,
}: {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetLabel: string | null;
  readonly resetTimeLabel: string | null;
}) {
  return (
    <View style={styles.window}>
      <View style={styles.windowHead}>
        <Text style={styles.windowLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.windowValue}>{`${usedPercent}% used`}</Text>
      </View>
      <View
        style={styles.windowTrack}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: usedPercent }}
        accessibilityLabel={`${label}: ${usedPercent}% used`}
      >
        {usedPercent > 0 ? (
          <View
            style={[
              styles.windowFill,
              {
                width: `${usedPercent}%`,
                backgroundColor: usedPercent >= 80 ? tokens.needs : tokens.text,
              },
            ]}
          />
        ) : null}
      </View>
      <Text style={styles.windowReset} numberOfLines={1}>
        {resetTimeLabel ?? "Reset time not reported"}
        {resetTimeLabel !== null && resetLabel !== null ? ` · ${resetLabel}` : ""}
      </Text>
    </View>
  );
}

function MissingRow({ label }: { readonly label: string }) {
  return (
    <View style={styles.windowHead}>
      <Text style={styles.windowLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.missing}>not reported</Text>
    </View>
  );
}

function BalanceRows({ card, now }: { readonly card: UsageCard; readonly now: number }) {
  const balance = card.balance;
  if (balance === null) return null;
  return (
    <View style={styles.balance}>
      <View style={styles.windowHead}>
        <Text style={styles.windowLabel}>Balance left</Text>
        <Text style={styles.windowValue}>
          {formatBalanceAmount(balance.total, balance.currency)}
        </Text>
      </View>
      <Text style={styles.balanceSpend}>{deepSeekSpendText(balance.spent, now)}</Text>
      <Text style={styles.balanceLine} numberOfLines={2}>
        Granted {formatBalanceAmount(balance.granted, balance.currency)} · Topped up{" "}
        {formatBalanceAmount(balance.toppedUp, balance.currency)}
      </Text>
      {balance.isAvailable &&
      isLowProviderBalance({ currency: balance.currency, totalBalance: balance.total }) ? (
        <Text style={styles.warning}>
          {balance.total > 0
            ? `DeepSeek balance is ${formatBalanceAmount(balance.total, balance.currency)}.`
            : "DeepSeek balance is empty."}{" "}
          Top up to keep DeepSeek bots running.
        </Text>
      ) : null}
      {balance.isAvailable ? null : (
        <Text style={styles.warning}>This account cannot make API calls right now.</Text>
      )}
    </View>
  );
}

function CardFooter({
  card,
  now,
  checking,
}: {
  readonly card: UsageCard;
  readonly now: number;
  readonly checking: boolean;
}) {
  const updatedAt = card.balance?.fetchedAt ?? card.checkedAt;
  const failure = checking ? null : usageRefreshFailureText(card);
  if (updatedAt === null && !checking && failure === null) return null;
  return (
    <View style={styles.footer}>
      {updatedAt !== null || checking ? (
        <View style={styles.footerLine}>
          {updatedAt !== null ? (
            <Text style={styles.footerText}>Updated {formatRelativeTime(updatedAt, now)}</Text>
          ) : null}
          {checking ? (
            <View style={styles.refreshing}>
              <ActivityIndicator size="small" color={tokens.textSecondary} />
              <Text style={styles.footerText}>Refreshing</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {failure !== null ? <Text style={styles.warning}>{failure}</Text> : null}
    </View>
  );
}

function RedeemBlock({
  native,
  card,
  now,
  onRedeemed,
}: {
  readonly native: NativePersonal;
  readonly card: UsageCard;
  readonly now: number;
  readonly onRedeemed: () => void;
}) {
  const environmentId: EnvironmentId = native.environmentId;
  const consume = native.client.useAtomCommand(native.bots.providerConsumeResetCredit, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canRedeem = useAtomValue(
    native.bots.providerConsumeResetCredit.permissionAtom(environmentId),
  );
  const resetCredits = card.resetCredits;
  if (resetCredits === null) return null;
  if (resetCredits.credits.availableCount === 0 && status === null) return null;
  const expiresIn = resetCreditsExpiresIn(resetCredits.credits, now);
  const confirm = resetCreditConfirm(resetCredits.credits, card.title);
  const redeemLabel = resetCreditRedeemLabel(resetCredits.credits);

  const redeem = async () => {
    if (inFlight.current) return;
    if (!canRedeem) {
      setConfirming(false);
      setStatus(RESET_CREDIT_PAIR_AGAIN_TEXT);
      return;
    }
    inFlight.current = true;
    setConfirming(false);
    setBusy(true);
    setStatus(null);
    try {
      const result = await consume({ environmentId, input: resetCredits.input });
      if (result._tag === "Success") {
        setStatus(result.value.warning ?? OUTCOME_TEXT[result.value.outcome]);
      } else {
        setStatus(resetCreditFailureText(result.cause));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onRedeemed();
    }
  };

  return (
    <View style={styles.redeemBlock}>
      {resetCredits.credits.availableCount > 0 ? (
        <View style={styles.redeemRow}>
          <View style={styles.redeemCopy}>
            <Text style={styles.redeemHeadline}>{resetCreditsHeadline(resetCredits.credits)}</Text>
            {expiresIn !== null ? (
              <Text style={styles.redeemExpiry} numberOfLines={1}>
                Next expires in {expiresIn}
              </Text>
            ) : null}
          </View>
          {canRedeem ? (
            <Pressable
              onPress={() => setConfirming(true)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={confirm.title.replace(/\?$/, "")}
              accessibilityState={{ disabled: busy, busy }}
              style={[styles.outlineButton, busy ? styles.disabled : null]}
            >
              <Text style={styles.outlineButtonText}>{busy ? "Redeeming…" : redeemLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {!canRedeem && resetCredits.credits.availableCount > 0 ? (
        <Text style={styles.redeemStatus}>{RESET_CREDIT_PAIR_AGAIN_TEXT}</Text>
      ) : null}
      {status !== null ? (
        <Text style={styles.redeemStatus} accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}
      <Modal
        visible={confirming}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirming(false)}
      >
        <View style={styles.confirmScrim}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>{confirm.title}</Text>
            <Text style={styles.confirmBody}>{confirm.body}</Text>
            <View style={styles.confirmActions}>
              <Pressable
                onPress={() => setConfirming(false)}
                accessibilityRole="button"
                style={[styles.primaryButton, styles.confirmButton]}
              >
                <Text style={styles.primaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void redeem()}
                disabled={busy}
                accessibilityRole="button"
                style={[styles.outlineButton, styles.confirmButton, busy ? styles.disabled : null]}
              >
                <Text style={styles.outlineButtonText}>Redeem</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function UsageCardView({
  native,
  card,
  now,
  checking,
  spendLine,
  onRedeemed,
}: {
  readonly native: NativePersonal;
  readonly card: UsageCard;
  readonly now: number;
  readonly checking: boolean;
  readonly spendLine: string | null;
  readonly onRedeemed: () => void;
}) {
  return (
    <View style={styles.card} accessibilityLabel={`${card.title} usage`}>
      <View>
        <View style={styles.cardTitleRow}>
          <View
            style={[
              styles.providerDot,
              { backgroundColor: PROVIDER_DOT[usageProviderOfDriver(card.driver)] },
            ]}
          />
          <Text style={styles.cardTitle} numberOfLines={1}>
            {card.title}
          </Text>
        </View>
        {card.plan ? (
          <Text style={styles.cardPlan} numberOfLines={1}>
            {card.plan}
          </Text>
        ) : null}
      </View>
      {card.status === "ready" && card.balance !== null ? (
        <BalanceRows card={card} now={now} />
      ) : card.status === "ready" ? (
        <View style={styles.windows}>
          {card.windows && card.windows.length > 0 ? (
            card.windows.map((row: UsageWindowRow) => (
              <WindowRow
                key={row.id}
                label={row.label}
                usedPercent={row.usedPercent}
                resetLabel={row.resetLabel}
                resetTimeLabel={row.resetTimeLabel}
              />
            ))
          ) : (
            <>
              {card.session ? (
                <WindowRow
                  label={card.session.label}
                  usedPercent={card.session.usedPercent}
                  resetLabel={card.session.resetLabel}
                  resetTimeLabel={card.session.resetTimeLabel}
                />
              ) : (
                <MissingRow label="5-hour session" />
              )}
              {card.weeklies.length > 0 ? (
                card.weeklies.map((row) => (
                  <WindowRow
                    key={row.id}
                    label={row.label}
                    usedPercent={row.usedPercent}
                    resetLabel={row.resetLabel}
                    resetTimeLabel={row.resetTimeLabel}
                  />
                ))
              ) : (
                <MissingRow label="Weekly" />
              )}
            </>
          )}
          {spendLine ? <Text style={styles.spendLine}>{spendLine}</Text> : null}
        </View>
      ) : (
        <Text style={styles.cardEmpty}>{usageCardEmptyText(card, { checking })}</Text>
      )}
      <RedeemBlock native={native} card={card} now={now} onRedeemed={onRedeemed} />
      <CardFooter card={card} now={now} checking={checking} />
    </View>
  );
}

function UsageSheet({
  native,
  visible,
  onClose,
  cards,
  now,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly cards: readonly UsageCard[];
  readonly now: number;
}) {
  const refreshProviders = native.client.useAtomCommand(native.bots.serverRefreshProviders, {
    reportFailure: false,
  });
  const tokenUsage = native.bots.usePersonalTokenUsage(native.environmentId);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const probed = useRef(false);
  const drag = useRef(0);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      setRefreshError(await sendUsageRefresh(refreshProviders, native.environmentId));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!visible) {
      // The modal stays mounted, so each open needs its own probe and no stale failure.
      probed.current = false;
      // eslint-disable-next-line react/set-state-in-effect -- a closed sheet must not reopen with the last failure
      setRefreshError(null);
      return;
    }
    if (probed.current) return;
    if (!usageNeedsRefreshOnOpen(cards, Date.now())) return;
    probed.current = true;
    void refresh();
    // Once per open.
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- once per open, by design
  }, [visible]);

  const pan = useMemo(
    () =>
      // eslint-disable-next-line react/refs -- the responder is created once
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          drag.current = Math.max(0, gesture.dy);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (drag.current > 80 || gesture.vy > 0.7) onClose();
          drag.current = 0;
        },
      }),
    [onClose],
  );

  const spendLine = selectOpenCodeSpendLine(tokenUsage.data);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetScrim}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close usage"
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <View {...pan.panHandlers} style={styles.sheetDragZone}>
            <View style={styles.dragHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeaderCopy}>
                <Text style={styles.sheetTitle}>Usage</Text>
                <Text style={styles.sheetDescription} numberOfLines={2}>
                  {usageSheetDescription(cards)}
                </Text>
              </View>
              <Pressable
                onPress={() => void refresh()}
                disabled={refreshing}
                accessibilityRole="button"
                accessibilityLabel="Refresh usage"
                accessibilityState={{ busy: refreshing, disabled: refreshing }}
                style={styles.iconButton}
              >
                {refreshing ? (
                  <ActivityIndicator size="small" color={tokens.textSecondary} />
                ) : (
                  <IconRefresh size={20} color={tokens.text} strokeWidth={1.75} />
                )}
              </Pressable>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close usage"
                style={styles.iconButton}
              >
                <IconX size={22} color={tokens.text} strokeWidth={1.75} />
              </Pressable>
            </View>
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetBody}
            showsVerticalScrollIndicator={false}
            style={styles.sheetScroll}
          >
            {refreshError !== null ? (
              <Text style={styles.warning} accessibilityLiveRegion="polite">
                {refreshError}
              </Text>
            ) : null}
            {cards.map((card) => (
              <UsageCardView
                key={card.driver}
                native={native}
                card={card}
                now={now}
                checking={refreshing}
                spendLine={card.driver === "opencode" ? spendLine : null}
                onRedeemed={() => void refresh()}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The two-up usage strip on Bots: one cell per window provider, its figures
 * and one hairline bar filled to the worse window. Tapping opens the sheet.
 */
export function PersonalUsageStrip({
  native,
  now,
}: {
  readonly native: NativePersonal;
  readonly now: number;
}) {
  const providers = native.useProviders();
  const hidden = native.bots.useHiddenUsageProviders(native.environmentId);
  const refreshProviders = native.client.useAtomCommand(native.bots.serverRefreshProviders, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const probe = useRef<{ lastProbeAt: number | null; firstLoadSeen: boolean }>({
    lastProbeAt: null,
    firstLoadSeen: false,
  });
  const cards = selectUsageCards(providers, now, hidden);
  const cells = selectUsageStripCells(cards);

  useEffect(() => {
    // eslint-disable-next-line react/purity -- the probe runs in an effect, not render
    const at = Date.now();
    const due = usageAutoProbeDue({
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the probe reads the current cards
      cards,
      now: at,
      lastProbeAt: probe.current.lastProbeAt,
      firstLoad: !probe.current.firstLoadSeen,
    });
    if (providers.length > 0) probe.current.firstLoadSeen = true;
    if (!due) return;
    probe.current.lastProbeAt = at;
    void refreshProviders({
      environmentId: native.environmentId,
      input: { refreshUsage: true },
    });
  }, [providers, now, hidden]);

  if (cells.length === 0) return null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={usageStripAriaLabel(cells)}
        accessibilityHint="Opens the usage sheet"
        style={[styles.strip, cells.length === 1 ? styles.stripOne : styles.stripRow]}
      >
        {cells.map((cell: UsageStripCell) => (
          <View key={cell.driver} style={styles.stripCell}>
            <Text style={styles.stripTitle} numberOfLines={1}>
              {cell.title}
            </Text>
            <Text style={styles.stripFigures} numberOfLines={1}>
              {cell.sessionPercent === null && cell.weeklyPercent === null ? (
                "Not reported"
              ) : cell.weeklyPercent === null ? (
                <Text style={bindingInk(cell, "session")}>
                  {`Sess ${formatStripPercent(cell.sessionPercent)}`}
                </Text>
              ) : (
                <>
                  <Text style={bindingInk(cell, "session")}>
                    {`Sess ${formatStripPercent(cell.sessionPercent)}`}
                  </Text>
                  {" · "}
                  <Text style={bindingInk(cell, "weekly")}>
                    {`Wk ${formatStripPercent(cell.weeklyPercent)}`}
                  </Text>
                </>
              )}
            </Text>
            <StripCellBar percent={stripCellBarPercent(cell)} />
          </View>
        ))}
      </Pressable>
      <UsageSheet
        native={native}
        visible={open}
        onClose={() => setOpen(false)}
        cards={cards}
        now={now}
      />
    </>
  );
}

const styles = StyleSheet.create({
  strip: {
    marginTop: 2,
    minHeight: 44,
    alignItems: "center",
    gap: 8,
  },
  stripRow: { flexDirection: "row" },
  stripOne: { flexDirection: "column", alignItems: "stretch" },
  stripCell: { flex: 1, minWidth: 0, gap: 2 },
  stripTitle: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: "600" },
  stripFigures: { color: tokens.textTertiary, fontSize: 11, lineHeight: 16 },
  stripTrack: {
    height: 3,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: tokens.track,
  },
  stripFill: { height: "100%", borderRadius: 999 },
  sheetScrim: { flex: 1, justifyContent: "flex-end", backgroundColor: tokens.scrim },
  sheet: {
    maxHeight: "90%",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden",
  },
  sheetDragZone: { paddingTop: 8 },
  dragHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: tokens.borderStrong,
    marginBottom: 6,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 20,
    paddingRight: 8,
    paddingBottom: 4,
  },
  sheetHeaderCopy: { flex: 1, minWidth: 0 },
  sheetTitle: { color: tokens.text, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  sheetDescription: { color: tokens.textTertiary, fontSize: 13, lineHeight: 18 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sheetScroll: { flexGrow: 0 },
  sheetBody: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  card: {
    gap: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: 16,
  },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  providerDot: { width: 8, height: 8, borderRadius: 999 },
  cardTitle: { color: tokens.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  cardPlan: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  windows: { gap: 16 },
  window: { gap: 6 },
  windowHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  windowLabel: { color: tokens.text, fontSize: 15, flexShrink: 1 },
  windowValue: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  windowTrack: {
    height: 10,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: tokens.track,
  },
  windowFill: { height: "100%", borderRadius: 999 },
  windowReset: { color: tokens.textSecondary, fontSize: 13, fontVariant: ["tabular-nums"] },
  missing: { color: tokens.textSecondary, fontSize: 13 },
  balance: { gap: 8 },
  balanceSpend: { color: tokens.textSecondary, fontSize: 13 },
  balanceLine: { color: tokens.textSecondary, fontSize: 13 },
  warning: { color: tokens.reviewText, fontSize: 13, lineHeight: 18 },
  cardEmpty: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20 },
  spendLine: { color: tokens.textSecondary, fontSize: 13, lineHeight: 20 },
  footer: { gap: 2 },
  footerLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  footerText: { color: tokens.textSecondary, fontSize: 13 },
  refreshing: { flexDirection: "row", alignItems: "center", gap: 4 },
  redeemBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 12,
    gap: 8,
  },
  redeemRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  redeemCopy: { flex: 1, minWidth: 0 },
  redeemHeadline: {
    color: tokens.text,
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ["tabular-nums"],
  },
  redeemExpiry: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  redeemStatus: { color: tokens.text, fontSize: 13, lineHeight: 18 },
  outlineButton: {
    height: 44,
    minWidth: 88,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineButtonText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  primaryButton: {
    height: 44,
    minWidth: 88,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  confirmScrim: {
    flex: 1,
    backgroundColor: tokens.scrim,
    justifyContent: "flex-end",
  },
  confirmCard: {
    width: "100%",
    gap: 12,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: 20,
    paddingBottom: 28,
  },
  confirmTitle: { color: tokens.text, fontSize: 18, lineHeight: 24, fontWeight: "600" },
  confirmBody: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21 },
  confirmActions: { flexDirection: "column", gap: 8, marginTop: 4 },
  confirmButton: { alignSelf: "stretch" },
});
