import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Download, ExternalLink, Share2, X } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { FileTextPreview } from "./FileTextPreview";
import { useAssetUrlState } from "~/assets/assetUrls";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { chatFilePreviewKind, fileNameFromPath } from "./filesModel";
import { useSheetDragDismiss } from "./useSheetDragDismiss";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const PRIMARY_ACTION =
  "flex h-11 flex-1 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)]";
const SECONDARY_ACTION =
  "flex h-11 flex-1 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] px-4 text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

export interface ChatFileOpenRequest {
  /** Workspace-relative, home-relative, `~/` or absolute host path of the file to show. */
  readonly path: string;
  readonly line: number | undefined;
  /** The chip's label, for the sheet's accessible description. */
  readonly label: string;
}

/** Returns true when the sheet took the request; false leaves the chip's own action. */
export type ChatFileOpener = (request: ChatFileOpenRequest) => boolean;

/**
 * A chat with a workspace root claims every file chip: the server finds the
 * file (workspace, home folder, `~/`, mapped Windows path) and the sheet picks
 * the view, so no chip is left to fail with a generic error.
 */
export function shouldOpenChatFilePreview(cwd: string | undefined, path: string): boolean {
  return cwd !== undefined && path.trim().length > 0;
}

const ChatFilePreviewContext = createContext<ChatFileOpener | null>(null);

/**
 * The personal chat shell's file opener, or null outside it (the desktop chat
 * and the task detail keep the right panel and editor).
 */
export function useChatFilePreview(): ChatFileOpener | null {
  return useContext(ChatFilePreviewContext);
}

function PreviewMessage({ children }: { readonly children: string }): JSX.Element {
  return (
    <p
      role="status"
      className="py-10 text-center text-[15px] text-[var(--personal-text-secondary)]"
    >
      {children}
    </p>
  );
}

const PROTECTED_MESSAGE =
  "This file holds credentials or machine state, so it is never shown or downloaded.";

/** The path as the server resolved it, joined to the chat folder when it came back relative. */
function resolvedPathLabel(cwd: string, resolved: string): string {
  if (resolved.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resolved) || resolved.startsWith("~")) {
    return resolved;
  }
  return `${cwd.replace(/[\\/]+$/, "")}/${resolved}`;
}

function useHostFileResource(
  cwd: string,
  path: string,
  disposition: "inline" | "download",
  enabled: boolean,
): AssetResource | null {
  return useMemo(
    () => (enabled ? { _tag: "host-file", cwd, path, disposition } : null),
    [cwd, path, disposition, enabled],
  );
}

function canShareFiles(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

function ActionLink({
  href,
  download,
  label,
  primary,
  children,
}: {
  readonly href: string | null;
  readonly download?: string;
  readonly label: string;
  readonly primary: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const className = primary ? PRIMARY_ACTION : SECONDARY_ACTION;
  if (href === null) {
    return (
      <span aria-disabled="true" className={`${className} opacity-40`}>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      {...(download !== undefined
        ? { download }
        : { target: "_blank", rel: "noopener noreferrer" })}
      aria-label={label}
      className={className}
    >
      {children}
    </a>
  );
}

/** Fetches the file and hands it to the system share sheet; fails quietly into a hint. */
function ShareButton({ url, name }: { readonly url: string; readonly name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const share = async () => {
    setFailed(false);
    try {
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] }) === false) throw new Error("unsupported");
      await navigator.share({ files: [file], title: name });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setFailed(true);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      aria-label={`Share ${name}`}
      className={SECONDARY_ACTION}
    >
      <Share2 aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
      {failed ? "Couldn't share" : "Share"}
    </button>
  );
}

function ImageView({ url, name }: { readonly url: string; readonly name: string }): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return <PreviewMessage>Couldn&apos;t load this image.</PreviewMessage>;
  return (
    <img
      src={url}
      alt={name}
      onError={() => setFailedUrl(url)}
      className="mx-auto block h-auto max-h-[70dvh] max-w-full rounded-[var(--personal-radius-button)] object-contain"
    />
  );
}

