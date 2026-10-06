// Training crawl: which third-party hosts do popular UK/US news, recipe and shopping pages contact?
// The pages used to measure the list (dailymail, allrecipes, ebay, vinted, thesun) are deliberately NOT in this list.
//   node scripts/personal/adblock/crawl.mjs   (writes crawl-out.json in the current directory, uses ./prof-crawl)
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
const require = NodeModule.createRequire(
  new URL("../../../apps/server/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const { getDomain } = require("tldts");
import { acceptConsent } from "./consent.mjs";
const sites = `https://www.bbc.co.uk/news
https://www.theguardian.com/uk
https://www.telegraph.co.uk/
https://www.mirror.co.uk/
https://www.express.co.uk/
https://metro.co.uk/
https://www.standard.co.uk/
https://news.sky.com/
https://www.independent.co.uk/
https://www.cnn.com/
https://www.foxnews.com/
https://www.usatoday.com/
https://nypost.com/
https://www.forbes.com/
https://www.businessinsider.com/
https://www.buzzfeed.com/
https://www.theverge.com/
https://www.huffpost.com/
https://www.nbcnews.com/
https://www.cbsnews.com/
https://www.bbcgoodfood.com/
https://www.foodnetwork.com/
https://www.simplyrecipes.com/
https://www.delish.com/
https://tasty.co/
https://www.seriouseats.com/
https://www.jamieoliver.com/recipes/
https://www.olivemagazine.com/
https://www.tasteofhome.com/
https://www.epicurious.com/
https://www.argos.co.uk/
https://www.currys.co.uk/
https://www.johnlewis.com/
https://www.asos.com/
https://www.next.co.uk/
https://www.very.co.uk/
https://ao.com/
https://www.etsy.com/uk/
https://www.walmart.com/
https://www.target.com/
https://www.bestbuy.com/
https://www.wayfair.co.uk/
https://www.boots.com/
https://www.tesco.com/
https://www.sainsburys.co.uk/
https://www.ikea.com/gb/en/
https://www.accuweather.com/
https://weather.com/
https://www.timeanddate.com/
https://www.imdb.com/
https://www.tripadvisor.co.uk/
https://www.quora.com/
https://www.wikihow.com/Main-Page
https://www.healthline.com/
https://www.webmd.com/
https://www.mumsnet.com/
https://www.skysports.com/
https://www.espn.com/
https://www.goal.com/en
https://www.90min.com/
https://www.reuters.com/
https://www.msn.com/en-gb
https://www.dotdash.com/
https://www.rottentomatoes.com/
https://www.ign.com/
https://www.cnet.com/
https://www.zdnet.com/
https://www.techradar.com/
https://www.pcmag.com/
https://www.thetimes.co.uk/
https://www.hellomagazine.com/
https://www.glamourmagazine.co.uk/`.split("\n");
const ctx = await chromium.launchPersistentContext(NodePath.resolve("prof-crawl"), {
  channel: "chrome",
  headless: true,
  viewport: { width: 390, height: 760 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const out = {};
for (const url of sites) {
  const page = await ctx.newPage();
  const hosts = new Map();
  page.on("request", (r) => {
    try {
      const u = new URL(r.url());
      if (!/^https?:$/.test(u.protocol)) return;
      hosts.set(u.hostname, (hosts.get(u.hostname) || 0) + 1);
    } catch {}
  });
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 3000));
  const consent = await acceptConsent(page, 5000);
  await new Promise((r) => setTimeout(r, 4000));
  try {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 600);
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  const final = page.url();
  out[url] = {
    consent,
    final,
    page: getDomain(new URL(final.startsWith("http") ? final : url).hostname),
    hosts: Object.fromEntries(hosts),
  };
  console.log(url, hosts.size, Date.now() - t0, consent);
  await page.close().catch(() => {});
  NodeFS.writeFileSync("crawl-out.json", JSON.stringify(out));
}
await ctx.close();
console.log("DONE");
