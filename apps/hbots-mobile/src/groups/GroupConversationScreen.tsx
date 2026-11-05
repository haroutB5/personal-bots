import { useAtomValue } from "@effect/atom-react";
import {
  MessageId,
  PersonalBotId,
  PersonalGroupId,
  PersonalGroupVoteId,
  ThreadId,
  type PersonalGroup,
  type PersonalReplyQuote,
} from "@t3tools/contracts";
import { requestOlderThreadTurns } from "@t3tools/client-runtime/state/threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { IconChevronLeft, IconDots } from "@tabler/icons-react-native";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { snoozePresets } from "@hbots/personal-client/bots/chatState";
import {
  activeGroupMembers,
  groupDeleteCandidates,
  groupRelayThreadIds,
  groupRoundCard,
  groupStatusLine,
  groupSubtitle,
  groupVoteCard,
  isGroupRoundLive,
  reusablePrivateChat,
  roundForGroup,
} from "@hbots/personal-client/conversation/groupModel";
import { mergePersonalGroups } from "@hbots/personal-client/groups/personalGroups";
import { buildChatFeed } from "@hbots/personal-client/feed/chatFeed";

import { useThreadDetailView, useThreadRef } from "../chat/chatEnvironment";
import { MessageList } from "../chat/MessageList";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetAction, SheetCancel, SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { GroupAvatarCluster } from "./GroupAvatarCluster";
import { GroupComposer } from "./GroupComposer";
import { GroupDeleteSheet } from "./GroupDeleteSheet";
import { GroupRoundCard, GroupVoteCard } from "./GroupCards";
import { GroupSettingsSheet } from "./GroupSettingsSheet";
import { groupComposerMode, groupMenuActions, groupScreenState } from "./groupScreenModel";

