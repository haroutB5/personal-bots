import * as NodeCrypto from "node:crypto";

/**
 * The scaffold `create_app` starts from, pinned by content.
 *
 * "Pinned known-good" has to mean something a test can check, so the template
 * is a literal file set here and its SHA-256 is asserted against a constant.
 * Editing the scaffold changes the digest, the digest is in the plan, and the
 * plan digest is what the owner's approval binds to — so a changed template
 * cannot ride along on a decision taken about the old one.
 *
 * Deliberately static HTML with no build step. A scaffold that has to compile
 * before it can be checked cannot be validated locally without running a
 * package manager, and a run that only finds out at deploy time whether its
 * own starting point is sound is not much of a starting point.
 */

export interface AppTemplateFile {
  readonly path: string;
  readonly contents: string;
}

export interface AppTemplate {
  readonly revision: string;
  readonly digest: string;
  /** Null: nothing to build, so no framework preset is claimed at the host. */
  readonly framework: string | null;
  readonly files: ReadonlyArray<AppTemplateFile>;
  /**
   * Non-secret build configuration the template needs, pinned with it. Secret
   * values never appear here; a data-store step supplies those at run time and
   * they reach the vendor without becoming text anywhere.
   */
  readonly environment: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly healthCheck: { readonly path: string; readonly marker: string };
}

/** What "the app answered" means: a string only this scaffold serves. */
const HEALTH_MARKER = "hbots-app-ok";

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{APP_NAME}}</title>
  </head>
  <body>
    <main>
      <h1>{{APP_NAME}}</h1>
      <p>This app was created by hbots and is live.</p>
    </main>
    <!-- Health marker. The create_app health check looks for exactly this, so a
         provider holding page or a 200 from an unrelated route does not count
         as the app having answered. -->
    <span data-health="${HEALTH_MARKER}" hidden>${HEALTH_MARKER}</span>
  </body>
</html>
`;

const PACKAGE_JSON = `{
  "name": "{{APP_NAME}}",
  "private": true,
  "version": "0.0.0"
}
`;

const VERCEL_JSON = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": null,
  "outputDirectory": "."
}
`;

const README = `# {{APP_NAME}}

Created by hbots from the pinned \`hbots/static-app\` template.

Every file here is static. Change \`index.html\` and push; the host redeploys.
`;

/** Placeholders the scaffold declares. Anything else in braces is left alone. */
const substitutions = (input: { readonly appName: string }): Readonly<Record<string, string>> => ({
  APP_NAME: input.appName,
});

const TEMPLATE_FILES: ReadonlyArray<AppTemplateFile> = [
  { path: "index.html", contents: INDEX_HTML },
  { path: "package.json", contents: PACKAGE_JSON },
  { path: "vercel.json", contents: VERCEL_JSON },
  { path: "README.md", contents: README },
];

/**
 * Content identity of a template. Sorted by path first, because the order a
 * file list happens to be written in is not part of what the scaffold is.
 */
export const templateDigest = (files: ReadonlyArray<AppTemplateFile>): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [...files].toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.contents);
    hash.update("\u0000");
  }
  return hash.digest("hex");
};

/**
 * The reviewed digest, written out rather than computed, so that changing the
 * scaffold fails a test instead of quietly redefining what "pinned" means.
 */
export const PINNED_TEMPLATE_DIGEST =
  "b7ae652a4010a6ebad0ce24656a11ccc954e4ed27d8e3fcbd0d4a225ff4e4d6a";

export const STATIC_APP_TEMPLATE: AppTemplate = {
  revision: "hbots/static-app@2026-09-21",
  digest: templateDigest(TEMPLATE_FILES),
  framework: null,
  files: TEMPLATE_FILES,
  environment: [{ key: "APP_ENVIRONMENT_LABEL", value: "hbots" }],
  healthCheck: { path: "/", marker: HEALTH_MARKER },
};

export const materializeTemplate = (
  template: AppTemplate,
  input: { readonly appName: string },
): ReadonlyArray<AppTemplateFile> => {
  const values = substitutions(input);
  return template.files.map((file) => ({
    path: file.path,
    contents: Object.entries(values).reduce(
      (contents, [name, value]) => contents.split(`{{${name}}}`).join(value),
      file.contents,
    ),
  }));
};

const REQUIRED_FILES = ["index.html", "package.json", "vercel.json"];
/** A scaffold is a handful of small text files; anything larger is not one. */
const MAX_TOTAL_BYTES = 256 * 1024;

/**
 * Everything that can be known about a scaffold without leaving this process.
 * Returns every problem rather than the first, so a broken template is fixed
 * in one pass instead of one push at a time.
 */
export const validateTemplateFiles = (
  files: ReadonlyArray<AppTemplateFile>,
  marker: string,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  let bytes = 0;

  for (const file of files) {
    if (seen.has(file.path)) problems.push(`${file.path} is listed twice.`);
    seen.add(file.path);
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").includes("..") ||
      file.path.trim().length === 0
    ) {
      problems.push(`${file.path} is not a path inside the repository.`);
    }
    bytes += Buffer.byteLength(file.contents, "utf8");
    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(file.contents);
      } catch {
        problems.push(`${file.path} is not valid JSON.`);
      }
    }
  }

  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) problems.push(`${required} is missing from the scaffold.`);
  }
  if (bytes > MAX_TOTAL_BYTES) {
    problems.push(`The scaffold is ${bytes} bytes, over the ${MAX_TOTAL_BYTES} byte limit.`);
  }

  const index = files.find((file) => file.path === "index.html");
  if (index !== undefined && !index.contents.includes(marker)) {
    // Without it the health check can never distinguish this app from whatever
    // else the host might answer with.
    problems.push(`index.html does not carry the health marker ${marker}.`);
  }

  return problems;
};
