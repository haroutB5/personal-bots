import { describe, expect, it } from "vite-plus/test";

import { duplicatePackages } from "./bundleDuplicates";

const PNPM = "/node_modules/.pnpm";

describe("duplicate package detection", () => {
  it("finds scheduler bundled from the app and from react-native", () => {
    const sources = [
      `${PNPM}/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.js`,
      `${PNPM}/scheduler@0.27.0/node_modules/scheduler/index.js`,
      `${PNPM}/react-native@0.86.3/node_modules/react-native/index.js`,
      `${PNPM}/scheduler@0.28.0/node_modules/scheduler/cjs/scheduler.js`,
    ];
    expect(duplicatePackages(sources)).toEqual([
      {
        name: "scheduler",
        roots: [
          { root: `${PNPM}/scheduler@0.27.0/node_modules/scheduler`, files: 2 },
          { root: `${PNPM}/scheduler@0.28.0/node_modules/scheduler`, files: 1 },
        ],
      },
    ]);
  });

  it("reads scoped package names and their own subpaths", () => {
    const sources = [
      `${PNPM}/@effect+atom-react@4.1.2_react@19.2.3/node_modules/@effect/atom-react/dist/RegistryContext.js`,
      `${PNPM}/@effect+atom-react@4.1.2_react@19.3.0/node_modules/@effect/atom-react/dist/RegistryContext.js`,
      `${PNPM}/@effect+atom-react@4.1.2_react@19.3.0/node_modules/@effect/atom-react/dist/index.js`,
    ];
    expect(duplicatePackages(sources).map((duplicate) => duplicate.name)).toEqual([
      "@effect/atom-react",
    ]);
  });

  it("keeps a nested dependency separate from a top-level copy", () => {
    const sources = [
      `${PNPM}/react-native@0.86.3/node_modules/react-native/index.js`,
      `${PNPM}/react-native@0.86.3/node_modules/react-native/node_modules/scheduler/index.js`,
      `${PNPM}/scheduler@0.28.0/node_modules/scheduler/index.js`,
    ];
    expect(duplicatePackages(sources).map((duplicate) => duplicate.name)).toEqual(["scheduler"]);
  });

  it("passes when every package resolves from one root", () => {
    const sources = [
      `${PNPM}/scheduler@0.27.0/node_modules/scheduler/index.js`,
      `${PNPM}/@effect+atom-react@4.1.2_react@19.2.3/node_modules/@effect/atom-react/dist/index.js`,
      "/node_modules/.pnpm/node_modules/react/cjs/react.js",
      "/apps/hbots-mobile/index.ts",
      "/apps/hbots-mobile/src/chat/Composer.tsx",
      "/packages/personal-client/src/react/command.ts",
      "__prelude__",
    ];
    expect(duplicatePackages(sources)).toEqual([]);
  });

  it("counts each workspace package once, whatever the file depth", () => {
    const sources = [
      "/packages/personal-client/src/react/command.ts",
      "/packages/personal-client/src/react/query.ts",
      "/apps/hbots-mobile/src/chat/Composer.tsx",
      "/apps/web/src/main.tsx",
    ];
    expect(duplicatePackages(sources)).toEqual([]);
  });
});
