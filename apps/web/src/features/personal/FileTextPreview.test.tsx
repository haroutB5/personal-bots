import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FileTextPreview } from "./FileTextPreview";

describe("FileTextPreview", () => {
  it("renders markdown, keeps the sanitised tree and drops images and raw HTML", () => {
    const html = renderToStaticMarkup(
      <FileTextPreview
        markdown
        text={[
          "# Report",
          "",
          "| item | value |",
          "| --- | --- |",
          "| tests | pass |",
          "",
          "![chart](https://example.com/chart.png)",
          "",
          '<script>alert("x")</script><b>bold</b>',
          "",
          "[link](https://example.com)",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>pass</td>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("chart.png");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("bold");
  });

  it("shows a text file as escaped preformatted source", () => {
    const html = renderToStaticMarkup(
      <FileTextPreview markdown={false} text={"line one\n<b>not html</b>\nconst x = 1;"} />,
    );

    expect(html).toContain("<pre");
    expect(html).toContain("line one\n&lt;b&gt;not html&lt;/b&gt;\nconst x = 1;");
    expect(html).not.toContain("<b>not html</b>");
  });
});
