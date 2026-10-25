import type { EnvironmentId } from "@t3tools/contracts";
import { X } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { FileTextPreview } from "./FileTextPreview";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { chatFilePreviewKind, fileNameFromPath } from "./filesModel";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

export interface ChatFileOpenRequest {
  /** Workspace-relative or absolute host path of the file to show. */
  readonly path: string;
  readonly line: number | undefined;
  /** The chip's label, for the sheet's accessible description. */
  readonly label: string;
}

/** Returns true when the sheet took the request; false leaves the chip's own action. */
export type ChatFileOpener = (request: ChatFileOpenRequest) => boolean;

/** A chat with a workspace root claims text and markdown chips only. */
export function shouldOpenChatFilePreview(cwd: string | undefined, path: string): boolean {
  return cwd !== undefined && chatFilePreviewKind(path) !== null;
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

/** The read-only sheet body: loading, load failure, the file, and a truncation note. */
export function ChatFilePreviewBody({
  request,
  environmentId,
  cwd,
}: {
  readonly request: ChatFileOpenRequest | null;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}): JSX.Element {
  const query = useProjectFileQuery(environmentId, cwd, request?.path ?? null, request !== null);
  const kind = request === null ? null : chatFilePreviewKind(request.path);
  if (query.error !== null) {
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
    </div>
  );
}

/**
 * Read-only bottom sheet for a markdown or text file linked in a bot chat. The
 * file is read through the environment's project-file query, the same read the
 * Files tab uses (an absolute host path is read in place); nothing is written.
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
  const openFile = useCallback<ChatFileOpener>(
    (next) => {
      if (!shouldOpenChatFilePreview(cwd, next.path)) return false;
      setRequest(next);
      return true;
    },
    [cwd],
  );
  const close = useCallback(() => setRequest(null), []);
  const contextValue = useMemo(() => openFile, [openFile]);
  const name = request === null ? "" : fileNameFromPath(request.path);
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
          side="bottom"
          showCloseButton={false}
          forceBackdrop
          backdropClassName="bg-background/70 backdrop-blur-md"
          className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
          data-chat-file-preview
        >
          {request !== null && cwd !== undefined ? (
            <>
              <div className="flex items-center gap-1 py-2 pr-2 pl-5">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
                    {name}
                  </SheetTitle>
                  <SheetDescription
                    className="truncate text-[13px] text-[var(--personal-text-tertiary)]"
                    title={request.path}
                  >
                    {request.path}
                  </SheetDescription>
                </div>
                <SheetClose aria-label="Close preview" className={ICON_BUTTON}>
                  <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
                </SheetClose>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
                <ChatFilePreviewBody request={request} environmentId={environmentId} cwd={cwd} />
              </div>
            </>
          ) : null}
        </SheetPopup>
      </Sheet>
    </ChatFilePreviewContext.Provider>
  );
}
