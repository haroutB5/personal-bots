import { describe, expect, it, vi } from "vite-plus/test";

import { openFileThroughChatPreview } from "./ChatMarkdown";

describe("openFileThroughChatPreview", () => {
  const request = {
    path: "C:/Claude/AI/reports/REPORT.md",
    line: 12,
    label: "REPORT.md · L12",
  };

  it("passes the resolved path, line and chip label to the host shell", () => {
    const opener = vi.fn(() => true);
    expect(openFileThroughChatPreview(opener, request)).toBe(true);
    expect(opener).toHaveBeenCalledWith(request);
  });

  it("declines when the shell declines or there is no shell", () => {
    expect(openFileThroughChatPreview(() => false, request)).toBe(false);
    expect(openFileThroughChatPreview(undefined, request)).toBe(false);
  });
});
