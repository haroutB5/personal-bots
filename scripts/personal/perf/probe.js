// In-page probe for the perf bench. Injected before any app script runs, so it
// sees every long task, layout shift and React commit from the first byte.
// Plain browser JS: no imports, no build step.
(() => {
  if (window.__perf) return;
  const P = {
    marks: {},
    t0: 0,
    commits: 0,
    commitTimes: [],
    longTasks: [],
    shifts: [],
    watchers: [
      // Chats list usable: a bot row link is on screen (cold-start snapshot
      // "Your bots" or the live "Your chats" list).
      [
        "rows",
        () =>
          document.querySelector(
            'ul[aria-label="Your chats"] li a[href^="/bots/"], ul[aria-label="Your bots"] li a[href^="/bots/"]',
          ),
      ],
      // The live list (not the snapshot) has landed.
      [
        "liveRows",
        () => document.querySelector('ul[aria-label="Your chats"] li a[href^="/bots/"]'),
      ],
      // Boot splash gone: React replaced index.html's placeholder.
      ["splashGone", () => !document.getElementById("boot-shell")],
      // Chat screen shell (header) is up, before the thread has loaded.
      ["chatShell", () => document.querySelector('a[aria-label="Back to Bots"]')],
      // Chat usable: the transcript and a typeable composer are both there.
      [
        "chat",
        () =>
          document.querySelector('[role="log"]') &&
          document.querySelector('textarea[placeholder^="Message"]:not([disabled])'),
      ],
    ],
  };
  window.__perf = P;

  // React calls these on every commit when a devtools hook is present, also in
  // production builds. Counting commits is deterministic where timing is not.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() {
      return 1;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot() {
      P.commits += 1;
      P.commitTimes.push(performance.now());
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };

  const region = (node) => {
    if (!node || !node.closest) return "unknown";
    const labelled = node.closest("[aria-label],[role],header,nav,main,footer");
    if (!labelled) return node.tagName ? node.tagName.toLowerCase() : "unknown";
    return (
      labelled.getAttribute("aria-label") ||
      labelled.getAttribute("role") ||
      labelled.tagName.toLowerCase()
    ).slice(0, 40);
  };

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) P.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        const where = (entry.sources || []).map((s) => region(s.node)).join("|") || "none";
        P.shifts.push([entry.startTime, entry.value, where]);
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}

  const visible = (node) => {
    if (!node || node === true) return !!node;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
  };
  // Checked once per frame, after that frame's layout has run (a message
  // posted from rAF lands after paint), so the probe never forces a layout
  // itself. The mark is the frame's rAF time: when that content painted.
  //
  // chatShell only: the element must already be in the DOM at the frame's rAF.
  // A tap's click task can run between a frame's rAF and its post-paint check;
  // the header it inserts then paints in the NEXT frame, but the check saw it
  // and recorded the earlier frame's time, before the tap had even been
  // handled (J2.chatShell read 120-200 ms or 325-385 ms at random, 2026-09-30).
  // Presence is read in rAF with querySelector only (no layout), and the mark
  // is the start of the first frame the header was in the DOM for.
  const PRESENT_AT_RAF = new Set(["chatShell"]);
  const presentAt = {};
  const channel = new MessageChannel();
  let frameAt = 0;
  channel.port1.addEventListener("message", () => {
    for (const [name, find] of P.watchers) {
      if (P.marks[name] !== undefined) continue;
      if (PRESENT_AT_RAF.has(name) && presentAt[name] === undefined) continue;
      let hit = false;
      try {
        hit = visible(find());
      } catch {}
      if (hit) P.marks[name] = PRESENT_AT_RAF.has(name) ? presentAt[name] : frameAt;
    }
  });
  channel.port1.start();
  const tick = (at) => {
    frameAt = at;
    for (const [name, find] of P.watchers) {
      if (!PRESENT_AT_RAF.has(name) || P.marks[name] !== undefined) continue;
      if (presentAt[name] !== undefined) continue;
      try {
        if (find()) presentAt[name] = at;
      } catch {}
    }
    channel.port2.postMessage(0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // A tap starts an in-app journey; the bench resets marks just before it.
  P.reset = () => {
    P.t0 = performance.now();
    P.marks = {};
    for (const name of Object.keys(presentAt)) delete presentAt[name];
    P.commits = 0;
    P.commitTimes = [];
  };
})();
