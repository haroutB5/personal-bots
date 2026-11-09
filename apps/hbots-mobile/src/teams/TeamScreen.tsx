import type { PersonalBotTeam } from "@t3tools/contracts";
import { PersonalBotId } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { botActiveModelShortLabel } from "@hbots/personal-client/bots/botModelLabel";
import { buildTeamGroups } from "@hbots/personal-client/teams/teamDiagramModel";
import { planDrop } from "@hbots/personal-client/teams/teamMoves";
import { IconPlus } from "@tabler/icons-react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useBotShells } from "../personal/useBotShells";
import { useNow } from "../chat/useNow";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { SheetShell } from "../sheets/SheetShell";
import { NewTeamForm } from "./NewTeamForm";
import { TeamCard } from "./TeamCards";
import { TeamLeadConfirmSheet, TeamMembersSheet, TeamMenuSheet, TeamMoveSheet } from "./TeamSheets";
import { TeamTokenUsage } from "./TeamTokenUsage";
import { TeamWorkingNow } from "./TeamWorkingNow";
import {
  leadConfirmFor,
  liveBotIds,
  moveSheetOptions,
  removeTeamLabel,
  teamCards,
  teamChartBots,
  teamScreenState,
  teamSummary,
  teamWorkingNowRows,
  takeTeamNotice,
  type MoveSheetOption,
  type TeamMemberModel,
  type TeamNotice,
} from "./teamScreenModel";

interface Feedback {
  readonly tone: "info" | "error";
  readonly text: string;
}

interface ConfirmState {
  readonly botId: string;
  readonly option: MoveSheetOption;
}