function failureText(result: { readonly _tag: string }, fallback: string): string | null {
  if (result._tag === "Success") return null;
  const cause = squashAtomCommandFailure(result as never);
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export function GroupConversationScreen({
  native,
  chat,
  groupId,
  onBack,
  onOpenChat,
  onEditBot,
}: {
  readonly native: NativePersonal;
  readonly chat: ReturnType<typeof import("../chat/chatEnvironment").createChatEnvironment>;
  readonly groupId: string;
  readonly onBack: () => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onEditBot: (botId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const list = native.groups.usePersonalGroupsList(environmentId);
  const { feed } = native.groups.usePersonalGroupsFeed(environmentId);
  const botsList = native.bots.usePersonalBotsList(environmentId);
  const merged = useMemo(() => mergePersonalGroups(list.data, feed), [list.data, feed]);
  const group =
    merged.groups.find((candidate) => candidate.groupId === groupId) ??
    merged.archivedGroups.find((candidate) => candidate.groupId === groupId) ??
    null;
  const archived = group !== null && group.archivedAt !== null;
  const round = roundForGroup(merged.rounds, groupId);
  const live = isGroupRoundLive(round);

  const threadId = group === null ? null : group.threadId;
  const ref = useThreadRef(environmentId, threadId);
  const view = useThreadDetailView(chat, ref);
  const thread = view.thread;

  const bots = botsList.data?.bots ?? [];
  const botsById = useMemo(
    () => new Map(bots.map((entry) => [entry.botId as string, entry] as const)),
    [bots],
  );
  const nameOf = (botId: string): string | null => botsById.get(botId)?.name ?? null;
  const members = group === null ? [] : activeGroupMembers(group);
  const memberBots = useMemo(
    () =>
      members.flatMap((member) => {
        const bot = botsById.get(member.botId);
        return bot === undefined ? [] : [bot];
      }),
    [botsById, members],
  );
  const speakerOf = (botId: string) => {
    const bot = botsById.get(botId);
    return bot === undefined
      ? null
      : { name: bot.name, avatarShape: bot.avatarShape, avatarColor: bot.avatarColor };
  };

  const state = groupScreenState({
    listLoaded: list.data !== null,
    listError: list.error,
    groupExists: group !== null,
  });

  const items = useMemo(
    () =>
      thread === null
        ? []
        : buildChatFeed({
            messages: thread.messages,
            proposedPlans: thread.proposedPlans,
            activities: thread.activities,
            groups: true,
          }),
    [thread],
  );

  const page = Option.getOrNull(view.state.page);
  const loadEarlierAvailable = page?.hasMore === true;

  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [unarchiving, setUnarchiving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const sendMessage = native.client.useAtomCommand(native.groups.personalGroupSendMessage, {
    reportFailure: false,
  });
  const continueRound = native.client.useAtomCommand(native.groups.personalGroupContinueRound, {
    reportFailure: false,
  });
  const stopRound = native.client.useAtomCommand(native.groups.personalGroupStop, {
    reportFailure: false,
  });
  const updateGroup = native.client.useAtomCommand(native.groups.personalGroupUpdate, {
    reportFailure: false,
  });
  const deleteGroup = native.client.useAtomCommand(native.groups.personalGroupDelete, {
    reportFailure: false,
  });
  const addMember = native.client.useAtomCommand(native.groups.personalGroupAddMember, {
    reportFailure: false,
  });
  const removeMember = native.client.useAtomCommand(native.groups.personalGroupRemoveMember, {
    reportFailure: false,
  });
  const createThread = native.client.useAtomCommand(native.bots.personalBotCreateThread, {
    reportFailure: false,
  });
  const shellState = useAtomValue(native.shell.stateValueAtom(environmentId));
  const allShells = useMemo(
    () => native.shellsOf(Option.getOrNull(shellState.snapshot)),
    [native, shellState.snapshot],
  );

  const update = async (
    change:
      | { readonly pinned: boolean }
      | { readonly archived: boolean }
      | { readonly snoozedUntil: string | null },
    fallback: string,
  ): Promise<string | null> => {
    if (group === null) return fallback;
    const result = await updateGroup({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId), ...change } as never,
    });
    return failureText(result, fallback);
  };

  const stopGroup = async (): Promise<string | null> => {
    const result = await stopRound({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId) },
    });
    return failureText(result, "Couldn't stop the group. Try again.");
  };

  const continueTheRound = async (): Promise<string | null> => {
    const result = await continueRound({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId) },
    });
    return failureText(result, "Couldn't continue the group. Try again.");
  };

  const onDecide = async (decision: "approve" | "reject"): Promise<string | null> => {
    const voteId = vote?.voteId;
    if (voteId === undefined) return null;
    const result = await continueRound({
      environmentId,
      input: {
        groupId: PersonalGroupId.make(groupId),
        vote: { voteId: PersonalGroupVoteId.make(voteId), decision },
      },
    });
    return failureText(
      result,
      decision === "approve"
        ? "Couldn't approve that. Try again."
        : "Couldn't reject that. Try again.",
    );
  };

  const messagePrivately = async (botId: string): Promise<string | null> => {
    const reuse = reusablePrivateChat({
      botId,
      links: botsList.data?.threads ?? [],
      shells: allShells.filter((shell) => shell.environmentId === environmentId),
      relayThreadIds: groupRelayThreadIds({
        groups: merged.groups,
        archivedGroups: merged.archivedGroups,
      }),
    });
    let target = reuse;
    if (target === null) {
      const fresh = ThreadId.make(native.client.ports.ids.randomUUID());
      const result = await createThread({
        environmentId,
        input: { botId: PersonalBotId.make(botId), threadId: fresh },
      });
      const failure = failureText(result, "Couldn't start a private chat. Try again.");
      if (failure !== null) return failure;
      target = fresh;
    }
    setSettingsOpen(false);
    onOpenChat(botId, target);
    return null;
  };

  const memberActions = {
    onEditBot,
    onAddMember: async (botId: string) => {
      const result = await addMember({
        environmentId,
        input: { groupId: PersonalGroupId.make(groupId), botId: PersonalBotId.make(botId) },
      });
      return failureText(result, "Couldn't add that bot. Try again.");
    },
    onRemoveMember: async (botId: string) => {
      const result = await removeMember({
        environmentId,
        input: { groupId: PersonalGroupId.make(groupId), botId: PersonalBotId.make(botId) },
      });
      return failureText(result, "Couldn't remove that bot. Try again.");
    },
    onMessagePrivately: messagePrivately,
  };

  const status = group === null ? null : groupStatusLine(round, nameOf, { archived });
  const card = groupRoundCard(round, nameOf);
  const vote =
    group === null ? null : groupVoteCard({ round, votes: merged.votes, members, nameOf });
  const composerMode = groupComposerMode({
    archived,
    live,
    memberCount: members.length,
  });

  const send = async (text: string): Promise<string | null> => {
    const result = await sendMessage({
      environmentId,
      input: {
        groupId: PersonalGroupId.make(groupId),
        messageId: MessageId.make(native.client.ports.ids.randomUUID()),
        text,
      },
    });
    return failureText(result, "Couldn't send that message. Try again.");
  };

  if (state.kind === "gone" || (group !== null && view.status === "deleted")) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header
          title="Group"
          subtitle={null}
          onBack={onBack}
          onMenu={null}
          avatar={null}
          status={null}
        />
        <View style={styles.center}>
          <Text style={styles.centerText}>This group no longer exists.</Text>
          <Pressable onPress={onBack} accessibilityRole="button" style={styles.pill}>
            <Text style={styles.pillText}>Back to Bots</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <Header
        title={group?.name ?? "Group"}
        subtitle={status === null ? null : status.label}
        onBack={onBack}
        onMenu={group === null ? null : () => setMenuOpen(true)}
        avatar={
          group === null ? null : (
            <GroupAvatarCluster bots={memberBots} memberCount={members.length} size={36} />
          )
        }
        status={
          group === null || status === null ? null : (
            <Text style={styles.headerSub} numberOfLines={1}>
              {`${groupSubtitle(group, nameOf)} · ${status.label}`}
            </Text>
          )
        }
        onTitle={group === null ? null : () => setSettingsOpen(true)}
      />

      {actionError !== null ? (
        <Pressable
          onPress={() => setActionError(null)}
          accessibilityRole="alert"
          style={styles.errorBox}
        >
          <Text style={styles.errorText}>{actionError}</Text>
        </Pressable>
      ) : null}

      {state.kind === "error" ? (
        <View style={styles.center}>
          <Text style={styles.centerText}>{`Couldn't load this group. ${state.message}`}</Text>
          <Pressable onPress={list.refresh} accessibilityRole="button" style={styles.pill}>
            <Text style={styles.pillText}>Try again</Text>
          </Pressable>
        </View>
      ) : thread === null || group === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.textSecondary} />
          <Text style={styles.centerText}>Loading group</Text>
        </View>
      ) : (
        <>
          <MessageList
            native={native}
            chat={chat}
            items={items}
            pending={[]}
            queued={[]}
            botName={group.name}
            currentUserId="You"
            activities={thread.activities}
            latestTurn={thread.latestTurn}
            busy={live}
            latestMessageStatus={null}
            onReply={(_quote: PersonalReplyQuote) => undefined}
            onMessageMenu={() => undefined}
            onOpenFile={undefined}
            onOpenLink={(url) => {
              void Linking.openURL(url).catch(() => setActionError("Couldn't open that link."));
            }}
            onCancelQueued={() => undefined}
            onRetryQueued={() => undefined}
            onLoadEarlier={
              loadEarlierAvailable && threadId !== null
                ? () => requestOlderThreadTurns(environmentId, ThreadId.make(threadId))
                : null
            }
            loadEarlierBusy={page?.loadingOlder === true}
            groupSpeaker={speakerOf}
          />

          {vote !== null && !archived ? (
            <View style={styles.cardSlot}>
              <GroupVoteCard card={vote} speakerOf={speakerOf} onDecide={onDecide} />
            </View>
          ) : null}
          {card !== null && !archived ? (
            <View style={styles.cardSlot}>
              <GroupRoundCard card={card} onAct={continueTheRound} />
            </View>
          ) : null}

          <View style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
            <GroupComposer mode={composerMode} onSend={send} onStop={stopGroup} />
          </View>
        </>
      )}

      <SheetShell visible={menuOpen} title="Group options" onClose={() => setMenuOpen(false)}>
        {group === null
          ? null
          : groupMenuActions({
              live,
              archived,
              pinned: group.pinnedAt !== undefined && group.pinnedAt !== null,
              unarchiving,
            }).map((action) => (
              <SheetAction
                key={action.key}
                label={action.label}
                danger={action.destructive}
                disabled={action.disabled}
                onPress={() => {
                  setMenuOpen(false);
                  switch (action.key) {
                    case "settings":
                      setSettingsOpen(true);
                      break;
                    case "stop":
                      void stopGroup().then(setActionError);
                      break;
                    case "pin":
                      void update(
                        { pinned: !(group.pinnedAt !== undefined && group.pinnedAt !== null) },
                        "Couldn't pin this group. Try again.",
                      ).then(setActionError);
                      break;
                    case "snooze":
                      setSnoozeOpen(true);
                      break;
                    case "unarchive":
                      setUnarchiving(true);
                      void update(
                        { archived: false },
                        "Couldn't unarchive this group. Try again.",
                      ).then((failure) => {
                        setUnarchiving(false);
                        setActionError(failure);
                      });
                      break;
                    case "archive":
                      void update(
                        { archived: true },
                        "Couldn't archive this group. Try again.",
                      ).then((failure) => {
                        setActionError(failure);
                        if (failure === null) onBack();
                      });
                      break;
                    case "delete":
                      setDeleteError(null);
                      setDeleteOpen(true);
                      break;
                  }
                }}
              />
            ))}
        <SheetCancel onPress={() => setMenuOpen(false)} />
      </SheetShell>

      <SheetShell visible={snoozeOpen} title="Snooze group" onClose={() => setSnoozeOpen(false)}>
        {snoozePresets(new Date()).map((preset) => (
          <SheetAction
            key={preset.key}
            label={preset.label}
            detail={preset.detail}
            onPress={() => {
              setSnoozeOpen(false);
              void update(
                { snoozedUntil: new Date(preset.untilMs).toISOString() },
                "Couldn't snooze this group. Try again.",
              ).then((failure) => {
                setActionError(failure);
                if (failure === null) onBack();
              });
            }}
          />
        ))}
        <SheetAction
          label="Wake now"
          onPress={() => {
            setSnoozeOpen(false);
            void update({ snoozedUntil: null }, "Couldn't wake this group. Try again.").then(
              setActionError,
            );
          }}
        />
        <SheetCancel onPress={() => setSnoozeOpen(false)} />
      </SheetShell>

      <GroupSettingsSheet
        visible={settingsOpen && group !== null}
        group={group}
        groups={merged.groups}
        bots={bots}
        actions={memberActions}
        onClose={() => setSettingsOpen(false)}
      />

      <GroupDeleteSheet
        visible={deleteOpen && group !== null}
        groupName={group?.name ?? "this group"}
        candidates={
          group === null ? [] : groupDeleteCandidates({ group, groups: merged.groups, bots })
        }
        botsById={new Map(bots.map((bot) => [bot.botId as string, bot] as const))}
        busy={deleting}
        error={deleteError}
        onClose={() => setDeleteOpen(false)}
        onConfirm={(purgeBotIds) => {
          if (group === null) return;
          setDeleting(true);
          setDeleteError(null);
          void deleteGroup({
            environmentId,
            input: {
              groupId: PersonalGroupId.make(groupId),
              purgeBotIds: purgeBotIds.map((botId) => PersonalBotId.make(botId)),
            },
          }).then((result) => {
            setDeleting(false);
            const failure = failureText(result, "Couldn't delete this group. Try again.");
            if (failure !== null) {
              setDeleteError(failure);
              return;
            }
            setDeleteOpen(false);
            onBack();
          });
        }}
      />
    </KeyboardAvoidingView>
  );
}

