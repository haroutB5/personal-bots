import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * What "the app is live" means.
 *
 * A deployment API answering 200 says a build was accepted, which is not the
 * same claim. This asks the URL itself, and only counts an answer that carries
 * the marker the pinned template serves — a host's own "deployment in
 * progress" page is also a 200.
 *
 * It sends no credential and takes none. The app it is checking is public by
 * construction, and a health check that authenticated would be a second place
 * a token could leak to.
 */

export interface AppProbeResponse {
  readonly status: number;
  readonly body: string;
}

/** The one seam: a plain GET, faked in tests, never carrying a secret. */
export type AppProbe = (url: string) => Effect.Effect<AppProbeResponse, string>;

export type AppHealthResult =
  | {
      readonly _tag: "healthy";
      readonly url: string;
      readonly status: number;
      readonly attempts: number;
    }
  | {
      readonly _tag: "unhealthy";
      readonly url: string;
      readonly attempts: number;
      /** What was actually seen, in the owner's words. */
      readonly reason: string;
    };

export class AppHealthCheck extends Context.Service<
  AppHealthCheck,
  {
    readonly awaitHealthy: (input: {
      readonly url: string;
      readonly path: string;
      readonly marker: string;
    }) => Effect.Effect<AppHealthResult>;
  }
>()("t3/personal/connections/createApp/healthCheck/AppHealthCheck") {}

/** A fresh deployment is usually building; this is how long it is given. */
const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY = Duration.seconds(6);

const join = (url: string, path: string) =>
  `${url.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export const makeAppHealthCheck = (
  probe: AppProbe,
  options?: { readonly attempts?: number; readonly delay?: Duration.Duration },
): AppHealthCheck["Service"] => {
  const attempts = options?.attempts ?? DEFAULT_ATTEMPTS;
  const delay = options?.delay ?? DEFAULT_DELAY;

  const awaitHealthy: AppHealthCheck["Service"]["awaitHealthy"] = (input) =>
    Effect.gen(function* () {
      const target = join(input.url, input.path);
      let last = "it was never asked";
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const seen = yield* probe(target).pipe(
          Effect.map((response) => ({ ok: true as const, response })),
          Effect.catch((reason) => Effect.succeed({ ok: false as const, reason })),
        );
        if (!seen.ok) {
          last = `it did not answer: ${seen.reason}`;
        } else if (seen.response.status < 200 || seen.response.status >= 300) {
          last = `it answered HTTP ${seen.response.status}`;
        } else if (!seen.response.body.includes(input.marker)) {
          // Deliberately not "close enough": without the marker this is some
          // other page, and calling it done is how a broken app ships.
          last = `it answered HTTP ${seen.response.status} but the page did not contain ${input.marker}`;
        } else {
          return {
            _tag: "healthy" as const,
            url: target,
            status: seen.response.status,
            attempts: attempt,
          };
        }
        if (attempt < attempts) yield* Effect.sleep(delay);
      }
      return { _tag: "unhealthy" as const, url: target, attempts, reason: last };
    });

  return AppHealthCheck.of({ awaitHealthy });
};

/** A plain GET with no headers of ours beyond the one that asks for a page. */
export const fetchAppProbe =
  (fetchImpl: typeof globalThis.fetch = globalThis.fetch): AppProbe =>
  (url) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "text/html,*/*" },
          redirect: "follow",
        });
        return { status: response.status, body: await response.text() };
      },
      catch: (cause) => String(cause),
    });

export const layer = Layer.sync(AppHealthCheck, () => makeAppHealthCheck(fetchAppProbe()));
