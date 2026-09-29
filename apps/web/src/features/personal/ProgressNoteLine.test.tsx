import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProgressNoteLine } from "./ProgressNoteLine";

describe("ProgressNoteLine", () => {
  it("renders nothing without a note, so an idle chat is unchanged", () => {
    expect(renderToStaticMarkup(<ProgressNoteLine note={null} />)).toBe("");
  });

  it("renders one muted, truncating line and no live region", () => {
    const html = renderToStaticMarkup(<ProgressNoteLine note="Reading the failing test" />);
    expect(html).toContain('data-testid="progress-note"');
    expect(html).toContain("Reading the failing test");
    expect(html).toContain("truncate");
    expect(html).toContain("--personal-text-tertiary");
    expect(html).not.toContain("aria-live");
  });
});
