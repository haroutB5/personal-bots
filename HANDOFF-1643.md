# HANDOFF: hbots 1.64.3 (6 Oct 2026)

Branch `feat/parallel-search` (off live main 976285cb95 = 1.64.2). One feature: the bots' `search_web` and `read_pages` use Parallel's free
Search MCP server first, with the existing Tavily path as automatic fallback. No migration, no web change. Concurrency stays 5.
Staged with `build.ps1 -NoActivate -CopyExternals`, not active until DevOps ships it.

## What changed

- `apps/server/src/personal/research/parallelSearch.ts` (new): one stateless JSON-RPC `tools/call` POST to
  `https://search.parallel.ai/mcp` (no initialize, no session, no key, no account; no `session_id`, no `model_name`, nothing that names a chat
  or a bot). Reads a plain-JSON or SSE answer, bounded at 6 MB. Every non-answer is a `ParallelFailure` with a reason slug.
- `researchClient.ts`: `search` (kind search) calls `web_search` (objective + `search_queries` = the bot's query, `site:` operators for
  `domains`, timeRange/country as objective text); `read` (kind extract) calls `web_fetch` with `full_content: true`. Both go through the
  existing `sources()` screen, so the caps are unchanged (6 results per query, 2000 chars per snippet, 12000 per page, public URLs only,
  no private/signed/token URLs coming back). Any Parallel failure falls back to the existing Tavily call for that one call.
  Timeouts: 20 s search, 30 s fetch (`parallelTimeoutMs` shortens both in tests).
- `handlers.ts`: the sensitive-site refusal still comes first (before the key lookup and before any provider). The Tavily key is now
  optional for these two tools (it only enables the fallback), required only in `tavily` mode. `search_google` and `search_products` are
  untouched and still need SERPAPI_API_KEY. One log line per call.
- `tools.ts` and `personalBotInstructions.ts`: descriptions say "needs no key, Parallel first, Tavily fallback".
- Output shape unchanged. `provider` is now `"parallel"` or `"tavily"` for these two tools (it already existed).

## Switches

`T3CODE_PERSONAL_RESEARCH_PROVIDER` (server env, idle restart; read on every call):

- unset / `parallel` / `auto` / anything else: Parallel first, Tavily on failure (default)
- `tavily`: Tavily only, the 1.64.2 behaviour exactly (Parallel is never called; the key is required again)
- `parallel-only`: no fallback (testing)

`T3CODE_PERSONAL_RESEARCH_PARALLEL_URL`: endpoint override, for tests (point it at a closed port to prove the fallback).

## Fallback reasons (logged as `fallbackReason`)

`timeout`, `rate_limited` (HTTP 429 or a rate-limit RPC error), `http_error`, `network_error`, `protocol_error` (not JSON-RPC),
`provider_error` (RPC error, `isError`, or a fetch error with no result), `too_large` (> 6 MB), `empty` (no results or no readable text),
`garbled` (> 5 % replacement or control characters), `blocked_page` (a short "just a moment / access denied" wall instead of the page).
A caller that cancels (interrupted turn) is not a failure: no fallback, no log line.

## Log line

`personal research call` (INFO; WARN when the call failed): `{ tool: search|read, provider: parallel|tavily, outcome: served|failed,
fallbackReason?, sources, ms }`. Counts and reason slugs only: never a query, a URL, a title or a provider body.

## Measured (throwaway scripts against the real client; Tavily key = this bot's own session secret, never printed)

Evidence: `C:/Users/Ht/.personal-bots/qa/parallel1643/` (`measure.json`, `run2/measure.json`, `switches.json`, test and gate logs,
`measure.mjs`, `switches.mjs`). Two runs of 10 public queries and 5 pages, one call at a time.

|                              | Parallel                        | Tavily                      |
| ---------------------------- | ------------------------------- | --------------------------- |
| search latency, median of 20 | 887 ms (min 670, max 4037 once) | 1165 ms (min 947, max 2068) |
| results per query            | 6 on all 20 calls               | 6 on all 20 calls           |
| read latency, median of 10   | 679 ms (max 1214)               | 148 ms (max 274)            |
| errors                       | 0                               | 0                           |

Quality (one line per query, run 1): Node LTS: Parallel 6 nodejs.org pages but three are localised archive duplicates, Tavily more varied with a
direct "Node 24 is Active LTS" answer (Tavily better). Playwright isolation: Parallel playwright.dev first, Tavily blogs (Parallel better).
UK VAT threshold: Parallel 3x gov.uk, Tavily Xero/SumUp (Parallel better). Wimbledon 2026 final: Parallel BBC recap dated 2026-07-12 with the score
in 748 ms vs Tavily Wikipedia in 1995 ms (both right). Effect Layer.mock: Parallel Effect API docs, Tavily YouTube (Parallel better). Neon free plan:
Parallel Neon docs "plans", Tavily blog/medium (Parallel better). Vercel cron: both vercel.com, both lead with the old beta post (tie). Tennis
strings: Parallel retail/review sites, Tavily had two mapquest hits (Parallel better). iOS web push: both mix Apple docs and vendors (tie,
Parallel more primary). SQLite WAL: Parallel sqlite.org pragma docs, Tavily a GitHub issue and blogs (Parallel better; its 4 s outlier did not repeat).
Pages: all 5 read by both (static article, 15-page arXiv PDF, Vercel docs (Next.js app), long Wikipedia article, GitHub README). Parallel returns
clean markdown with the page's own title; the PDF came back as readable text with the paper title; the long article truncates at 12000 like Tavily.
Tavily's extract answered in about 150 ms (it looks cached) so reads are slower on Parallel by about half a second.

Fallback and switches (`switches.mjs`, env-driven, 10 of 10 pass): default serves from Parallel; closed port -> Tavily (`network_error`) for a
search and a read; HTTP 429 -> Tavily (`rate_limited`); a server that never answers -> Tavily after 20 s (23.7 s total, `timeout`);
`parallel-only` + closed port -> failure naming the reason, Tavily untouched; `tavily` switch (also `TAVILY`) -> a local counter standing in for
Parallel got 0 requests; a signed-link URL and a token-bearing query were refused with 0 requests to either provider.

## Guards (unchanged, tests)

`researchHandlers.test.ts`, `parallelResearch.test.ts`: the sensitive-site refusal fires before any `fetch` for search_web and read_pages, key or
no key; missing capability or unlinked bot refused before any `fetch`; share links in queries and signed/private/token URLs never reach Parallel or
Tavily; untrusted framing and the tool descriptions are unchanged apart from the key sentence; per-call limits (4 queries, 8 URLs) are schema-level
and untouched.

## Gates

server `vp test run src/personal src/mcp`: 154 files passed, 3 skipped; 2035 tests passed, 3 skipped, exit 0 (193 in the research and toolkit
files, about 50 of them new). `tsc --noEmit` exit 0. `vp lint` and `vp fmt` on the 8 changed files: exit 0.

## Risks

- Parallel's free tier is anonymous: bot queries and read URLs now go to a second third party (their privacy policy is linked in the response
  headers). Same class of data as Tavily got; the sensitive-site guard and URL screens are unchanged. `tavily` switch reverts it.
- Free-tier rate limits are by caller and undocumented ("generous for hobby use"): a 429 just falls back to Tavily (and is logged).
- `country` and `timeRange` are hints on Parallel (words in the objective), strict on Tavily. `domains` becomes `site:` operators plus a client-side
  filter; if nothing in those domains comes back it falls back to Tavily, which enforces them.
- A bot that had no Tavily key before now works; one that has a key now spends fewer Tavily credits.
