import type {
  ChatAttachment,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  PersonalReplyQuote,
} from "@t3tools/contracts";
import { readPersonalReplyQuote } from "@t3tools/contracts";
import {
  formatDayDivider,
  type ConversationItem,
} from "@hbots/personal-client/conversation/conversationModel";
import { replyQuoteForMessage } from "@hbots/personal-client/feed/messageReply";
import { ownerVisibleText } from "@hbots/personal-client/feed/composerText";
import { turnStartByAssistantItem } from "@hbots/personal-client/feed/contextUsed";
import { groupSystemLabel } from "@hbots/personal-client/conversation/groupModel";
import type { LatestMessageReadStatus } from "@hbots/personal-client/feed/messageReadStatus";
import type { PendingOutgoingMessage } from "@hbots/personal-client/feed/types";
import type { OutboxRow } from "@hbots/personal-client/composer/outbox";
import {
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileTypePdf,
  IconPhoto,
  IconPaperclip,
} from "@tabler/icons-react-native";
import { useMemo, useRef, useState, createElement } from "react";
import { Animated, FlatList, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

import type { BotAvatarShape } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import type { ChatEnvironment } from "./chatEnvironment";
import { AttachmentImage } from "./AttachmentImage";
import {
  linkTarget,
  markdownBlocks,
  markdownNeedsWidth,
  type FileLink,
  type InlineSpan,
  type MarkdownBlock,
} from "./markdown";

type Row =
  | { readonly kind: "item"; readonly key: string; readonly item: ConversationItem }
  | { readonly kind: "pending"; readonly key: string; readonly message: PendingOutgoingMessage }
  | { readonly kind: "queued"; readonly key: string; readonly row: OutboxRow };

type ImageAttachment = Extract<ChatAttachment, { readonly type: "image" }>;

function isImageAttachment(attachment: ChatAttachment): attachment is ImageAttachment {
  return attachment.type === "image";
}

function pathLike(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 2 &&
    !trimmed.includes("\n") &&
    /[/\\]/.test(trimmed) &&
    !/^[a-z]+:\/\//i.test(trimmed)
  );
}

