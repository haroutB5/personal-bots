---
name: web-perf-loop
description: Make a web app measurably faster with a measure, optimize and ratchet loop, based on how claude.ai was made faster. Use when asked to speed up a web app or PWA, find what makes it slow, set performance budgets, or add real-user timing. You define user journeys, take a baseline with a phone-sized headless Chrome harness, check which metrics track wall-clock, fix the biggest measured offender one change per commit with before/after numbers and a kill switch, then lock each win into a budget that can only go down.
---

# Web perf loop: measure, optimize, ratchet

This skill is the process behind Anthropic's "How we made claude.ai faster".
The core lesson is that once there is a number to beat, the work becomes
tractable, and the highest-leverage step is finding more things to measure.
Never optimize on faith. Every change needs a measured offender before it
and a measured win after it.

Scripts are in this skill's `scripts/` folder, and templates in `templates/`.
They need Node 18+ and `playwright-core` (`npm i -D playwright-core` in the app,
or anywhere you can resolve it). They drive the system Chrome, so no browser
download is needed.

## 0. Ground rules

- Work on a branch, and make one optimization per commit. Each commit body
  carries the before and after numbers (p50, plus p75 where there is noise),
  the machine load, and how the numbers were measured.
- Put every change that alters when or how work happens behind a kill switch,
  so it can be turned off on one device without a release. The
  `templates/perf-flags.ts` pattern (a localStorage key) also lets you A/B a
  change in a single build.
- Reject complexity for trivial gains. The claude.ai team rejected a 900-line
  PR for 2 ms. If a change is big, its measured win must be big too.
- Write unit tests for any logic you change, before you optimize it.
- Note the machine state with every measurement (the harness prints CPU busy %
  and free memory). Other load on the machine easily moves wall-clock by 2x.
  Compare only interleaved A/B runs, or runs taken back to back.

## 1. Define the journeys

Write down 3-6 user journeys, each with an exact start and end. The end must
be what the user waits for (usable), not what the page does (onload). Typical
journeys:

| Journey    | Start -> end                                                          |
| ---------- | --------------------------------------------------------------------- |
| fresh load | first visit, empty caches -> main content visible and interactive     |
| warm load  | repeat visit / installed PWA relaunch -> same                         |
| open item  | tap a list row -> detail content visible and its input typeable       |
| send       | submit -> own item echoed; first server response rendered             |
| stream     | a long streamed response -> frame drops and long tasks while it grows |

Express each end as a CSS selector that exists only when the journey is done.
Copy `templates/perf.config.example.json` next to the app and fill it in.

## 2. Baseline

```bash
node <skill>/scripts/bench.mjs --config perf.config.json --runs 7
```

Each run opens a fresh, isolated, phone-sized Chrome context (390x844, DPR 3,
touch, 4x CPU throttle), walks the journeys in order, and records per journey:

- wall-clock to the end mark (taken at paint time, and the probe never forces
  a layout itself);
- long tasks (count and ms), React commits (when React is present), layout
  shifts before and after the mark, with the region they hit;
- requests and JS KB loaded before the mark;
- CDP script ms, task ms, layout and style-recalc counts, and heap;
- the same counters in the few seconds after the mark (`longTaskMsAfter`).

The output is JSON with p50/p75 per journey. For signed-in apps, pass a
Playwright storage state (`"storageState"` in the config), and keep it out of
the repo because it holds a session. For each journey also take a CPU profile
when you need to know _where_ the time goes (`--profile <journey>`).

Add RUM early, not last: `templates/rum-beacon.ts` sends one small beacon per
journey from real clients to a rate-limited, allowlisted endpoint. The lab says
where the time goes; RUM says what users actually wait. Report p75.

## 3. Prove which metrics track wall-clock

```bash
node <skill>/scripts/correlate.mjs bench-*.json
```

For each counter this prints its Pearson r against wall across runs, plus its
run-to-run cv:

- `tracks wall` (r >= 0.6): the counter explains the journey's time, and it is a
  good gate and a good guide to what to fix.
- `deterministic` (cv ~ 0), such as requests, JS bytes and commits: these cannot
  correlate run to run. Judge them across builds: did they move when wall
  moved?
- `noise`: do not gate on it.

If _no_ client counter tracks a journey's wall, the time is on the server or
the network. Profile the server (CPU profile, query timings, event-loop lag
probe) before touching the client.

## 4. Find and fix the biggest offender

Rank offenders by measured cost, never by this list. Then use the checklist
below to find a fix for the top one. Each item is a real finding from
claude.ai or from the first app this skill was used on.

Load and navigation

