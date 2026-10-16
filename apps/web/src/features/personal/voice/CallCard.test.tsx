/**
 * The call card's summary (Harout, 16 Oct 2026): what a finished call shows on
 * the collapsed card, above the transcript it already had.
 *
 * The failure this exists to prevent is Harout's own: he asked on a call
 * whether a court was free before his Saturday booking, the voice found Court 3
 * free 11:00-12:00, and the chat showed nothing of it afterwards.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CallCard, type VoiceCallCardModel } from "./CallCard";

let renderer: ReactTestRenderer | undefined;

const model = (overrides: Partial<VoiceCallCardModel> = {}): VoiceCallCardModel => ({
  callId: "8f9c3ace",
  startedAtMs: Date.parse("2026-10-16T13:59:17.443Z"),
  durationMs: 168_000,
  endedLine: "You said bye.",
  sentCount: 3,
  transcript: [],
  live: false,
  voiceName: "Charon",
  ...overrides,
});

const render = async (value: VoiceCallCardModel) => {
  await act(async () => {
    renderer = create(
      <CallCard model={value} onCallBack={() => undefined} onReturn={() => undefined} />,
    );
  });
};

/** Every string the card renders, in tree order. */
const texts = (): ReadonlyArray<string> =>
  JSON.stringify(renderer!.toJSON())
    .match(/"([^"]*)"/g)
    ?.map((part) => part.slice(1, -1)) ?? [];

const flat = () => texts().join("\n");

describe("CallCard summary", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("shows the sentence, the bullets and the decision on the collapsed card", async () => {
    await render(
      model({
        summary: {
          summary:
            "He asked whether a court was free before his Saturday booking; Court 3 is free 11:00-12:00.",
          points: ["Court 2 booked Saturday 12:00-15:00", "Court 3 free 11:00-12:00 Saturday"],
          decision: "No change, just wanted to know",
          open: null,
        },
      }),
    );

    const shown = flat();
    expect(shown).toContain("Court 3 is free 11:00-12:00");
    expect(shown).toContain("Court 2 booked Saturday 12:00-15:00");
    expect(shown).toContain("Decided:");
    expect(shown).toContain("No change, just wanted to know");
    // Nothing was left open, so no "Still open" line at all.
    expect(shown).not.toContain("Still open");

    // The decision is the line he comes back for: it gets its own marked block.
    const decision = renderer!.root.findByProps({ "data-voice-call-decision": "true" });
    const decisionText = decision
      .findAll((node) => node.type === "span")
      .flatMap((node) =>
        node.children.filter((child): child is string => typeof child === "string"),
      )
      .join(" ");
    expect(decisionText).toContain("No change, just wanted to know");

    // The transcript is still there, collapsed, exactly as before.
    const toggle = renderer!.root.findAll(
      (node) => node.type === "button" && node.children.includes("Transcript"),
    );
    expect(toggle).toHaveLength(1);
    expect(toggle[0]!.props["aria-expanded"]).toBe(false);
  });

  it("shows nothing where the summary would be when there is none", async () => {
    await render(model());
    const shown = flat();
    expect(shown).not.toContain("Decided:");
    expect(shown).toContain("Voice call");
    expect(shown).toContain("3 messages sent");
  });

  it("never shows a summary on a call that is still running", async () => {
    await render(
      model({
        live: true,
        summary: {
          summary: "Should not be on screen yet.",
          points: [],
          decision: null,
          open: null,
        },
      }),
    );
    expect(flat()).not.toContain("Should not be on screen yet.");
    expect(flat()).toContain("On a call");
  });

  it("marks the open question and wraps long lines with dir=auto", async () => {
    await render(
      model({
        summary: {
          summary: "He asked about the Saturday slot.",
          points: [],
          decision: null,
          open: "Still to check whether court one is free",
        },
      }),
    );
    const shown = flat();
    expect(shown).toContain("Still open:");
    expect(shown).toContain("Still to check whether court one is free");

    // Armenian and Arabic lines lay out right-to-left: the sentence and the
    // open line each carry dir="auto".
    const auto = renderer!.root.findAll((node) => node.props.dir === "auto");
    expect(auto.length).toBeGreaterThanOrEqual(2);
  });
});