export function TeamScreen({
  native,
  onBack,
  onNewTeam,
  onNewBot,
  onOpenBot,
  onOpenTask,
  onOpenChat,
  onOpenChats,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
  readonly onNewTeam: () => void;
  readonly onNewBot: () => void;
  readonly onOpenBot: (botId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onOpenChats: (botId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const profile = native.bots.usePersonalProfile(environmentId);
  const providers = native.useProviders();
  const connection = native.useConnectionState();
  const now = useNow();
  const taskFeed = native.bots.usePersonalTasks(environmentId);
  const { shells } = useBotShells(native, environmentId);
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const saveProfile = native.client.useAtomCommand(native.bots.personalProfileSet, {
    reportFailure: false,
  });

  const [notice, setNotice] = useState<TeamNotice | null>(() => takeTeamNotice());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [membersTeam, setMembersTeam] = useState<string | null>(null);
  const [moveBotId, setMoveBotId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [menuTeam, setMenuTeam] = useState<string | null>(null);
  const [newTeamBotId, setNewTeamBotId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const allBots = useMemo(
    () => (list.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [list.data],
  );
  const customTeams = useMemo(
    () => profile.data?.customTeams ?? ([] as ReadonlyArray<PersonalBotTeam>),
    [profile.data],
  );
  const bots = useMemo(() => teamChartBots(allBots), [allBots]);
  const live = useMemo(() => liveBotIds(list.data?.threads ?? [], shells), [list.data, shells]);
  const tasks = useMemo(
    () => (taskFeed.data === null ? [] : [...taskFeed.data.values()]),
    [taskFeed.data],
  );
  const working = useMemo(
    () => teamWorkingNowRows({ tasks, bots, nowMs: now }),
    [bots, now, tasks],
  );
  const modelNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const provider of providers) {
      for (const model of provider.models) {
        names.set(model.slug, model.name);
        for (const alias of model.aliases ?? []) {
          if (!names.has(alias)) names.set(alias, model.name);
        }
      }
    }
    return names;
  }, [providers]);
  const listedBotIds = useMemo(() => new Set(bots.map((bot) => bot.botId as string)), [bots]);
  const cards = useMemo(
    () =>
      teamCards({
        bots,
        customTeams,
        liveBotIds: live,
        modelLabelOf: (bot) => botActiveModelShortLabel(bot, providers),
      }),
    [bots, customTeams, live, providers],
  );
  const groups = useMemo(() => buildTeamGroups(bots, customTeams), [bots, customTeams]);
  const roster = useMemo(
    () =>
      bots.map((bot) => ({
        botId: bot.botId as string,
        name: bot.name,
        team: bot.team,
        lead: bot.lead,
      })),
    [bots],
  );
  const state = teamScreenState({
    connected: connection.phase === "connected",
    listLoaded: list.data !== null,
    listError: list.error,
    botCount: allBots.length,
    teamCount: cards.length,
  });

  const botById = useMemo(
    () => new Map(bots.map((bot) => [bot.botId as string, bot] as const)),
    [bots],
  );
  const moveBot = moveBotId === null ? null : (botById.get(moveBotId) ?? null);
  const moving =
    moveBot === null
      ? null
      : {
          botId: moveBot.botId as string,
          name: moveBot.name,
          team: moveBot.team,
          lead: moveBot.lead,
        };
  const moveOptions = useMemo(
    () => (moving === null ? [] : moveSheetOptions(moving, groups, roster)),
    [groups, moving, roster],
  );
  const confirmBot = confirm === null ? null : (botById.get(confirm.botId) ?? null);
  const confirmCopy =
    confirm === null || confirmBot === null
      ? null
      : leadConfirmFor(
          {
            botId: confirmBot.botId as string,
            name: confirmBot.name,
            team: confirmBot.team,
            lead: confirmBot.lead,
          },
          confirm.option.team,
          roster,
        );
  const confirmOldLead =
    confirm === null
      ? null
      : (cards
          .find((card) => card.team === confirm.option.team)
          ?.members.find((member) => member.isLead) ?? null);
  const membersCard =
    membersTeam === null ? null : (cards.find((card) => card.team === membersTeam) ?? null);
  const menuCard =
    menuTeam === null ? null : (cards.find((card) => card.team === menuTeam) ?? null);
  const newTeamBot = newTeamBotId === null ? null : (botById.get(newTeamBotId) ?? null);

  const send = async (
    botId: string,
    update: { readonly team: PersonalBotTeam; readonly lead: boolean },
    message: string,
  ) => {
    setFeedback(null);
    const result = await updateBot({
      environmentId,
      input: { botId: PersonalBotId.make(botId), team: update.team, lead: update.lead },
    });
    const failure = commandFailureMessage(result, "Couldn't move this bot. Try again.");
    setFeedback(
      failure === null ? { tone: "info", text: message } : { tone: "error", text: failure },
    );
  };

  const pick = (option: MoveSheetOption) => {
    if (moving === null) return;
    const plan = planDrop({
      bot: moving,
      target: { kind: option.kind, team: option.team },
      roster,
    });
    if (plan.kind === "confirm") {
      setConfirm({ botId: moving.botId, option });
      return;
    }
    if (plan.kind !== "commit") {
      setFeedback({ tone: plan.kind === "blocked" ? "error" : "info", text: plan.message });
      return;
    }
    setMoveBotId(null);
    void send(moving.botId, plan.outcome.update, plan.outcome.message);
  };

  const confirmMove = () => {
    if (moving === null || confirm === null) return;
    const plan = planDrop({
      bot: moving,
      target: { kind: confirm.option.kind, team: confirm.option.team },
      roster,
      confirmed: true,
    });
    setConfirm(null);
    setMoveBotId(null);
    if (plan.kind === "commit") {
      void send(moving.botId, plan.outcome.update, plan.outcome.message);
    }
  };

  const removeTeam = async (team: PersonalBotTeam) => {
    if (removing) return;
    setRemoving(true);
    setFeedback(null);
    try {
      const result = await saveProfile({
        environmentId,
        input: { teamChange: { operation: "delete", name: team.trim() } },
      });
      const failure = commandFailureMessage(result, "Couldn't remove the team. Try again.");
      if (failure !== null) setFeedback({ tone: "error", text: failure });
      else setFeedback({ tone: "info", text: `${team} removed.` });
      setMenuTeam(null);
    } finally {
      setRemoving(false);
    }
  };

  const memberRows: ReadonlyArray<TeamMemberModel> = membersCard?.members ?? [];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Team"
        onBack={onBack}
        right={
          <Pressable
            onPress={onNewTeam}
            accessibilityRole="button"
            accessibilityLabel="New team"
            style={styles.newButton}
          >
            <IconPlus size={22} color={tokens.text} strokeWidth={2} />
          </Pressable>
        }
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 28 }]}
      >
        {notice === null ? null : (
          <Text style={styles.notice} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.5}>
            {notice.message}
          </Text>
        )}
        {list.error !== null && list.data !== null ? (
          <Text style={styles.feedbackError} maxFontSizeMultiplier={1.5}>
            Couldn't refresh your bots. {list.error}
          </Text>
        ) : null}
        {profile.error !== null ? (
          <Text style={styles.feedbackError} maxFontSizeMultiplier={1.5}>
            Couldn't load your teams.
          </Text>
        ) : null}
        {feedback === null ? null : (
          <Text
            style={feedback.tone === "error" ? styles.feedbackError : styles.feedback}
            accessibilityRole={feedback.tone === "error" ? "alert" : undefined}
            accessibilityLiveRegion="polite"
            maxFontSizeMultiplier={1.5}
          >
            {feedback.text}
          </Text>
        )}

        {state.kind === "offline" ? (
          <Text style={styles.stateText} maxFontSizeMultiplier={1.5}>
            Connect to your computer to see your team.
          </Text>
        ) : state.kind === "loading" ? (
          <Text style={styles.stateText} maxFontSizeMultiplier={1.5}>
            Loading your team…
          </Text>
        ) : state.kind === "error" ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText} maxFontSizeMultiplier={1.5}>
              Couldn't load your bots. {state.message}
            </Text>
            <Pressable
              onPress={() => {
                list.refresh();
                profile.refresh();
              }}
              accessibilityRole="button"
              accessibilityLabel="Try again"
              style={styles.tryButton}
            >
              <Text style={styles.tryText} maxFontSizeMultiplier={1.4}>
                Try again
              </Text>
            </Pressable>
          </View>
        ) : state.kind === "empty" ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.5}>
              No bots yet
            </Text>
            <Text style={styles.stateText} maxFontSizeMultiplier={1.5}>
              Give a bot a name, a look and a provider, then see how your team works together.
            </Text>
            <Pressable
              onPress={onNewBot}
              accessibilityRole="button"
              accessibilityLabel="Create your first bot"
              style={styles.primary}
            >
              <Text style={styles.primaryText} maxFontSizeMultiplier={1.4}>
                Create your first bot
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.summary}>
              <View style={styles.ownerBadge}>
                <Text style={styles.ownerInitial} maxFontSizeMultiplier={1.3}>
                  {(profile.data?.displayName.trim() || "You").slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={styles.summaryText}>
                <Text style={styles.ownerName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                  {profile.data?.displayName.trim() || "You"}
                </Text>
                <Text style={styles.summaryLine} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                  {teamSummary(cards.length, bots.length)}
                </Text>
              </View>
            </View>
            <TeamWorkingNow
              rows={working}
              onOpen={(row) => {
                if (row.threadId === null) onOpenTask(row.taskId);
                else onOpenChat(row.to.botId, row.threadId);
              }}
            />
            {cards.map((card) => (
              <TeamCard
                key={card.team}
                card={card}
                onOpenMembers={() => setMembersTeam(card.team)}
                onMove={(botId) => setMoveBotId(botId)}
                onOpenMenu={() => setMenuTeam(card.team)}
              />
            ))}
            <TeamTokenUsage
              native={native}
              bots={allBots}
              listedBotIds={listedBotIds}
              modelNames={modelNames}
              nowMs={now}
              onOpenChats={onOpenChats}
            />
          </>
        )}
      </ScrollView>

      <TeamMembersSheet
        visible={membersCard !== null}
        teamLabel={membersCard?.label ?? ""}
        rows={memberRows}
        onClose={() => setMembersTeam(null)}
        onOpenBot={(botId) => {
          setMembersTeam(null);
          onOpenBot(botId);
        }}
        onMove={(botId) => {
          setMembersTeam(null);
          setMoveBotId(botId);
        }}
      />

      <TeamMoveSheet
        visible={moving !== null && confirm === null && newTeamBot === null}
        botName={moving?.name ?? ""}
        options={moveOptions}
        onClose={() => setMoveBotId(null)}
        onPick={pick}
        onNewTeam={() => {
          if (moving === null) return;
          setNewTeamBotId(moving.botId);
        }}
      />

      {confirm === null || confirmCopy === null ? null : (
        <TeamLeadConfirmSheet
          visible
          copy={confirmCopy}
          newLeadName={confirmBot?.name ?? ""}
          oldLead={confirmOldLead}
          busy={false}
          onConfirm={confirmMove}
          onCancel={() => setConfirm(null)}
        />
      )}

      <TeamMenuSheet
        visible={menuCard !== null}
        teamLabel={menuCard?.label ?? ""}
        removeLabel={removeTeamLabel(menuCard?.removable ?? false)}
        removable={menuCard?.removable ?? false}
        busy={removing}
        onClose={() => setMenuTeam(null)}
        onRemove={() => {
          if (menuCard !== null) void removeTeam(menuCard.team);
        }}
      />

      <SheetShell
        visible={newTeamBot !== null}
        title={`New team with ${newTeamBot?.name ?? ""}`}
        onClose={() => setNewTeamBotId(null)}
        inline
      >
        <NewTeamForm
          native={native}
          bots={allBots}
          customTeams={customTeams}
          initialMemberIds={newTeamBot === null ? [] : [newTeamBot.botId as string]}
          onCancel={() => setNewTeamBotId(null)}
          onCreated={(created) => {
            setNewTeamBotId(null);
            setMoveBotId(null);
            setNotice(created);
          }}
        />
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  scroll: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  newButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
    marginRight: 4,
  },
  summary: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 4 },
  ownerBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  ownerInitial: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
  summaryText: { flex: 1, minWidth: 0 },
  ownerName: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  summaryLine: { color: tokens.textSecondary, fontSize: 13 },
  notice: {
    color: tokens.text,
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 21,
  },
  feedback: {
    color: tokens.text,
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 21,
  },
  feedbackError: {
    color: tokens.danger,
    backgroundColor: tokens.dangerBg,
    borderColor: tokens.dangerBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 21,
  },
  stateText: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21 },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  errorText: { flex: 1, color: tokens.text, fontSize: 15, lineHeight: 21 },
  tryButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  tryText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  empty: { alignItems: "center", gap: 10, paddingTop: 40 },
  emptyTitle: { color: tokens.text, fontSize: 18, fontWeight: "600" },
  primary: {
    minHeight: 44,
    marginTop: 8,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  primaryText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
});