function SpanText({
  spans,
  style,
  onOpenFile,
  onOpenLink,
}: {
  readonly spans: ReadonlyArray<InlineSpan>;
  readonly style?: object;
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
}) {
  return (
    <Text style={style}>
      {spans.map((span, index) => {
        if (span.kind === "bold") {
          return (
            <Text key={index} style={styles.bold}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === "italic") {
          return (
            <Text key={index} style={styles.italic}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === "link") {
          const target = linkTarget(span.href);
          if (target.kind === "blocked") {
            return <Text key={index}>{span.text}</Text>;
          }
          if (target.kind === "file") {
            return (
              <Text
                key={index}
                style={styles.fileChip}
                accessibilityRole="link"
                onPress={() => onOpenFile?.(target.path)}
              >
                {span.text}
              </Text>
            );
          }
          return (
            <Text
              key={index}
              style={styles.link}
              accessibilityRole="link"
              onPress={() => onOpenLink?.(target.url)}
            >
              {span.text}
            </Text>
          );
        }
        if (span.kind === "code") {
          if (onOpenFile !== undefined && pathLike(span.text)) {
            return (
              <Text
                key={index}
                style={styles.fileChip}
                accessibilityRole="link"
                onPress={() => onOpenFile(span.text.trim())}
              >
                {span.text}
              </Text>
            );
          }
          return (
            <Text key={index} style={styles.inlineCode}>
              {span.text}
            </Text>
          );
        }
        return <Text key={index}>{span.text}</Text>;
      })}
    </Text>
  );
}

function fileBasename(path: string): string {
  return (
    path
      .split(/[\\/]/u)
      .filter((part) => part.length > 0)
      .at(-1) ?? path
  );
}

function fileIcon(name: string) {
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(name)) return IconPhoto;
  if (/\.pdf$/iu.test(name)) return IconFileTypePdf;
  if (
    /\.(?:ts|tsx|js|jsx|json|css|html|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sql|sh|bash|zsh|yml|yaml|toml|xml)$/iu.test(
      name,
    )
  )
    return IconFileCode;
  if (/\.(?:md|markdown|txt|log)$/iu.test(name)) return IconFileText;
  return IconFile;
}

function FileChip({
  file,
  onOpenFile,
}: {
  readonly file: FileLink;
  readonly onOpenFile?: ((path: string) => void) | undefined;
}) {
  const name = fileBasename(file.path) || file.label;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${name}`}
      onPress={() => onOpenFile?.(file.path)}
      style={({ pressed }) => [styles.fileChipButton, pressed ? styles.fileChipPressed : null]}
    >
      {createElement(fileIcon(name), {
        size: 16,
        color: tokens.textSecondary,
        strokeWidth: 1.75,
      })}
      <Text style={styles.fileChipName} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  );
}

function FileChips({
  files,
  onOpenFile,
}: {
  readonly files: ReadonlyArray<FileLink>;
  readonly onOpenFile?: ((path: string) => void) | undefined;
}) {
  return (
    <View style={styles.fileList}>
      {files.map((file) => (
        <FileChip key={`${file.path}:${file.label}`} file={file} onOpenFile={onOpenFile} />
      ))}
    </View>
  );
}

function MarkdownBody({
  text,
  onOpenFile,
  onOpenLink,
  tone,
}: {
  readonly text: string;
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
  readonly tone: "assistant" | "user";
}) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return (
    <View style={styles.markdown}>
      {blocks.map((block, index) => (
        <Block
          key={index}
          block={block}
          onOpenFile={onOpenFile}
          onOpenLink={onOpenLink}
          tone={tone}
        />
      ))}
    </View>
  );
}

function Block({
  block,
  onOpenFile,
  onOpenLink,
  tone,
}: {
  readonly block: MarkdownBlock;
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
  readonly tone: "assistant" | "user";
}) {
  const base = tone === "user" ? styles.userText : styles.assistantText;
  if (block.files !== undefined) {
    return <FileChips files={block.files} onOpenFile={onOpenFile} />;
  }
  switch (block.kind) {
    case "heading":
      return (
        <SpanText
          spans={block.spans}
          style={[base, styles.heading]}
          onOpenFile={onOpenFile}
          onOpenLink={onOpenLink}
        />
      );
    case "code":
      return (
        <View style={styles.codeBlock}>
          <Text style={styles.codeText} selectable>
            {block.text}
          </Text>
        </View>
      );
    case "bullet": {
      const marker = ["•", "◦", "▪"][block.depth ?? 0] ?? "•";
      return (
        <View style={[styles.listRow, { paddingLeft: (block.depth ?? 0) * 16 }]}>
          <Text style={[base, styles.marker]}>{marker}</Text>
          <SpanText
            spans={block.spans}
            style={[base, styles.flex]}
            onOpenFile={onOpenFile}
            onOpenLink={onOpenLink}
          />
        </View>
      );
    }
    case "number":
      return (
        <View style={[styles.listRow, { paddingLeft: (block.depth ?? 0) * 16 }]}>
          <Text style={[base, styles.marker]}>{`${block.marker ?? "1"}.`}</Text>
          <SpanText
            spans={block.spans}
            style={[base, styles.flex]}
            onOpenFile={onOpenFile}
            onOpenLink={onOpenLink}
          />
        </View>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <SpanText
            spans={block.spans}
            style={[base, styles.quoteText]}
            onOpenFile={onOpenFile}
            onOpenLink={onOpenLink}
          />
        </View>
      );
    case "paragraph":
      return (
        <SpanText
          spans={block.spans}
          style={base}
          onOpenFile={onOpenFile}
          onOpenLink={onOpenLink}
        />
      );
  }
}

function SentAt({ at, align }: { readonly at: Date; readonly align: "start" | "end" }) {
  return (
    <Text style={[styles.sentAt, align === "end" ? styles.sentAtEnd : null]}>
      {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </Text>
  );
}

function SwipeMessageRow({
  onReply,
  align,
  sentAt,
  children,
}: {
  readonly onReply: (() => void) | undefined;
  readonly align: "start" | "end";
  readonly sentAt: Date | null;
  readonly children: React.ReactNode;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
      onPanResponderMove: (_event, gesture) => {
        const direction = align === "end" ? -1 : 1;
        const next = Math.max(0, Math.min(72, gesture.dx * direction));
        translateX.setValue(align === "end" ? -next : next);
        setRevealed(next > 6);
      },
      onPanResponderRelease: (_event, gesture) => {
        const direction = align === "end" ? -1 : 1;
        const distance = gesture.dx * direction;
        if (distance > 56 && onReply !== undefined) {
          onReply();
        }
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 26,
        }).start(() => setRevealed(false));
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 26,
        }).start(() => setRevealed(false));
      },
    }),
  ).current;
  return (
    <View style={[styles.swipeRow, align === "end" ? styles.alignEnd : styles.alignStart]}>
      {revealed && sentAt !== null ? (
        <View
          style={[styles.swipeTime, align === "end" ? styles.swipeTimeEnd : styles.swipeTimeStart]}
        >
          <SentAt at={sentAt} align={align} />
        </View>
      ) : null}
      <Animated.View
        style={[styles.swipeContent, { transform: [{ translateX }] }]}
        {...responder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function UserBubble({
  native,
  chat,
  text,
  quote,
  attachments,
  onLongPress,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly text: string;
  readonly quote: PersonalReplyQuote | null;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly onLongPress: () => void;
}) {
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={styles.userBubble}>
      {quote !== null ? (
        <View style={styles.quoteChip}>
          <Text style={styles.quoteName} numberOfLines={1}>
            {quote.name}
          </Text>
          <Text style={styles.quoteExcerpt} numberOfLines={2}>
            {quote.excerpt}
          </Text>
        </View>
      ) : null}
      <Text style={styles.userText}>{text}</Text>
      {attachments?.map((attachment) =>
        isImageAttachment(attachment) ? (
          <AttachmentImage
            key={attachment.id}
            native={native}
            chat={chat}
            attachment={attachment}
          />
        ) : (
          <View key={attachment.id} style={styles.attachment}>
            <IconPaperclip size={14} color={tokens.textSecondary} strokeWidth={2} />
            <Text style={styles.attachmentText} numberOfLines={1}>
              {attachment.name}
            </Text>
          </View>
        ),
      )}
    </Pressable>
  );
}

export function MessageList({
  native,
  chat,
  items,
  pending,
  queued,
  botName,
  currentUserId,
  activities,
  latestTurn,
  busy,
  latestMessageStatus,
  onReply,
  onMessageMenu,
  onOpenFile,
  onOpenLink,
  onCancelQueued,
  onRetryQueued,
  onLoadEarlier,
  loadEarlierBusy,
  groupSpeaker,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly items: ReadonlyArray<ConversationItem>;
  readonly pending: ReadonlyArray<PendingOutgoingMessage>;
  readonly queued: ReadonlyArray<OutboxRow>;
  readonly botName: string;
  readonly currentUserId: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly busy: boolean;
  readonly latestMessageStatus: LatestMessageReadStatus | null;
  readonly onReply: (quote: PersonalReplyQuote) => void;
  readonly onMessageMenu: (message: {
    readonly messageId: string;
    readonly name: string;
    readonly text: string;
    readonly sentAt: Date | null;
  }) => void;
  readonly onOpenFile: ((path: string) => void) | undefined;
  readonly onOpenLink: ((href: string) => void) | undefined;
  readonly onCancelQueued: (id: string) => void;
  readonly onRetryQueued: (id: string) => void;
  readonly onLoadEarlier: (() => void) | null;
  readonly loadEarlierBusy: boolean;
  /** Group transcripts only: who a member message belongs to. */
  readonly groupSpeaker?: (
    botId: string,
  ) => {
    readonly name: string;
    readonly avatarShape: BotAvatarShape;
    readonly avatarColor: string;
  } | null;
}) {
  const listRef = useRef<FlatList<Row>>(null);
  const rows = useMemo<ReadonlyArray<Row>>(
    () => [
      ...items.map((item): Row => ({ kind: "item", key: item.id, item })),
      ...pending.map((message): Row => ({
        kind: "pending",
        key: `pending:${message.id}`,
        message,
      })),
      ...queued.map((row): Row => ({ kind: "queued", key: `queued:${row.entry.id}`, row })),
    ],
    [items, pending, queued],
  );
  const contextTurns = useMemo(() => turnStartByAssistantItem(items), [items]);

  return (
    <FlatList
      ref={listRef}
      data={rows.toReversed()}
      inverted
      style={styles.list}
      keyExtractor={(row) => row.key}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      initialNumToRender={24}
      maxToRenderPerBatch={16}
      windowSize={9}
      removeClippedSubviews
      ListFooterComponent={
        onLoadEarlier === null ? null : (
          <Pressable
            onPress={onLoadEarlier}
            disabled={loadEarlierBusy}
            accessibilityRole="button"
            style={styles.loadEarlier}
          >
            <Text style={styles.loadEarlierText}>
              {loadEarlierBusy ? "Loading…" : "Load earlier messages"}
            </Text>
          </Pressable>
        )
      }
      renderItem={({ item: row }) => {
        if (row.kind === "pending") {
          return (
            <View style={styles.messageRowEnd}>
              <View style={[styles.userBubble, styles.pendingBubble]}>
                <Text style={styles.userText}>{row.message.text}</Text>
              </View>
            </View>
          );
        }
        if (row.kind === "queued") {
          return (
            <View style={styles.messageRowEnd}>
              <View style={[styles.userBubble, styles.pendingBubble]}>
                <Text style={styles.userText}>{row.row.entry.text}</Text>
                <View style={styles.queuedFooter}>
                  <Text style={styles.queuedState}>
                    {row.row.state === "sending"
                      ? "Sending…"
                      : row.row.state === "failed"
                        ? (row.row.entry.error ?? "Not sent")
                        : "Queued"}
                  </Text>
                  {row.row.state === "failed" ? (
                    <Pressable
                      onPress={() => onRetryQueued(row.row.entry.id)}
                      accessibilityRole="button"
                      style={styles.queuedButton}
                    >
                      <Text style={styles.queuedButtonText}>Retry</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => onCancelQueued(row.row.entry.id)}
                    accessibilityRole="button"
                    style={styles.queuedButton}
                  >
                    <Text style={styles.queuedButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
        }
        const item = row.item;
        if (item.kind === "divider") {
          return (
            <View style={styles.dividerRow}>
              <Text style={styles.dividerText}>{formatDayDivider(item.at, new Date())}</Text>
            </View>
          );
        }
        if (item.kind === "work") {
          return (
            <View style={styles.work}>
              {item.entries.map((entry) => (
                <View key={entry.id} style={styles.workRow}>
                  <View
                    style={[styles.workDot, entry.tone === "error" ? styles.workError : null]}
                  />
                  <Text style={styles.workText} numberOfLines={2}>
                    {entry.label}
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (item.kind === "plan") {
          return (
            <View style={styles.planCard}>
              <Text style={styles.planLabel}>Plan</Text>
              <MarkdownBody
                text={item.plan.planMarkdown}
                tone="assistant"
                onOpenFile={onOpenFile}
                onOpenLink={onOpenLink}
              />
            </View>
          );
        }
        if (item.kind === "notice" || item.kind === "system-turn") {
          return (
            <Text style={styles.notice} numberOfLines={3}>
              {item.message.text}
            </Text>
          );
        }
        if (item.kind === "group-system") {
          return (
            <Text style={styles.notice} numberOfLines={3}>
              {groupSystemLabel(item.event, item.message.text)}
            </Text>
          );
        }
        if (item.kind === "group-message") {
          const message = item.message;
          const text = ownerVisibleText(message.text);
          if (text.length === 0) return null;
          const sentAt = Number.isNaN(Date.parse(message.createdAt))
            ? null
            : new Date(message.createdAt);
          const speaker = groupSpeaker?.(item.speaker.botId) ?? null;
          return (
            <View style={styles.messageRowStart}>
              <SwipeMessageRow
                align="start"
                sentAt={sentAt}
                onReply={() =>
                  onReply(replyQuoteForMessage({ message, botName: item.speaker.name }))
                }
              >
                <Pressable
                  onLongPress={() =>
                    onMessageMenu({
                      messageId: String(message.id),
                      name: item.speaker.name,
                      text,
                      sentAt,
                    })
                  }
                  delayLongPress={350}
                  style={[
                    styles.assistantPress,
                    markdownNeedsWidth(text) ? styles.assistantWide : null,
                  ]}
                >
                  {item.showSpeaker ? (
                    <View style={styles.speakerRow}>
                      {speaker !== null ? (
                        <BotAvatar
                          shape={speaker.avatarShape}
                          color={speaker.avatarColor}
                          size={18}
                          label={speaker.name}
                        />
                      ) : null}
                      <Text style={styles.speakerName} numberOfLines={1}>
                        {item.speaker.name}
                      </Text>
                    </View>
                  ) : null}
                  <MarkdownBody
                    text={text}
                    tone="assistant"
                    onOpenFile={onOpenFile}
                    onOpenLink={onOpenLink}
                  />
                  {message.attachments?.map((attachment) =>
                    isImageAttachment(attachment) ? (
                      <AttachmentImage
                        key={attachment.id}
                        native={native}
                        chat={chat}
                        attachment={attachment}
                      />
                    ) : (
                      <View key={attachment.id} style={styles.attachment}>
                        <IconPaperclip size={14} color={tokens.textSecondary} strokeWidth={2} />
                        <Text style={styles.attachmentText} numberOfLines={1}>
                          {attachment.name}
                        </Text>
                      </View>
                    ),
                  )}
                </Pressable>
              </SwipeMessageRow>
            </View>
          );
        }
        if (item.kind !== "message") return null;
        const message = item.message;
        const text = ownerVisibleText(message.text);
        const role = message.role;
        const sentAt = Number.isNaN(Date.parse(message.createdAt))
          ? null
          : new Date(message.createdAt);
        const quote = readPersonalReplyQuote(message.context);
        if (role === "user") {
          return (
            <View style={styles.messageRowEnd}>
              <SwipeMessageRow
                align="end"
                sentAt={sentAt}
                onReply={() => onReply(replyQuoteForMessage({ message, botName: currentUserId }))}
              >
                <View style={styles.userColumn}>
                  <UserBubble
                    native={native}
                    chat={chat}
                    text={text}
                    quote={quote}
                    attachments={message.attachments}
                    onLongPress={() =>
                      onMessageMenu({
                        messageId: String(message.id),
                        name: "You",
                        text,
                        sentAt,
                      })
                    }
                  />
                  {latestMessageStatus?.messageId === String(message.id) ? (
                    <Text style={styles.readStatus}>
                      {latestMessageStatus.status === "read"
                        ? "Read"
                        : latestMessageStatus.status === "queued"
                          ? "Queued"
                          : "Steering"}
                    </Text>
                  ) : null}
                </View>
              </SwipeMessageRow>
            </View>
          );
        }
        if (text.length === 0) return null;
        return (
          <View style={styles.messageRowStart}>
            <SwipeMessageRow
              align="start"
              sentAt={sentAt}
              onReply={() => onReply(replyQuoteForMessage({ message, botName }))}
            >
              <Pressable
                onLongPress={() =>
                  onMessageMenu({ messageId: String(message.id), name: botName, text, sentAt })
                }
                delayLongPress={350}
                style={[
                  styles.assistantPress,
                  markdownNeedsWidth(text) ? styles.assistantWide : null,
                ]}
              >
                <MarkdownBody
                  text={text}
                  tone="assistant"
                  onOpenFile={onOpenFile}
                  onOpenLink={onOpenLink}
                />
                {message.attachments?.map((attachment) =>
                  isImageAttachment(attachment) ? (
                    <AttachmentImage
                      key={attachment.id}
                      native={native}
                      chat={chat}
                      attachment={attachment}
                    />
                  ) : (
                    <View key={attachment.id} style={styles.attachment}>
                      <IconPaperclip size={14} color={tokens.textSecondary} strokeWidth={2} />
                      <Text style={styles.attachmentText} numberOfLines={1}>
                        {attachment.name}
                      </Text>
                    </View>
                  ),
                )}
                {contextTurns.has(String(message.id)) ? (
                  <Text style={styles.contextUsed}>{"Context used ⌄"}</Text>
                ) : null}
              </Pressable>
            </SwipeMessageRow>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 10 },
  messageRowEnd: { width: "100%", alignItems: "flex-end" },
  messageRowStart: { width: "100%", alignItems: "flex-start" },
  alignEnd: { alignItems: "flex-end" },
  alignStart: { alignItems: "flex-start" },
  swipeRow: { width: "100%" },
  swipeContent: { width: "100%" },
  swipeTime: { position: "absolute", top: "35%", zIndex: 1 },
  swipeTimeStart: { left: 4 },
  swipeTimeEnd: { right: 4 },
  userColumn: { alignSelf: "flex-end", alignItems: "flex-end", gap: 4, maxWidth: "78%" },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "100%",
    borderRadius: 20,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  pendingBubble: { opacity: 0.82 },
  userText: { color: tokens.text, fontSize: 15, lineHeight: 21 },
  assistantPress: { alignSelf: "flex-start", maxWidth: "90%", gap: 6 },
  speakerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  speakerName: {
    color: tokens.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    flexShrink: 1,
  },
  assistantWide: { width: "90%" },
  assistantText: { color: tokens.text, fontSize: 15, lineHeight: 22 },
  markdown: { gap: 6, maxWidth: "100%" },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  link: {
    color: tokens.primary,
    textDecorationLine: "underline",
    fontSize: 15,
  },
  inlineCode: {
    fontFamily: "monospace",
    backgroundColor: tokens.fillMuted,
    color: tokens.text,
    fontSize: 14,
  },
  fileChip: {
    color: tokens.text,
    textDecorationLine: "underline",
    backgroundColor: tokens.fillMuted,
    fontSize: 14,
  },
  fileList: { gap: 6, alignItems: "flex-start" },
  fileChipButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    maxWidth: "100%",
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  fileChipPressed: { opacity: 0.7 },
  fileChipName: { color: tokens.text, fontSize: 14, lineHeight: 19, flexShrink: 1 },
  heading: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  codeBlock: {
    backgroundColor: tokens.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 10,
  },
  codeText: { color: tokens.text, fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  listRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  marker: { minWidth: 12, fontSize: 14, lineHeight: 21, color: tokens.textSecondary },
  flex: { flex: 1 },
  quote: { borderLeftWidth: 2, borderLeftColor: tokens.borderStrong, paddingLeft: 8 },
  quoteText: { color: tokens.textSecondary },
  dividerRow: { alignItems: "center", paddingVertical: 8 },
  dividerText: { color: tokens.textTertiary, fontSize: 12, lineHeight: 16 },
  notice: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 8,
  },
  work: { gap: 4, paddingLeft: 2 },
  workRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  workDot: { width: 5, height: 5, borderRadius: 999, backgroundColor: tokens.borderStrong },
  workError: { backgroundColor: tokens.danger },
  workText: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18, flex: 1 },
  planCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: 12,
    gap: 6,
  },
  planLabel: {
    color: tokens.textTertiary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  quoteChip: {
    borderLeftWidth: 2,
    borderLeftColor: tokens.borderStrong,
    paddingLeft: 8,
    marginBottom: 6,
    gap: 1,
  },
  quoteName: { color: tokens.text, fontSize: 12, fontWeight: "600" },
  quoteExcerpt: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  readStatus: { color: tokens.textTertiary, fontSize: 11, lineHeight: 15 },
  contextUsed: { color: tokens.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },
  sentAt: { color: tokens.textTertiary, fontSize: 12 },
  sentAtEnd: { textAlign: "right" },
  attachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 9,
    paddingVertical: 6,
    maxWidth: "90%",
  },
  attachmentText: { color: tokens.text, fontSize: 13, flexShrink: 1 },
  queuedFooter: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    maxWidth: "100%",
    marginTop: 6,
  },
  queuedState: { color: tokens.textSecondary, fontSize: 12, flexShrink: 1 },
  queuedButton: { minHeight: 32, justifyContent: "center", flexShrink: 0 },
  queuedButtonText: { color: tokens.text, fontSize: 12, fontWeight: "600" },
  loadEarlier: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  loadEarlierText: { color: tokens.textSecondary, fontSize: 13 },
});
