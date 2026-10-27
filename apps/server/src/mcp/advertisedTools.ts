import { Tool, type Toolkit } from "effect/unstable/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

import { BotsToolkit } from "./toolkits/bots/tools.ts";
import { ConnectionsToolkit } from "./toolkits/connections/tools.ts";
import { DesktopImageToolkit, DesktopStandardToolkit } from "./toolkits/desktop/tools.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit } from "./toolkits/device/tools.ts";
import { PersonalToolkit } from "./toolkits/personal/tools.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "./toolkits/preview/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";

/**
 * Every toolkit `McpHttpServer.layer` registers, in registration order. Keep the two in step:
 * personal/agentContextBudget.test.ts measures the context bots pay for from this list.
 */
export const ADVERTISED_TOOLKITS: ReadonlyArray<Toolkit.Toolkit<Record<string, Tool.Any>>> = [
  PreviewStandardToolkit,
  PreviewSnapshotToolkit,
  PullRequestsToolkit,
  BotsToolkit,
  PersonalToolkit,
  ConnectionsToolkit,
  DeviceStandardToolkit,
  DeviceScreenshotToolkit,
  DesktopStandardToolkit,
  DesktopImageToolkit,
];

/** The fields of each advertised tool that reach the model, as the MCP `tools/list` sends them. */
export const advertisedToolList = () =>
  ADVERTISED_TOOLKITS.flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool) => ({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: advertisedJsonSchema(tool),
    })),
  );
