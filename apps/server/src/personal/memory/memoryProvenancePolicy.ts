// Where a memory note came from and how it may be undone: web-tool detection and turn-origin tags. Pure.

/** Tools that bring web or browser content into a turn (app tools and provider built-ins). */
export const WEB_TOOL_PATTERN =
  /(search_web|read_pages|search_google|search_products|secret_request|preview_[a-z_]+|computer_[a-z_]+|use_login|WebFetch|WebSearch|web_fetch|web_search)/i;
/** The same tools as WEB_TOOL_PATTERN, lowercase, for a SQL `instr` over a whole thread. */
export const WEB_TOOL_NEEDLES = [
  "search_web",
  "read_pages",
  "search_google",
  "search_products",
  "secret_request",
  "preview_",
  "computer_",
  "use_login",
  "webfetch",
  "websearch",
  "web_fetch",
  "web_search",
] as const;
