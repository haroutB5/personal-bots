import type { AssetResource, ProjectReadFileResult } from "@t3tools/contracts";
import { ProjectReadFileError } from "@t3tools/contracts";
import {
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import {
  filePreviewErrorText,
  filePreviewRoute,
  filePreviewState,
  fileTextRead,
  type FilePreviewSource,
  type FileReadOutcome,
} from "./filePreviewModel";
import { SheetShell } from "./SheetShell";

const TEXT_READ_TIMEOUT_MS = 15_000;

const isProjectReadFileError = Schema.is(ProjectReadFileError);

const EMPTY_FILE_READ_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("native-file-read:empty"));

/**
 * The chat's file sheet. Text reads through the project file RPC, the same read
 * the web Files tab uses. Images keep the asset URL, which the server only
 * issues for previewable types. A personal chat resolves both under the
 * Personal project's folder and a project chat under its worktree.
 */
export function FilePreviewSheet({
  native,
  chat,
  visible,
  cwd,
  path,
  onClose,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly visible: boolean;
  readonly cwd: string | null;
  readonly path: string | null;
  readonly onClose: () => void;
}) {
  const route = path === null ? "unsupported" : filePreviewRoute(path);
  const resource = useMemo<AssetResource | null>(
    () =>
      visible && path !== null && cwd !== null && route === "image"
        ? {
            _tag: "draft-workspace-file",
            cwd,
            path,
          }
        : null,
    [cwd, path, route, visible],
  );
  const urlAtom = useMemo(
    () =>
      resource === null
        ? EMPTY_ASSET_URL_ATOM
        : chat.assets.createUrl({
            environmentId: native.environmentId,
            input: { resource },
          }),
    [chat.assets, native.environmentId, resource],
  );
  const asset = assetUrlStateFromResult(useAtomValue(urlAtom), native.httpBaseUrl);
  const refreshAsset = useAtomRefresh(urlAtom);

  const readAtom = useMemo(
    () =>
      visible && path !== null && cwd !== null && route === "text"
        ? chat.projects.readFile({
            environmentId: native.environmentId,
            input: { cwd, relativePath: path, allowMissing: true },
          })
        : EMPTY_FILE_READ_ATOM,
    [chat.projects, cwd, native.environmentId, path, route, visible],
  );
  const readResult = useAtomValue(readAtom);
  const refreshRead = useAtomRefresh(readAtom);
  const outcome: FileReadOutcome = useMemo(() => {
    if (route !== "text") return { _tag: "Pending" };
    if (AsyncResult.isSuccess(readResult)) return { _tag: "Loaded", result: readResult.value };
    if (AsyncResult.isFailure(readResult)) {
      const cause = Cause.squash(readResult.cause);
      return {
        _tag: "Failed",
        failure: isProjectReadFileError(cause) ? (cause.failure ?? null) : null,
      };
    }
    return { _tag: "Pending" };
  }, [readResult, route]);

  const [attempt, setAttempt] = useState(0);
  const readKey = `${attempt}:${cwd ?? ""}:${path ?? ""}`;
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);

  // A read that has not settled in 15 s stops waiting. Retry starts a fresh key.
  const settled = outcome._tag !== "Pending";
  useEffect(() => {
    if (!visible || route !== "text" || settled) return;
    const timeout = setTimeout(() => setTimedOutKey(readKey), TEXT_READ_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [readKey, route, settled, visible]);

  const read = timedOutKey === readKey ? ({ _tag: "TimedOut" } as const) : fileTextRead(outcome);

  // A missing file is remembered by the query. Retry asks both sources again, so
  // a file created after the first look opens here.
  const retry = () => {
    refreshAsset();
    refreshRead();
    setAttempt((value) => value + 1);
  };
  // Closing ends this look at the file, so a reopen gets its own 15 s.
  const close = () => {
    setTimedOutKey(null);
    onClose();
  };

  const name = path === null ? "" : (path.split(/[\\/]/).at(-1) ?? path);
  const source: FilePreviewSource =
    route === "text"
      ? { _tag: "Text", read }
      : route === "image"
        ? { _tag: "Image", asset }
        : { _tag: "Unsupported" };
  const preview = filePreviewState({ folder: cwd, path, source });

  const content = (() => {
    switch (preview._tag) {
      case "NoFolder":
        return (
          <Text style={styles.notice} accessibilityRole="alert">
            This chat has no folder to open files from.
          </Text>
        );
      case "Loading":
        return (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.textSecondary} />
          </View>
        );
      case "Text":
        return (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.code} selectable>
              {preview.text}
            </Text>
            {read._tag === "Loaded" && read.truncated ? (
              <Text style={styles.truncated}>Showing the first 1 MB of this file.</Text>
            ) : null}
          </ScrollView>
        );
      case "Image":
        return (
          <Image
            source={{ uri: preview.url }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={name}
          />
        );
      case "Unsupported":
        return (
          <Text style={styles.notice} accessibilityRole="alert">
            This file can&apos;t be shown on the phone.
          </Text>
        );
      case "Denied":
        return (
          <Text style={styles.notice} accessibilityRole="alert">
            This file holds credentials or machine state, so it is never shown.
          </Text>
        );
      case "Error":
        return (
          <View style={styles.center}>
            <Text style={styles.error} accessibilityRole="alert">
              {filePreviewErrorText(preview.reason)}
            </Text>
            <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        );
      default:
        return assertNever(preview);
    }
  })();

  return (
    <SheetShell visible={visible} title={name} onClose={close}>
      <View style={styles.body}>
        <Text style={styles.path} numberOfLines={2}>
          {path ?? ""}
        </Text>
        {content}
      </View>
    </SheetShell>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled file preview state: ${JSON.stringify(value)}`);
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 10, maxHeight: 620 },
  path: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  center: { paddingVertical: 32, alignItems: "center", gap: 12 },
  notice: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  error: { color: tokens.error, fontSize: 14, lineHeight: 20, textAlign: "center" },
  retry: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    justifyContent: "center",
  },
  retryText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  scroll: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  scrollContent: { padding: 12 },
  code: { color: tokens.text, fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  truncated: {
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: 10,
  },
  image: { width: "100%", height: 420, borderRadius: 12, backgroundColor: tokens.bg },
});
