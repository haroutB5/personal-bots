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
  const channel = new MessageChannel();
  let frameAt = 0;
  channel.port1.addEventListener("message", () => {
    for (const [name, find] of P.watchers) {
      if (P.marks[name] !== undefined) continue;
      let hit = false;
      try {
        hit = visible(find());
      } catch {}
      if (hit) P.marks[name] = frameAt;
    }
  });
  channel.port1.start();
  const tick = (at) => {
    frameAt = at;
    channel.port2.postMessage(0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // A tap starts an in-app journey; the bench resets marks just before it.
  P.reset = () => {
    P.t0 = performance.now();
    P.marks = {};
    P.commits = 0;
    P.commitTimes = [];
  };
})();
