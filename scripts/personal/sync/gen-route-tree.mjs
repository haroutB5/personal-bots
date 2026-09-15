// Regenerates apps/web/src/routeTree.gen.ts with the TanStack router generator
// the web build uses, without running the build. The weekly upstream sync takes
// our side of a conflicted routeTree.gen.ts and runs this after `vp i`.
// Usage (repo root): node scripts/personal/sync/gen-route-tree.mjs
import * as NodeFs from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

const webRoot = NodePath.resolve(import.meta.dirname, "..", "..", "..", "apps", "web");
// The generator is a dependency of the router plugin; resolve it from the
// plugin's real (pnpm store) location.
const pluginManifest = NodeFs.realpathSync(
  NodePath.join(webRoot, "node_modules", "@tanstack", "router-plugin", "package.json"),
);
const generatorEntry = createRequire(pluginManifest).resolve("@tanstack/router-generator");
const generator = await import(pathToFileURL(generatorEntry).href);
// Same options as tanstackRouter({ autoCodeSplitting: true }) in apps/web/vite.config.ts.
const config = generator.getConfig({ autoCodeSplitting: true }, webRoot);
await new generator.Generator({ config, root: webRoot }).run();
console.log(`generated ${NodePath.relative(process.cwd(), config.generatedRouteTree)}`);
