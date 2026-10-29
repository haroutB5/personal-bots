import * as NodeZlib from "node:zlib";

import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  OTLP_MAX_UNZIPPED_BYTES,
  OtlpRequestBodyError,
  readOtlpJsonBody,
} from "./otlpRequestBody.ts";

const body = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "chat.open" }] }] }] };
const bodyText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(body);

const post = (payload: string | Uint8Array<ArrayBuffer>, headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/api/observability/v1/traces", {
      method: "POST",
      headers,
      body: payload,
    }),
  );

it.effect("reads a plain JSON body", () =>
  Effect.gen(function* () {
    const request = post(bodyText, { "content-type": "application/json" });
    expect(yield* readOtlpJsonBody(request)).toEqual(body);
  }),
);

it.effect("unzips a gzipped JSON body", () =>
  Effect.gen(function* () {
    const request = post(new Uint8Array(NodeZlib.gzipSync(bodyText)), {
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    expect(yield* readOtlpJsonBody(request)).toEqual(body);
  }),
);

it.effect("refuses a body that unzips past the limit or is not gzip", () =>
  Effect.gen(function* () {
    const bomb = post(
      new Uint8Array(NodeZlib.gzipSync(Buffer.alloc(OTLP_MAX_UNZIPPED_BYTES + 1, 32))),
      {
        "content-encoding": "gzip",
      },
    );
    const tooBig = yield* Effect.exit(readOtlpJsonBody(bomb));
    expect(tooBig._tag === "Failure" && Cause.squash(tooBig.cause)).toBeInstanceOf(
      OtlpRequestBodyError,
    );
    const garbled = post("not gzip", { "content-encoding": "gzip" });
    const bad = yield* Effect.exit(readOtlpJsonBody(garbled));
    expect(bad._tag === "Failure" && Cause.squash(bad.cause)).toBeInstanceOf(OtlpRequestBodyError);
  }),
);
