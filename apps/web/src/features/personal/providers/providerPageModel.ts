import type { ServerProvider } from "@t3tools/contracts";

import { botsNamed, firstLine, type ProviderRow } from "../providerRows";

/** The three steps of the setup card (provider-setup SPEC 5.3). */
export type SetupStepKey = "install" | "signIn" | "test";
export type SetupStepStatus = "done" | "now" | "next" | "failed";

export interface SetupStep {
  readonly key: SetupStepKey;
  readonly title: string;
  readonly status: SetupStepStatus;
  /** The right-aligned note: the installed version, the sign-in method. */
  readonly note: string | null;
}

export interface SetupInput {
  readonly installed: boolean;
  readonly installFailed: boolean;
  /** Installed but signed out. */
  readonly authNeeded: boolean;
  readonly canTest: boolean;
  readonly testPassed: boolean;
  readonly testFailed: boolean;
  readonly installedVersion: string | null;
  readonly signInNote: string | null;
}

/**
 * Where the provider is in its setup. The first step that is not done is "now",
 * the ones after it are "next". A provider with no test message of its own
 * (Antigravity today) has two steps, not three.
 */
export function setupSteps(input: SetupInput): ReadonlyArray<SetupStep> {
  const installDone = input.installed;
  const signInDone = installDone && !input.authNeeded;
  const testDone = signInDone && input.testPassed;
  const raw: Array<{
    key: SetupStepKey;
    title: string;
    done: boolean;
    failed: boolean;
    note: string | null;
  }> = [
    {
      key: "install",
      title: "Install",
      done: installDone,
      failed: input.installFailed,
      note: installDone ? input.installedVersion : null,
    },
    { key: "signIn", title: "Sign in", done: signInDone, failed: false, note: input.signInNote },
    ...(input.canTest
      ? [
          {
            key: "test" as const,
            title: "Test with one message",
            done: testDone,
            failed: input.testFailed && signInDone,
            note: null,
          },
        ]
      : []),
  ];
  let nowAssigned = false;
  return raw.map((step) => {
    if (step.done) return { key: step.key, title: step.title, status: "done", note: step.note };
    if (!nowAssigned) {
      nowAssigned = true;
      return {
        key: step.key,
        title: step.title,
        status: step.failed ? "failed" : "now",
        note: step.note,
      };
    }
    return { key: step.key, title: step.title, status: "next", note: null };
  });
}

export function setupFinished(steps: ReadonlyArray<SetupStep>): boolean {
  return steps.every((step) => step.status === "done");
}

/** The bold state word of the status card. */
export function stateWord(row: ProviderRow): string {
  switch (row.state) {
    case "ready":
      return "Ready";
    case "updateAvailable":
      return "Update available";
    case "needsSignIn":
      return "Needs sign-in";
    case "off":
      return "Off";
    case "installing":
      return "Installing";
    case "updating":
      return "Updating";
    case "testing":
      return "Testing";
    case "waitingForLimit":
      return "Waiting";
    case "lowBalance":
      return "Low balance";
    case "notInstalled":
      return "Not installed";
    default:
      return "Needs attention";
  }
}

export type NoteButton = "goBack" | "testAgain" | "tryAgain" | "pickModel" | "removeIt";

export interface PageNote {
  readonly tone: "danger" | "review";
  readonly title: string;
  readonly text: string;
  readonly buttons: ReadonlyArray<NoteButton>;
}

/** "Unexpected server error" out of "model: Unexpected server error"; the provider's own words, one line. */
export function reasonOf(message: string | null | undefined): string | null {
  const line = firstLine(message, 120);
  if (line === null) return null;
  const separator = line.indexOf(": ");
  const rest = separator > 0 && separator < 80 ? line.slice(separator + 2) : line;
  return rest.trim().length > 0 ? rest.trim() : null;
}

