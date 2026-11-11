import { describe, expect, it } from "vite-plus/test";

type Service = { $: Record<string, string>; "intent-filter"?: Array<Record<string, any>> };
type Meta = { $: Record<string, string> };
type Manifest = {
  manifest: {
    application: Array<{ $: Record<string, string>; service?: Service[]; "meta-data"?: Meta[] }>;
  };
};

const plugin = require("../../plugins/withFirebase.cjs") as {
  (config: Record<string, any>): Record<string, any>;
  configureFirebase: (
    config: Record<string, any>,
    options: { env: Record<string, string | undefined>; fileSystem: FakeFs },
  ) => Record<string, any>;
  resolveFirebase: (
    env: Record<string, string | undefined>,
    packageName: string | undefined,
    fileSystem: FakeFs,
  ) => { configured: boolean; reason?: string; source?: string };
  applyFirebaseManifest: (manifest: Manifest, configured: boolean) => Manifest;
  applyProjectGradle: (contents: string, configured: boolean) => string;
  applyAppGradle: (contents: string, configured: boolean) => string;
  ENV_NAME: string;
  SERVICE_NAME: string;
  META_NAME: string;
};

interface FakeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}

const PACKAGE = "com.haroutb5.hbots";
const PATH = "/outside/the/repo/google-services.json";

