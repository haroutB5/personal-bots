# hbots 1.62.0: ad and tracker blocking in the bots' shared Chrome

Branch `feat/browser-adblock`, on top of `e4bd87aef9` (1.61.1 live), no force. Harout: "Ok try ad blocking and see if that helps with performance." No migration. `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged with `build.ps1 -NoActivate -CopyExternals`; `current.txt` untouched. Not live until DevOps ships it.

## What it does

One extra Chrome launch switch, `--host-rules="MAP *.doubleclick.net ^NOTFOUND,..."`, built from `browser/adblockDomains.ts` (255 rules for 216 hosts, 7.7 kB of the Windows command line, limit 32 kB). Chrome's network stack fails those hosts instantly with `net::ERR_NAME_NOT_RESOLVED`, for every frame, worker and popup, with no CDP session, no request route, no extension, no new dependency and no change to Chrome's HTTP cache. A request to a host that is not on the list is not touched at all, so first-party requests and everything else behave as before.

- **Kill switch**: `T3CODE_PERSONAL_BROWSER_ADBLOCK=off` (also `0`, `false`, `no`), applied by the usual idle restart. Off launches Chrome with exactly today's arguments (checked on the real browser process: command line 1,646 characters, no `--host-rules`; on it is 9,334 characters).
- **Logs** (counts only, never a URL): `browser ad blocking is on` (rules) or `is off` at each launch, and one `browser ad blocking summary` (rules, requests, blocked) when that Chrome closes. A blocked request is a `net::ERR_NAME_NOT_RESOLVED` failure whose host is on the list, so real DNS failures are not counted.
- **The list** is generated, not hand-edited: hosts that EasyList, EasyPrivacy or Peter Lowe's list block as a whole, kept when a crawl of 72 popular UK/US news, recipe and shopping pages (not the pages measured below) found them contacted as a third party by at least two pages, minus sign-in, payment, bot-protection (DataDome, PerimeterX, ThreatMetrix...), CAPTCHA (reCAPTCHA, hCaptcha, Cloudflare), consent-platform, CDN and tag-manager hosts, and anything whose name says consent, privacy, login, auth, pay, checkout or account. It is a bundled snapshot, never fetched at launch. `scripts/personal/adblock/README.md` says how to refresh it. `adblock.test.ts` pins about 45 hosts that must never be blocked (Google, reCAPTCHA, hCaptcha, Turnstile, DataDome, PerimeterX, Stripe, PayPal, eBay, Amazon, Vinted, OneTrust, GTM...).
- **Not covered**: ads served from a host that is also content (first-party ads, `google.com/pagead`), and anything the host rules cannot see when Chrome is configured with a proxy (blocking then silently does nothing; the summary line would show `blocked: 0`).
- **Side effects to know**: (1) a direct visit to a listed host fails to load (an ad-network marketing site, say). (2) Some sites show an anti-adblock wall: The Sun showed "We see you're using an ad blocker" and locked scrolling in every run, caused by the 7 Google ad hosts alone (`doubleclick`, `googlesyndication`...). It has a "Continue without supporting us" link. Leaving the Google hosts out of the list removes that wall but also most of the benefit (Vinted got worse than no blocking at all, see below), so the list keeps them.

## Measured (throwaway profiles, real `driver.ts`, 390 px phone viewport at DPR 2, medians of 3 runs, cold cache, cookie banners accepted)

Evidence: `C:/Users/Ht/.personal-bots/qa/backend-adblock/` (`RESULT.md`, `RESULT-table.md`, `results*.json`, `measure.mjs`). Frames and KB are what Chrome's screencast produced in the driver, before the app's own 30 fps pacing. CPU is the whole Chrome process tree.

| page                                      | requests    | load + 20 s CPU % | idle 30 s frames / KB          | idle CPU %  | scroll frames / KB                     | scroll CPU % | time to settled frames |
| ----------------------------------------- | ----------- | ----------------- | ------------------------------ | ----------- | -------------------------------------- | ------------ | ---------------------- |
| Vinted search, off -> on                  | 2625 -> 378 | 198 -> 45         | 2 / 166 -> 0 / 0               | 24.9 -> 3.9 | 213 / 20.4 MB -> 117 / 11.2 MB         | 60 -> 30     | 12.7 s -> 5.8 s        |
| allrecipes cookies, off -> on             | 792 -> 282  | 101 -> 65         | 776 / 76.6 MB -> 833 / 86.3 MB | 64 -> 59    | 425 / 37.3 MB -> 389 / 28.8 MB         | 118 -> 71    | never -> 1.5 s         |
| eBay search (2 valid off runs), off -> on | 371 -> 220  | 46 -> 32          | 0 -> 0                         | 10 -> 6     | 153 / 13.6 MB -> 150 / 13.3 MB         | 46 -> 41     | 5.0 -> 4.7 s           |
| Daily Mail home, off -> on                | 219 -> 216  | 124 -> 106        | 1677 / 270 MB -> 1682 / 270 MB | 113 -> 96   | 501 / 80.7 MB -> 514 / 82.5 MB         | 99 -> 100    | no change              |
| The Sun home, off -> on                   | 812 -> 178  | 67 -> 27          | 0 -> 0                         | 10.6 -> 1.9 | 154 / 17.7 MB -> 0 (anti-adblock wall) | 48 -> 6      | 3.6 s -> 1.9 s         |

Reading: it clearly cuts requests and Chrome CPU on ad-heavy pages and shortens page load where ads were slowing it (Vinted, The Sun). Screencast frames and bytes fall only where ads were what repainted the page (Vinted: idle and scroll; recipe: scroll); the Daily Mail's 56 frames a second come from content, not ads, and do not change; the recipe page's idle stream is 7 % to 13 % larger with blocking (consistent over 3 runs, cause not found). eBay's baseline was throttled by eBay on its repeat runs (a block page after repeated loads of the same URL, with blocking on or off), so its off numbers are n=2.

Other approaches, same pages: Ghostery `@ghostery/adblocker-playwright` (EasyList + EasyPrivacy, request route) gave the same result on Vinted (364 requests, idle CPU 1.7 %, scroll 11.2 MB) and recipe (237 requests, scroll CPU 72 %) with network-only 234/77 %: no better than 255 host rules, and it needs a dependency, an in-memory engine and a round trip through the server per request. A CDP URL list (`Network.setBlockedURLs`) costs about 3 ms per request at 3,000 domains. An unpacked extension is not loaded by branded Chrome 154.

Works with blocking on (identical to off): reCAPTCHA demo and hCaptcha demo widgets render at full size; Cloudflare Turnstile demo gets its challenge responses (302/200/200) and token; eBay, Amazon and Vinted sign-in/landing pages render their forms; the five measured pages show their content. Nothing was typed or submitted.

## Tests and checks

- Server `vp test run src/personal` exit 0 (135 files, 1679 tests, 3 skipped); `npx tsc --noEmit` exit 0; lint and fmt clean on the touched files. Web not touched.
- `adblock.test.ts` (11 tests): kill switch variants, exactly one switch on and none off, switch fits 24,000 characters, plain host globs only, no protected host blocked, counter counts only NAME_NOT_RESOLVED on listed hosts, snapshot holds numbers only.

## Rollback

Set `T3CODE_PERSONAL_BROWSER_ADBLOCK=off` and idle-restart, or run the previous release (no migration).
