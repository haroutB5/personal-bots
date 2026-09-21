import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { makeAppHealthCheck, type AppProbe } from "./healthCheck.ts";

const probeReturning = (
  replies: ReadonlyArray<{ readonly status: number; readonly body: string } | "unreachable">,
) => {
  const asked: Array<string> = [];
  let index = 0;
  const probe: AppProbe = (url) => {
    asked.push(url);
    const reply = replies[Math.min(index, replies.length - 1)] ?? "unreachable";
    index += 1;
    return reply === "unreachable" ? Effect.fail("the host did not answer") : Effect.succeed(reply);
  };
  return { probe, asked };
};

const check = (probe: AppProbe) => makeAppHealthCheck(probe, { attempts: 3, delay: Duration.zero });

describe("create_app health check", () => {
  it.effect("is healthy only when the app's own marker came back", () =>
    Effect.gen(function* () {
      const { probe, asked } = probeReturning([{ status: 200, body: "<html>hbots-app-ok</html>" }]);
      const outcome = yield* check(probe).awaitHealthy({
        url: "https://my-app.example",
        path: "/",
        marker: "hbots-app-ok",
      });
      assert.equal(outcome._tag, "healthy");
      assert.deepEqual(asked, ["https://my-app.example/"]);
    }),
  );

  it.effect("is not healthy when a 200 came back without the app in it", () =>
    Effect.gen(function* () {
      // A host's own holding page answers 200 while the app is still building.
      // Completion has to mean the app answered, not that something did.
      const { probe } = probeReturning([
        { status: 200, body: "<html>Deployment in progress</html>" },
      ]);
      const outcome = yield* check(probe).awaitHealthy({
        url: "https://my-app.example",
        path: "/",
        marker: "hbots-app-ok",
      });
      assert.equal(outcome._tag, "unhealthy");
      assert.ok(outcome._tag === "unhealthy" && outcome.reason.includes("hbots-app-ok"));
    }),
  );

  it.effect("keeps trying while a deployment is still building, then gives up", () =>
    Effect.gen(function* () {
      const { probe, asked } = probeReturning([
        { status: 404, body: "" },
        { status: 502, body: "" },
        { status: 200, body: "hbots-app-ok" },
      ]);
      const outcome = yield* check(probe).awaitHealthy({
        url: "https://my-app.example",
        path: "/",
        marker: "hbots-app-ok",
      });
      assert.equal(outcome._tag, "healthy");
      assert.equal(asked.length, 3);
    }),
  );

  it.effect("reports what it saw when the deploy API said yes and the URL never did", () =>
    Effect.gen(function* () {
      const { probe, asked } = probeReturning([{ status: 503, body: "" }]);
      const outcome = yield* check(probe).awaitHealthy({
        url: "https://my-app.example",
        path: "/",
        marker: "hbots-app-ok",
      });
      assert.equal(outcome._tag, "unhealthy");
      assert.equal(asked.length, 3);
      assert.ok(outcome._tag === "unhealthy" && outcome.reason.includes("503"));
    }),
  );

  it.effect("treats an unreachable host as not healthy rather than as an error", () =>
    Effect.gen(function* () {
      const { probe } = probeReturning(["unreachable"]);
      const outcome = yield* check(probe).awaitHealthy({
        url: "https://my-app.example",
        path: "/",
        marker: "hbots-app-ok",
      });
      // A run must be able to record "it never answered" as a fact about the
      // app, not blow up as a fact about the checker.
      assert.equal(outcome._tag, "unhealthy");
      assert.ok(outcome._tag === "unhealthy" && outcome.reason.includes("did not answer"));
    }),
  );

  it.effect("joins the path without doubling or dropping a slash", () =>
    Effect.gen(function* () {
      const { probe, asked } = probeReturning([{ status: 200, body: "marker" }]);
      yield* check(probe).awaitHealthy({
        url: "https://my-app.example/",
        path: "/health",
        marker: "marker",
      });
      assert.deepEqual(asked, ["https://my-app.example/health"]);
    }),
  );
});
