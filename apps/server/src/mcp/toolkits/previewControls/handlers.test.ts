import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as Preview from "../../../preview/Manager.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewControlsHandlers from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

it.effect.each([
  { name: "project opt-in", globalAccess: false, projectAccess: true },
  { name: "project opt-out", globalAccess: true, projectAccess: false },
])("list and close respect the credential for a $name", ({ globalAccess, projectAccess }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("preview-controls-project");
    const threadId = ThreadId.make("preview-controls-thread");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentBrowserAccess: globalAccess,
      projectSettingsOverrides: {
        [projectId]: { enableAgentBrowserAccess: projectAccess },
      },
    };
    const effective = resolveProjectSettings(settings, projectId).settings;
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("preview-controls-environment"),
      requestNamespace: "preview-controls-provider-session",
      thread: {
        threadId,
        providerSessionId: "preview-controls-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(effective.enableAgentBrowserAccess ? ["preview"] : []),
      issuedAt: 0,
    };
    const manager = yield* Preview.make.pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-controls-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeCrypto.layer,
        ),
      ),
    );
    const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
    const layerDependencies = Layer.mergeAll(
      PreviewAutomationBroker.layer.pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
      Layer.succeed(Preview.PreviewManager, manager),
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      McpToolAccessTestkit.liveThreadsLayer,
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(settings),
      }),
    );
    const toolkit = yield* PreviewControlsToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const listed = yield* toolkit
      .handle("t3_preview_list", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    const closed = yield* toolkit
      .handle("t3_preview_close", { tabId: tab.tabId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    if (projectAccess) {
      expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab], nextCursor: null });
      expect(closed.at(-1)?.result).toEqual({});
      expect((yield* manager.list({ threadId })).sessions).toEqual([]);
    } else {
      for (const result of [listed, closed]) {
        expect(result.at(-1)?.result).toMatchObject({
          _tag: "PreviewAutomationUnavailableError",
          capability: "preview",
          threadId,
        });
      }
      expect((yield* manager.list({ threadId })).sessions).toEqual([tab]);
    }
  }),
);

/**
 * A tab the personal shared browser opened is a manager row with no runtime, so
 * closing only the row left Chrome's page open (QA's L1): the next preview_open
 * got the same tab back. The close must reach the host that owns the page.
 */
const closeOnHost = (hostAnswer: (operation: string) => PreviewAutomationHostAnswer) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("preview-controls-host-thread");
      const environmentId = EnvironmentId.make("preview-controls-host-environment");
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "preview-controls-host-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-host-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["preview"]),
        issuedAt: 0,
      };
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-controls-host-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const broker = yield* PreviewAutomationBroker.make.pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const received: Array<{ operation: string; tabId: string | undefined }> = [];
      const events = yield* broker.connect({
        clientId: "server-browser",
        environmentId,
        supportedOperations: ["status", "closeTab"],
        kind: "server",
      });
      let connectionId: string | undefined;
      yield* events.pipe(
        Stream.runForEach((event) => {
          if (event.type === "connected") {
            connectionId = event.connectionId;
            return Effect.void;
          }
          const { request } = event;
          received.push({ operation: request.operation, tabId: request.tabId });
          const answer = hostAnswer(request.operation);
          return broker.respond({
            clientId: "server-browser",
            connectionId: connectionId ?? event.connectionId,
            requestId: request.requestId,
            ...answer,
          });
        }),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const settings = { ...DEFAULT_SERVER_SETTINGS, enableAgentBrowserAccess: true };
      const layerDependencies = Layer.mergeAll(
        Layer.succeed(PreviewAutomationBroker.PreviewAutomationBroker, broker),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      const closed = yield* toolkit
        .handle("t3_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      return {
        result: closed.at(-1)?.result,
        received,
        tabId: tab.tabId,
        remaining: (yield* manager.list({ threadId })).sessions,
      };
    }),
  );

type PreviewAutomationHostAnswer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly _tag: string; readonly message: string } };

it.effect("t3_preview_close closes the page on the host that owns the tab, then the row", () =>
  Effect.gen(function* () {
    const outcome = yield* closeOnHost(() => ({
      ok: true,
      result: { tabId: null, closedTabId: "x", remainingTabIds: [] },
    }));
    expect(outcome.received.filter((entry) => entry.operation !== "status")).toEqual([
      { operation: "closeTab", tabId: outcome.tabId },
    ]);
    expect(outcome.result).toEqual({});
    expect(outcome.remaining).toEqual([]);
  }),
);

it.effect(
  "t3_preview_close says so, and keeps the row, when the host could not close the page",
  () =>
    Effect.gen(function* () {
      const outcome = yield* closeOnHost(() => ({
        ok: false,
        error: {
          _tag: "PreviewAutomationExecutionError",
          message: "The browser did not finish closing the tab.",
        },
      }));
      expect(outcome.result).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
      // Not closed: the row still names the tab that is still open.
      expect(outcome.remaining.map((session) => session.tabId)).toEqual([outcome.tabId]);
    }),
);

it.effect("t3_preview_close still removes a row whose page the host no longer has", () =>
  Effect.gen(function* () {
    const outcome = yield* closeOnHost(() => ({
      ok: false,
      error: { _tag: "PreviewAutomationTabNotFoundError", message: "No open tab with that tabId." },
    }));
    expect(outcome.result).toEqual({});
    expect(outcome.remaining).toEqual([]);
  }),
);