- [ ] **Static shell before JS boots.** Is the first thing the user needs
      (content from the last visit, an input box) painted from HTML and
      localStorage before the framework boots? claude.ai: fresh load went from
      3085 to 550 ms with a static composer that keeps keystrokes across the
      handoff to React.
- [ ] **Cached content gated on something late.** A cached snapshot that waits
      for an id or a connection before painting. Paint it at once and validate it
      when the id arrives. Measured: warm relaunch 1310 -> 716 ms.
- [ ] **Next screen's code loaded on tap.** Preload the likely next route's
      chunks once the current screen is idle. Hover/touch intent alone gives
      about 100 ms on a phone. Measured: open item 516 -> 265 ms, and 48 -> 2
      requests after the tap.
- [ ] **Prefetch data on intent** (hover/touchstart of a row), not on click.
- [ ] **JS evaluated before usable.** Check the requests and JS KB before the
      mark. Look for large libraries in the startup graph (highlighters, editors,
      auth SDKs for other platforms) and for hundreds of tiny chunks.
- [ ] **Server cold start**: code cache / compile cache (`module.enableCompileCache()`
      in Node, V8 code cache in Electron). claude.ai desktop: 1.9x.
- [ ] **HTTP caching** of hashed assets (immutable), and whether a relay/CDN
      in front actually caches them.

Rendering and interaction

- [ ] **Hook and store-subscription census** on the typing path. claude.ai
      found 6,900 hooks and 900 subscriptions.
- [ ] **Keep persistent UI mounted** (a composer, a sidebar) across route
      changes instead of remounting it. claude.ai: -90% sidebar re-renders.
- [ ] **Costly selectors**: one `:root:has()` cost 24 ms on every DOM change.
- [ ] **Layout shift after usable**: late rows, banners or images. Defer
      non-critical rows until after first paint, and reserve their space.
- [ ] **Algorithmic hot spots**: IDs resolved several times per node, and
      megamorphic dictionary lookups. A single pass gave 4.6x.
- [ ] **Cheap pre-checks before regexes** (first-char test): 1.8x.

Streaming and code

- [ ] **Syntax-highlighter first use**: compiling a grammar on first use can
      cost 20x a warm run. Warm the common languages while the user waits for a
      response (not while they type). Measured: worst long task while streaming
      748 -> 237 ms.
- [ ] **Non-Latin-1 text forces slow regex paths** (UTF-16 strings). Copy
      code to 1-byte strings before highlighting, and cache per block. 2.8x.
- [ ] **Memoize finished markdown blocks** so each chunk does no O(message)
      work. Tokenize the growing code fence in a Worker. Keep a frame budget
      (8.33 ms at 120 Hz).

Hidden costs that load metrics miss

- [ ] Leftover `location.reload()` calls (claude.ai: 500k hidden reloads a
      day).
- [ ] Storage churn: identical snapshots written to IndexedDB or localStorage
      on a timer, on the main thread.
- [ ] Main-thread synchronous work on the server (sync DB drivers, JSON of
      large payloads). Probe event-loop lag while the journey runs.
- [ ] Measurement overhead: the probe or the harness itself showing up in the
      profile (layout reads, a11y-tree polling). Fix the harness first.

## 5. One change, measured

1. Implement the fix behind a kill switch (`templates/perf-flags.ts`).
2. Deploy it the normal way, then A/B it in the same build:
   `bench.mjs --config perf.config.json --runs 10 --ab <flag>` alternates runs
   with the flag on and off and reports `journey@on` and `journey@off`.
3. Keep the change only if the target journey improves beyond noise. Also
   check that nothing else got worse, including the idle cost after the mark
   (`longTaskMsAfter`).
4. Commit it with the numbers, then ship. Where the app has a service worker,
   say that clients get the change only after the worker updates.

## 6. Ratchet

```bash
node <skill>/scripts/check.mjs --config perf.config.json            # exit 1 on a regression
node <skill>/scripts/check.mjs --config perf.config.json --ratchet  # lower beaten budgets
```

`budget.json` (created from `templates/budget.example.json`) holds p50
ceilings per journey. Wall ceilings get headroom (machine noise, 30-50%).
Deterministic counters get tight headroom plus an absolute `slack`. Budgets
only move down. `--ratchet` lowers a beaten budget to p75 x (1 + headroom), not
p50, so one fast run cannot set a budget that ordinary runs then fail. Each
lowering is committed with the change that earned it.
Run the check before every release, and in CI or a nightly job if the app has
one.

## 7. Report

Finish with a table: journey, baseline p50/p75, after p50/p75, and the change
that did it. Add what you tried and rejected, and why. Say where the budget
file and RUM summary live, and state the machine load for the headline numbers.
