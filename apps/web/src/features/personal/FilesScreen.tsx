import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";

import type { PersonalFile } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  Download,
  Ellipsis,
  ExternalLink,
  File as FileIcon,
  FileImage,
  FileText,
  Search,
  type LucideIcon,
} from "lucide-react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { usePreparedConnection } from "~/state/session";

import { BotAvatar } from "./BotAvatar";
import {
  allSelected,
  selectedCountLabel,
  toggleAllSelection,
  toggleSelection,
  visibleSelection,
} from "./bulkSelection";
import { useMinuteClock } from "./ChatsScreen";
import { FilePreviewSheet } from "./FilePreviewSheet";
import {
  type FilePreviewKind,
  filePreviewKind,
  formatFileSize,
  groupFilesByBot,
} from "./filesModel";
import { formatRelativeTime } from "./relativeTime";
import {
  BulkNoticeLine,
  NO_TOUCH_SELECT,
  SELECT_TEXT_BUTTON,
  SelectCheck,
  SelectModeActions,
  SelectModeDeleteButton,
  SelectModeHeader,
  useBulkNotice,
  useEscapeToExit,
} from "./SelectMode";
import { SwipeToDelete } from "./SwipeToDelete";
import { FILE_NOUN, useBulkDeleteFiles } from "./useBulkDelete";
import { useDeleteFile } from "./useDeleteFile";
import { useLongPress } from "./useLongPress";
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

/** Icon, name, size and age; the trailing icon shows what a tap does. */
function FileRowBody({
  file,
  kind,
  now,
  trailing,
}: {
  file: PersonalFile;
  kind: FilePreviewKind;
  now: number;
  trailing: boolean;
}): JSX.Element {
  const Icon = KIND_ICONS[kind];
  const createdMs = file.createdAt.epochMilliseconds;
  const TrailingIcon = kind === "download" ? Download : kind === "pdf" ? ExternalLink : null;
  return (
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
      {TrailingIcon !== null && trailing ? (
        <TrailingIcon
          aria-hidden="true"
          className="size-[18px] shrink-0 text-[var(--personal-text-secondary)]"
          strokeWidth={1.75}
        />
      ) : null}
    </>
  );
}

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
  const body = <FileRowBody file={file} kind={kind} now={now} trailing={href !== null} />;

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
 * A file in the list: tap to open, swipe left to delete, press and hold to
 * start select mode with this file picked.
 */
function ListedFile({
  file,
  href,
  now,
  onPreview,
  onDelete,
  onLongPress,
}: {
  file: PersonalFile;
  href: string | null;
  now: number;
  onPreview: (file: PersonalFile) => void;
  onDelete: (file: PersonalFile) => Promise<void>;
  onLongPress: (fileId: string) => void;
}): JSX.Element {
  const fileId = file.fileId;
  const longPress = useLongPress(useCallback(() => onLongPress(fileId), [onLongPress, fileId]));
  return (
    <li>
      <SwipeToDelete label={`Delete ${file.name}`} onDelete={() => onDelete(file)}>
        <div {...longPress} className={NO_TOUCH_SELECT}>
          <FileRow
            file={file}
            kind={filePreviewKind(file)}
            href={href}
            now={now}
            onPreview={() => onPreview(file)}
          />
        </div>
      </SwipeToDelete>
    </li>
  );
}

/** A file in select mode: the whole row toggles; no swipe, no opening the file. */
function SelectableFile({
  file,
  now,
  selected,
  onToggle,
}: {
  file: PersonalFile;
  now: number;
  selected: boolean;
  onToggle: (fileId: string) => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={() => onToggle(file.fileId)}
        className={cn(ROW_CLASS, NO_TOUCH_SELECT)}
      >
        <SelectCheck checked={selected} />
        <FileRowBody file={file} kind={filePreviewKind(file)} now={now} trailing={false} />
      </button>
    </li>
  );
}

/**
 * Files tab: every attachment from personal-bot chats, grouped under its bot
 * and searchable by name. Images, text and markdown open in a preview sheet,
 * PDFs in the browser's viewer, everything else downloads. All URLs are the
 * server's signed, id-based asset URLs. Select mode (the "..." menu, or press
 * and hold a file) picks files across bots for one bulk delete; Select all
 * covers every file on screen, and each bot's heading selects its own.
 */
