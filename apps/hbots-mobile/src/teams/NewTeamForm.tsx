import type { EnvironmentId, PersonalBot, PersonalBotTeam } from "@t3tools/contracts";
import { isGroupOnlyBot } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { botActiveModelShortLabel } from "@hbots/personal-client/bots/botModelLabel";
import { IconCheck } from "@tabler/icons-react-native";
import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { FieldLabel, FormButton, Hint, TextField } from "../bots/BotFormUi";
import { leaderChoices, newTeamButtonLabel, newTeamPlan, type TeamNotice } from "./teamScreenModel";

function PickRow({
  label,
  detail,
  leading,
  checked,
  onPress,
}: {
  readonly label: string;
  readonly detail: string | null;
  readonly leading: string | null;
  readonly checked: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.pickRow, pressed ? styles.pressed : null]}
    >
      <View style={[styles.check, checked ? styles.checkOn : null]}>
        {checked ? <IconCheck size={14} color={tokens.primaryText} strokeWidth={3} /> : null}
      </View>
      <View style={styles.pickText}>
        <Text style={styles.pickName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {label}
        </Text>
        {detail === null ? null : (
          <Text style={styles.pickDetail} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {detail}
          </Text>
        )}
        {leading === null ? null : (
          <Text style={styles.pickLeads} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {leading}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * A name, an optional leader and optional first members, in one step. The team
 * is registered through `personalProfile.set` and the bots are then moved with
 * `personalBots.update`, the calls the web form makes, so the server's rules
 * are the only rules. A bot that leads another team is named first and moved
 * only after a second, explicit confirm.
 */
export function NewTeamForm({
  native,
  bots: allBots,
  customTeams,
  initialMemberIds = [],
  onCreated,
  onCancel,
}: {
  readonly native: NativePersonal;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly customTeams: ReadonlyArray<PersonalBotTeam>;
  readonly initialMemberIds?: ReadonlyArray<string>;
  readonly onCreated: (notice: TeamNotice) => void;
  readonly onCancel?: () => void;
}) {
  const providers = native.useProviders();
  const connection = native.useConnectionState();
  const saveProfile = native.client.useAtomCommand(native.bots.personalProfileSet, {
    reportFailure: false,
  });
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const [name, setName] = useState("");
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<ReadonlyArray<string>>(initialMemberIds);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const moved = useRef(new Set<string>());

  const bots = useMemo(() => allBots.filter((bot) => !isGroupOnlyBot(bot)), [allBots]);
  const labels = useMemo(
    () => new Map(bots.map((bot) => [bot.botId, botActiveModelShortLabel(bot, providers)])),
    [bots, providers],
  );
  const labelOf = (bot: PersonalBot): string | null => labels.get(bot.botId) ?? null;
  const leader = bots.find((bot) => bot.botId === leaderId) ?? null;
  const members = bots.filter((bot) => memberIds.includes(bot.botId) && bot.botId !== leaderId);
  const plan = newTeamPlan({ name, leader, members, customTeams, allBots });

  const create = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      let team = createdName;
      if (team === null) {
        const result = await saveProfile({
          environmentId: native.environmentId,
          input: { teamChange: { operation: "create", name: name.trim() } },
        });
        const failure = commandFailureMessage(result, "Couldn't create the team. Try again.");
        if (failure !== null) {
          setError(failure);
          return;
        }
        team = name.trim();
        setCreatedName(team);
      }
      for (const move of plan.moves) {
        if (moved.current.has(move.botId)) continue;
        const result = await updateBot({
          environmentId: native.environmentId,
          input: { botId: move.botId, team, lead: move.lead },
        });
        const failure = commandFailureMessage(result, `${move.name} couldn't be moved.`);
        if (failure !== null) {
          setError(`${team} was created, but ${move.name} couldn't be moved: ${failure}`);
          return;
        }
        moved.current.add(move.botId);
      }
      onCreated({
        team,
        message: plan.createdMessage ?? `Team ${team} created.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (busy) return;
    if (createdName === null && plan.nameError !== null) {
      setNameError(plan.nameError);
      return;
    }
    if (plan.warning !== null && !confirming && createdName === null) {
      setConfirming(true);
      return;
    }
    void create();
  };

  const toggleMember = (botId: string) => {
    setError(null);
    setConfirming(false);
    setMemberIds((current) =>
      current.includes(botId) ? current.filter((id) => id !== botId) : [...current, botId],
    );
  };

  const choices = leaderChoices(bots, labelOf);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.form}
    >
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <TextField
          label="Team name"
          value={name}
          onChange={(next) => {
            setName(next.slice(0, 60));
            setNameError(null);
            setConfirming(false);
          }}
          placeholder="e.g. Research"
          maxLength={60}
          error={nameError}
        />

        <View style={styles.section}>
          <View style={styles.sectionHeading}>
            <FieldLabel>Leader</FieldLabel>
            <Text style={styles.optional} maxFontSizeMultiplier={1.4}>
              Optional
            </Text>
          </View>
          {bots.length === 0 ? (
            <Text style={styles.note} maxFontSizeMultiplier={1.4}>
              No bots yet. The team can start empty.
            </Text>
          ) : (
            <View style={styles.list} accessibilityRole="radiogroup">
              {choices.map((choice) => (
                <PickRow
                  key={choice.botId ?? "none"}
                  label={choice.name}
                  detail={choice.detail}
                  leading={choice.leads}
                  checked={(choice.botId ?? null) === leaderId}
                  onPress={() => {
                    setLeaderId(choice.botId);
                    setConfirming(false);
                    setError(null);
                  }}
                />
              ))}
            </View>
          )}
        </View>

        {bots.length > 1 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeading}>
              <FieldLabel>Members</FieldLabel>
              <Text style={styles.optional} maxFontSizeMultiplier={1.4}>
                {members.length === 0 ? "Optional" : `${members.length} picked`}
              </Text>
            </View>
            <View style={styles.list}>
              {bots
                .filter((bot) => bot.botId !== leaderId)
                .map((bot) => {
                  const checked = memberIds.includes(bot.botId);
                  return (
                    <Pressable
                      key={bot.botId}
                      onPress={() => toggleMember(bot.botId)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      accessibilityLabel={`${bot.name} moves into the new team`}
                      style={({ pressed }) => [styles.pickRow, pressed ? styles.pressed : null]}
                    >
                      <View style={[styles.check, checked ? styles.checkOn : null]}>
                        {checked ? (
                          <IconCheck size={14} color={tokens.primaryText} strokeWidth={3} />
                        ) : null}
                      </View>
                      <BotAvatar
                        shape={bot.avatarShape}
                        color={bot.avatarColor}
                        size={32}
                        label=""
                      />
                      <View style={styles.pickText}>
                        <Text style={styles.pickName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                          {bot.name}
                        </Text>
                        {labelOf(bot) === null ? null : (
                          <Text
                            style={styles.pickDetail}
                            numberOfLines={1}
                            maxFontSizeMultiplier={1.4}
                          >
                            {labelOf(bot)}
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
            </View>
          </View>
        ) : null}

        {plan.warning === null ? null : (
          <Text style={styles.warning} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.5}>
            {plan.warning}
          </Text>
        )}
        {error === null ? null : <Hint error>{error}</Hint>}
        {connection.phase !== "connected" ? (
          <Text style={styles.note} maxFontSizeMultiplier={1.4}>
            Your computer is offline. Try again once it reconnects.
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {confirming ? (
          <>
            <Text style={styles.confirmText} maxFontSizeMultiplier={1.5}>
              {plan.warning}
            </Text>
            <FormButton
              label={
                leader === null
                  ? "Move them and create team"
                  : `Move ${leader.name} and create team`
              }
              onPress={() => void create()}
              variant="primary"
              disabled={busy}
            />
            <FormButton label="Back" onPress={() => setConfirming(false)} variant="quiet" />
          </>
        ) : (
          <View style={styles.footerRow}>
            {onCancel === undefined ? null : (
              <View style={styles.cancelSlot}>
                <FormButton label="Cancel" onPress={onCancel} variant="quiet" disabled={busy} />
              </View>
            )}
            <View style={styles.submitSlot}>
              <FormButton
                label={newTeamButtonLabel({
                  busy,
                  createdName,
                  leaderName: leader?.name ?? null,
                })}
                onPress={submit}
                variant="primary"
                disabled={busy || (createdName === null && name.trim().length === 0)}
                busy={busy}
              />
            </View>
          </View>
        )}
      </View>
      {busy ? (
        <View style={styles.busyOverlay} pointerEvents="none">
          <ActivityIndicator color={tokens.text} />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  form: { flexShrink: 1 },
  body: { padding: 16, gap: 20, paddingBottom: 24 },
  section: { gap: 8 },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  optional: { color: tokens.textSecondary, fontSize: 13 },
  list: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden",
  },
  pickRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  pickText: { flex: 1, minWidth: 0, gap: 1 },
  pickName: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  pickDetail: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  pickLeads: { color: tokens.reviewText, fontSize: 12, lineHeight: 16 },
  note: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  warning: {
    color: tokens.text,
    backgroundColor: tokens.reviewBg,
    borderColor: tokens.reviewBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20,
  },
  footer: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  footerRow: { flexDirection: "row", gap: 8 },
  cancelSlot: { flex: 1 },
  submitSlot: { flex: 2 },
  confirmText: { color: tokens.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  busyOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
