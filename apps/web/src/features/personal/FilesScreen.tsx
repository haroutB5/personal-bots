import type { JSX } from "react";
import { useMemo, useState } from "react";

import type { PersonalFile } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  Download,
  ExternalLink,
  File as FileIcon,
  FileImage,
  FileText,
  Search,
  type LucideIcon,
} from "lucide-react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { usePreparedConnection } from "~/state/session";

import { BotAvatar } from "./BotAvatar";
import { useMinuteClock } from "./ChatsScreen";
import { FilePreviewSheet } from "./FilePreviewSheet";
import {
  type FilePreviewKind,
  filePreviewKind,
  formatFileSize,
  groupFilesByBot,
} from "./filesModel";
import { formatRelativeTime } from "./relativeTime";
import { SwipeToDelete } from "./SwipeToDelete";
import { useDeleteFile } from "./useDeleteFile";
import { usePersonalBotsList, usePersonalEnvironmentId, usePersonalFiles } from "./usePersonalBots";

const EMPTY_FILES: ReadonlyArray<PersonalFile> = [];

const KIND_ICONS: Record<FilePreviewKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  markdown: FileText,
  text: FileText,
  download: FileIcon,
};

const ROW_CLASS =
  "flex min-h-[60px] w-full min-w-0 items-center gap-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]";

function FileRow({
  file,
  kind,
  href,
  now,
  onPreview,
}: {
  file: PersonalFile;
  kind: FilePreviewKind;
  /** Resolved URL for the row's action; null renders a plain, inert row. */
  href: string | null;
  now: number;
  onPreview: () => void;
}): JSX.Element {
  const Icon = KIND_ICONS[kind];
  const createdMs = file.createdAt.epochMilliseconds;
  const TrailingIcon = kind === "download" ? Download : kind === "pdf" ? ExternalLink : null;
  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)]"
      >
        <Icon className="size-5 text-[var(--personal-text-secondary)]" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] leading-5 font-medium text-[var(--personal-text)]">
          {file.name}
        </span>
        <span className="text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]">
          {formatFileSize(file.sizeBytes)} ·{" "}
          <time dateTime={new Date(createdMs).toISOString()}>
            {formatRelativeTime(createdMs, now)}
          </time>
        </span>
      </span>
      {TrailingIcon !== null && href !== null ? (
        <TrailingIcon
          aria-hidden="true"
          className="size-[18px] shrink-0 text-[var(--personal-text-secondary)]"
          strokeWidth={1.75}
        />
      ) : null}
    </>
  );

  if (href === null) return <div className={ROW_CLASS}>{body}</div>;
  if (kind === "download") {
    return (
      <a href={href} download={file.name} className={ROW_CLASS}>
        {body}
        <span className="sr-only">, download</span>
      </a>
    );
  }
  if (kind === "pdf") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={ROW_CLASS}>
        {body}
        <span className="sr-only">, opens in a new tab</span>
      </a>
    );
  }
  return (
    <button type="button" aria-haspopup="dialog" onClick={onPreview} className={ROW_CLASS}>
      {body}
    </button>
  );
}

/**
 * Files tab: every attachment from personal-bot chats, grouped under its bot
 * and searchable by name. Images, text and markdown open in a preview sheet,
 * PDFs in the browser's viewer, everything else downloads. All URLs are the
 * server's signed, id-based asset URLs.
 */
