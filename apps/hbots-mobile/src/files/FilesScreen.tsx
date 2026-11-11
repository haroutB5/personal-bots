import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import {
  bulkDeleteConfirmLabel,
  bulkDeleteFilesConfirmMessage,
  bulkResultNotice,
  DELETE_VERB,
  FILE_NOUN,
  selectedCountLabel,
  toggleAllSelection,
  toggleSelection,
  visibleSelection,
} from "@hbots/personal-client/lists/bulkSelection";
import {
  filePreviewKind,
  formatFileSize,
  groupFilesByBot,
} from "@hbots/personal-client/files/filesModel";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { PERSONAL_FILES_BATCH_MAX, type PersonalFile } from "@t3tools/contracts";
import {
  IconDots,
  IconDownload,
  IconExternalLink,
  IconFile,
  IconFileText,
  IconPhoto,
  IconSearch,
} from "@tabler/icons-react-native";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { confirmDestructive } from "../components/confirmDestructive";
import { SwipeToDeleteRow } from "../components/SwipeToDeleteRow";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecureScreen } from "../platform/secureScreen";
import { PersonalFilePreviewSheet } from "../sheets/PersonalFilePreviewSheet";
import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import { chosenFiles, filesScreenState, shownFileIds } from "../files/filesScreenModel";

