import type { PersonalBot, PersonalFile } from "@t3tools/contracts";

/** How the Files tab opens a file. */
export type FilePreviewKind = "image" | "pdf" | "markdown" | "text" | "download";

/** Largest text or markdown file the preview sheet fetches and renders. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "sh",
  "ps1",
  "sql",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Images, text and markdown preview in the sheet (text is always shown as
 * source, never rendered as HTML). PDFs open in the browser's own viewer via
 * the server-minted inline URL. Everything else, including SVG and oversized
 * text, downloads.
 */
export function filePreviewKind(
  file: Pick<PersonalFile, "name" | "mimeType" | "sizeBytes" | "previewUrl">,
): FilePreviewKind {
  const mime = (file.mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
  const extension = extensionOf(file.name);
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (file.previewUrl !== null) return "pdf";
  const fitsPreview = file.sizeBytes <= TEXT_PREVIEW_MAX_BYTES;
  if (mime === "text/markdown" || MARKDOWN_EXTENSIONS.has(extension)) {
    return fitsPreview ? "markdown" : "download";
  }
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTENSIONS.has(extension)) {
    return fitsPreview ? "text" : "download";
  }
  return "download";
}

/** "512 B", "1.4 KB", "23 KB", "4.2 MB" (1024-based, one decimal under 10). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

export interface BotFileGroup {
  readonly bot: PersonalBot;
  readonly files: ReadonlyArray<PersonalFile>;
}

/**
 * Files grouped under their bot in the Chats order, newest file first inside
 * each group. `query` matches file names case-insensitively; groups left
 * empty are dropped.
 */
export function groupFilesByBot(input: {
  readonly files: ReadonlyArray<PersonalFile>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly query: string;
}): ReadonlyArray<BotFileGroup> {
  const needle = input.query.trim().toLowerCase();
  const byBot = new Map<string, Array<PersonalFile>>();
  for (const file of input.files) {
    if (needle.length > 0 && !file.name.toLowerCase().includes(needle)) continue;
    const bucket = byBot.get(file.botId);
    if (bucket === undefined) byBot.set(file.botId, [file]);
    else bucket.push(file);
  }
  const groups: Array<BotFileGroup> = [];
  for (const bot of [...input.bots].toSorted((a, b) => a.sortOrder - b.sortOrder)) {
    const files = byBot.get(bot.botId);
    if (files === undefined) continue;
    groups.push({
      bot,
      files: files.toSorted(
        (a, b) => b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds,
      ),
    });
  }
  return groups;
}
