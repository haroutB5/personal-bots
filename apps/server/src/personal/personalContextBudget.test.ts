// Tests for the per-step context trims of 1.66.62: the built-in tools no bot
// calls, the bundled skills bots never use, the large whole-file Read guard and
// the search_memory result cap (memoryShared.ts).
import { describe, expect, it } from "@effect/vitest";

import {
  BLOCK_ENTRY_MAX_CHARS,
  capByJsonChars,
  memorySearchMaxChars,
  PERSONAL_MEMORY_RESEND_EVERY_TURNS,
  PERSONAL_MEMORY_SEARCH_MAX_CHARS,
} from "./memory/memoryShared.ts";
import {
  LARGE_FILE_READ_ESCAPE_PROPERTY,
  LARGE_FILE_READ_MAX_CHARS,
  largeFileReadGuardEnabled,
  largeFileReadRefusal,
  largeFileReadRefusalForSize,
  PERSONAL_BOT_DISALLOWED_TOOLS,
  PERSONAL_BOT_HIDDEN_SKILLS,
  personalBotDisallowedTools,
  personalBotSkillOverrides,
  personalBotToolTrimEnabled,
} from "./personalContextBudget.ts";

const longText = (chars: number) => "x".repeat(chars);

describe("personalContextBudget: built-in tools", () => {
  it("denies exactly the four tools no bot has called", () => {
    expect([...PERSONAL_BOT_DISALLOWED_TOOLS]).toEqual([
      "Workflow",
      "ReportFindings",
      "ScheduleWakeup",
      "AskUserQuestion",
    ]);
    // The tools bots do use stay available.
    for (const kept of ["Agent", "PowerShell", "ListAgents", "Read", "Bash"]) {
      expect(PERSONAL_BOT_DISALLOWED_TOOLS).not.toContain(kept);
    }
  });

  it("passes the list, and nothing, per the kill switch", () => {
    expect(personalBotDisallowedTools({})).toEqual([...PERSONAL_BOT_DISALLOWED_TOOLS]);
    expect(personalBotToolTrimEnabled({})).toBe(true);
    for (const value of ["off", "0", "false", "no", "disabled"]) {
      expect(personalBotDisallowedTools({ PERSONAL_BOT_TOOL_TRIM: value })).toBeUndefined();
    }
    expect(personalBotDisallowedTools({ T3CODE_PERSONAL_BOT_TOOL_TRIM: "off" })).toBeUndefined();
    expect(personalBotDisallowedTools({ PERSONAL_BOT_TOOL_TRIM: "on" })).toHaveLength(4);
  });

  it("trims the bundled skill list without hiding a skill a bot uses", () => {
    const overrides = personalBotSkillOverrides({});
    expect(overrides).toBeDefined();
    expect(Object.keys(overrides ?? {}).sort()).toEqual([...PERSONAL_BOT_HIDDEN_SKILLS].sort());
    expect(PERSONAL_BOT_HIDDEN_SKILLS).toContain("code-review");
    expect(PERSONAL_BOT_HIDDEN_SKILLS).toContain("schedule");
    // 1.66.63: the three a bot's session still advertised after the 1.66.62 trim
    // (QA counted 7 skills where 4 were promised). /run and /security-review
    // still expand as slash commands.
    for (const later of ["workflow-authoring", "run", "security-review"]) {
      expect(PERSONAL_BOT_HIDDEN_SKILLS).toContain(later);
    }
    // user-invocable-only keeps /name working, so nothing breaks hard.
    expect(new Set(Object.values(overrides ?? {}))).toEqual(new Set(["user-invocable-only"]));
    // hbots' own shared skill and the skills bots do use stay listed.
    for (const kept of ["speedoptimiser", "dataviz", "claude-api"]) {
      expect(Object.keys(overrides ?? {})).not.toContain(kept);
    }
    expect(personalBotSkillOverrides({ PERSONAL_BOT_SKILL_TRIM: "off" })).toBeUndefined();
    expect(personalBotSkillOverrides({ T3CODE_PERSONAL_BOT_SKILL_TRIM: "0" })).toBeUndefined();
  });
});