function Header({
  title,
  subtitle,
  onBack,
  onMenu,
  avatar,
  status,
  onTitle,
}: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly onBack: () => void;
  readonly onMenu: (() => void) | null;
  readonly avatar: React.ReactNode;
  readonly status: React.ReactNode;
  readonly onTitle?: (() => void) | null;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.headerButton}
      >
        <IconChevronLeft size={24} color={tokens.text} strokeWidth={2} />
      </Pressable>
      <Pressable
        onPress={onTitle ?? undefined}
        disabled={onTitle === null || onTitle === undefined}
        accessibilityRole={onTitle === null || onTitle === undefined ? undefined : "button"}
        accessibilityLabel={
          onTitle === null || onTitle === undefined ? undefined : `${title} settings`
        }
        style={styles.headerMain}
      >
        {avatar}
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {title}
          </Text>
          {status ?? (
            <Text style={styles.headerSub} numberOfLines={1}>
              {subtitle ?? " "}
            </Text>
          )}
        </View>
      </Pressable>
      {onMenu === null ? (
        <View style={styles.headerButton} />
      ) : (
        <Pressable
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel="Group options"
          style={styles.headerButton}
        >
          <IconDots size={22} color={tokens.text} strokeWidth={1.75} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  header: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
    gap: 4,
  },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: { color: tokens.text, fontSize: 17, lineHeight: 22, fontWeight: "700" },
  headerSub: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  centerText: { color: tokens.textSecondary, fontSize: 15, textAlign: "center" },
  pill: {
    minHeight: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  pillText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  cardSlot: { paddingHorizontal: 16, paddingBottom: 8 },
  errorBox: {
    margin: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
  },
  errorText: { color: tokens.danger, fontSize: 14, lineHeight: 19 },
});