function fakeFs(files: Record<string, string>): FakeFs {
  return {
    existsSync: (path) => path in files,
    readFileSync: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

// A made-up file for this test only. It has no real project id, key or app id.
function madeUp(packageName = PACKAGE): string {
  return JSON.stringify({
    project_info: { project_id: "made-up-test-project", project_number: "0" },
    client: [{ client_info: { android_client_info: { package_name: packageName } } }],
  });
}

function manifest(): Manifest {
  return {
    manifest: {
      application: [{ $: { "android:name": ".MainApplication" }, service: [], "meta-data": [] }],
    },
  };
}

const ROOT_GRADLE = `buildscript {
  repositories {
    google()
  }
  dependencies {
    classpath('com.android.tools.build:gradle')
  }
}
`;

describe("resolveFirebase", () => {
  it("is unconfigured when the variable is unset or blank", () => {
    expect(plugin.resolveFirebase({}, PACKAGE, fakeFs({}))).toEqual({
      configured: false,
      reason: "unset",
    });
    expect(plugin.resolveFirebase({ [plugin.ENV_NAME]: "  " }, PACKAGE, fakeFs({})).reason).toBe(
      "unset",
    );
  });

  it("is unconfigured, not an error, when the path points at nothing", () => {
    const result = plugin.resolveFirebase({ [plugin.ENV_NAME]: PATH }, PACKAGE, fakeFs({}));
    expect(result.configured).toBe(false);
    expect(result.reason).toBe("missing");
  });

  it("is configured for a usable file with a client for this app id", () => {
    const result = plugin.resolveFirebase(
      { [plugin.ENV_NAME]: PATH },
      PACKAGE,
      fakeFs({ [PATH]: madeUp() }),
    );
    expect(result).toEqual({ configured: true, source: PATH });
  });

  it("fails loudly for a file that is not JSON, has no client, or is for another app", () => {
    const env = { [plugin.ENV_NAME]: PATH };
    expect(() => plugin.resolveFirebase(env, PACKAGE, fakeFs({ [PATH]: "nope" }))).toThrow(
      /not valid JSON/,
    );
    expect(() => plugin.resolveFirebase(env, PACKAGE, fakeFs({ [PATH]: "{}" }))).toThrow(
      /does not look like/,
    );
    expect(() =>
      plugin.resolveFirebase(env, PACKAGE, fakeFs({ [PATH]: madeUp("com.other.app") })),
    ).toThrow(/no client for the app id com\.haroutb5\.hbots/);
  });
});

describe("the manifest", () => {
  it("declares the messaging service with the Firebase action when configured", () => {
    const application = plugin.applyFirebaseManifest(manifest(), true).manifest.application[0]!;
    const service = application.service!.find((s) => s.$["android:name"] === plugin.SERVICE_NAME);
    expect(service?.$["android:exported"]).toBe("false");
    expect(service?.["intent-filter"]?.[0]?.action[0].$["android:name"]).toBe(
      "com.google.firebase.MESSAGING_EVENT",
    );
    expect(
      application["meta-data"]!.find((m) => m.$["android:name"] === plugin.META_NAME)?.$,
    ).toMatchObject({
      "android:value": "true",
    });
  });

  it("declares no service and records false when unconfigured", () => {
    const application = plugin.applyFirebaseManifest(manifest(), false).manifest.application[0]!;
    expect(application.service).toEqual([]);
    expect(
      application["meta-data"]!.find((m) => m.$["android:name"] === plugin.META_NAME)?.$,
    ).toMatchObject({
      "android:value": "false",
    });
  });

  it("is idempotent, and removes the service when a later prebuild is unconfigured", () => {
    const on = plugin.applyFirebaseManifest(plugin.applyFirebaseManifest(manifest(), true), true);
    expect(on.manifest.application[0]!.service).toHaveLength(1);
    expect(on.manifest.application[0]!["meta-data"]).toHaveLength(1);
    const off = plugin.applyFirebaseManifest(on, false);
    expect(off.manifest.application[0]!.service).toEqual([]);
    expect(off.manifest.application[0]!["meta-data"]).toHaveLength(1);
  });
});

describe("the Gradle files", () => {
  it("adds the google-services classpath once, inside buildscript dependencies", () => {
    const once = plugin.applyProjectGradle(ROOT_GRADLE, true);
    const twice = plugin.applyProjectGradle(once, true);
    expect(twice).toBe(once);
    expect(once).toContain("classpath('com.google.gms:google-services:4.4.4')");
    expect(once.indexOf("google-services")).toBeGreaterThan(once.indexOf("dependencies {"));
  });

  it("leaves the root file untouched when unconfigured, and strips an earlier addition", () => {
    expect(plugin.applyProjectGradle(ROOT_GRADLE, false)).toBe(ROOT_GRADLE);
    const on = plugin.applyProjectGradle(ROOT_GRADLE, true);
    expect(plugin.applyProjectGradle(on, false)).toBe(ROOT_GRADLE);
  });

  it("refuses a root file it cannot place the classpath in", () => {
    expect(() => plugin.applyProjectGradle("plugins {}", true)).toThrow(/buildscript/);
  });

  it("applies the plugin once at the end of the app file, and removes it", () => {
    const app = "android {\n}\n";
    const on = plugin.applyAppGradle(app, true);
    expect(on.trimEnd().endsWith('apply plugin: "com.google.gms.google-services"')).toBe(true);
    expect(plugin.applyAppGradle(on, true)).toBe(on);
    expect(plugin.applyAppGradle(on, false).trim()).toBe(app.trim());
  });

  it("adds nothing when unconfigured", () => {
    expect(plugin.applyAppGradle("android {\n}\n", false)).toBe("android {\n}\n");
  });
});

describe("the config plugin", () => {
  const base = { name: "hbots", slug: "hbots", android: { package: PACKAGE } };
  const modsOf = (config: Record<string, any>) => Object.keys(config.mods?.android ?? {}).sort();

  it("registers the manifest, both Gradle files and the file copy when configured", () => {
    const config = plugin.configureFirebase(
      { ...base },
      { env: { [plugin.ENV_NAME]: PATH }, fileSystem: fakeFs({ [PATH]: madeUp() }) },
    );
    expect(modsOf(config)).toEqual([
      "appBuildGradle",
      "dangerous",
      "manifest",
      "projectBuildGradle",
    ]);
  });

  it("registers the same mods when unconfigured, so a stale copy is cleaned up", () => {
    const config = plugin.configureFirebase({ ...base }, { env: {}, fileSystem: fakeFs({}) });
    expect(modsOf(config)).toEqual([
      "appBuildGradle",
      "dangerous",
      "manifest",
      "projectBuildGradle",
    ]);
  });

  it("throws at prebuild for an unusable file", () => {
    expect(() =>
      plugin.configureFirebase(
        { ...base },
        { env: { [plugin.ENV_NAME]: PATH }, fileSystem: fakeFs({ [PATH]: "{}" }) },
      ),
    ).toThrow();
  });
});