function FileCard({
  name,
  note,
  children,
}: {
  readonly name: string;
  readonly note: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-4 py-6 text-center">
      <p className="break-words text-[17px] font-semibold text-[var(--personal-text)]">{name}</p>
      <p className="text-[15px] text-[var(--personal-text-secondary)]">{note}</p>
      <div className="flex flex-col gap-2 [&>a]:flex-none [&>span]:flex-none [&>button]:flex-none">
        {children}
      </div>
    </div>
  );
}

function ActionRow({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="flex gap-2 pt-3">{children}</div>;
}

/**
 * The read-only sheet body. Markdown, text and source read through the project
 * file query (the Files tab's read); images, PDFs and downloads use a signed
 * host-file URL. A file the text read cannot show (binary) falls back to
 * Download, and a protected file says so instead of failing generically.
 */
export function ChatFilePreviewBody({
  request,
  environmentId,
  cwd,
  onResolvedPath,
}: {
  readonly request: ChatFileOpenRequest | null;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** Called with the path the server actually opened, for the sheet header. */
  readonly onResolvedPath?: (path: string) => void;
}): JSX.Element {
  const path = request?.path ?? null;
  const kind = path === null ? null : chatFilePreviewKind(path);
  const name = path === null ? "" : fileNameFromPath(path);
  const readsText = kind === "markdown" || kind === "text" || kind === "html" || kind === "other";
  const query = useProjectFileQuery(environmentId, cwd, path, request !== null && readsText);
  const wantsInline = kind === "image" || kind === "pdf" || kind === "html";
  const inline = useAssetUrlState(
    environmentId,
    useHostFileResource(cwd, path ?? "", "inline", wantsInline && path !== null),
  );
  const download = useAssetUrlState(
    environmentId,
    useHostFileResource(cwd, path ?? "", "download", path !== null),
  );
  const downloadUrl = download._tag === "Success" ? download.url : null;
  const inlineUrl = inline._tag === "Success" ? inline.url : null;
  const resolved =
    wantsInline && inline._tag === "Success" && inline.sourcePath !== undefined
      ? inline.sourcePath
      : readsText && query.data !== null
        ? resolvedPathLabel(cwd, query.data.relativePath)
        : download._tag === "Success" && download.sourcePath !== undefined
          ? download.sourcePath
          : null;
  useEffect(() => {
    if (resolved !== null) onResolvedPath?.(resolved);
  }, [onResolvedPath, resolved]);

  const downloadAction = (primary: boolean): JSX.Element => (
    <ActionLink href={downloadUrl} download={name} label={`Download ${name}`} primary={primary}>
      <Download aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
      Download
    </ActionLink>
  );
  const shareAction =
    downloadUrl !== null && canShareFiles() ? <ShareButton url={downloadUrl} name={name} /> : null;
  const protectedFile =
    query.isProtected ||
    (wantsInline && inline._tag === "Failure" && inline.protectedFile === true);
  if (protectedFile || (download._tag === "Failure" && download.protectedFile === true)) {
    return <PreviewMessage>{PROTECTED_MESSAGE}</PreviewMessage>;
  }

  if (kind === "image") {
    if (inline._tag === "Failure")
      return (
        <PreviewMessage>
          Couldn&apos;t open this image. It may have moved or been deleted.
        </PreviewMessage>
      );
    if (inlineUrl === null) return <PreviewMessage>Loading image…</PreviewMessage>;
    return (
      <div>
        <ImageView url={inlineUrl} name={name} />
        <ActionRow>
          <ActionLink href={inlineUrl} label={`Open ${name} in a new tab`} primary={false}>
            <ExternalLink aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
            Open
          </ActionLink>
          {downloadAction(true)}
        </ActionRow>
      </div>
    );
  }

  if (kind === "pdf") {
    if (inline._tag === "Failure")
      return (
        <PreviewMessage>
          Couldn&apos;t open this PDF. It may have moved or been deleted.
        </PreviewMessage>
      );
    if (inlineUrl === null) return <PreviewMessage>Loading PDF…</PreviewMessage>;
    // Safari on iPhone cannot scroll an embedded PDF, so the PDF opens in the
    // browser's own viewer in a new tab instead of an inline frame.
    return (
      <FileCard name={name} note="PDF document">
        <ActionLink href={inlineUrl} label={`Open ${name}`} primary>
          <ExternalLink aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
          Open PDF
        </ActionLink>
        <div className="flex gap-2">
          {downloadAction(false)}
          {shareAction}
        </div>
      </FileCard>
    );
  }

  if (kind === "download" || (readsText && query.isBinary)) {
    if (download._tag === "Failure") {
      return (
        <PreviewMessage>
          Couldn&apos;t open this file. It may have moved or been deleted.
        </PreviewMessage>
      );
    }
    return (
      <FileCard name={name} note="No preview for this type of file.">
        {downloadAction(true)}
        {shareAction}
      </FileCard>
    );
  }

  if (query.error !== null) {
    if (query.isNotFile) {
      return <PreviewMessage>This is a folder, not a file.</PreviewMessage>;
    }
    return (
      <PreviewMessage>
        Couldn&apos;t open this file. It may have moved or been deleted.
      </PreviewMessage>
    );
  }
  if (query.data === null) return <PreviewMessage>Loading file…</PreviewMessage>;
  return (
    <div className="space-y-3">
      <FileTextPreview text={query.data.contents} markdown={kind === "markdown"} />
      {query.data.truncated ? (
        <p className="border-t border-[var(--personal-border)] pt-3 text-[13px] text-[var(--personal-text-tertiary)]">
          Showing the first 1 MB of this file.
        </p>
      ) : null}
      <ActionRow>
        {kind === "html" ? (
          // The server serves HTML from an opaque-origin sandbox: scripts may
          // run, but there are no app cookies, storage or same-origin access;
          // the source above is the default view.
          <ActionLink href={inlineUrl} label={`Open ${name} rendered`} primary={false}>
            <ExternalLink aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
            Open rendered
          </ActionLink>
        ) : null}
        {downloadAction(kind !== "html")}
      </ActionRow>
    </div>
  );
}

/**
 * Read-only bottom sheet for any file linked in a bot chat. Text is read
 * through the environment's project-file query, the same read the Files tab
 * uses; images, PDFs and downloads use a signed host-file URL. The header shows
 * the path the server actually opened. Nothing is written.
 */
export function ChatFilePreviewProvider({
  environmentId,
  cwd,
  children,
}: {
  readonly environmentId: EnvironmentId;
  /** The chat's workspace root; without one, chips keep their previous action. */
  readonly cwd: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  const [request, setRequest] = useState<ChatFileOpenRequest | null>(null);
  const [resolved, setResolved] = useState<{ readonly key: string; readonly path: string } | null>(
    null,
  );
  const openFile = useCallback<ChatFileOpener>(
    (next) => {
      if (!shouldOpenChatFilePreview(cwd, next.path)) return false;
      setRequest(next);
      return true;
    },
    [cwd],
  );
  const close = useCallback(() => setRequest(null), []);
  const dragRef = useSheetDragDismiss(close);
  const contextValue = useMemo(() => openFile, [openFile]);
  const name = request === null ? "" : fileNameFromPath(request.path);
  const requestPath = request?.path ?? null;
  const onResolvedPath = useCallback(
    (path: string) => {
      if (requestPath !== null) setResolved({ key: requestPath, path });
    },
    [requestPath],
  );
  const shownPath =
    request === null ? "" : resolved?.key === request.path ? resolved.path : request.path;
  return (
    <ChatFilePreviewContext.Provider value={contextValue}>
      {children}
      <Sheet
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetPopup
          ref={dragRef}
          side="bottom"
          showCloseButton={false}
          forceBackdrop
          backdropClassName="bg-background/70 backdrop-blur-md"
          className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
          data-chat-file-preview
        >
          {request !== null && cwd !== undefined ? (
            <>
              <div
                data-sheet-drag-zone=""
                className="flex touch-none items-center gap-1 py-2 pr-2 pl-5"
              >
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
                    {name}
                  </SheetTitle>
                  <SheetDescription
                    className="truncate text-[13px] text-[var(--personal-text-tertiary)]"
                    title={shownPath}
                  >
                    {shownPath}
                  </SheetDescription>
                </div>
                <SheetClose aria-label="Close preview" className={ICON_BUTTON}>
                  <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
                </SheetClose>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
                <ChatFilePreviewBody
                  request={request}
                  environmentId={environmentId}
                  cwd={cwd}
                  onResolvedPath={onResolvedPath}
                />
              </div>
            </>
          ) : null}
        </SheetPopup>
      </Sheet>
    </ChatFilePreviewContext.Provider>
  );
}
