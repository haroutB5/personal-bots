---
name: modern-web-guidance
description: "Use FIRST for any web UI, CSS or client-side JavaScript work in a browser app, web app or PWA (hbots web, Matchday, CalTrack web, CreditTracker, kino and others): dialogs, popovers, forms and validation, dark mode, layout, animations and view transitions, scrolling, tables, images, Core Web Vitals (LCP, INP, CLS), accessibility, security, passkeys, dates and time zones, built-in AI, web components. Looks up expert, browser-vendor guidance on the modern platform way to do it before you write ad-hoc code or add a library. Not for React Native screens, backend, SQL, CI, Docker, build config or tests."
---

# Modern Web Guidance

Curated guides from the Chrome, Edge, Firefox and MDN teams on how to build web features with today's platform instead of legacy patterns and heavy libraries. Models often know an API exists but get it subtly wrong. Look the pattern up before you write the code.

## When to use it

- At the start of adding or changing any browser UI, CSS layout or animation, or client-side JS logic (dates, sanitizing HTML, performance, accessibility, UX fixes).
- Before adding a dependency for something the platform may now do natively (a dialog library, a date library, a tooltip positioner, a virtual scroller).
- With the `speedoptimiser` skill on a web performance task: speedoptimiser decides what to fix from measurements, this skill tells you the modern way to fix it.

Not for: React Native screens in `apps/hbots-mobile` (native components, not the DOM; a WebView page inside it does count), servers, databases, CI, Docker, build or lint config, tests.

## How to use it

Always through the pinned runner. Never `npx modern-web-guidance`: that downloads and runs the newest release on every call and sends telemetry.

```sh
R=<this skill's folder>/scripts/mwg.sh
bash $R search "<query>"          # 2-5 words, one capability
bash $R retrieve "<id>,<id>"      # full guides, comma-separated
```

1. **Search.** Use a 2 to 5 word English query for one capability: verb plus UI or platform object, for example `"light dismiss dialog"` or `"responsive data table"`. Leave out framework names, app names and file names. Split a task with several features into several searches. Turn intent into the UI primitive it implies ("delete with confirmation" becomes `"confirm dialog"`). Weak or empty results: rephrase once with the concrete noun (dialog, popover, table, form). Still nothing: the topic is not covered, carry on without it.
2. **Retrieve** the matching use-case guides, plus the broad discipline guide that applies (`html`, `css`, `forms`, `accessibility`, `color`, `performance`, `security`). Read the whole output. If it says it saved a large guide to a file, read that file in full with your file tool.
3. **Check your code against the guide** before you report: the modern pattern and any fallback the guide requires are in, and the user's request is fully met.
4. **Report it** the pstack way. Name each guide id you applied and the concrete choice it changed, with a short quote of the rule it rests on, in one line each. Only ids you retrieved in this task; never from memory after a compaction (search again). If you searched and nothing applied, say in one sentence what you checked.

Broad modernization only (Harout asks to modernize or audit a whole app, no specific feature named): `bash $R legacy-scan <path> --json`, check each finding against its `keepWhen` / `dropWhen` rule and drop false positives, report, then fix by retrieving each finding's guide. It covers only about 20 percent of the guides. Never edit safe code just to reach zero findings.

## Frameworks and browser support

- The guides are plain HTML, CSS and JS. Keep the modern feature when you move it into React or another framework: spread new HTML attributes that the types do not know yet (`{...({ popover: "hint", commandfor: id, closedby: "any" } as any)}`), call `showModal()` through a ref, make per-instance ids with `useId()`, keep `:root` and `@starting-style` rules top-level, guard `window` during server rendering.
- Default policy: features that are Baseline widely available need no fallback. For anything newer, follow the guide's fallback advice. An app sheet in `dev-team/apps/` may set a narrower policy (for example Chrome on Android only); when it does, use the guide's compatibility data against that policy. Do not invent a policy; ask the lead.
- Every app is still tested as an Android phone (360 x 785, DPR 3, touch, Chrome, dark mode; Matchday light mode). The guide does not replace that proof.

## Install, update, privacy

- Installed once at `/home/harout/Claude/AI/dev-team/tools/modern-web-guidance/<version>/` (npm package `modern-web-guidance`, signed SLSA provenance, published by the Chrome team). The runner pins the version and sets `DISABLE_TELEMETRY=1`. It works with no network at all (measured 14 Nov 2026: search in 0.15 s inside a network namespace with no interfaces).
- Exit 3 from the runner means the pinned version is not installed: tell the lead, do not install it yourself.
- Updating is a lead task, done like any dependency bump: `npm install --ignore-scripts --save-exact modern-web-guidance@<new>` into a new `<version>/` folder with its own `package.json`, `npm audit signatures` must show a verified attestation, run a search and a retrieve under `unshare -rn`, compare the new upstream `SKILL.md` with this one, then change `VERSION` in `scripts/mwg.sh` and rerun `node scripts/personal/perf/skill/install.mjs`. Keep the old folder until the new one is proven.
- The runner's "a new SKILL.md is available" warning compares local files only. Ignore it; updates follow the steps above.

Adapted from the Modern Web Guidance skill (GoogleChrome/modern-web-guidance, `SKILL.md`, skill version 2026_11_09-5bcc021b), licensed CC BY 4.0. Changes: pinned offline runner instead of npx, telemetry off, team trigger list and reporting rules.
