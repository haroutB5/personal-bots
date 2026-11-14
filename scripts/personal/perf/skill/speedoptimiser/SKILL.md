---
name: speedoptimiser
description: "Use for ANY optimisation task on any app or tool: a slow or laggy screen, a slow web app, PWA, Android app, server, build, test run or release. Measure each stage of the user's wait, fix the biggest measured offender one change per commit with before/after numbers, then ratchet each win into a budget that can only go down. Also use to find what makes something slow, or to set performance budgets."
---

# Speed optimiser: measure, optimize, ratchet

This skill is the process behind Anthropic's "How we made claude.ai faster".
The core lesson is that once there is a number to beat, the work becomes
tractable, and the highest-leverage step is finding more things to measure.
Never optimize on faith. Every change needs a measured offender before it
and a measured win after it.

The loop, in one line: name the wait, split it into stages, measure each
stage, prove the cause, fix one thing, prove the win, lock it in, look for the
next slow spot. Sections 1 to 7 are the loop for a web app or PWA, with
scripts. Section 8 is the same loop for a native phone app, a server, or a
build and release pipeline. Section 9 is how to run it as a team.

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
- **Your first guess is a hypothesis, not a finding.** Write it down, then
  measure. On hbots (13 Nov 2026) the guess for a slow chat open was "the
  server sends the whole history". Measured: the server answered in 46 to
  334 ms with a 70 KB tail. The 3 to 5 s waits were on the phone, before the
  request left it. Fixing the guess would have shipped nothing.
- **Every wait is a chain of stages.** Start at the user's tap and end when the
  result is on screen. Time each stage on its own (client before the request,
  network, server read, payload size, client parse, first render), so the
  number says which side owns the time.
- **If no metric can see the problem, build one.** A user's screenshot or
  recording is a valid bug report even when every dashboard is green.
  claude.ai's layout jank scored 0.008 against a "good" limit of 0.1, so the
  team reported every shift by named region and phase instead, and found that
  31% of loads moved something after the page was usable.
- **A metric earns its place.** A new counter must be shown to move wall-clock
  time, or it is thrown out. Never climb a hill that users do not feel.
- **Prove a fix both ways.** The check goes red on the old code N of N runs and
  green on the new code N of N runs (claude.ai used 20 of 20). A test that
  passes on the old code proves nothing.
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

Add to the table below the list of what is still slow and the next offender by
measured cost. A target that is met is not the stopping point: say what the
next number to beat is.

Finish with a table: journey, baseline p50/p75, after p50/p75, and the change
that did it. Add what you tried and rejected, and why. Say where the budget
file and RUM summary live, and state the machine load for the headline numbers.

## 8. The same loop outside the browser

The scripts above drive Chrome. For anything else, keep the loop and swap the
instruments. Never skip the stage table.

Native phone app (Android)

- Put timing marks in the app for each stage of the journey and send them
  through the app's existing diagnostics path. Marks carry durations, sizes and
  fixed labels only, never user text. Then the real numbers come from the real
  phone after an update, with nobody handling the phone.
- An emulator is a lab, not the field. It has no hardware key store, a
  different CPU and a fast local network. hbots: the emulator showed 1.0 s
  opens while the real phone stalled 3 to 5 s on key store calls. Say which
  numbers are lab and which are field.
- Usual offenders, each one measured on hbots or claude.ai before it went on
  this list: a secure key store call per read or write on the main thread
  (wrap one data key instead and do the crypto in process); a cache with a size
  cap the biggest item never fits under, so the slowest screen never gets the
  cache (measured 1,085 KB against a 1,024 KB cap); a cache read that gates the
  network request (give it a short deadline, 500 ms, then go to the network);
  JSON parse of a large payload (measured 68 to 79 ms of a 127 ms read);
  writes on the JS thread; a list that renders every row.
- Test the upgrade path, not only a fresh install: old saved data must be read
  or dropped cleanly, with no crash and no stuck spinner.

Server

- Split a request into queue wait, database time, payload build,
  serialisation and bytes on the wire. Log each for the slow journey.
- Probe event-loop lag while the journey runs. A stall with no slow query is
  usually synchronous work or memory pressure, not the database.
- Check what is sent, not only how fast: a bounded tail against the whole
  history, and fields the client never reads.
- A change in another project (upstream) that "improves performance" helps only
  if it is on the measured path. Check before promising a gain.

Build, test and release pipelines

- The journey is "change ready" to "live". Take stage times from the logs of
  the last 10 to 20 runs before proposing anything.
- Count reruns and waits, not only step time. hbots: a census of 21 releases
  showed the feared idle wait was never caused by the suspected chat, and that
  two 11 minute reruns came from settings typed by hand. Moving those settings
  into the tool beat every planned speed-up.
- A skip rule that never fires is not a speed-up. Replay it against past runs
  before building it.
- Often the largest win is doing the slow thing less often (batching), which
  needs no code.

## 9. Running it as a team

- **One thread, one journey.** Keep each task narrow: one journey or one
  benchmark, improvements only inside it. Open a new task for a new slow spot
  instead of widening a running one. Two writers never share a branch.
- **Roles.** Architect (read-only) builds the stage table, names the top
  offenders with numbers and writes the build brief with a target number.
  Builder makes one change per commit with before and after. Verifier repeats
  the numbers independently and tries to break the fix. Shipper releases and
  reads the field numbers after.
- **Estimate in milliseconds.** Each proposed fix gets an expected saving in ms
  (or minutes for a pipeline) before work starts. Rank by saving against risk
  and complexity, and set the target from the sum.
- **Guardrails first.** Unit tests before the optimisation. Anything a user
  could see goes behind a kill switch. Risky changes roll out in steps where
  the app allows it. Classify every flag as a kill switch or a ramp and remove
  it once the change is proven, so flags do not pile up.
- **Protect brittle wins.** A fast path that depends on two things staying in
  step (a static copy of a screen, a cache format) gets tests that fail the
  moment they drift, plus a field report that flags any nonzero error.
- **Taste belongs to the owner.** A change the user can perceive (a skeleton,
  a fade, content filling in piece by piece) is shown with a before and after
  screenshot or recording, and the owner rules on it. Never trade look or
  behaviour for milliseconds silently.
- **Ambition.** Do not ticket what can be done now, and do not stop at the
  target. After each win ask what the next number is. Ask for odd ideas when
  the obvious list is done: instruction counts, call counts, frames that miss
  an 8.33 ms budget are all countable, and what can be counted can be climbed.
- **Know when to stop a thread.** Close it when the next win is small against
  its complexity. claude.ai turned down a 900-line change worth 2 ms.
- **Watch after shipping.** Read the field numbers after each release. If the
  field does not confirm the lab, turn the change off and iterate. If it does,
  ratchet the budget down in the same change.
- **Report honestly.** Label each number measured, inferred or guess, say lab
  or field, and list what was not verified.