/**
 * The note that replaces the status card when something needs a decision
 * (SPEC section 7): what happened in one sentence and the next step as
 * buttons. Never a stack trace: provider text is its first line only.
 */
export function pageNote(
  row: ProviderRow,
  snapshot: ServerProvider,
  canRemove: boolean,
): PageNote | null {
  const smoke = snapshot.smokeCheck;
  switch (row.state) {
    case "updateBroke": {
      const reason = reasonOf(smoke?.message);
      const previous = smoke?.previousVersion;
      return {
        tone: "review",
        title: `An update broke ${row.label}`,
        text: `${smoke?.version ?? "The new version"} failed the test message${
          reason !== null ? ` with "${reason}"` : ""
        }.${previous !== undefined ? ` ${previous} passed before.` : ""}`,
        buttons: row.action?.kind === "goBack" ? ["goBack", "testAgain"] : ["testAgain"],
      };
    }
    case "modelGone": {
      const missing = smoke?.missingModels ?? [];
      const bots = row.bots;
      return {
        tone: "review",
        title: `${missing.length === 1 ? missing[0] : `${missing.length} models`} ${missing.length === 1 ? "is" : "are"} gone`,
        text:
          bots.length > 0
            ? `${row.label} no longer offers ${missing.length === 1 ? "it" : "them"}. ${botsNamed(bots)} use${bots.length === 1 ? "s" : ""} it and can't reply until ${bots.length === 1 ? "it gets" : "they get"} another model.`
            : `${row.label} no longer offers ${missing.length === 1 ? "it" : "them"}.`,
        buttons: ["pickModel"],
      };
    }
    case "installFailed":
      return {
        tone: "danger",
        title: "The install stopped",
        text: row.detail ?? "Nothing was installed.",
        buttons: ["tryAgain"],
      };
    case "wontStart":
      return {
        tone: "danger",
        title: "Installed, but it won't start",
        text:
          row.detail !== null
            ? `${row.label} stopped with "${row.detail}".`
            : `${row.label} didn't start.`,
        buttons: canRemove ? ["tryAgain", "removeIt"] : ["tryAgain"],
      };
    case "updateFailed":
      return {
        tone: "review",
        title: "The update failed",
        text: row.detail ?? "Nothing changed.",
        buttons: ["tryAgain"],
      };
    case "testFailed": {
      const reason = reasonOf(smoke?.message);
      return {
        tone: "danger",
        title: `${row.label} didn't answer`,
        text: reason !== null ? `It said "${reason}".` : "The test message got no answer.",
        buttons: ["testAgain"],
      };
    }
    default:
      return null;
  }
}

/** "Passed today 21:58 · 2.4 s", "Failed today 21:58", or null before any test. */
export function testLine(
  smoke: ServerProvider["smokeCheck"] | undefined,
  now: Date = new Date(),
): string | null {
  if (smoke === undefined) return null;
  if (smoke.status === "checking") return "Testing…";
  if (smoke.checkedAt === null) return null;
  const at = new Date(smoke.checkedAt);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  const when = sameDay
    ? `today ${time}`
    : `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
  if (smoke.status === "passed") {
    return `Passed ${when}${smoke.durationMs !== undefined ? ` · ${(smoke.durationMs / 1000).toFixed(1)} s` : ""}`;
  }
  if (smoke.status === "failed") return `Failed ${when}`;
  return null;
}

/** "Gemini 3 Pro answered in 2.4 s", the line of the Ready card. */
export function answeredLine(
  smoke: ServerProvider["smokeCheck"] | undefined,
  models: ServerProvider["models"],
): string | null {
  if (smoke?.status !== "passed") return null;
  const name = models.find((model) => model.slug === smoke.model)?.name ?? smoke.model ?? null;
  const seconds =
    smoke.durationMs !== undefined ? ` in ${(smoke.durationMs / 1000).toFixed(1)} s` : "";
  return name === null ? `It answered${seconds}` : `${name} answered${seconds}`;
}
