import {
  filePreviewKind,
  formatFileSize,
  TEXT_PREVIEW_MAX_BYTES,
} from "@hbots/personal-client/files/filesModel";
import type { PersonalFile } from "@t3tools/contracts";
import { IconDownload, IconExternalLink, IconTrash } from "@tabler/icons-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { SheetShell } from "./SheetShell";
import { tokens } from "../shell/tokens";

type TextState =
  | { readonly url: string; readonly status: "ready"; readonly text: string }
  | { readonly url: string; readonly status: "error" };

function useFileText(url: string | null): "loading" | "error" | { readonly text: string } {
  const [state, setState] = useState<TextState | null>(null);
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) =>
        setState({ url, status: "ready", text: text.slice(0, TEXT_PREVIEW_MAX_BYTES) }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setState({ url, status: "error" });
      });
    return () => controller.abort();
  }, [url]);
  if (url === null || state === null || state.url !== url) return "loading";
  return state.status === "ready" ? { text: state.text } : "error";
}

function PreviewMessage({ children }: { readonly children: string }) {
  return (
    <Text style={styles.message} maxFontSizeMultiplier={1.6}>
      {children}
    </Text>
  );
}

function TextBody({ url, markdown }: { readonly url: string; readonly markdown: boolean }) {
  const body = useFileText(url);
  if (body === "loading") {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={tokens.textSecondary} />
      </View>
    );
  }
  if (body === "error") {
    return <PreviewMessage>Couldn't load this file. Download it instead.</PreviewMessage>;
  }
  return (
    <ScrollView style={styles.textScroll} contentContainerStyle={styles.textBody}>
      <Text
        style={[styles.text, markdown ? styles.markdownText : null]}
        selectable
        maxFontSizeMultiplier={1.6}
      >
        {body.text}
      </Text>
    </ScrollView>
  );
}

function ImageBody({ url, name }: { readonly url: string; readonly name: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return <PreviewMessage>Couldn't load this image.</PreviewMessage>;
  return (
    <View style={styles.imageBox}>
      <Image
        source={{ uri: url }}
        accessibilityLabel={name}
        resizeMode="contain"
        style={styles.image}
        onError={() => setFailedUrl(url)}
      />
    </View>
  );
}

/**
 * Bottom sheet for Files-tab previews. Images show inline, text and markdown as
 * source, PDFs open in the browser's own viewer. Download and Delete are the
 * sheet's two actions.
 */
export function PersonalFilePreviewSheet({
  file,
  url,
  onClose,
  onDelete,
}: {
  readonly file: PersonalFile | null;
  /** Resolved signed URL for the file; null while the connection is not ready. */
  readonly url: string | null;
  readonly onClose: () => void;
  readonly onDelete: () => Promise<void>;
}) {
  const kind = file === null ? null : filePreviewKind(file);
  const [deleting, setDeleting] = useState(false);
  const deleteFile = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };
  return (
    <SheetShell visible={file !== null} title={file?.name ?? "Preview"} onClose={onClose}>
      {file !== null ? (
        <View style={styles.sheet}>
          <Text style={styles.size} maxFontSizeMultiplier={1.3}>
            {formatFileSize(file.sizeBytes)}
          </Text>
          <View style={styles.preview}>
            {url === null ? (
              <PreviewMessage>Reconnecting to your computer…</PreviewMessage>
            ) : kind === "image" ? (
              <ImageBody url={url} name={file.name} />
            ) : kind === "markdown" || kind === "text" ? (
              <TextBody url={url} markdown={kind === "markdown"} />
            ) : null}
          </View>
          <View style={styles.actions}>
            {url === null ? (
              <View style={[styles.action, styles.actionPrimary, styles.actionDisabled]}>
                <IconDownload size={18} color={tokens.primaryText} strokeWidth={1.75} />
                <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>Download</Text>
              </View>
            ) : (
              <Pressable
                onPress={() => void Linking.openURL(url)}
                accessibilityRole="button"
                accessibilityLabel={`Download ${file.name}`}
                style={[styles.action, styles.actionPrimary]}
              >
                <IconDownload size={18} color={tokens.primaryText} strokeWidth={1.75} />
                <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>Download</Text>
              </Pressable>
            )}
            {kind === "image" && url !== null ? (
              <Pressable
                onPress={() => void Linking.openURL(url)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${file.name} in a new tab`}
                style={styles.iconAction}
              >
                <IconExternalLink size={20} color={tokens.text} strokeWidth={1.75} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => void deleteFile()}
              disabled={deleting}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${file.name}`}
              style={[styles.action, styles.actionDanger, deleting ? styles.actionDisabled : null]}
            >
              <IconTrash size={18} color={tokens.error} strokeWidth={1.75} />
              <Text style={[styles.actionLabel, styles.actionLabelDanger]}>
                {deleting ? "Deleting…" : "Delete"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: 8 },
  size: { color: tokens.textTertiary, fontSize: 13, marginTop: -8 },
  preview: { minHeight: 80 },
  message: {
    color: tokens.textSecondary,
    fontSize: 15,
    textAlign: "center",
    paddingVertical: 32,
  },
  loading: { paddingVertical: 32, alignItems: "center" },
  textScroll: { maxHeight: 420 },
  textBody: { paddingVertical: 8 },
  text: { color: tokens.text, fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  markdownText: { fontFamily: undefined, fontSize: 15, lineHeight: 22 },
  imageBox: { maxHeight: 420 },
  image: { width: "100%", height: 360, borderRadius: 8 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 },
  action: {
    minHeight: 44,
    flexGrow: 1,
    flexBasis: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 8,
    paddingHorizontal: 16,
  },
  actionPrimary: { backgroundColor: tokens.primary },
  actionDanger: {
    flexGrow: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
  },
  actionDisabled: { opacity: 0.4 },
  actionLabel: { fontSize: 15, fontWeight: "600" },
  actionLabelPrimary: { color: tokens.primaryText },
  actionLabelDanger: { color: tokens.error },
  iconAction: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
