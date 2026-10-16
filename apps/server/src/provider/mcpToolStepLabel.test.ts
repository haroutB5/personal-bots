import { assert, describe, it } from "@effect/vitest";

import { humaniseMcpToolName, mcpToolStepLabel } from "./mcpToolStepLabel.ts";

describe("mcpToolStepLabel", () => {
  it("names the page a navigation is opening by hostname, never its path or query", () => {
    assert.equal(
      mcpToolStepLabel({
        tool: "mcp__t3-code__preview_navigate",
        arguments: { url: "https://www.clubspark.uk/booking/42?token=abc123#top" },
      }),
      "Opening clubspark.uk",
    );
    assert.equal(
      mcpToolStepLabel({
        server: "t3-code",
        tool: "preview_navigate",
        arguments: { target: { kind: "url", url: "http://127.0.0.1:5173/settings?tab=x" } },
      }),
      "Opening 127.0.0.1",
    );
    // A schemeless host with a port still yields only the host.
    assert.equal(
      mcpToolStepLabel({
        server: "t3-code",
        tool: "preview_navigate",
        arguments: { url: "example.com:8080/admin" },
      }),
      "Opening example.com",
    );
    // No URL, or one that is not a plain host: the plain line, still no value.
    assert.equal(
      mcpToolStepLabel({ server: "t3-code", tool: "preview_navigate", arguments: {} }),
      "Opening a page in the browser",
    );
    assert.equal(
      mcpToolStepLabel({
        server: "t3-code",
        tool: "preview_navigate",
        arguments: { url: "javascript:alert(1)" },
      }),
      "Opening a page in the browser",
    );
  });

  it("never lets a path, query, port or secret survive into the label", () => {
    const label = mcpToolStepLabel({
      tool: "mcp__t3-code__preview_open",
      arguments: {
        url: "https://user:hunter2@example.com:8443/private/report.pdf?key=sk-live-SECRETSECRETSECRET",
      },
    });
    assert.equal(label, "Opening example.com");
    for (const leaked of ["hunter2", "8443", "private", "report.pdf", "key=", "SECRET"]) {
      assert.ok(!(label ?? "").includes(leaked), `label leaked ${leaked}`);
    }
  });

  it("writes hbots' own tools in plain words", () => {
    assert.equal(mcpToolStepLabel({ server: "t3-code", tool: "search_web" }), "Searching the web");
    assert.equal(
      mcpToolStepLabel({
        server: "t3-code",
        tool: "delegate_task",
        arguments: { targetBot: "QA" },
      }),
      "Handing work to QA",
    );
    assert.equal(
      mcpToolStepLabel({ server: "t3-code", tool: "delegate_task" }),
      "Handing work to another bot",
    );
    assert.equal(mcpToolStepLabel({ server: "t3-code", tool: "save_memory" }), "Saving a note");
    assert.equal(
      mcpToolStepLabel({ server: "t3-code", tool: "save_memory", arguments: { secret: "x" } }),
      "Saving a note",
    );
    assert.equal(
      mcpToolStepLabel({ server: "t3-code", tool: "preview_click" }),
      "Clicking on the page",
    );
    assert.equal(
      mcpToolStepLabel({ server: "t3-code", tool: "computer_screenshot" }),
      "Looking at your screen",
    );
    assert.equal(
      mcpToolStepLabel({ server: "t3-code", tool: "use_login" }),
      "Signing in to a site",
    );
  });

  it("humanises any other MCP tool's name, and does not borrow the t3-code table", () => {
    assert.equal(mcpToolStepLabel({ tool: "mcp__linear__create_issue" }), "Create issue");
    assert.equal(mcpToolStepLabel({ tool: "mcp__github__fetch_pr" }), "Fetch PR");
    // A foreign server's tool that shares a name with an hbots one stays its own.
    assert.equal(mcpToolStepLabel({ tool: "mcp__other__search_web" }), "Search web");
    assert.equal(mcpToolStepLabel({ server: "t3-code", tool: "brand_new_tool" }), "Brand new tool");
    assert.equal(humaniseMcpToolName("previewNavigate"), "Preview navigate");
    assert.equal(mcpToolStepLabel({ tool: "   " }), undefined);
  });
});
