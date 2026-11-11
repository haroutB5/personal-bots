import * as Data from "effect/Data";

export type BrowserBackendSetting =
  | { readonly kind: "owned" }
  | { readonly kind: "shared"; readonly userDataDir: string };

export type BrowserBackend =
  | { readonly kind: "owned"; readonly profileDir: string }
  | { readonly kind: "shared"; readonly userDataDir: string };

export const resolveBackend = (
  setting: BrowserBackendSetting | undefined,
  ownedProfileDir: string,
): BrowserBackend =>
  setting?.kind === "shared"
    ? { kind: "shared", userDataDir: setting.userDataDir }
    : { kind: "owned", profileDir: ownedProfileDir };

export const SHARED_PROTECTION_PROFILE_ID = "shared";

export const SHARED_BROWSER_CLOSED = "Brave is closed on the laptop. Ask Harout to open it.";

export type SharedAttachReason = "brave-not-running" | "port-file-stale" | "wrong-browser";

export class SharedAttachError extends Data.TaggedError("SharedAttachError")<{
  readonly reason: SharedAttachReason;
  readonly message: string;
}> {}

const SENTENCES: Record<SharedAttachReason, string> = {
  "brave-not-running": "Brave is not open on the laptop. Ask Harout to open it.",
  "port-file-stale":
    "Brave's debugging port file is out of date and nothing answers on it. Ask Harout to restart Brave.",
  "wrong-browser":
    "Something other than Brave answers on Brave's debugging port. Ask Harout to check the shared browser setting.",
};

export const sharedAttachSentence = (reason: SharedAttachReason): string => SENTENCES[reason];

export const sharedAttachError = (reason: SharedAttachReason): SharedAttachError =>
  new SharedAttachError({ reason, message: sharedAttachSentence(reason) });

export const backendSettingFromEnvironment = (env: NodeJS.ProcessEnv): BrowserBackendSetting => {
  const kind = env.T3CODE_PERSONAL_BROWSER_BACKEND?.trim() || "owned";
  if (kind === "owned") return { kind: "owned" };
  if (kind !== "shared") {
    throw new Error('T3CODE_PERSONAL_BROWSER_BACKEND must be "owned" or "shared".');
  }
  const userDataDir = env.T3CODE_PERSONAL_BROWSER_SHARED_DIR?.trim();
  if (!userDataDir) {
    throw new Error(
      "T3CODE_PERSONAL_BROWSER_BACKEND=shared needs T3CODE_PERSONAL_BROWSER_SHARED_DIR, the folder Brave writes DevToolsActivePort into.",
    );
  }
  return { kind: "shared", userDataDir };
};
