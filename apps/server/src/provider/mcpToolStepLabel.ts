/**
 * One plain-language line for an MCP tool step.
 *
 * The working indicator, the Bots list row and the voice call's `bot_status`
 * all read a tool step's TITLE (see `personalProgressNote`), and the providers
 * used to hand them the generic "MCP tool call". Harout's test on live 1.66.57
 * (16 Oct) asked for what the bot is actually doing: "Opening clubspark.com",
 * "Searching the web", "Handing work to QA".
 *
 * hbots' own `t3-code` tools get a hand-written line each; any other MCP tool
 * gets its tool name in words ("fetch_pr" -> "Fetch PR").
 *
 * Safety (the same rule as the progress note): only a bare HOSTNAME is ever
 * read out of a tool's arguments. Never a path, a query, a parameter, a header
 * or a value. `hostnameOf` parses the URL and then re-checks the result against
 * a strict DNS-host shape, so anything that is not a host is dropped and the
 * plain fallback line is used instead.
 */

/** Servers whose tools get their own hand-written lines. */
const HBOTS_MCP_SERVERS = new Set(["t3-code", "t3_code", "t3code", "t3-code-server"]);

/** Longest bot name quoted in "Handing work to ...". */
const DELEGATE_BOT_NAME_MAX_CHARS = 40;
/** Longest hostname shown. */
const HOSTNAME_MAX_CHARS = 80;

/** A DNS host (letters, digits, hyphens, at least one dot) and nothing else. */
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Words kept as capitals when a tool name is turned into words. */
const TOOL_NAME_ACRONYMS = new Set([
  "api",
  "css",
  "db",
  "html",
  "id",
  "ip",
  "json",
  "mcp",
  "pr",
  "sql",
  "ui",
  "url",
]);

/** The `t3-code` toolkit, one line each. */
const HBOTS_TOOL_STEP_LABELS: Readonly<Record<string, string>> = {
  // The shared browser.
  preview_open: "Opening the browser",
  preview_status: "Checking the browser",
  preview_snapshot: "Looking at the page",
  preview_click: "Clicking on the page",
  preview_type: "Typing on the page",
  preview_press: "Pressing a key on the page",
  preview_hover: "Hovering over the page",
  preview_scroll: "Scrolling the page",
  preview_drag: "Dragging on the page",
  preview_evaluate: "Running a script on the page",
  preview_wait_for: "Waiting for the page",
  preview_history: "Going back in the browser",
  preview_close_tab: "Closing a browser tab",
  preview_resize: "Resizing the browser view",
  preview_set_appearance: "Switching the page's theme",
  preview_recording_start: "Recording the browser",
  preview_recording_stop: "Stopping the browser recording",
  close_browser: "Closing the browser",
  use_login: "Signing in to a site",
  // The owner's real PC.
  computer_screenshot: "Looking at your screen",
  computer_zoom: "Looking closer at your screen",
  computer_click: "Clicking on your computer",
  computer_type: "Typing on your computer",
  computer_key: "Pressing a key on your computer",
  computer_hold_key: "Holding a key on your computer",
  computer_scroll: "Scrolling on your computer",
  computer_drag: "Dragging on your computer",
  computer_mouse_down: "Using the mouse on your computer",
  computer_mouse_up: "Using the mouse on your computer",
  computer_move: "Moving the mouse on your computer",
  computer_cursor_position: "Finding the mouse pointer",
  computer_release: "Handing back your computer",
  // Research and memory.
  search_web: "Searching the web",
  search_google: "Searching Google",
  search_products: "Searching for products",
  read_pages: "Reading a web page",
  read_chat_history: "Reading earlier messages",
  search_memory: "Checking memory",
  save_memory: "Saving a note",
  forget_memory: "Forgetting a note",
  // Bots, tasks and routines.
  delegate_task: "Handing work to another bot",
  steer_task: "Updating a task",
  stop_task: "Stopping a task",
  get_task: "Checking a task",
  list_tasks: "Listing tasks",
  update_work_record: "Updating the work record",
  list_bots: "Listing the bots",
  list_bot_chats: "Looking through bot chats",
  create_bot: "Creating a bot",
  update_bot: "Changing a bot",
  remove_bot: "Removing a bot",
  create_routine: "Scheduling a routine",
  update_routine: "Changing a routine",
  set_routine_enabled: "Pausing or resuming a routine",
  delete_routine: "Deleting a routine",
  list_routines: "Listing routines",
  notify_user: "Sending you a notification",
  call_vote: "Starting a vote",
  cast_vote: "Casting a vote",
  // Apps, connections and pull requests.
  create_app: "Building a new app",
  create_app_status: "Checking the app build",
  list_connections: "Listing your connections",
  connection_call: "Calling a service",
  link_pull_request: "Linking a pull request",
  unlink_pull_request: "Unlinking a pull request",
  list_thread_pull_requests: "Listing pull requests",
  // Asking the owner.
  request_login: "Asking you to sign in",
  request_secret: "Asking you for a key",
  secret_request: "Using a saved key",
  request_browser_help: "Asking you for help in the browser",
  // Devices.
  device_list: "Listing devices",
  device_open: "Opening a device",
  device_screenshot: "Looking at the device screen",
  device_close: "Closing a device",
};

