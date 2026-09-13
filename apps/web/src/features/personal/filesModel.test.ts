import { PersonalBot, PersonalFile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  formatFileSize,
  groupFilesByBot,
  TEXT_PREVIEW_MAX_BYTES,
} from "./filesModel";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeFile = Schema.decodeUnknownSync(PersonalFile);

function bot(botId: string, name: string, sortOrder: number) {
  return decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: "codex", model: "some-model" },
    enabled: true,
    sortOrder,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

function file(
  fileId: string,
  botId: string,
  name: string,
  createdAt: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return decodeFile({
    fileId,
    name,
    mimeType: "text/plain",
    sizeBytes: 100,
    botId,
    threadId: `thread-${botId}`,
    createdAt,
    url: `/api/assets/token-${fileId}/${name}`,
    previewUrl: null,
    expiresAt: 0,
    ...overrides,
  });
}

describe("filePreviewKind", () => {
  const kindOf = (name: string, mimeType: string, extra: Partial<Record<string, unknown>> = {}) =>
    filePreviewKind(file("f", "b", name, "2026-09-13T10:00:00.000Z", { mimeType, ...extra }));

  it("previews raster images, but downloads SVG", () => {
    expect(kindOf("photo.png", "image/png")).toBe("image");
    expect(kindOf("logo.svg", "image/svg+xml")).toBe("download");
  });

  it("opens PDFs only when the server minted an inline URL", () => {
    expect(
      kindOf("report.pdf", "application/pdf", { previewUrl: "/api/assets/t/report.pdf" }),
    ).toBe("pdf");
    expect(kindOf("report.pdf", "application/pdf")).toBe("download");
  });

  it("recognises markdown and text by mime or extension, within the size limit", () => {
    expect(kindOf("notes.md", "application/octet-stream")).toBe("markdown");
    expect(kindOf("notes", "text/markdown")).toBe("markdown");
    expect(kindOf("data.json", "application/json")).toBe("text");
    expect(kindOf("script.py", "application/octet-stream")).toBe("text");
    expect(kindOf("page.html", "text/html")).toBe("text");
    expect(kindOf("huge.log", "text/plain", { sizeBytes: TEXT_PREVIEW_MAX_BYTES + 1 })).toBe(
      "download",
    );
  });

  it("downloads everything else", () => {
    expect(kindOf("archive.zip", "application/zip")).toBe("download");
    expect(kindOf("sheet.xlsx", "application/vnd.ms-excel")).toBe("download");
  });
});

describe("formatFileSize", () => {
  it("uses 1024-based units with one decimal under ten", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(23 * 1024)).toBe("23 KB");
    expect(formatFileSize(4.2 * 1024 * 1024)).toBe("4.2 MB");
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });
});

describe("groupFilesByBot", () => {
  const assistant = bot("assistant", "Assistant", 0);
  const developer = bot("developer", "Developer", 1);
  const files = [
    file("a1", "assistant", "Trip plan.md", "2026-09-12T10:00:00.000Z"),
    file("d1", "developer", "diff.patch", "2026-09-13T09:00:00.000Z"),
    file("a2", "assistant", "receipt.png", "2026-09-13T08:00:00.000Z"),
    file("x1", "deleted-bot", "orphan.txt", "2026-09-13T11:00:00.000Z"),
  ];

  it("groups in bot order, newest file first, and drops files without a live bot", () => {
    const groups = groupFilesByBot({ files, bots: [developer, assistant], query: "" });
    expect(
      groups.map((group) => [group.bot.name, group.files.map((entry) => entry.fileId)]),
    ).toEqual([
      ["Assistant", ["a2", "a1"]],
      ["Developer", ["d1"]],
    ]);
  });

  it("filters by file name case-insensitively and drops emptied groups", () => {
    const groups = groupFilesByBot({ files, bots: [assistant, developer], query: "  TRIP " });
    expect(
      groups.map((group) => [group.bot.name, group.files.map((entry) => entry.fileId)]),
    ).toEqual([["Assistant", ["a1"]]]);
    expect(groupFilesByBot({ files, bots: [assistant, developer], query: "nothing" })).toEqual([]);
  });
});
