// Builds adblockDomains.ts: which ad/tracker hosts are worth a browser-wide block rule.
//   node scripts/personal/adblock/build-list.mjs <crawl-out.json> <lists dir> apps/server/src/personal/browser/adblockDomains.ts
// (see README.md for how to get the inputs)
// Input 1: filter-list domains (EasyList + EasyPrivacy `||host^` entries that block a whole host,
//          plus Peter Lowe's ad-server list), extracted by extract.mjs into domains-full.txt.
// Input 2: a crawl of popular pages: every host each page contacted.
// A host is kept when a filter list blocks it AND it is third-party to the page that contacted it.
// They are ranked by how many different pages contacted them and cut to what fits on the command line.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
const require = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const { getDomain } = require("tldts");

const [crawlFile, listsDir, outFile] = process.argv.slice(2);
const BUDGET = Number(process.env.ARG_BUDGET ?? 22000);
const filter = new Set(
  NodeFS.readFileSync(`${listsDir}/domains-full.txt`, "utf8").split("\n").filter(Boolean),
);
const crawl = JSON.parse(NodeFS.readFileSync(crawlFile, "utf8"));

// Registrable domains that are never blocked: infrastructure, sign-in, payment, bot protection, CAPTCHA, consent.
const EXEMPT_NAMES =
  `googletagmanager.com google.com gstatic.com googleapis.com googleusercontent.com youtube.com ytimg.com youtu.be googlevideo.com
recaptcha.net hcaptcha.com captcha-delivery.com arkoselabs.com funcaptcha.com geetest.com mtcaptcha.com friendlycaptcha.com
cloudflare.com cloudflare.net cloudflareinsights.com akamaihd.net akamai.net akamaized.net akamaiedge.net edgekey.net edgesuite.net fastly.net fastlylb.net
cloudfront.net amazonaws.com azureedge.net jsdelivr.net unpkg.com bootstrapcdn.com jquery.com fontawesome.com typekit.net
facebook.com facebook.net fbcdn.net twitter.com twimg.com x.com instagram.com linkedin.com licdn.com github.com githubusercontent.com
apple.com icloud.com microsoft.com microsoftonline.com live.com msn.com bing.com office.com
paypal.com paypalobjects.com braintreegateway.com braintree-api.com stripe.com stripe.network adyen.com klarna.com checkout.com worldpay.com cardinalcommerce.com
online-metrix.net threatmetrix.com datadome.co perimeterx.net px-cdn.net px-cloud.net px-client.net pxchk.net humansecurity.com forter.com riskified.com sift.com siftscience.com signifyd.com kount.com iovation.com
ebay.com ebay.co.uk ebay.de ebay.fr ebay.it ebay.es ebay.ie ebaystatic.com ebayimg.com ebaycdn.net ebayrtm.com ebaycdn.com
amazon.com amazon.co.uk amazon.de amazon.fr amazon.it amazon.es ssl-images-amazon.com media-amazon.com amazonpay.com
vinted.com vinted.co.uk vinted.net vinted.fr vinted.de
onetrust.com cookielaw.org cookiepro.com trustarc.com truste.com consensu.org sp-prod.net privacy-mgmt.com didomi.io cookiebot.com usercentrics.eu usercentrics.com osano.com iubenda.com evidon.com
auth0.com okta.com sentry.io
t.co openai.com piano.io tiqcdn.com ensighten.com adobedtm.com tealiumiq.com bbci.co.uk`
    .split(/\s+/)
    .filter(Boolean);
const EXEMPT = new Set(EXEMPT_NAMES);

const stats = new Map(); // E -> { sites:Set, requests, bare }
const pageDomains = new Set();
for (const site of Object.values(crawl)) {
  const P = site.page;
  if (!P) continue;
  pageDomains.add(P);
  for (const [host, count] of Object.entries(site.hosts)) {
    const R = getDomain(host);
    if (!R || R === P) continue; // first party
    // Broadest filter entry covering this host: walk from the registrable domain down to the host.
    const labels = host.split(".");
    const rLabels = R.split(".").length;
    let E = null;
    for (let i = labels.length - rLabels; i >= 0; i--) {
      const cand = labels.slice(i).join(".");
      if (filter.has(cand)) {
        E = cand;
        break;
      }
    }
    if (!E) continue;
    const s = stats.get(E) ?? { sites: new Set(), requests: 0, bare: false };
    s.sites.add(P);
    s.requests += count;
    if (host === E) s.bare = true;
    stats.set(E, s);
  }
}
// Hosts that look like consent, sign-in or payment infrastructure stay reachable whoever runs them.
const SENSITIVE_WORDS =
  /(^|[.-])(cmp|consent|privacy|cookie|cookies|captcha|login|signin|auth|sso|oauth|pay|payment|payments|checkout|account|accounts|secure|id)([.-]|$)/;
const exempt = (E) => {
  const R = getDomain(E) ?? E;
  return EXEMPT.has(R) || EXEMPT.has(E) || SENSITIVE_WORDS.test(E);
};
// A host only one page contacted is usually that site's own analytics endpoint, not an ad network.
const MIN_SITES = Number(process.env.MIN_SITES ?? 2);
const ranked = [...stats.entries()]
  .filter(
    ([E, st]) => st.sites.size >= MIN_SITES && !exempt(E) && !pageDomains.has(getDomain(E) ?? ""),
  )
  .sort((a, b) => b[1].sites.size - a[1].sites.size || b[1].requests - a[1].requests);
const patterns = [];
let chars = "--host-rules=".length;
const cost = (p) => "MAP ".length + p.length + " ^NOTFOUND".length + 1;
let cut = null;
for (const [E, s] of ranked) {
  const add = [`*.${E}`, ...(s.bare ? [E] : [])];
  const c = add.reduce((n, p) => n + cost(p), 0);
  if (chars + c > BUDGET) {
    cut = { E, sites: s.sites.size };
    break;
  }
  chars += c;
  patterns.push(...add);
}
const used = ranked.slice(0, patterns.filter((p) => p.startsWith("*.")).length);
console.log(
  JSON.stringify(
    {
      sites: Object.keys(crawl).length,
      candidates: ranked.length,
      kept: used.length,
      patterns: patterns.length,
      argChars: chars,
      cutAt: cut,
      exemptDropped: [...stats.keys()].filter(exempt).slice(0, 25),
      top: used.slice(0, 15).map(([E, s]) => `${E}:${s.sites.size}`),
      tail: used.slice(-5).map(([E, s]) => `${E}:${s.sites.size}`),
    },
    null,
    1,
  ),
);
const date = new Date().toISOString().slice(0, 10);
NodeFS.writeFileSync(
  outFile,
  `// Generated by scripts/personal/adblock/build-list.mjs on ${date}. Do not edit by hand; see adblock.test.ts for what must stay out.
// Source: hosts that EasyList, EasyPrivacy or Peter Lowe's ad-server list block as a whole, kept when a crawl of
// ${Object.keys(crawl).length} popular news, recipe and shopping pages found them contacted as a third party, most widespread first,
// cut to fit one Chrome command-line switch. \`*.x\` blocks every host under x, a bare \`x\` blocks that host only.
export const ADBLOCK_HOST_PATTERNS: ReadonlyArray<string> = [\n${patterns.map((p) => `  ${JSON.stringify(p)},`).join("\n")}\n];\n`,
);
NodeFS.writeFileSync(
  "adblock-ranking.json",
  JSON.stringify(
    used.map(([E, s]) => ({ E, sites: s.sites.size, requests: s.requests, bare: s.bare })),
    null,
    1,
  ),
);