const KIND_ICONS = {
  image: IconPhoto,
  pdf: IconFileText,
  markdown: IconFileText,
  text: IconFileText,
  download: IconFile,
} as const;

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function FileRowBody({
  file,
  now,
  trailing,
}: {
  readonly file: PersonalFile;
  readonly now: number;
  readonly trailing: boolean;
}) {
  const kind = filePreviewKind(file);
  const Icon = KIND_ICONS[kind];
  const TrailingIcon =
    kind === "download" ? IconDownload : kind === "pdf" ? IconExternalLink : null;
  const createdMs = DateTime.toEpochMillis(file.createdAt);
  return (
    <>
      <View style={styles.fileIcon}>
        <Icon size={20} color={tokens.textSecondary} strokeWidth={1.75} />
      </View>
      <View style={styles.fileText}>
        <Text style={styles.fileName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {file.name}
        </Text>
        <Text style={styles.fileMeta} maxFontSizeMultiplier={1.6}>
          {formatFileSize(file.sizeBytes)} · {formatRelativeTime(createdMs, now)}
        </Text>
      </View>
      {TrailingIcon !== null && trailing ? (
        <TrailingIcon size={18} color={tokens.textSecondary} strokeWidth={1.75} />
      ) : null}
    </>
  );
}

function Check({ checked }: { readonly checked: boolean }) {
  return (
    <View style={[styles.check, checked ? styles.checkOn : null]}>
      {checked ? <View style={styles.checkDot} /> : null}
    </View>
  );
}

export function FilesScreen({ native }: { readonly native: NativePersonal }) {
  useSecureScreen(true);
  const environmentId = native.environmentId;
  const filesList = native.bots.usePersonalFiles(environmentId);
  const botsList = native.bots.usePersonalBotsList(environmentId);
  const deleteFile = native.client.useAtomCommand(native.bots.personalFileDelete, {
    reportFailure: false,
  });
  const deleteMany = native.client.useAtomCommand(native.bots.personalFilesDeleteMany, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState<PersonalFile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const now = useMinuteNow();

  const files = filesList.data?.files ?? [];
  const bots = botsList.data?.bots;
  const groups = useMemo(
    () => groupFilesByBot({ files, bots: bots ?? [], query }),
    [bots, files, query],
  );
  const state = filesScreenState({
    filesLoaded: filesList.data !== null,
    botsLoaded: botsList.data !== null,
    error: filesList.error ?? botsList.error,
    fileCount: files.length,
  });
  const selecting = selection !== null;
  const shownIds = useMemo(() => shownFileIds(groups), [groups]);
  const chosen = selection === null ? [] : visibleSelection(selection, shownIds);
  const chosenCount = chosenFiles(selection, groups).length;
  const everySelected =
    selection !== null && shownIds.length > 0 && shownIds.every((id) => selection.has(id));

  const enterSelect = useCallback((first: string | null) => {
    setNotice(null);
    setDeleteError(null);
    setSelection(new Set(first === null ? [] : [first]));
  }, []);
  const exitSelect = useCallback(() => setSelection(null), []);
  const toggle = useCallback((fileId: string) => {
    setSelection((current) => (current === null ? current : toggleSelection(current, fileId)));
  }, []);

  const resolve = (relativeUrl: string | null): string | null =>
    relativeUrl === null ? null : resolveAssetUrl(native.httpBaseUrl, relativeUrl);

  const removeFile = async (file: PersonalFile) => {
    const confirmed = await confirmDestructive(
      `Delete ${file.name} permanently?\nThe file will disappear from your chats and can't be undone.`,
      "Delete file",
    );
    if (!confirmed) return;
    const outcome = await deleteFile({ environmentId, input: { fileId: file.fileId } });
    if (outcome._tag !== "Success") {
      setDeleteError("Couldn't delete this file. Try again.");
      return;
    }
    setDeleteError(null);
    setPreviewing((current) => (current?.fileId === file.fileId ? null : current));
  };

  const openFile = (file: PersonalFile) => {
    const kind = filePreviewKind(file);
    if (kind === "download") {
      const url = resolve(file.url);
      if (url !== null) void Linking.openURL(url);
      return;
    }
    if (kind === "pdf") {
      const url = resolve(file.previewUrl ?? file.url);
      if (url !== null) void Linking.openURL(url);
      return;
    }
    setPreviewing(file);
  };

  const runBulkDelete = async () => {
    if (chosen.length === 0 || bulkBusy) return;
    const confirmed = await confirmDestructive(
      bulkDeleteFilesConfirmMessage(chosen.length),
      bulkDeleteConfirmLabel(chosen.length, FILE_NOUN),
    );
    if (!confirmed) return;
    setBulkBusy(true);
    const done: Array<string> = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (let start = 0; start < chosen.length; start += PERSONAL_FILES_BATCH_MAX) {
      const chunk = chosen.slice(start, start + PERSONAL_FILES_BATCH_MAX);
      const outcome = await deleteMany({ environmentId, input: { fileIds: chunk } });
      if (outcome._tag === "Success") {
        done.push(...outcome.value.done);
        failed.push(
          ...outcome.value.failed.map((entry) => ({
            id: entry.fileId,
            message: entry.message,
          })),
        );
      } else {
        failed.push(
          ...chunk.map((id) => ({ id, message: "Couldn't reach your laptop. Try again." })),
        );
      }
    }
    const summary = bulkResultNotice(
      DELETE_VERB,
      FILE_NOUN,
      done.length,
      failed.map((entry) => entry.message),
    );
    setBulkBusy(false);
    setNotice(summary);
    const gone = new Set(done);
    setPreviewing((current) => (current !== null && gone.has(current.fileId) ? null : current));
    setSelection(failed.length === 0 ? null : new Set(failed.map((entry) => entry.id)));
  };

  const previewUrl = previewing === null ? null : resolve(previewing.url);

  return (
    <View style={styles.screen}>
      {selecting ? (
        <View style={styles.header}>
          <Pressable onPress={exitSelect} accessibilityRole="button" style={styles.headerButton}>
            <Text style={styles.headerButtonLabel} maxFontSizeMultiplier={1.3}>
              Cancel
            </Text>
          </Pressable>
          <Text style={styles.selectCount} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {selectedCountLabel(chosenCount, FILE_NOUN)}
          </Text>
          <Pressable
            onPress={() =>
              setSelection((current) =>
                current === null ? current : toggleAllSelection(current, shownIds),
              )
            }
            disabled={shownIds.length === 0}
            accessibilityRole="button"
            style={styles.headerButton}
          >
            <Text style={styles.headerButtonLabel} maxFontSizeMultiplier={1.3}>
              {everySelected ? "Deselect all" : "Select all"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            Files
          </Text>
          {state.kind === "ready" ? (
            <Pressable
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="File list options"
              style={styles.iconButton}
            >
              <IconDots size={24} color={tokens.text} strokeWidth={1.75} />
            </Pressable>
          ) : null}
        </View>
      )}

      {deleteError !== null ? (
        <Text style={styles.errorBanner} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
          {deleteError}
        </Text>
      ) : null}
      {notice !== null ? (
        <Text
          style={[styles.notice, notice.failed ? styles.noticeFailed : null]}
          accessibilityRole="alert"
          maxFontSizeMultiplier={1.6}
        >
          {notice.text}
        </Text>
      ) : null}

      {state.kind === "error" ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateText} maxFontSizeMultiplier={1.6}>
            Couldn't load your files. {state.message}
          </Text>
          <Pressable
            onPress={() => {
              filesList.refresh();
              botsList.refresh();
            }}
            accessibilityRole="button"
            style={styles.retry}
          >
            <Text style={styles.retryLabel} maxFontSizeMultiplier={1.6}>
              Try again
            </Text>
          </Pressable>
        </View>
      ) : state.kind === "loading" ? (
        <View style={styles.stateBlock}>
          <ActivityIndicator color={tokens.textSecondary} />
          <Text style={styles.stateText} maxFontSizeMultiplier={1.6}>
            Loading files…
          </Text>
        </View>
      ) : state.kind === "empty" ? (
        <View style={styles.emptyBlock}>
          <View style={styles.emptyIcon}>
            <IconFile size={24} color={tokens.textSecondary} strokeWidth={1.75} />
          </View>
          <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.3}>
            No files yet
          </Text>
          <Text style={styles.emptyText} maxFontSizeMultiplier={1.6}>
            Files you attach in bot chats show up here, grouped by bot.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.searchBox}>
            <IconSearch size={18} color={tokens.textSecondary} strokeWidth={1.75} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search files"
              placeholderTextColor={tokens.textSecondary}
              accessibilityLabel="Search files"
              style={styles.searchInput}
              autoCorrect={false}
            />
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
            {groups.length === 0 ? (
              <Text style={styles.stateText} maxFontSizeMultiplier={1.6}>
                No files match "{query.trim()}".
              </Text>
            ) : (
              groups.map(({ bot, files: botFiles }) => {
                const groupIds = botFiles.map((file) => file.fileId);
                const groupSelected =
                  selection !== null && groupIds.every((id) => selection.has(id));
                return (
                  <View key={bot.botId} style={styles.group}>
                    <View style={styles.groupHeader}>
                      <BotAvatar
                        shape={bot.avatarShape}
                        color={bot.avatarColor}
                        size={20}
                        label={bot.name}
                      />
                      <Text style={styles.groupName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
                        {bot.name}
                      </Text>
                      <Text style={styles.groupCount} maxFontSizeMultiplier={1.3}>
                        {botFiles.length === 1 ? "1 file" : `${botFiles.length} files`}
                      </Text>
                      {selecting ? (
                        <Pressable
                          onPress={() =>
                            setSelection((current) =>
                              current === null ? current : toggleAllSelection(current, groupIds),
                            )
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`${groupSelected ? "Deselect" : "Select"} all ${bot.name} files`}
                          style={styles.groupSelect}
                        >
                          <Text style={styles.groupSelectLabel} maxFontSizeMultiplier={1.3}>
                            {groupSelected ? "Deselect all" : "Select all"}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {botFiles.map((file) => {
                      const row = selecting ? (
                        <Pressable
                          onPress={() => toggle(file.fileId)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: selection.has(file.fileId) }}
                          accessibilityLabel={file.name}
                          style={styles.row}
                        >
                          <Check checked={selection.has(file.fileId)} />
                          <FileRowBody file={file} now={now} trailing={false} />
                        </Pressable>
                      ) : (
                        <Pressable
                          onPress={() => openFile(file)}
                          onLongPress={() => enterSelect(file.fileId)}
                          delayLongPress={350}
                          accessibilityRole="button"
                          accessibilityLabel={`${file.name}, ${formatFileSize(file.sizeBytes)}`}
                          android_ripple={{ color: "rgba(255,255,255,0.08)" }}
                          style={styles.row}
                        >
                          <FileRowBody file={file} now={now} trailing={true} />
                        </Pressable>
                      );
                      return selecting ? (
                        <View key={file.fileId}>{row}</View>
                      ) : (
                        <SwipeToDeleteRow
                          key={file.fileId}
                          label={`Delete ${file.name}`}
                          onDelete={() => void removeFile(file)}
                        >
                          {row}
                        </SwipeToDeleteRow>
                      );
                    })}
                  </View>
                );
              })
            )}
          </ScrollView>
        </>
      )}

      {selecting ? (
        <View style={styles.actions}>
          <View style={styles.actionsSpacer} />
          <Pressable
            onPress={() => void runBulkDelete()}
            disabled={chosen.length === 0 || bulkBusy}
            accessibilityRole="button"
            accessibilityLabel={bulkDeleteConfirmLabel(chosen.length, FILE_NOUN)}
            style={[
              styles.deleteButton,
              chosen.length === 0 || bulkBusy ? styles.deleteButtonDisabled : null,
            ]}
          >
            <Text style={styles.deleteButtonLabel} maxFontSizeMultiplier={1.6}>
              {bulkBusy ? "Deleting…" : "Delete"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <PersonalFilePreviewSheet
        file={previewing}
        url={previewUrl}
        onClose={() => setPreviewing(null)}
        onDelete={() => (previewing === null ? Promise.resolve() : removeFile(previewing))}
      />

      <SheetShell visible={menuOpen} title="File list options" onClose={() => setMenuOpen(false)}>
        <SheetAction
          label="Select files"
          onPress={() => {
            setMenuOpen(false);
            enterSelect(null);
          }}
        />
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
  },
  title: { color: tokens.text, fontSize: 28, fontWeight: "700" },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButton: { minHeight: 44, justifyContent: "center" },
  headerButtonLabel: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  selectCount: { color: tokens.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  errorBanner: {
    color: tokens.error,
    fontSize: 14,
    backgroundColor: tokens.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    borderRadius: 12,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  notice: { color: tokens.textSecondary, fontSize: 13, paddingHorizontal: 16, paddingTop: 8 },
  noticeFailed: { color: tokens.error },
  stateBlock: { alignItems: "center", padding: 24, gap: 12 },
  stateText: {
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  retry: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 16,
  },
  retryLabel: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  emptyBlock: { alignItems: "center", paddingTop: 64, paddingHorizontal: 24, gap: 12 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { color: tokens.text, fontSize: 18, fontWeight: "600" },
  emptyText: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21, textAlign: "center" },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    height: 44,
    borderRadius: 22,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, color: tokens.text, fontSize: 16, paddingVertical: 0 },
  scroll: { flex: 1, marginTop: 4 },
  scrollBody: { paddingBottom: 24 },
  group: { marginTop: 12 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  groupName: { color: tokens.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  groupCount: { color: tokens.textTertiary, fontSize: 13, marginLeft: "auto" },
  groupSelect: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  groupSelectLabel: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  row: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  fileText: { flex: 1, minWidth: 0, gap: 2 },
  fileName: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  fileMeta: { color: tokens.textTertiary, fontSize: 13 },
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
  checkDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.primaryText },
  actions: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  actionsSpacer: { flex: 1 },
  deleteButton: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    paddingHorizontal: 20,
  },
  deleteButtonDisabled: { opacity: 0.4 },
  deleteButtonLabel: { color: tokens.error, fontSize: 15, fontWeight: "600" },
});