describe("personalContextBudget: whole-file Read guard", () => {
  const bigRead = {
    toolName: "Read",
    toolInput: { file_path: "C:/Claude/AI/dev-team/HANDBOOK.md" },
  };

  it("refuses a whole-file read of a long text file and keeps a ranged read", () => {
    const message = largeFileReadRefusal({ ...bigRead, sizeChars: 54_000 });
    expect(message).toBeDefined();
    expect(message).toContain("54,000 chars");
    expect(message).toContain("grep first");
    expect(message).toContain("offset/limit");
    expect(message).toContain(LARGE_FILE_READ_ESCAPE_PROPERTY);
    expect(
      largeFileReadRefusal({ ...bigRead, sizeChars: LARGE_FILE_READ_MAX_CHARS }),
    ).toBeUndefined();
    expect(
      largeFileReadRefusal({
        toolName: "Read",
        toolInput: { file_path: "C:/x.md", offset: 1 },
        sizeChars: 54_000,
      }),
    ).toBeUndefined();
    expect(
      largeFileReadRefusal({
        toolName: "Read",
        toolInput: { file_path: "C:/x.md", limit: 100 },
        sizeChars: 54_000,
      }),
    ).toBeUndefined();
    expect(
      largeFileReadRefusal({
        toolName: "Read",
        toolInput: { file_path: "C:/x.md", [LARGE_FILE_READ_ESCAPE_PROPERTY]: true },
        sizeChars: 54_000,
      }),
    ).toBeUndefined();
  });

  it("exempts images, PDFs and notebooks, and every other tool", () => {
    for (const file of ["a.png", "a.JPG", "a.pdf", "a.ipynb", "shot.webp"]) {
      expect(
        largeFileReadRefusal({
          toolName: "Read",
          toolInput: { file_path: `C:/x/${file}` },
          sizeChars: 90_000,
        }),
      ).toBeUndefined();
    }
    expect(
      largeFileReadRefusal({ toolName: "Grep", toolInput: { pattern: "x" }, sizeChars: 90_000 }),
    ).toBeUndefined();
    expect(
      largeFileReadRefusal({ toolName: "Read", toolInput: {}, sizeChars: 90_000 }),
    ).toBeUndefined();
  });

  it("sizes the file without reading it, and reads only when the bytes leave it open", () => {
    let reads = 0;
    const readText = () => {
      reads += 1;
      return longText(54_000);
    };
    // 12,000 bytes can never be more than 12,000 chars.
    expect(
      largeFileReadRefusalForSize({ ...bigRead, statBytes: 12_000, readText, env: {} }),
    ).toBeUndefined();
    expect(reads).toBe(0);
    expect(
      largeFileReadRefusalForSize({ ...bigRead, statBytes: 30_000, readText, env: {} }),
    ).toContain("54,000 chars");
    expect(reads).toBe(1);
    // 54,000 bytes of multi-byte text can decode to fewer than 20,000 chars.
    expect(
      largeFileReadRefusalForSize({
        ...bigRead,
        statBytes: 30_000,
        readText: () => longText(19_000),
        env: {},
      }),
    ).toBeUndefined();
    // A file too large to read to count is refused on its byte size.
    expect(
      largeFileReadRefusalForSize({
        ...bigRead,
        statBytes: 20_000_000,
        readText: () => {
          throw new Error("must not read a 20 MB file");
        },
        env: {},
      }),
    ).toContain("20,000,000 bytes");
    // An unsized file is left to the Read tool.
    expect(
      largeFileReadRefusalForSize({ ...bigRead, statBytes: undefined, env: {} }),
    ).toBeUndefined();
  });

  it("has an env kill switch", () => {
    expect(largeFileReadGuardEnabled({})).toBe(true);
    for (const value of ["off", "0", "false", "no", "disabled"]) {
      expect(largeFileReadGuardEnabled({ PERSONAL_READ_LARGE_GUARD: value })).toBe(false);
      expect(
        largeFileReadRefusalForSize({
          ...bigRead,
          statBytes: 54_000,
          env: { PERSONAL_READ_LARGE_GUARD: value },
        }),
      ).toBeUndefined();
    }
    expect(
      largeFileReadRefusalForSize({
        ...bigRead,
        statBytes: 54_000,
        env: { T3CODE_PERSONAL_READ_LARGE_GUARD: "off" },
      }),
    ).toBeUndefined();
  });
});

describe("personalContextBudget: search_memory result cap", () => {
  const entry = (index: number) => ({
    memoryId: `id-${index}`,
    kind: "preference",
    content: longText(400),
  });

  it("keeps the best matches first inside the cap and counts the rest", () => {
    const entries = Array.from({ length: 40 }, (_, index) => entry(index));
    const capped = capByJsonChars(entries, PERSONAL_MEMORY_SEARCH_MAX_CHARS);
    expect(capped.dropped).toBe(40 - capped.entries.length);
    expect(capped.dropped).toBeGreaterThan(0);
    expect(capped.entries[0]).toEqual(entry(0));
    expect(JSON.stringify(capped.entries).length).toBeLessThanOrEqual(
      PERSONAL_MEMORY_SEARCH_MAX_CHARS,
    );
    expect(JSON.stringify(capped.entries).length).toBeGreaterThan(
      PERSONAL_MEMORY_SEARCH_MAX_CHARS - 600,
    );
  });

  it("always returns the first match, and everything when the cap is off", () => {
    const huge = [{ content: longText(50_000) }, { content: longText(10) }];
    expect(capByJsonChars(huge, PERSONAL_MEMORY_SEARCH_MAX_CHARS)).toEqual({
      entries: [huge[0]],
      dropped: 1,
    });
    expect(capByJsonChars(huge, 0)).toEqual({ entries: huge, dropped: 0 });
    expect(capByJsonChars([], PERSONAL_MEMORY_SEARCH_MAX_CHARS)).toEqual({
      entries: [],
      dropped: 0,
    });
  });

  it("reads its kill switch from the environment", () => {
    expect(memorySearchMaxChars({})).toBe(PERSONAL_MEMORY_SEARCH_MAX_CHARS);
    expect(memorySearchMaxChars({ PERSONAL_MEMORY_SEARCH_MAX_CHARS: "9000" })).toBe(9000);
    expect(memorySearchMaxChars({ T3CODE_PERSONAL_MEMORY_SEARCH_MAX_CHARS: "off" })).toBe(0);
    expect(memorySearchMaxChars({ PERSONAL_MEMORY_SEARCH_MAX_CHARS: "nonsense" })).toBe(
      PERSONAL_MEMORY_SEARCH_MAX_CHARS,
    );
    expect(memorySearchMaxChars({ PERSONAL_MEMORY_SEARCH_MAX_CHARS: "0" })).toBe(0);
  });
});

describe("personalContextBudget: memory block limits", () => {
  it("carries the 1.66.62 values", () => {
    expect(BLOCK_ENTRY_MAX_CHARS).toBe(300);
    expect(PERSONAL_MEMORY_RESEND_EVERY_TURNS).toBe(20);
    expect(PERSONAL_MEMORY_SEARCH_MAX_CHARS).toBe(6_000);
  });
});
