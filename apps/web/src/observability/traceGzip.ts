import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { perfOptimizationOn } from "../features/personal/perfFlags";

/**
 * Trace exports are OTLP JSON and were most of what the app uploaded on a
 * slow phone link (about 0.5 MB in the first two minutes on 3G). JSON this
 * repetitive gzips to roughly a tenth, so each export is sent gzipped; the
 * server unzips it (otlpRequestBody.ts). Kill switch: bots:perf-off
 * `trace-gzip`. Browsers without CompressionStream send plain JSON.
 */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function gzipRequestBody(
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest> {
  const body = request.body;
  if (
    body._tag !== "Uint8Array" ||
    typeof CompressionStream === "undefined" ||
    !perfOptimizationOn("trace-gzip")
  ) {
    return Effect.succeed(request);
  }
  return Effect.promise(() => gzipBytes(body.body)).pipe(
    Effect.map((zipped) =>
      HttpClientRequest.setHeader(
        HttpClientRequest.bodyUint8Array(request, zipped, body.contentType),
        "content-encoding",
        "gzip",
      ),
    ),
    // A failed compression sends the plain body, as before.
    Effect.catchCause(() => Effect.succeed(request)),
  );
}

/** The HttpClient in scope, with request bodies gzipped (see above). */
export const gzipRequestBodiesLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(HttpClient.mapRequestEffect(gzipRequestBody));
  }),
);
