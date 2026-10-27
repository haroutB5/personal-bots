import type { Plugin } from "vite-plus";

/**
 * Personal fork: the app boots as bootstrap.ts → import("./main") → router →
 * lazy route component, so on a cold launch the browser learns about each
 * level of scripts only after the previous level downloaded and ran. On slow
 * 3G that left the network idle for seconds between waves.
 *
 * This writes a small inline script into index.html that adds
 * `<link rel="modulepreload">` for main's static closure on every launch, and
 * for the route chunks of the page being opened (a chat deep link, a bot page,
 * or the Bots list). Hints only: nothing runs early, and a wrong guess costs
 * bytes, not behaviour. Kill switch: localStorage "bots:perf-off" includes
 * "route-preload".
 */
interface RoutePreload {
  /** Tested against location.pathname in the browser. */
  readonly path: RegExp;
  /** Route files whose split component chunks the page needs. */
  readonly routes: ReadonlyArray<string>;
}

const PERSONAL_LAYOUT = "_personal.tsx";

export const ROUTE_PRELOADS: ReadonlyArray<RoutePreload> = [
  {
    // /bots/$botId/$threadId, but not /bots/$botId/edit or the two-segment
    // groups, settings and teams pages.
    path: /^\/bots\/(?!groups\/|settings\/|teams\/)[^/]+\/(?!edit\/?$)[^/]+\/?$/,
    routes: [PERSONAL_LAYOUT, "_personal.bots_.$botId.$threadId.tsx"],
  },
  {
    path: /^\/bots\/?$/,
    routes: [PERSONAL_LAYOUT, "_personal.bots.tsx"],
  },
  {
    path: /^\/bots\/(?!new\/?$|team\/?$|settings\/?$)[^/]+\/?$/,
    routes: [PERSONAL_LAYOUT, "_personal.bots_.$botId.index.tsx"],
  },
];

interface ChunkLike {
  readonly type: "chunk";
  readonly fileName: string;
  readonly facadeModuleId: string | null;
  readonly imports: ReadonlyArray<string>;
}

type BundleLike = Record<string, ChunkLike | { readonly type: "asset" }>;

function staticClosure(bundle: BundleLike, roots: ReadonlyArray<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const fileName = stack.pop()!;
    if (seen.has(fileName)) continue;
    const chunk = bundle[fileName];
    if (!chunk || chunk.type !== "chunk") continue;
    seen.add(fileName);
    stack.push(...chunk.imports);
  }
  return seen;
}

function chunkFor(bundle: BundleLike, matches: (id: string) => boolean): ChunkLike | undefined {
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk" || !output.facadeModuleId) continue;
    if (matches(output.facadeModuleId.replaceAll("\\", "/"))) return output;
  }
  return undefined;
}

/** Returns the inline script, or null when the bundle lacks an expected chunk. */
export function routePreloadScript(bundle: BundleLike, base: string): string | null {
  const entries = Object.values(bundle).filter(
    (output): output is ChunkLike => output.type === "chunk" && isEntry(output),
  );
  const main = chunkFor(bundle, (id) => id.endsWith("/src/main.tsx"));
  if (!main || entries.length === 0) return null;

  // The entry is already a <script> in the page; everything it reaches
  // statically is fetched by the browser's own module loading.
  const loaded = staticClosure(
    bundle,
    entries.map((entry) => entry.fileName),
  );
  const mainFiles = [...staticClosure(bundle, [main.fileName])].filter(
    (fileName) => !loaded.has(fileName),
  );
  const known = new Set([...loaded, ...mainFiles]);

  const routes: Array<[string, Array<string>]> = [];
  for (const preload of ROUTE_PRELOADS) {
    const roots: Array<string> = [];
    for (const route of preload.routes) {
      const chunk = chunkFor(bundle, (id) =>
        id.endsWith(`/src/routes/${route}?tsr-split=component`),
      );
      if (!chunk) return null;
      roots.push(chunk.fileName);
    }
    const files = [...staticClosure(bundle, roots)].filter((fileName) => !known.has(fileName));
    routes.push([preload.path.source, files]);
  }

  const payload = JSON.stringify({ base, main: mainFiles, routes });
  return `(function(p){try{var o=localStorage.getItem("bots:perf-off");if(o&&o.split(",").some(function(e){return e.trim()==="route-preload"}))return}catch(e){}var f=p.main.slice(),l=location.pathname;for(var i=0;i<p.routes.length;i++){if(new RegExp(p.routes[i][0]).test(l)){f=f.concat(p.routes[i][1]);break}}for(var j=0;j<f.length;j++){var k=document.createElement("link");k.rel="modulepreload";k.crossOrigin="";k.href=p.base+f[j];document.head.appendChild(k)}})(${payload});`;
}

function isEntry(chunk: ChunkLike): boolean {
  return (chunk as ChunkLike & { readonly isEntry?: boolean }).isEntry === true;
}

export function routePreloadPlugin(): Plugin {
  let base = "/";
  return {
    name: "personal:route-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return;
        const script = routePreloadScript(ctx.bundle as unknown as BundleLike, base);
        if (!script) {
          console.warn("[personal:route-preload] expected chunks not found; no hints written");
          return;
        }
        return [{ tag: "script", children: script, injectTo: "head" }];
      },
    },
  };
}