export function FilesScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const botsList = usePersonalBotsList(environmentId);
  const filesList = usePersonalFiles(environmentId);
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const now = useMinuteClock();
  const deleteFile = useDeleteFile(environmentId);
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState<PersonalFile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const onDeleteFile = async (file: PersonalFile) => {
    const outcome = await deleteFile(file);
    if (outcome.status === "cancelled") return;
    if (outcome.status === "failed") {
      setDeleteError(outcome.message);
      return;
    }
    setDeleteError(null);
    setPreviewing((current) => (current?.fileId === file.fileId ? null : current));
  };

  const files = filesList.data?.files ?? EMPTY_FILES;
  const bots = botsList.data?.bots;
  const groups = useMemo(
    () => groupFilesByBot({ files, bots: bots ?? [], query }),
    [bots, files, query],
  );
  const loaded = filesList.data !== null && botsList.data !== null;
  const loadError = filesList.error ?? botsList.error;

  const resolve = (relativeUrl: string | null): string | null =>
    relativeUrl === null || httpBaseUrl === null ? null : resolveAssetUrl(httpBaseUrl, relativeUrl);

  return (
    <div className="flex min-w-0 flex-col px-5 pb-6">
      <header className="flex h-14 items-center">
        <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">Files</h1>
      </header>

      {environmentId === null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          Not connected to your computer yet.{" "}
          <Link
            to="/settings/connections"
            className="font-medium text-[var(--personal-text)] underline"
          >
            Open Connections
          </Link>
        </p>
      ) : null}

      {loadError !== null ? (
        <div className="mt-6 flex items-center justify-between gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
          <p className="min-w-0 text-[15px] text-[var(--personal-text)]">
            Couldn't load your files. {loadError}
          </p>
          <button
            type="button"
            onClick={() => {
              filesList.refresh();
              botsList.refresh();
            }}
            className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-medium text-[var(--personal-text)]"
          >
            Try again
          </button>
        </div>
      ) : null}

      {deleteError !== null ? (
        <p
          role="alert"
          className="mt-4 rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] px-3.5 py-2.5 text-sm break-words text-[var(--personal-danger)]"
        >
          {deleteError}
        </p>
      ) : null}

      {environmentId !== null && !loaded && loadError === null ? (
        <p role="status" className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          Loading files…
        </p>
      ) : null}

      {loaded && files.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-[var(--personal-fill-muted)]">
            <FileIcon
              aria-hidden="true"
              className="size-6 text-[var(--personal-text-secondary)]"
              strokeWidth={1.75}
            />
          </span>
          <h2 className="text-lg font-semibold text-[var(--personal-text)]">No files yet</h2>
          <p className="max-w-[280px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
            Files you attach in bot chats show up here, grouped by bot.
          </p>
        </div>
      ) : null}

      {loaded && files.length > 0 ? (
        <>
          <div className="relative mt-2">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-[var(--personal-text-secondary)]"
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              aria-label="Search files"
              className="h-11 w-full rounded-full border-0 bg-[var(--personal-fill-muted)] pr-4 pl-10 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            />
          </div>

          {groups.length === 0 ? (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No files match "{query.trim()}".
            </p>
          ) : (
            groups.map(({ bot, files: botFiles }) => {
              const headingId = `files-bot-${bot.botId}`;
              return (
                <section key={bot.botId} aria-labelledby={headingId} className="mt-5">
                  <h2
                    id={headingId}
                    className="flex min-w-0 items-center gap-2 text-[15px] leading-5 font-semibold text-[var(--personal-text)]"
                  >
                    <span aria-hidden="true" className="flex">
                      <BotAvatar
                        shape={bot.avatarShape}
                        color={bot.avatarColor}
                        size={20}
                        label={bot.name}
                      />
                    </span>
                    <span className="truncate">{bot.name}</span>
                    <span className="ml-auto shrink-0 text-[13px] font-normal text-[var(--personal-text-tertiary)]">
                      {botFiles.length === 1 ? "1 file" : `${botFiles.length} files`}
                    </span>
                  </h2>
                  <ul className="mt-2 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]">
                    {botFiles.map((file) => {
                      const kind = filePreviewKind(file);
                      return (
                        <li key={file.fileId}>
                          <SwipeToDelete
                            label={`Delete ${file.name}`}
                            onDelete={() => onDeleteFile(file)}
                          >
                            <FileRow
                              file={file}
                              kind={kind}
                              href={resolve(kind === "pdf" ? file.previewUrl : file.url)}
                              now={now}
                              onPreview={() => setPreviewing(file)}
                            />
                          </SwipeToDelete>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </>
      ) : null}

      <FilePreviewSheet
        file={previewing}
        url={resolve(previewing?.url ?? null)}
        onClose={() => setPreviewing(null)}
        onDelete={() => (previewing === null ? Promise.resolve() : onDeleteFile(previewing))}
      />
    </div>
  );
}
