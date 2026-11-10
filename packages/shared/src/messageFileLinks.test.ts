import { describe, expect, it } from "vite-plus/test";

import { linkTarget, messageFileLinkPaths, pathLike } from "./messageFileLinks.ts";

describe("messageFileLinkPaths", () => {
  it("reads a markdown link to an absolute path", () => {
    expect([
      ...messageFileLinkPaths("The report is [here](/home/harout/qa/REPORT.md) now."),
    ]).toEqual(["/home/harout/qa/REPORT.md"]);
  });

  it("reads a workspace-relative and a tilde path", () => {
    expect([...messageFileLinkPaths("[plan](docs/plan.md) and [notes](~/notes/a.md)")]).toEqual([
      "docs/plan.md",
      "~/notes/a.md",
    ]);
  });

  it("reads a file URL as the renderer resolves it", () => {
    expect([...messageFileLinkPaths("[log](file:///home/harout/logs/a.log)")]).toEqual([
      "/home/harout/logs/a.log",
    ]);
    expect([...messageFileLinkPaths("[shot](file:///C:/work/shot.png)")]).toEqual([
      "C:/work/shot.png",
    ]);
    expect([...messageFileLinkPaths("[space](file:///tmp/a%20b.md)")]).toEqual(["/tmp/a b.md"]);
  });

  it("reads a Windows path written directly", () => {
    expect([...messageFileLinkPaths("[win](C:\\work\\a.ts)")]).toEqual(["C:\\work\\a.ts"]);
    expect([...messageFileLinkPaths("`C:/work/b.md`")]).toEqual(["C:/work/b.md"]);
  });

  it("reads a path in an inline code span, trimmed as the chip shows it", () => {
    expect([...messageFileLinkPaths("See `/home/harout/run/result.json`.")]).toEqual([
      "/home/harout/run/result.json",
    ]);
    expect([...messageFileLinkPaths("See ` ~/notes/a.md `.")]).toEqual(["~/notes/a.md"]);
  });

  it("ignores plain prose, external links and blocked schemes", () => {
    expect([...messageFileLinkPaths("The file at /home/harout/x.md is plain text.")]).toEqual([]);
    expect([...messageFileLinkPaths("[web](https://example.com/a/b)")]).toEqual([]);
    expect([...messageFileLinkPaths("[call](tel:5551234)")]).toEqual([]);
    expect([...messageFileLinkPaths("Run `vp test` and `/`.")]).toEqual([]);
  });

  it("finds a link nested in emphasis, as the renderer does", () => {
    expect([...messageFileLinkPaths("**Evidence: `/home/harout/run/result.json`**")]).toEqual([
      "/home/harout/run/result.json",
    ]);
    expect([...messageFileLinkPaths("*See [the plan](docs/plan.md) now*")]).toEqual([
      "docs/plan.md",
    ]);
  });

  it("keeps a path with an intraword underscore", () => {
    expect([...messageFileLinkPaths("[file](docs/ready_for_review.md)")]).toEqual([
      "docs/ready_for_review.md",
    ]);
  });

  it("returns both paths when a message links two files", () => {
    expect([
      ...messageFileLinkPaths("Text in [a.md](docs/a.md), image in [b.png](docs/b.png)."),
    ]).toEqual(["docs/a.md", "docs/b.png"]);
  });

  it("does not throw on a malformed file URL escape", () => {
    expect([...messageFileLinkPaths("[bad](file:///tmp/100%.md)")]).toEqual([]);
  });
});

describe("pathLike", () => {
  it("accepts a path with a separator and rejects prose", () => {
    expect(pathLike("/home/harout/a.md")).toBe(true);
    expect(pathLike("~/a.md")).toBe(true);
    expect(pathLike("vp test")).toBe(false);
    expect(pathLike("https://example.com/a")).toBe(false);
    expect(pathLike("/")).toBe(false);
  });
});

describe("linkTarget", () => {
  it("sends only http and https links outside the app", () => {
    expect(linkTarget("https://example.com/a")).toEqual({
      kind: "external",
      url: "https://example.com/a",
    });
    expect(linkTarget("mailto:a@b.c")).toEqual({ kind: "blocked" });
    expect(linkTarget("javascript:alert(1)")).toEqual({ kind: "blocked" });
  });

  it("opens workspace, absolute, Windows and tilde paths in the file sheet", () => {
    expect(linkTarget("docs/a.md")).toEqual({ kind: "file", path: "docs/a.md" });
    expect(linkTarget("C:/work/a.ts")).toEqual({ kind: "file", path: "C:/work/a.ts" });
    expect(linkTarget("~/notes/a.md")).toEqual({ kind: "file", path: "~/notes/a.md" });
  });
});