export function FilesScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const botsList = usePersonalBotsList(environmentId);
  const filesList = usePersonalFiles(environmentId);
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const now = useMinuteClock();
  const deleteFile = useDeleteFile(environmentId);
  const deleteFiles = useBulkDeleteFiles(environmentId);
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState<PersonalFile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useBulkNotice();
  const [bulkBusy, setBulkBusy] = useState(false);

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

  // Select mode covers the files on screen: a search narrows what Select all
  // reaches, and a file deleted elsewhere stops counting.
  const selecting = selection !== null;
  const shownIds = useMemo(
    () => groups.flatMap((group) => group.files.map((file) => file.fileId)),
    [groups],
  );
  const chosen = selection === null ? [] : visibleSelection(selection, shownIds);
  const everySelected = selection !== null && allSelected(selection, shownIds);

  const enterSelect = useCallback(
    (first: string | null) => {
      setNotice(null);
      setDeleteError(null);
      setSelection(new Set(first === null ? [] : [first]));
    },
    [setNotice],
  );
  const exitSelect = useCallback(() => setSelection(null), []);
  useEscapeToExit(selecting, exitSelect);
  const toggle = useCallback((fileId: string) => {
    setSelection((current) => (current === null ? current : toggleSelection(current, fileId)));
  }, []);
  const toggleAll = (ids: ReadonlyArray<string>) => {
    setSelection((current) => (current === null ? current : toggleAllSelection(current, ids)));
  };

  const onBulkDelete = async () => {
    if (chosen.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    const outcome = await deleteFiles(chosen);
    setBulkBusy(false);
    if (outcome.status === "cancelled") return;
    setNotice({ text: outcome.notice, failed: outcome.anyFailed });
    const gone = new Set(outcome.doneIds);
    setPreviewing((current) => (current !== null && gone.has(current.fileId) ? null : current));
    // Done: back to the plain list. Refused files stay selected for another try.
    setSelection(outcome.failedIds.length === 0 ? null : new Set(outcome.failedIds));
  };

  const resolve = (relativeUrl: string | null): string | null =>
    relativeUrl === null || httpBaseUrl === null ? null : resolveAssetUrl(httpBaseUrl, relativeUrl);

  return (
    <div className={cn("flex min-w-0 flex-col px-5", selecting ? "min-h-full" : "pb-6")}>
      {selecting ? (
        <SelectModeHeader
          label={selectedCountLabel(chosen.length, FILE_NOUN)}
          everySelected={everySelected}
          canSelectAll={shownIds.length > 0}
          onCancel={exitSelect}
          onToggleAll={() => toggleAll(shownIds)}
        />
      ) : (
        <header className="flex h-14 items-center justify-between gap-3">
          <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">Files</h1>
          {loaded && files.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="File list options"
                    className="-mr-3 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                  />
                }
              >
                <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
              </MenuTrigger>
              <MenuPopup align="end" className="personal-app personal-menu min-w-48">
                <MenuItem onClick={() => enterSelect(null)}>Select files</MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </header>
      )}

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

      <BulkNoticeLine notice={notice} />

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
              const groupIds = botFiles.map((file) => file.fileId);
              const groupSelected = selection !== null && allSelected(selection, groupIds);
              return (
                <section key={bot.botId} aria-labelledby={headingId} className="mt-5">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2
                      id={headingId}
                      className="flex min-w-0 flex-1 items-center gap-2 text-[15px] leading-5 font-semibold text-[var(--personal-text)]"
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
                    {/* Picks this bot's files only; the header's Select all takes every bot's. */}
                    {selecting ? (
                      <button
                        type="button"
                        onClick={() => toggleAll(groupIds)}
                        aria-label={`${groupSelected ? "Deselect" : "Select"} all ${bot.name} files`}
                        className={cn(
                          "-my-3 -mr-2",
                          SELECT_TEXT_BUTTON,
                          "text-[14px] text-[var(--personal-text)]",
                        )}
                      >
                        {groupSelected ? "Deselect all" : "Select all"}
                      </button>
                    ) : null}
                  </div>
                  <ul className="mt-2 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]">
                    {botFiles.map((file) =>
                      selecting ? (
                        <SelectableFile
                          key={file.fileId}
                          file={file}
                          now={now}
                          selected={selection.has(file.fileId)}
                          onToggle={toggle}
                        />
                      ) : (
                        <ListedFile
                          key={file.fileId}
                          file={file}
                          href={resolve(
                            filePreviewKind(file) === "pdf" ? file.previewUrl : file.url,
                          )}
                          now={now}
                          onPreview={setPreviewing}
                          onDelete={onDeleteFile}
                          onLongPress={enterSelect}
                        />
                      ),
                    )}
                  </ul>
                </section>
              );
            })
          )}
        </>
      ) : null}

      {selecting ? (
        <SelectModeActions>
          <SelectModeDeleteButton
            disabled={chosen.length === 0}
            busy={bulkBusy}
            onClick={() => void onBulkDelete()}
          />
        </SelectModeActions>
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
