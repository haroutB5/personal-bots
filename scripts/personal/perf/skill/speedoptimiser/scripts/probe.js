// In-page probe (speedoptimiser skill). Injected before any page script, so it
// sees every long task, layout shift and React commit from the first byte.
// Marks: for each selector in window.__perfSelectors, the paint time of the
// first frame in which it exists with a box.
(() => {
  if (window.__perf) return;
  const selectors = window.__perfSelectors || [];
  const P = { marks: {}, commitTimes: [], longTasks: [], shifts: [] };
  window.__perf = P;
  P.resetMark = () => {
    P.marks = {};
  };

  // React calls these on every commit when a devtools hook exists, also in
  // production builds. Harmless for other frameworks.
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onScheduleFiberRoot() {},
      onCommitFiberRoot() {
        P.commitTimes.push(performance.now());
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  }

  const region = (node) => {
    const el =
      node && node.closest
        ? node.closest("[aria-label],[role],header,nav,main,footer,section")
        : null;
    if (!el) return node && node.tagName ? node.tagName.toLowerCase() : "unknown";
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("role") ||
      el.tagName.toLowerCase()
    ).slice(0, 40);
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        P.shifts.push([
          e.startTime,
          e.value,
          (e.sources || []).map((s) => region(s.node)).join("|") || "none",
        ]);
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}

  // Checked after each frame's layout (a message posted from rAF lands after
  // paint), so the probe never forces a layout of its own.
  const channel = new MessageChannel();
  let frameAt = 0;
  channel.port1.addEventListener("message", () => {
    for (const selector of selectors) {
      if (P.marks[selector] !== undefined) continue;
      const node = document.querySelector(selector);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) P.marks[selector] = frameAt;
    }
  });
  channel.port1.start();
  const tick = (at) => {
    frameAt = at;
    channel.port2.postMessage(0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
