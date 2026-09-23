import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { PersonalFile } from "@t3tools/contracts";
import { Download, ExternalLink, Trash2, X } from "lucide-react";
import ReactMarkdown, {
  type Components,
  type Options as ReactMarkdownOptions,
} from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { filePreviewKind, formatFileSize, TEXT_PREVIEW_MAX_BYTES } from "./filesModel";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

// Raw HTML is dropped (no rehype-raw, skipHtml), the tree is sanitised with the
// GitHub-style default schema, and images are not rendered so a previewed file
// cannot make the browser fetch remote URLs.
const REMARK_PLUGINS = [remarkGfm] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
const REHYPE_PLUGINS = [[rehypeSanitize, defaultSchema]] satisfies NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;
const DISALLOWED_ELEMENTS = ["img"];
const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};
const MARKDOWN_CLASS =
  "text-[15px] leading-[1.5] text-[var(--personal-text)] break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--personal-border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--personal-text-secondary)] [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--personal-radius-button)] [&_pre]:bg-[var(--personal-fill-muted)] [&_pre]:p-3 [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-[var(--personal-border)] [&_td]:px-2 [&_th]:border [&_th]:border-[var(--personal-border)] [&_th]:px-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5";

type TextState =
  | { readonly url: string; readonly status: "ready"; readonly text: string }
  | { readonly url: string; readonly status: "error" };

/** Fetches a text body once per URL; state is keyed by URL so a new file starts loading. */
function useFileText(url: string | null): "loading" | "error" | { text: string } {
  const [state, setState] = useState<TextState | null>(null);
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, credentials: "omit" })
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

function PreviewMessage({ children }: { children: string }): JSX.Element {
  return (
    <p
      role="status"
      className="py-10 text-center text-[15px] text-[var(--personal-text-secondary)]"
    >
      {children}
    </p>
  );
}

function TextBody({ url, markdown }: { url: string; markdown: boolean }): JSX.Element {
  const body = useFileText(url);
  if (body === "loading") return <PreviewMessage>Loading preview…</PreviewMessage>;
  if (body === "error") {
    return <PreviewMessage>Couldn't load this file. Download it instead.</PreviewMessage>;
  }
  if (markdown) {
    return (
      <div className={MARKDOWN_CLASS}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          disallowedElements={DISALLOWED_ELEMENTS}
          components={MARKDOWN_COMPONENTS}
          skipHtml
        >
          {body.text}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <pre className="font-mono text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-[var(--personal-text)]">
      {body.text}
    </pre>
  );
}

function ImageBody({ url, name }: { url: string; name: string }): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return <PreviewMessage>Couldn't load this image.</PreviewMessage>;
  return (
    <img
      src={url}
      alt={name}
      onError={() => setFailedUrl(url)}
      className="mx-auto block h-auto max-h-[70dvh] max-w-full rounded-[var(--personal-radius-button)] object-contain"
    />
  );
}

/**
 * Bottom sheet for Files-tab previews: images inline, text as source, markdown
 * rendered and sanitised. The header action opens the original image or
 * downloads the text file through the same signed URL.
 */
export function FilePreviewSheet({
  file,
  url,
  onClose,
  onDelete,
}: {
  file: PersonalFile | null;
  /** Resolved signed URL for `file`; null while the connection is not ready. */
  url: string | null;
  onClose: () => void;
  onDelete: () => Promise<unknown>;
}): JSX.Element {
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
    <Sheet
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup
        side="bottom"
        showCloseButton={false}
        forceBackdrop
        backdropClassName="bg-background/70 backdrop-blur-md"
        className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
      >
        {file !== null ? (
          <>
            <div className="flex items-center gap-1 py-2 pr-2 pl-5">
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
                  {file.name}
                </SheetTitle>
                <SheetDescription className="text-[13px] text-[var(--personal-text-tertiary)]">
                  {formatFileSize(file.sizeBytes)}
                </SheetDescription>
              </div>
              {url !== null && kind === "image" ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${file.name} in a new tab`}
                  className={ICON_BUTTON}
                >
                  <ExternalLink aria-hidden="true" className="size-5" strokeWidth={1.75} />
                </a>
              ) : null}
              <SheetClose aria-label="Close preview" className={ICON_BUTTON}>
                <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
              </SheetClose>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
              {url === null ? (
                <PreviewMessage>Reconnecting to your computer…</PreviewMessage>
              ) : kind === "image" ? (
                <ImageBody url={url} name={file.name} />
              ) : kind === "markdown" || kind === "text" ? (
                <TextBody url={url} markdown={kind === "markdown"} />
              ) : null}
            </div>
            {/* Download is the sheet's one filled action; Delete is still one
                tap (and still confirmed) but no longer the only saturated,
                full-width button on a preview. */}
            <div className="flex gap-2 border-t border-[var(--personal-border)] px-5 py-3">
              {url !== null ? (
                <a
                  href={url}
                  download={file.name}
                  aria-label={`Download ${file.name}`}
                  className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)]"
                >
                  <Download aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
                  Download
                </a>
              ) : (
                <span className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] opacity-40">
                  <Download aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
                  Download
                </span>
              )}
              <button
                type="button"
                disabled={deleting}
                onClick={() => void deleteFile()}
                className="flex h-11 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] px-4 text-[15px] font-semibold text-[var(--personal-error)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
              >
                <Trash2 aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
