import { assert, describe, it } from "@effect/vitest";

import {
  PINNED_TEMPLATE_DIGEST,
  STATIC_APP_TEMPLATE,
  materializeTemplate,
  templateDigest,
  validateTemplateFiles,
} from "./template.ts";

describe("create_app template", () => {
  it("is pinned: its contents hash to the revision this build was reviewed with", () => {
    // The point of a pinned template is that nobody edits the scaffold without
    // the plan's template digest changing, which re-approves every run.
    assert.equal(templateDigest(STATIC_APP_TEMPLATE.files), PINNED_TEMPLATE_DIGEST);
    assert.equal(STATIC_APP_TEMPLATE.digest, PINNED_TEMPLATE_DIGEST);
  });

  it("changes its digest when a single byte of one file changes", () => {
    const tampered = STATIC_APP_TEMPLATE.files.map((file, index) =>
      index === 0 ? { ...file, contents: `${file.contents} ` } : file,
    );
    assert.notEqual(templateDigest(tampered), PINNED_TEMPLATE_DIGEST);
  });

  it("does not depend on the order files happen to be listed in", () => {
    assert.equal(templateDigest([...STATIC_APP_TEMPLATE.files].reverse()), PINNED_TEMPLATE_DIGEST);
  });

  it("validates locally, with no network and no provider", () => {
    const problems = validateTemplateFiles(
      materializeTemplate(STATIC_APP_TEMPLATE, { appName: "my-app" }),
      STATIC_APP_TEMPLATE.healthCheck.marker,
    );
    assert.deepEqual(problems, []);
  });

  it("carries the health marker into the file the health check will read", () => {
    const files = materializeTemplate(STATIC_APP_TEMPLATE, { appName: "my-app" });
    const index = files.find((file) => file.path === "index.html");
    assert.ok(index !== undefined);
    assert.ok(index.contents.includes(STATIC_APP_TEMPLATE.healthCheck.marker));
    // A deploy that answers with a provider holding page would not contain it.
    assert.ok(index.contents.includes("my-app"));
  });

  it("refuses a file whose path escapes the repository root", () => {
    const problems = validateTemplateFiles(
      [
        { path: "../outside.txt", contents: "x" },
        { path: "index.html", contents: "marker" },
      ],
      "marker",
    );
    assert.ok(problems.some((problem) => problem.includes("../outside.txt")));
  });

  it("refuses an absolute path, a backslash path and a duplicate", () => {
    const problems = validateTemplateFiles(
      [
        { path: "/etc/passwd", contents: "x" },
        { path: "src\\app.ts", contents: "x" },
        { path: "index.html", contents: "marker" },
        { path: "index.html", contents: "marker" },
      ],
      "marker",
    );
    assert.ok(problems.some((problem) => problem.includes("/etc/passwd")));
    assert.ok(problems.some((problem) => problem.includes("src\\app.ts")));
    assert.ok(problems.some((problem) => problem.includes("listed twice")));
  });

  it("refuses JSON that does not parse, before anything is pushed", () => {
    const problems = validateTemplateFiles(
      [
        { path: "package.json", contents: "{ not json" },
        { path: "index.html", contents: "marker" },
      ],
      "marker",
    );
    assert.ok(problems.some((problem) => problem.includes("package.json")));
  });

  it("refuses a scaffold the health check could never pass", () => {
    const problems = validateTemplateFiles(
      [{ path: "index.html", contents: "<html></html>" }],
      "marker",
    );
    assert.ok(problems.some((problem) => problem.includes("marker")));
  });

  it("substitutes only the placeholders it declares, leaving unknown braces alone", () => {
    const files = materializeTemplate(
      {
        ...STATIC_APP_TEMPLATE,
        files: [{ path: "index.html", contents: "{{APP_NAME}} and {{SOMETHING_ELSE}}" }],
      },
      { appName: "my-app" },
    );
    assert.equal(files[0]?.contents, "my-app and {{SOMETHING_ELSE}}");
  });
});
