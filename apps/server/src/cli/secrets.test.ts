import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { makeCli } from "../binCli.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const helpText = Effect.gen(function* () {
  yield* Command.runWith(makeCli(), { version: "0.0.0" })(["--help"]).pipe(
    Effect.provide(layerCliRuntime),
    Effect.exit,
  );
  const lines = yield* TestConsole.logLines;
  return lines.map((line) => (Array.isArray(line) ? line.join(" ") : String(line))).join("\n");
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, TestConsole.layer))(
  "secrets CLI command",
  (it) => {
    it.effect("is registered and its help lists secrets", () =>
      Effect.gen(function* () {
        const help = yield* helpText;
        assert.include(help, "secrets");
      }),
    );

    it.effect("lists the export and import subcommands", () =>
      Effect.gen(function* () {
        yield* Command.runWith(makeCli(), { version: "0.0.0" })(["secrets", "--help"]).pipe(
          Effect.provide(layerCliRuntime),
          Effect.exit,
        );
        const lines = yield* TestConsole.logLines;
        const help = lines
          .map((line) => (Array.isArray(line) ? line.join(" ") : String(line)))
          .join("\n");
        assert.include(help, "export");
        assert.include(help, "import");
      }),
    );
  },
);
