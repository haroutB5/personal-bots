import type { BotFileGroup, FilePreviewKind } from "@hbots/personal-client/files/filesModel";
import type { PersonalFile } from "@t3tools/contracts";

export type FilesScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready" };

/** The one state the Files tab shows, from the two lists it reads. */
export function filesScreenState(input: {
  readonly filesLoaded: boolean;
  readonly botsLoaded: boolean;
  readonly error: string | null;
  readonly fileCount: number;
}): FilesScreenState {
  if (input.error !== null) return { kind: "error", message: input.error };
  if (!input.filesLoaded || !input.botsLoaded) return { kind: "loading" };
  return input.fileCount === 0 ? { kind: "empty" } : { kind: "ready" };
}

/** Every file id the search leaves on screen, in list order. */
export function shownFileIds(groups: ReadonlyArray<BotFileGroup>): ReadonlyArray<string> {
  return groups.flatMap((group) => group.files.map((file) => file.fileId));
}

/** Files still on screen that were picked; a deleted or filtered one stops counting. */
export function chosenFiles(
  selected: ReadonlySet<string> | null,
  groups: ReadonlyArray<BotFileGroup>,
): ReadonlyArray<PersonalFile> {
  if (selected === null) return [];
  return groups.flatMap((group) => group.files.filter((file) => selected.has(file.fileId)));
}

/** What a row's trailing icon promises: download, a browser viewer, or the sheet. */
export function fileRowAction(kind: FilePreviewKind): {
  readonly open: "sheet" | "browser" | "download";
} {
  if (kind === "download") return { open: "download" };
  if (kind === "pdf") return { open: "browser" };
  return { open: "sheet" };
}