export interface McpToolStepLabelInput {
  /** The MCP server, when the provider names it separately ("t3-code"). */
  readonly server?: string | undefined;
  /** The tool name, either plain ("preview_navigate") or Claude's `mcp__server__tool`. */
  readonly tool: string;
  /** Parsed tool arguments. Only a bare hostname is ever read from them. */
  readonly arguments?: Record<string, unknown> | undefined;
}

/** Splits Claude's `mcp__<server>__<tool>` shape, else keeps the plain name. */
function splitMcpToolName(
  tool: string,
  server: string | undefined,
): { readonly server: string; readonly tool: string } {
  const name = tool.trim();
  const given = server?.trim().toLowerCase() ?? "";
  if (name.toLowerCase().startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const separator = rest.indexOf("__");
    if (separator > 0) {
      return {
        server: rest.slice(0, separator).toLowerCase(),
        tool: rest.slice(separator + 2),
      };
    }
  }
  return { server: given, tool: name };
}

function stringArgument(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The host a URL parses to, or undefined when it does not parse at all. */
function parsedHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/** A bare hostname from a URL, or undefined. `www.` is dropped; only the host survives. */
function hostnameOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return undefined;
  // First as given ("https://example.com/x"), then as a schemeless host
  // ("example.com/x"); a "example.com:8080/x" only parses the second way.
  for (const candidate of [parsedHostname(trimmed), parsedHostname(`https://${trimmed}`)]) {
    const hostname = candidate?.toLowerCase().replace(/^www\./, "") ?? "";
    if (hostname.length === 0 || hostname.length > HOSTNAME_MAX_CHARS) continue;
    if (HOSTNAME.test(hostname)) return hostname;
  }
  return undefined;
}

/** The hostname a navigation is heading for, if the arguments name one. */
function hostnameFromToolArguments(args: Record<string, unknown> | undefined): string | undefined {
  const direct = stringArgument(args, "url");
  if (direct !== undefined) {
    const host = hostnameOf(direct);
    if (host !== undefined) return host;
  }
  const target = args?.["target"];
  if (typeof target === "object" && target !== null) {
    const nested = stringArgument(target as Record<string, unknown>, "url");
    if (nested !== undefined) return hostnameOf(nested);
  }
  return undefined;
}

/** The bot a delegation is going to, bounded and stripped to plain name characters. */
function delegateTarget(args: Record<string, unknown> | undefined): string | undefined {
  const raw = stringArgument(args, "targetBot");
  if (raw === undefined) return undefined;
  const cleaned = raw
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DELEGATE_BOT_NAME_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** A tool name in words: "fetch_pr" -> "Fetch PR", "previewNavigate" -> "Preview navigate". */
export function humaniseMcpToolName(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (TOOL_NAME_ACRONYMS.has(lower)) return lower.toUpperCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

function hbotsToolStepLabel(
  tool: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (tool === "preview_navigate" || tool === "preview_open") {
    const host = hostnameFromToolArguments(args);
    if (host !== undefined) return `Opening ${host}`;
    return tool === "preview_open"
      ? HBOTS_TOOL_STEP_LABELS["preview_open"]!
      : "Opening a page in the browser";
  }
  if (tool === "delegate_task") {
    const target = delegateTarget(args);
    return target === undefined
      ? HBOTS_TOOL_STEP_LABELS["delegate_task"]!
      : `Handing work to ${target}`;
  }
  const known = HBOTS_TOOL_STEP_LABELS[tool];
  if (known !== undefined) return known;
  // A tool added to the toolkit since this table was written still reads as a
  // human line rather than the generic "MCP tool call".
  if (tool.startsWith("computer_")) return "Using your computer";
  if (tool.startsWith("preview_")) return "Using the browser";
  if (tool.startsWith("device_")) return "Using a device";
  return undefined;
}

/**
 * The title of an MCP tool step, in plain words. Undefined when the name says
 * nothing at all, so the caller keeps its own fallback.
 */
export function mcpToolStepLabel(input: McpToolStepLabelInput): string | undefined {
  const { server, tool } = splitMcpToolName(input.tool, input.server);
  const normalized = tool.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  if (HBOTS_MCP_SERVERS.has(server)) {
    const label = hbotsToolStepLabel(normalized, input.arguments);
    if (label !== undefined) return label;
  }
  const humanised = humaniseMcpToolName(normalized);
  return humanised.length > 0 ? humanised : undefined;
}
