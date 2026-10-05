# Browser ad-blocking list

`apps/server/src/personal/browser/adblockDomains.ts` is generated; do not edit it by hand. It is refreshed rarely (when blocked-request counts in the `browser ad blocking summary` log line drop, or a site breaks), never at launch.

1. Download the three source lists into one folder (each is public, no key):
   - `https://easylist.to/easylist/easylist.txt` -> `easylist.txt`
   - `https://easylist.to/easylist/easyprivacy.txt` -> `easyprivacy.txt`
   - `https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext` -> `pgl.txt`
2. `node scripts/personal/adblock/extract-domains.mjs <lists dir>` writes `domains-full.txt` (hosts a list blocks as a whole).
3. `node scripts/personal/adblock/crawl.mjs` loads about 70 popular news, recipe and shopping pages in a throwaway profile, accepts their cookie banners and records which hosts each contacted -> `crawl-out.json`.
4. `node scripts/personal/adblock/build-list.mjs crawl-out.json <lists dir> apps/server/src/personal/browser/adblockDomains.ts` keeps hosts a list blocks that at least two pages contacted as a third party, drops sign-in, payment, bot-protection, CAPTCHA, consent and CDN hosts, and cuts to what fits one Chrome switch.
5. `cd apps/server && vp test run src/personal/browser/adblock.test.ts`: the test pins the protected hosts that must never be blocked.
