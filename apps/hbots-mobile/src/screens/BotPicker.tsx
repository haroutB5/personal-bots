import { IconCheck } from "@tabler/icons-react-native";
import type { PersonalBot } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useStartChat } from "../chat/useStartChat";
import type { NativePersonal } from "../personal/nativePersonalClient";
import {
  backToPick,
  beginSend,
  blockedMessage,
  emptySearchText,
  filterBots,
  intakeShare,
  keepsSharedFiles,
  openPicker,
  pickBot,
  previewLabel,
  setNote,
  setQuery,
  shareChatId,
  type PickerIntent,
  type PickerState,
} from "../share/pickerModel";
import { sendShare } from "../share/sendShare";
import { discardShare, readShare } from "../share/shareIntake";
import { BotAvatar } from "../shell/BotAvatar";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";

/**
 * Where a share or "Ask hbots" lands (SPEC section 6): pick a bot, add a note,
 * Send. It never sends on its own. A send starts a new chat with the bot and
 * queues the message in the outbox, so it goes out like a typed one.
 */
export function BotPicker({
  native,
  shareId,
  onClose,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly shareId: string;
  readonly onClose: () => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const connection = native.useConnectionState();
  const start = useStartChat(native);
  const [intake] = useState(() => {
    const raw = readShare(shareId);
    return raw === null ? ({ ok: false, reason: "empty" } as const) : intakeShare(raw);
  });
  const chatIds = useRef(new Map<string, string>());
  const [picked, setState] = useState<PickerState | null>(null);
  const online = connection.phase === "connected";
  const bots = (list.data?.bots ?? []).filter((bot) => bot.enabled);
  const state = picked ?? openPicker(intake, { paired: true, online });

  useEffect(() => () => discardShare(shareId), [shareId]);
  // A refusal never reads the files, so they go now, not when the picker closes.
  const filesNeeded = keepsSharedFiles(state);
  useEffect(() => {
    if (!filesNeeded) discardShare(shareId);
  }, [filesNeeded, shareId]);

  const intent = "intent" in state ? state.intent : null;

  const send = async () => {
    if (state.step !== "confirm") return;
    setState(beginSend(state));
    const threadId = shareChatId(chatIds.current, state.botId, () =>
      native.client.ports.ids.randomUUID(),
    );
    const next = await sendShare({ state, bots, native, start, threadId });
    if (next.step === "sent") discardShare(shareId);
    setState(next);
  };

  const title = intent?.kind === "ask" ? "Ask a bot" : "Send to";

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]} accessibilityViewIsModal>
      <ScreenHeader
        title={state.step === "sent" ? "Sent" : title}
        onBack={state.step === "confirm" ? () => setState(backToPick(state)) : onClose}
      />
      {state.step === "blocked" ? (
        <Centered>
          <Text style={styles.notice} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
            {blockedMessage(state.reason)}
          </Text>
        </Centered>
      ) : state.step === "sending" ? (
        <Centered>
          <ActivityIndicator color={tokens.textSecondary} accessibilityLabel="Sending" />
        </Centered>
      ) : state.step === "sent" ? (
        <SentRow
          botName={bots.find((bot) => bot.botId === state.botId)?.name ?? "the bot"}
          onOpen={() => onOpenChat(state.botId, state.threadId)}
          onClose={onClose}
        />
      ) : state.step === "confirm" ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
          <Preview intent={state.intent} />
          <Text style={styles.target} maxFontSizeMultiplier={1.6}>
            New chat with {bots.find((bot) => bot.botId === state.botId)?.name ?? "the bot"}
          </Text>
          <TextInput
            value={state.note}
            onChangeText={(note) => setState(setNote(state, note))}
            autoFocus
            multiline
            placeholder={state.intent.kind === "ask" ? "What do you want to ask?" : "Add a note"}
            placeholderTextColor={tokens.textSecondary}
            accessibilityLabel={state.intent.kind === "ask" ? "Your question" : "Note"}
            maxFontSizeMultiplier={1.6}
            style={styles.input}
          />
          {state.error === undefined ? null : (
            <Text style={styles.error} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
              {state.error}
            </Text>
          )}
          <Pressable
            onPress={() => void send()}
            accessibilityRole="button"
            accessibilityLabel="Send"
            style={styles.send}
          >
            <Text style={styles.sendText} maxFontSizeMultiplier={1.6}>
              Send
            </Text>
          </Pressable>
        </ScrollView>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
          <Preview intent={state.intent} />
          <TextInput
            value={state.query}
            onChangeText={(query) => setState(setQuery(state, query))}
            placeholder="Search bots"
            placeholderTextColor={tokens.textSecondary}
            accessibilityLabel="Search bots"
            autoComplete="off"
            maxFontSizeMultiplier={1.6}
            style={styles.search}
          />
          {list.data === null ? (
            <ActivityIndicator color={tokens.textSecondary} accessibilityLabel="Loading bots" />
          ) : (
            <BotRows
              bots={filterBots(bots, state.query)}
              query={state.query}
              onPick={(bot) => setState(pickBot(state, bot.botId as string))}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Centered({ children }: { readonly children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

function Preview({ intent }: { readonly intent: PickerIntent }) {
  const images =
    intent.kind === "share" ? intent.items.filter((item) => item.kind === "image") : [];
  const quote =
    intent.kind === "ask"
      ? intent.text
      : intent.items.flatMap((item) => (item.kind === "text" ? [item.text] : [])).join("\n\n");
  return (
    <View accessible accessibilityLabel={previewLabel(intent)} style={styles.preview}>
      {images.length > 0 ? (
        <View style={styles.thumbs}>
          {images.map((item) =>
            item.kind === "image" ? (
              <Image key={item.uri} source={{ uri: item.uri }} style={styles.thumb} />
            ) : null,
          )}
        </View>
      ) : null}
      {intent.kind === "share"
        ? intent.items
            .filter((item) => item.kind === "file")
            .map((item) => (
              <Text
                key={item.kind === "file" ? item.uri : ""}
                style={styles.fileName}
                numberOfLines={1}
              >
                {item.kind === "file" ? item.name : ""}
              </Text>
            ))
        : null}
      {quote.length > 0 ? (
        <View style={styles.quote}>
          <View style={styles.quoteBar} />
          <Text style={styles.quoteText} numberOfLines={3} maxFontSizeMultiplier={1.6}>
            {quote}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function BotRows({
  bots,
  query,
  onPick,
}: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly query: string;
  readonly onPick: (bot: PersonalBot) => void;
}) {
  if (bots.length === 0) {
    return (
      <Text style={styles.notice} maxFontSizeMultiplier={1.6}>
        {query.trim().length > 0 ? emptySearchText(query) : "You have no bots yet."}
      </Text>
    );
  }
  return (
    <View>
      {bots.map((bot) => (
        <Pressable
          key={bot.botId}
          onPress={() => onPick(bot)}
          accessibilityRole="button"
          accessibilityLabel={bot.title.length > 0 ? `${bot.name}, ${bot.title}` : bot.name}
          style={styles.row}
        >
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={40} label="" />
          <View style={styles.rowText}>
            <Text style={styles.rowName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
              {bot.name}
            </Text>
            {bot.title.length > 0 ? (
              <Text style={styles.rowRole} numberOfLines={1} maxFontSizeMultiplier={1.6}>
                {bot.title}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function SentRow({
  botName,
  onOpen,
  onClose,
}: {
  readonly botName: string;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}) {
  return (
    <View style={styles.sent}>
      <IconCheck size={20} color={tokens.working} strokeWidth={2.2} />
      <Text
        style={styles.sentText}
        accessibilityLiveRegion="polite"
        maxFontSizeMultiplier={1.6}
      >{`Sent to ${botName}`}</Text>
      <Pressable onPress={onOpen} accessibilityRole="button" hitSlop={8}>
        <Text style={styles.link} maxFontSizeMultiplier={1.6}>
          Open
        </Text>
      </Pressable>
      <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8}>
        <Text style={styles.link} maxFontSizeMultiplier={1.6}>
          Done
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  notice: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  preview: { gap: 8 },
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: tokens.fillMuted },
  fileName: { color: tokens.text, fontSize: 14 },
  quote: { flexDirection: "row", gap: 10 },
  quoteBar: { width: 2, borderRadius: 1, backgroundColor: tokens.primary },
  quoteText: { flex: 1, color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  search: {
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 14,
    color: tokens.text,
    backgroundColor: tokens.surface,
    fontSize: 16,
  },
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12 },
  rowText: { flex: 1, gap: 2 },
  rowName: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  rowRole: { color: tokens.textSecondary, fontSize: 12 },
  target: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  input: {
    minHeight: 96,
    borderRadius: 12,
    padding: 14,
    color: tokens.text,
    backgroundColor: tokens.surface,
    fontSize: 16,
    textAlignVertical: "top",
  },
  error: { color: tokens.error, fontSize: 13 },
  send: {
    minHeight: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  sendText: { color: tokens.primaryText, fontSize: 16, fontWeight: "600" },
  sent: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
  },
  sentText: { flex: 1, color: tokens.text, fontSize: 16 },
  link: { color: tokens.primary, fontSize: 15, fontWeight: "600" },
});
