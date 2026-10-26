/**
 * Browser trace exports arrive as OTLP JSON. On a slow phone link they were
 * most of what the app uploads (about 0.5 MB in the first two minutes on
 * 3G), so the web client gzips them (`Content-Encoding: gzip`, client switch
 * `trace-gzip`). Plain bodies are still read as before.
 */
import { gunzip } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/** Unzipped bodies past this are refused, so a small upload cannot expand without bound. */
export const OTLP_MAX_UNZIPPED_BYTES = 32 * 1024 * 1024;

export class OtlpRequestBodyError extends Data.TaggedError("OtlpRequestBodyError")<{
  readonly cause: unknown;
}> {}

const gunzipBounded = (bytes: Uint8Array) =>
  Effect.callback<Buffer, OtlpRequestBodyError>((resume) => {
    gunzip(bytes, { maxOutputLength: OTLP_MAX_UNZIPPED_BYTES }, (error, result) => {
      resume(
        error ? Effect.fail(new OtlpRequestBodyError({ cause: error })) : Effect.succeed(result),
      );
    });
  });

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The request's JSON body, unzipped first when it was sent gzipped. */
export const readOtlpJsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding !== "gzip") {
      return yield* request.json.pipe(
        Effect.mapError((cause) => new OtlpRequestBodyError({ cause })),
      );
    }
    const zipped = yield* request.arrayBuffer.pipe(
      Effect.mapError((cause) => new OtlpRequestBodyError({ cause })),
    );
    const text = (yield* gunzipBounded(new Uint8Array(zipped))).toString("utf8");
    return yield* decodeJson(text).pipe(
      Effect.mapError((cause) => new OtlpRequestBodyError({ cause })),
    );
  });
