import type { ChatAttachment, PersonalReplyQuote } from "@t3tools/contracts";
import { readPersonalReplyQuote } from "@t3tools/contracts";
import {
  formatDayDivider,
  type ConversationItem,
} from "@hbots/personal-client/conversation/conversationModel";
import { replyQuoteForMessage } from "@hbots/personal-client/feed/messageReply";
import { ownerVisibleText } from "@hbots/personal-client/feed/composerText";
import {
  choicesStates,
  mayHaveChoices,
  splitChoices,
  type ChoicesState,
} from "@hbots/personal-client/conversation/choices";
import { turnStartByAssistantItem } from "@hbots/personal-client/feed/contextUsed";
import { groupSystemLabel } from "@hbots/personal-client/conversation/groupModel";
import type { LatestMessageReadStatus } from "@hbots/personal-client/feed/messageReadStatus";
import type { PendingOutgoingMessage } from "@hbots/personal-client/feed/types";
import type { OutboxRow } from "@hbots/personal-client/composer/outbox";
import type { OrchestrationLatestTurn } from "@hbots/personal-client/bots/threadShell";
import type { OrchestrationThreadActivity } from "@hbots/personal-client/conversation/wireTypes";
import {
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileTypePdf,
  IconPhoto,
  IconPaperclip,
} from "@tabler/icons-react-native";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  createElement,
  useContext,
} from "react";
import {
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type { BotAvatarShape } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import type { CardContext } from "./cards/types";
import { isChatCard, renderChatCard } from "./cards/registry";
import type { ChatEnvironment } from "./chatEnvironment";
import {
  claimsReplySwipe,
  opensMessageMenu,
  scrollIndexForItem,
  TABLE_CELL_MIN_WIDTH,
  tableColumnWidths,
} from "./messageListModel";
import { MarkInteractiveTouchProvider, useMarkInteractiveTouch } from "./messageTouch";
import { AttachmentImage } from "./AttachmentImage";
import { ChoiceButtons } from "./ChoiceButtons";
import {

  /* eslint-disable react/refs -- the list owns imperative scroll and swipe handles */
  hasFileSpan,
  linkTarget,
  markdownBlocks,
  markdownNeedsWidth,
  type FileLink,
  type InlineSpan,
  type MarkdownBlock,
  type MarkdownTable,
} from "./markdown";

export interface MessageListHandle {
  readonly scrollToCard: (itemId: string) => void;
}

type Row =
  | { readonly kind: "item"; readonly key: string; readonly item: ConversationItem }
  | { readonly kind: "pending"; readonly key: string; readonly message: PendingOutgoingMessage }
  | { readonly kind: "queued"; readonly key: string; readonly row: OutboxRow };

type ImageAttachment = Extract<ChatAttachment, { readonly type: "image" }>;

/** An inverted list draws offset 0 at the visual bottom, where a card's Save row sits. */
const CARD_REVEAL_VIEW_POSITION = 0;

function isImageAttachment(attachment: ChatAttachment): attachment is ImageAttachment {
  return attachment.type === "image";
}

type OpenLink = ((href: string) => void) | undefined;

/** A link inside a paragraph; touching it owns the press instead of the menu. */
function LinkText({
  text,
  href,
  onOpenLink,
}: {
  readonly text: string;
  readonly href: string;
  readonly onOpenLink: OpenLink;
}) {
  const markInteractive = useMarkInteractiveTouch();
  return (
    <Text
      style={styles.link}
      accessibilityRole="link"
      onPressIn={markInteractive}
      onPress={() => onOpenLink?.(href)}
    >
      {text}
    </Text>
  );
}

/** One span drawn inside a paragraph. Bold and italic recurse into their children. */
function spanNode(span: InlineSpan, index: number, onOpenLink: OpenLink): React.ReactNode {
  const key = `${span.kind}:${index}`;
  if (span.kind === "bold" || span.kind === "italic") {
    return (
      <Text key={key} style={span.kind === "bold" ? styles.bold : styles.italic}>
        {span.spans === undefined ? span.text : spanNodes(span.spans, onOpenLink)}
      </Text>
    );
  }
  if (span.kind === "link") {
    const target = linkTarget(span.href);
    if (target.kind === "blocked") {
      return <Text key={key}>{span.text}</Text>;
    }
    if (target.kind === "file") {
      return (
        <Text key={key} style={styles.fileNameOnly}>
          {span.text}
        </Text>
      );
    }
    return <LinkText key={key} text={span.text} href={target.url} onOpenLink={onOpenLink} />;
  }
  if (span.kind === "code") {
    return (
      <Text key={key} style={styles.inlineCode}>
        {span.text}
      </Text>
    );
  }
  if (span.kind === "file") {
    return (
      <Text key={key} style={styles.fileNameOnly}>
        {span.name}
      </Text>
    );
  }
  return <Text key={key}>{span.text}</Text>;
}

function spanNodes(
  spans: ReadonlyArray<InlineSpan>,
  onOpenLink: OpenLink,
): ReadonlyArray<React.ReactNode> {
  return spans.map((span, index) => spanNode(span, index, onOpenLink));
}

function SpanText({
  spans,
  style,
  containerStyle,
  onOpenFile,
  onOpenLink,
}: {
  readonly spans: ReadonlyArray<InlineSpan>;
  readonly style?: object;
  readonly containerStyle?: object;
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
}) {
  if (hasFileSpan(spans)) {
    return (
      <SpanFlow
        spans={spans}
        style={style}
        containerStyle={containerStyle}
        onOpenFile={onOpenFile}
        onOpenLink={onOpenLink}
      />
    );
  }
  return <Text style={style}>{spanNodes(spans, onOpenLink)}</Text>;
}

type FlowWord = {
  readonly text: string;
  readonly format: "text" | "code" | "link";
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly href?: string;
};

type FlowEmphasis = { readonly bold?: boolean; readonly italic?: boolean };

type FlowPiece =
  | { readonly kind: "word"; readonly key: string; readonly word: FlowWord }
  | { readonly kind: "file"; readonly key: string; readonly file: FileLink }
  | { readonly kind: "break"; readonly key: string };

/** Only the set flags, so exact optional property types stay happy. */
function emphasisFields(style: FlowEmphasis): FlowEmphasis {
  return {
    ...(style.bold === true ? { bold: true } : {}),
    ...(style.italic === true ? { italic: true } : {}),
  };
}

function flowPieces(
  spans: ReadonlyArray<InlineSpan>,
  emphasis: FlowEmphasis = {},
  counter = { value: 0 },
): ReadonlyArray<FlowPiece> {
  const pieces: FlowPiece[] = [];
  const pushWords = (
    text: string,
    format: FlowWord["format"],
    style: FlowEmphasis,
    href?: string,
  ) => {
    const sources = text.split("\n");
    sources.forEach((source, lineIndex) => {
      if (lineIndex > 0) pieces.push({ kind: "break", key: `break:${counter.value++}` });
      for (const token of source.match(/\s+|\S+/gu) ?? []) {
        if (!/^\s+$/u.test(token)) {
          pieces.push({
            kind: "word",
            key: `word:${counter.value++}`,
            word: { text: token, format, ...emphasisFields(style), ...(href ? { href } : {}) },
          });
          continue;
        }
        const previous = pieces.at(-1);
        if (previous?.kind === "word") {
          pieces[pieces.length - 1] = {
            ...previous,
            word: { ...previous.word, text: previous.word.text + token },
          };
        } else if (previous !== undefined && previous.kind !== "break") {
          pieces.push({
            kind: "word",
            key: `word:${counter.value++}`,
            word: { text: token, format: "text", ...emphasisFields(style) },
          });
        }
      }
    });
  };
  for (const span of spans) {
    if (span.kind === "file") {
      pieces.push({ kind: "file", key: `file:${counter.value++}`, file: span });
      continue;
    }
    if (span.kind === "bold" || span.kind === "italic") {
      const inner: FlowEmphasis =
        span.kind === "bold" ? { ...emphasis, bold: true } : { ...emphasis, italic: true };
      if (span.spans === undefined) pushWords(span.text, "text", inner);
      else pieces.push(...flowPieces(span.spans, inner, counter));
      continue;
    }
    pushWords(span.text, span.kind, emphasis, span.kind === "link" ? span.href : undefined);
  }
  return pieces;
}

type FlowLine = { readonly key: string; readonly pieces: ReadonlyArray<FlowPiece> };

function flowLines(pieces: ReadonlyArray<FlowPiece>): ReadonlyArray<FlowLine> {
  const lines: FlowPiece[][] = [[]];
  for (const piece of pieces) {
    if (piece.kind === "break") lines.push([]);
    else lines[lines.length - 1]!.push(piece);
  }
  let pieceSerial = 0;
  return lines.map((line) => ({ key: `line:${pieceSerial++}`, pieces: line }));
}

function SpanFlow({
  spans,
  style,
  containerStyle,
  onOpenFile,
  onOpenLink,
}: {
  readonly spans: ReadonlyArray<InlineSpan>;
  readonly style?: object;
  readonly containerStyle?: object;
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
}) {
  const lines = useMemo(() => flowLines(flowPieces(spans)), [spans]);
  const markInteractive = useMarkInteractiveTouch();
  return (
    <View style={[styles.flow, containerStyle]}>
      {lines.map((line) => (
        <View key={line.key} style={styles.flowLine}>
          {line.pieces.length === 0 ? <Text style={style}>{"\u200b"}</Text> : null}
          {line.pieces.map((piece) => {
            if (piece.kind === "break") return null;
            if (piece.kind === "file") {
              return <FileChip key={piece.key} file={piece.file} onOpenFile={onOpenFile} />;
            }
            const word = piece.word;
            const href = word.href;
            const wordStyle = [
              style,
              word.bold === true ? styles.bold : null,
              word.italic === true ? styles.italic : null,
              word.format === "code"
                ? styles.inlineCode
                : word.format === "link"
                  ? styles.link
                  : null,
            ];
            return (
              <Text
                key={piece.key}
                style={wordStyle}
                accessibilityRole={word.format === "link" ? "link" : undefined}
                onPressIn={
                  word.format === "link" && href !== undefined ? markInteractive : undefined
                }
                onPress={
                  word.format === "link" && href !== undefined
                    ? () => onOpenLink?.(href)
                    : undefined
                }
              >
                {word.text}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
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
  const name = file.name || file.label;
  const markInteractive = useMarkInteractiveTouch();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${name}`}
      onPressIn={markInteractive}
      onPress={() => onOpenFile?.(file.path)}
      style={({ pressed }) => [styles.fileChipButton, pressed ? styles.fileChipPressed : null]}
    >
      {createElement(fileIcon(name), {
        size: 15,
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
  const blocks = useMemo(() => keyedList(markdownBlocks(text), blockKey), [text]);
  return (
    <View style={styles.markdown}>
      {blocks.map(({ key, item: block }) => (
        <Block
          key={key}
          block={block}
          onOpenFile={onOpenFile}
          onOpenLink={onOpenLink}
          tone={tone}
        />
      ))}
    </View>
  );
}

/** Stable render keys from item content, with a count for repeated items. */
function keyedList<T>(
  items: ReadonlyArray<T>,
  seed: (item: T) => string,
): ReadonlyArray<{ readonly key: string; readonly item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = seed(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: `${base}#${count}`, item };
  });
}

function blockKey(block: MarkdownBlock): string {
  if (block.kind === "table") {
    return `table:${block.table.header.map((cell) => cell.text).join("|")}`;
  }
  return `${block.kind}:${block.text}`;
}

function replyBody(
  text: string,
  streaming: boolean,
  itemId: string,
  states: ReadonlyMap<string, ChoicesState>,
  onChoose: ((text: string) => Promise<boolean>) | undefined,
): {
  readonly body: string;
  readonly options: ReadonlyArray<string> | null;
  readonly state: ChoicesState | null;
} {
  if (onChoose === undefined || !mayHaveChoices(text)) {
    return { body: text, options: null, state: null };
  }
  const split = splitChoices(text, streaming);
  const state = states.get(itemId) ?? null;
  const draw = split.options !== null && state !== null;
  const heldBack = split.options === null && split.body !== text;
  return {
    body: draw || heldBack ? split.body : text,
    options: draw ? split.options : null,
    state: draw ? state : null,
  };
}

interface HorizontalScrollTouch {
  readonly began: () => void;
  readonly ended: () => void;
}

/**
 * A horizontal scroller reports touches so the enclosing message row does not
 * take its drag for the reply swipe. The row's PanResponder only sees the
 * gesture, not where the touch started.
 */
const HorizontalScrollTouchContext = createContext<HorizontalScrollTouch | null>(null);

function TableGrid({
  table,
  onOpenFile,
  onOpenLink,
}: {
  readonly table: MarkdownTable;
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
}) {
  const widths = useMemo(() => tableColumnWidths(table), [table]);
  const rows = useMemo(
    () => keyedList([table.header, ...table.rows], (row) => row.map((cell) => cell.text).join("|")),
    [table],
  );
  const scrollTouch = useContext(HorizontalScrollTouchContext);
  return (
    <ScrollView horizontal style={styles.tableScroll} showsHorizontalScrollIndicator={false}>
      <View
        style={styles.table}
        onTouchStart={scrollTouch?.began}
        onTouchEnd={scrollTouch?.ended}
        onTouchCancel={scrollTouch?.ended}
      >
        {rows.map(({ key: rowKey, item: row }, rowIndex) => (
          <View
            key={rowKey}
            style={[styles.tableRow, rowIndex === 0 ? styles.tableHeaderRow : null]}
          >
            {keyedList(row, (cell) => cell.text).map(
              ({ key: cellKey, item: cell }, columnIndex) => (
                <View
                  key={cellKey}
                  style={[
                    styles.tableCell,
                    { width: widths[columnIndex] ?? TABLE_CELL_MIN_WIDTH },
                    columnIndex < row.length - 1 ? styles.tableCellDivider : null,
                    rowIndex < rows.length - 1 ? styles.tableRowDivider : null,
                  ]}
                >
                  <SpanText
                    spans={cell.spans}
                    style={[
                      styles.tableText,
                      rowIndex === 0 ? styles.tableHeaderText : null,
                      { textAlign: table.aligns[columnIndex] ?? "left" },
                    ]}
                    onOpenFile={onOpenFile}
                    onOpenLink={onOpenLink}
                  />
                </View>
              ),
            )}
          </View>
        ))}
      </View>
    </ScrollView>
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
  if ("files" in block && block.files !== undefined) {
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
            style={base}
            containerStyle={styles.flex}
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
            style={base}
            containerStyle={styles.flex}
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
    case "table":
      return <TableGrid table={block.table} onOpenFile={onOpenFile} onOpenLink={onOpenLink} />;
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

const LONG_PRESS_MS = 350;
const MESSAGE_ACCESSIBILITY_ACTIONS = [{ name: "longpress" }];

/**
 * A long-press target that never claims the touch responder, so a table's
 * horizontal scroller keeps its drag. A still finger on the body opens the
 * menu, unless the touch began on a link, file chip or choice button; the body
 * stays one accessible node with the menu as its long-press action.
 */
function LongPressSurface({
  onLongPress,
  style,
  children,
}: {
  readonly onLongPress: () => void;
  readonly style: StyleProp<ViewStyle>;
  readonly children: React.ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const latest = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const startedOnInteractive = useRef(false);
  const markInteractive = useCallback(() => {
    startedOnInteractive.current = true;
  }, []);
  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
    latest.current = null;
  }, []);
  const reset = useCallback(() => {
    cancel();
    startedOnInteractive.current = false;
  }, [cancel]);
  useEffect(() => reset, [reset]);
  return (
    <MarkInteractiveTouchProvider value={markInteractive}>
      <View
        style={style}
        accessible
        accessibilityActions={MESSAGE_ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "longpress") onLongPress();
        }}
        onTouchStart={(event) => {
          cancel();
          const { pageX, pageY } = event.nativeEvent;
          origin.current = { x: pageX, y: pageY };
          latest.current = { x: pageX, y: pageY };
          timer.current = setTimeout(() => {
            timer.current = null;
            const start = origin.current;
            const end = latest.current;
            origin.current = null;
            latest.current = null;
            const interactive = startedOnInteractive.current;
            startedOnInteractive.current = false;
            if (
              start !== null &&
              end !== null &&
              opensMessageMenu(interactive, end.x - start.x, end.y - start.y)
            ) {
              onLongPress();
            }
          }, LONG_PRESS_MS);
        }}
        onTouchMove={(event) => {
          const { pageX, pageY } = event.nativeEvent;
          latest.current = { x: pageX, y: pageY };
        }}
        onTouchEnd={reset}
        onTouchCancel={reset}
      >
        {children}
      </View>
    </MarkInteractiveTouchProvider>
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
  // eslint-disable-next-line react/refs -- the animated value is created once
  const translateX = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);
  const beganInScroller = useRef(false);
  const scrollTouch = useMemo<HorizontalScrollTouch>(
    () => ({
      began: () => {
        beganInScroller.current = true;
      },
      ended: () => {
        beganInScroller.current = false;
      },
    }),
    [beganInScroller],
  );
  const responder = useRef(
    // eslint-disable-next-line react/refs -- the responder is created once
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        claimsReplySwipe(gesture.dx, gesture.dy, beganInScroller.current),
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
  const panHandlers = responder.panHandlers;
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
        {...panHandlers}
      >
        <HorizontalScrollTouchContext.Provider value={scrollTouch}>
          {children}
        </HorizontalScrollTouchContext.Provider>
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
  cardContext,
  items,
  pending,
  queued,
  botName,
  currentUserId,
  activities: _activities,
  latestTurn: _latestTurn,
  busy,
  latestMessageStatus,
  onReply,
  onMessageMenu,
  onOpenFile,
  onOpenLink,
  onChoose,
  onCancelQueued,
  onRetryQueued,
  onLoadEarlier,
  loadEarlierBusy,
  groupSpeaker,
  listControl,
  keyboardInset = 0,
  onHeightChange,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly cardContext?: CardContext;
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
  /** Sends an option from a reply's choices block; absent where nothing can be sent. */
  readonly onChoose?: ((text: string) => Promise<boolean>) | undefined;
  readonly onCancelQueued: (id: string) => void;
  readonly onRetryQueued: (id: string) => void;
  readonly onLoadEarlier: (() => void) | null;
  readonly loadEarlierBusy: boolean;
  /** The body's keyboard padding, so the reveal runs after the list shrinks. */
  readonly keyboardInset?: number;
  /** Set by the chat screen so a card can bring itself above the keyboard. */
  readonly listControl?: { current: MessageListHandle | null };
  /** The measured list viewport, used to bound a focused card row. */
  readonly onHeightChange?: (height: number) => void;
  /** Group transcripts only: who a member message belongs to. */
  readonly groupSpeaker?: (botId: string) => {
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
  const choiceStates = useMemo(() => choicesStates(items, busy), [items, busy]);
  const lastReveal = useRef<string | null>(null);
  const scrollToCard = useCallback(
    (itemId: string) => {
      lastReveal.current = itemId;
      const index = scrollIndexForItem(rows, itemId);
      if (index === null) return;
      // Inverted: viewPosition 0 puts the card's bottom, where Save sits, at
      // the visible bottom. The card is bounded to the list while the keyboard
      // is open, so its whole body fits above the composer.
      listRef.current?.scrollToIndex({
        index,
        viewPosition: CARD_REVEAL_VIEW_POSITION,
        animated: true,
      });
    },
    [rows],
  );
  useEffect(() => {
    if (listControl === undefined) return;
    // eslint-disable-next-line react/immutability -- the parent's ref is this list's imperative handle
    listControl.current = { scrollToCard };
    return () => {
      if (listControl.current?.scrollToCard === scrollToCard) listControl.current = null;
    };
  }, [listControl, scrollToCard]);
  useEffect(() => {
    if (keyboardInset <= 0 || lastReveal.current === null) return;
    const frame = requestAnimationFrame(() => {
      if (lastReveal.current !== null) scrollToCard(lastReveal.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboardInset, scrollToCard]);

  return (
    <FlatList
      ref={listRef}
      data={rows.toReversed()}
      extraData={cardContext}
      inverted
      nestedScrollEnabled
      onLayout={(event) => onHeightChange?.(event.nativeEvent.layout.height)}
      style={styles.list}
      keyExtractor={(row) => row.key}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      initialNumToRender={24}
      maxToRenderPerBatch={16}
      windowSize={9}
      removeClippedSubviews
      onScrollToIndexFailed={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
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
              {/* eslint-disable-next-line react/purity -- the divider names the day in the device's zone */}
              <Text style={styles.dividerText}>{formatDayDivider(item.at, new Date())}</Text>
            </View>
          );
        }
        if (isChatCard(item)) {
          return cardContext === undefined ? null : renderChatCard(item, cardContext);
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
          const reply = replyBody(text, message.streaming, item.id, choiceStates, onChoose);
          const body = reply.body;
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
                  onReply(
                    replyQuoteForMessage({
                      message: { id: message.id, role: message.role, text: body },
                      botName: item.speaker.name,
                    }),
                  )
                }
              >
                <LongPressSurface
                  onLongPress={() =>
                    onMessageMenu({
                      messageId: String(message.id),
                      name: item.speaker.name,
                      text: body,
                      sentAt,
                    })
                  }
                  style={[
                    styles.assistantPress,
                    markdownNeedsWidth(body) || reply.options !== null
                      ? styles.assistantWide
                      : null,
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
                    text={body}
                    tone="assistant"
                    onOpenFile={onOpenFile}
                    onOpenLink={onOpenLink}
                  />
                  {reply.options !== null && reply.state !== null ? (
                    <ChoiceButtons
                      options={reply.options}
                      state={reply.state}
                      onChoose={onChoose}
                    />
                  ) : null}
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
                </LongPressSurface>
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
        const reply = replyBody(text, message.streaming, item.id, choiceStates, onChoose);
        const body = reply.body;
        return (
          <View style={styles.messageRowStart}>
            <SwipeMessageRow
              align="start"
              sentAt={sentAt}
              onReply={() =>
                onReply(
                  replyQuoteForMessage({
                    message: { id: message.id, role: message.role, text: body },
                    botName,
                  }),
                )
              }
            >
              <LongPressSurface
                onLongPress={() =>
                  onMessageMenu({
                    messageId: String(message.id),
                    name: botName,
                    text: body,
                    sentAt,
                  })
                }
                style={[
                  styles.assistantPress,
                  markdownNeedsWidth(body) || reply.options !== null ? styles.assistantWide : null,
                ]}
              >
                <MarkdownBody
                  text={body}
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
                {reply.options !== null && reply.state !== null ? (
                  <ChoiceButtons options={reply.options} state={reply.state} onChoose={onChoose} />
                ) : null}
                {contextTurns.has(String(message.id)) ? (
                  <Text style={styles.contextUsed}>{"Context used ⌄"}</Text>
                ) : null}
              </LongPressSurface>
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
  fileNameOnly: { color: tokens.text, fontSize: 14 },
  flow: { maxWidth: "100%" },
  flowLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", minHeight: 22 },
  fileList: { gap: 6, alignItems: "flex-start" },
  fileChipButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginVertical: 1,
  },
  fileChipPressed: { opacity: 0.7 },
  fileChipName: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
  },
  heading: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  codeBlock: {
    backgroundColor: tokens.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 10,
  },
  codeText: { color: tokens.text, fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  tableScroll: { maxWidth: "100%", flexGrow: 0 },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 10,
    overflow: "hidden",
  },
  tableRow: { flexDirection: "row" },
  tableHeaderRow: { backgroundColor: tokens.surface },
  tableCell: { paddingHorizontal: 10, paddingVertical: 7, justifyContent: "center" },
  tableCellDivider: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: tokens.border,
  },
  tableRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  tableText: { color: tokens.text, fontSize: 13, lineHeight: 18 },
  tableHeaderText: { color: tokens.sectionLabel, fontWeight: "700" },
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
