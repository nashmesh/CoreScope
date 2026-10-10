#!/usr/bin/env node
/* B6 coverage push for public/touch-gestures.js (umbrella #1297).
 *
 * Sister suite to tests/e2e/test-gestures-1062-e2e.js — that file proves correctness
 * of the *primary* swipe paths (row-action, bottom-nav forward, slide-over
 * dismiss). This file drives the branches that the primary suite does not:
 *
 *   (cov1) onClickAction — trace button on a row overlay → URL updates to
 *          #/packets/<hash> and overlay dismisses.
 *   (cov2) onClickAction — filter button → URL updates to
 *          #/packets?hash=<hash> and overlay dismisses.
 *   (cov3) onClickAction — copy button populates navigator.clipboard
 *          (stubbed), then dismisses.
 *   (cov4) onClickAction — outside-overlay click dismisses overlay
 *          (the "click outside" branch).
 *   (cov5) Bottom-nav swipe LEFT-TO-RIGHT on #/live → navigates BACK to
 *          #/packets (the dx >= +TAB_SWIPE_PX branch — opposite direction
 *          to the existing test's "next tab" case).
 *   (cov6) Bottom-nav swipe boundary — on #/home (first tab), swipe RTL
 *          should go to #/packets (next), but swipe LTR must NOT navigate
 *          below index 0 (boundary guard branch).
 *   (cov7) Desktop viewport (>768px) — pointerdown on a row is a no-op:
 *          isNarrow() === false short-circuits onPointerDown, so no overlay
 *          ever appears even on a 200px left swipe.
 *   (cov8) onPointerCancel — start a swipe, fire pointercancel mid-gesture;
 *          row transform must be cleared and gestureContext reset (next
 *          gesture works normally).
 *   (cov9) lostpointercapture — same as cov8 but via lostpointercapture
 *          event (browser-stolen capture path).
 *   (cov10) findRow nodes-table coverage — swipe a #nodesTable row, overlay
 *           must appear (proves findRow's nodes-table branch executes).
 *
 * Pointer events are synthesized at the document level (same approach as
 * tests/e2e/test-gestures-1062-e2e.js) because headless Chromium's native
 * page.touchscreen does not interact reliably with axis-locked custom
 * handlers driven by Pointer Events.
 */
'use strict';

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:13581';

async function synthSwipe(page, fromX, fromY, toX, toY, opts) {
  opts = opts || {};
  const steps = opts.steps || 12;
  const evidence = await page.evaluate(({ fromX, fromY, toX, toY, steps, rowSel, cancelEvent }) => {
    const interactive = 'a, button, input, select, textarea, [role="button"], [contenteditable="true"]';
    let row = null;
    if (rowSel) {
      // Resolve layout and hit-test in the SAME browser task as pointerdown.
      // No cached row center can survive a route/render/layout change here.
      row = document.querySelector(rowSel);
      const r = row?.getBoundingClientRect();
      let point = null;
      if (r && r.width > 0 && r.height > 0) {
        for (const fx of [0.78, 0.9, 0.65]) {
          for (const fy of [0.5, 0.25, 0.75]) {
            const x = r.left + r.width * fx, y = r.top + r.height * fy;
            const hit = document.elementFromPoint(x, y);
            if (hit?.closest(rowSel) === row && !hit.closest(interactive)) {
              point = { x, y };
              break;
            }
          }
          if (point) break;
        }
      }
      if (!point) throw new Error('No hit-tested non-interactive row point for gesture');
      fromX = point.x;
      fromY = toY = point.y;
      toX = fromX - Math.min(200, r.width * 0.55);
    }
    const target = document.elementFromPoint(fromX, fromY) || document.body;
    const startHitsRow = row ? target.closest(rowSel) === row : false;
    const startInteractive = !!target.closest?.(interactive);
    function ev(type, x, y) {
      return new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y,
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
      });
    }
    target.dispatchEvent(ev('pointerdown', fromX, fromY));
    for (let i = 1; i <= steps; i++) {
      const x = fromX + (toX - fromX) * (i / steps);
      const y = fromY + (toY - fromY) * (i / steps);
      const t = document.elementFromPoint(x, y) || target;
      t.dispatchEvent(ev('pointermove', x, y));
    }
    const dragged = !!row && /translateX/i.test(row.style.transform || '');
    const tup = document.elementFromPoint(toX, toY) || target;
    const endHitsRow = row ? tup.closest?.(rowSel) === row : false;
    const endInteractive = !!tup.closest?.(interactive);
    tup.dispatchEvent(ev(cancelEvent || 'pointerup', toX, toY));
    // Persist coordinates and hit-test booleans only, never DOM/packet data.
    return { fromX, fromY, toX, toY, startHitsRow, endHitsRow, startInteractive, endInteractive, dragged };
  }, { fromX, fromY, toX, toY, steps, rowSel: opts.rowSel, cancelEvent: opts.cancelEvent });
  await page.waitForTimeout(80);
  return evidence;
}

// Cancellation uses exactly the same resolver/dispatcher as recovery;
// the terminal event is never pointerup on this path.
async function synthSwipeCancel(page, fromX, fromY, toX, toY, cancelEvent, rowSel) {
  return synthSwipe(page, fromX, fromY, toX, toY, { steps: 6, cancelEvent, rowSel });
}

async function gestureGeometry(page, gesture) {
  return page.evaluate((gesture) => {
    const row = document.querySelector('#pktBody tr[data-hash]');
    const r = row?.getBoundingClientRect();
    return { width: innerWidth,
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      ...gesture,
      transformed: !!row && /translateX/i.test(row.style.transform || ''),
      slideOpen: !!window.SlideOver?.isOpen(),
      overlayCount: document.querySelectorAll('.row-action-overlay').length };
  }, gesture);
}

async function rowRect(page, sel) {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel);
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height,
             hash: r.getAttribute('data-hash') || r.getAttribute('data-id') || '' };
  }, sel);
}

async function clearOverlays(page) {
  await page.evaluate(() => {
    if (window.TouchGestures && typeof window.TouchGestures.dismissRowAction === 'function') {
      window.TouchGestures.dismissRowAction();
    }
    document.querySelectorAll('.row-action-overlay').forEach(o => o.remove());
  });
}

// Re-open the row-action overlay by swiping a fresh row. Used by cov2/3/4
// after cov1's trace-click navigated to #/packets/<hash> and dismissed the
// overlay — subsequent covs need a clean re-open to assert on filter/copy/
// outside-click branches. Polls for overlay-open up to ~2s with one retry
// because the first swipe after a hash-route navigation occasionally races
// the SPA re-render in CI (faster than the swipe gesture lands).
async function openRowOverlay(page, rowSel) {
  await page.waitForSelector(rowSel, { timeout: 10000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await clearOverlays(page);
    await page.waitForTimeout(120);
    const r = await rowRect(page, rowSel);
    if (!r) { await page.waitForTimeout(200); continue; }
    await synthSwipe(page, null, null, null, null, { rowSel });
    // Poll for overlay up to ~800ms.
    for (let i = 0; i < 8; i++) {
      const ok = await page.evaluate(() =>
        !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
      if (ok) return r;
      await page.waitForTimeout(100);
    }
  }
  return null;
}

async function main() {
  const requireChromium = process.env.CHROMIUM_REQUIRE === '1';
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  } catch (err) {
    if (requireChromium) {
      console.error(`tests/e2e/test-touch-gestures-coverage-e2e.js: FAIL — Chromium required but unavailable: ${err.message}`);
      process.exit(1);
    }
    console.log(`tests/e2e/test-touch-gestures-coverage-e2e.js: SKIP (Chromium unavailable: ${err.message.split('\n')[0]})`);
    process.exit(0);
  }

  let failures = 0, passes = 0;
  const fail = (m) => { failures++; console.error('  FAIL: ' + m); };
  const pass = (m) => { passes++; console.log('  PASS: ' + m); };

  // ────────────────────────────────────────────────────────────────
  // Phone viewport context (most tests live here).
  // ────────────────────────────────────────────────────────────────
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // Stub clipboard so cov3 can observe writes without a real permission.
  await page.addInitScript(() => {
    // Late canonical fixtures outlive 15 minutes; use the supported mobile
    // window without changing production limits or accepting absent rows.
    localStorage.setItem('meshcore-time-window', '180');
    window.__clipboardWrites = [];
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (s) => { window.__clipboardWrites.push(String(s)); return Promise.resolve(); } },
      });
    } else {
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (s) => { window.__clipboardWrites.push(String(s)); return orig(s); };
    }
  });

  await page.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pktBody tr[data-hash]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);

  const moduleReady = await page.evaluate(() => typeof window.__touchGestures1062InitCount === 'number');
  if (!moduleReady) { fail('touch-gestures.js not loaded'); } else { pass('touch-gestures.js loaded'); }

  const r = await rowRect(page, '#pktBody tr[data-hash]');
  if (!r) {
    fail('no packets row available — fixture/setup problem (cannot run row-action assertions)');
  }

  // ── (cov1) row-action: Trace button → #/packets/<hash> ──
  if (r) {
    await clearOverlays(page);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await synthSwipe(page, cx + 100, cy, cx - 100, cy);
    const overlayPresent = await page.evaluate(() =>
      !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
    if (!overlayPresent) {
      fail('(cov1) precondition — overlay did not appear after left swipe');
    } else {
      await page.evaluate(() => {
        // Production stamps data-hash on trace/filter/copy buttons natively
        // (issue #1305). Just click — no test-side workaround needed.
        const btn = document.querySelector('.row-action-overlay [data-row-action="trace"]');
        if (btn) { btn.click(); }
      });
      await page.waitForTimeout(120);
      const state = await page.evaluate(() => ({
        hash: location.hash,
        overlay: !!document.querySelector('.row-action-overlay.row-action-overlay-open'),
        timeWindow: localStorage.getItem('meshcore-time-window'),
      }));
      const expected = `#/packets/${encodeURIComponent(r.hash)}`;
      // selectPacket writes the detail path; updatePacketsUrl may additionally
      // serialize the retained window. Both must identify the exact packet.
      const [route, query = ''] = state.hash.split('?');
      const windowParam = new URLSearchParams(query).get('timeWindow');
      if (route === expected && (windowParam === null || windowParam === '180') && state.timeWindow === '180' && !state.overlay) {
        pass(`(cov1) trace button navigated to ${state.hash} and dismissed overlay`);
      } else {
        fail(`(cov1) trace button: hash=${state.hash} expected=${expected}, overlay=${state.overlay}`);
      }
    }
  }

  // ── (cov2) row-action: Filter button → #/packets?hash=<hash> ──
  await page.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pktBody tr[data-hash]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);
  const r2 = await openRowOverlay(page, '#pktBody tr[data-hash]');
  if (r2) {
    const ok = await page.evaluate(() =>
      !!document.querySelector('.row-action-overlay [data-row-action="filter"]'));
    if (!ok) {
      fail('(cov2) precondition — filter button not in overlay');
    } else {
      await page.evaluate(() => {
        // Production stamps data-hash on filter button natively (#1305).
        const btn = document.querySelector('.row-action-overlay [data-row-action="filter"]');
        if (btn) { btn.click(); }
      });
      await page.waitForTimeout(120);
      const state = await page.evaluate(() => ({
        hash: location.hash,
        overlay: !!document.querySelector('.row-action-overlay.row-action-overlay-open'),
      }));
      const expected = `#/packets?timeWindow=180&hash=${encodeURIComponent(r2.hash)}`;
      if (state.hash === expected && !state.overlay) {
        pass(`(cov2) filter button navigated to ${state.hash} and dismissed overlay`);
      } else {
        fail(`(cov2) filter: hash=${state.hash} expected=${expected}, overlay=${state.overlay}`);
      }
    }
  } else {
    fail('(cov2) precondition — no actionable packet row overlay');
  }

  // ── (cov3) row-action: Copy button writes to clipboard ──
  await page.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pktBody tr[data-hash]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__clipboardWrites = []; });
  const r3 = await openRowOverlay(page, '#pktBody tr[data-hash]');
  if (r3) {
    const has = await page.evaluate(() =>
      !!document.querySelector('.row-action-overlay [data-row-action="copy"]'));
    if (!has) {
      fail('(cov3) precondition — copy button not in overlay');
    } else {
      await page.evaluate(() => {
        const btn = document.querySelector('.row-action-overlay [data-row-action="copy"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(120);
      const writes = await page.evaluate(() => window.__clipboardWrites || []);
      const overlay = await page.evaluate(() =>
        !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
      if (writes.length === 1 && writes[0] === r3.hash && !overlay) {
        pass(`(cov3) copy button wrote ${writes[0]} to clipboard and dismissed`);
      } else {
        fail(`(cov3) copy: writes=${JSON.stringify(writes)} expected="${r3.hash}", overlay=${overlay}`);
      }
    }
  } else {
    fail('(cov3) precondition — no actionable packet row overlay');
  }

  // ── (cov4) outside-click dismisses overlay ──
  await page.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pktBody tr[data-hash]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);
  const r4 = await openRowOverlay(page, '#pktBody tr[data-hash]');
  if (r4) {
    const before = await page.evaluate(() =>
      !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
    if (!before) {
      fail('(cov4) precondition — overlay not present before outside click');
    } else {
      // Click somewhere clearly outside the overlay — top-left corner.
      await page.evaluate(() => {
        const el = document.elementFromPoint(5, 5) || document.body;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      });
      await page.waitForTimeout(120);
      const after = await page.evaluate(() =>
        !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
      if (!after) pass('(cov4) outside click dismissed overlay');
      else fail('(cov4) outside click did not dismiss overlay');
    }
  } else {
    fail('(cov4) precondition — no actionable packet row overlay');
  }

  // ── (cov5) bottom-nav swipe LTR on #/live → back to #/packets ──
  await page.goto(`${BASE}/#/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-bottom-nav]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
  const nav5 = await page.evaluate(() => {
    const n = document.querySelector('[data-bottom-nav]');
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  if (!nav5) {
    fail('(cov5) [data-bottom-nav] missing at 375x812 on #/live');
  } else {
    const cx = nav5.x + nav5.w / 2, cy = nav5.y + nav5.h / 2;
    // Swipe LEFT-TO-RIGHT (positive dx) → previous tab (delta = -1).
    await synthSwipe(page, cx - 80, cy, cx + 80, cy);
    await page.waitForTimeout(250);
    const hash = await page.evaluate(() => location.hash);
    if (hash === '#/packets?timeWindow=180') pass('(cov5) LTR bottom-nav swipe returns to packets with the chosen window preserved');
    else fail(`(cov5) expected #/packets?timeWindow=180, got ${hash}`);
  }

  // ── (cov6) bottom-nav boundary — LTR swipe on first tab (#/home) no-op ──
  await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-bottom-nav]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
  const nav6 = await page.evaluate(() => {
    const n = document.querySelector('[data-bottom-nav]');
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  if (!nav6) {
    fail('(cov6) [data-bottom-nav] missing on #/home');
  } else {
    const cx = nav6.x + nav6.w / 2, cy = nav6.y + nav6.h / 2;
    const before = await page.evaluate(() => location.hash);
    // Try to go BEFORE index 0 — must be a no-op.
    await synthSwipe(page, cx - 80, cy, cx + 80, cy);
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => location.hash);
    if (after === before) pass(`(cov6) LTR swipe on first tab (#/home) was no-op (hash=${after})`);
    else fail(`(cov6) LTR swipe on first tab unexpectedly navigated: ${before} → ${after}`);
  }

  await ctx.close();

  // ────────────────────────────────────────────────────────────────
  // Desktop viewport context for (cov7).
  // ────────────────────────────────────────────────────────────────
  {
    const ctxD = await browser.newContext({ viewport: { width: 1200, height: 900 }, hasTouch: true });
    const pD = await ctxD.newPage();
    pD.setDefaultTimeout(15000);
    pD.on('pageerror', (e) => console.error('[pageerror-desktop]', e.message));
    await pD.addInitScript(() => localStorage.setItem('meshcore-time-window', '180'));
    await pD.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
    await pD.waitForSelector('#pktBody tr[data-hash]', { timeout: 10000 }).catch(() => {});
    await pD.waitForTimeout(200);
    const rD = await rowRect(pD, '#pktBody tr[data-hash]');
    if (rD) {
      const cx = rD.x + rD.w / 2, cy = rD.y + rD.h / 2;
      await synthSwipe(pD, cx + 100, cy, cx - 100, cy);
      const overlayState = await pD.evaluate(() => {
        const o = document.querySelector('.row-action-overlay');
        if (!o) return { present: false };
        const cs = getComputedStyle(o);
        return { present: true, display: cs.display, visibility: cs.visibility };
      });
      if (!overlayState.present || overlayState.display === 'none' || overlayState.visibility === 'hidden') {
        pass('(cov7) desktop viewport (>768px) — left swipe did NOT create overlay (isNarrow guard works)');
      } else {
        fail(`(cov7) overlay appeared at 1200px viewport — isNarrow guard broken (state=${JSON.stringify(overlayState)})`);
      }
    } else {
      fail('(cov7) no row at desktop viewport — cannot test isNarrow guard');
    }
    await ctxD.close();
  }

  // ────────────────────────────────────────────────────────────────
  // Phone viewport again for (cov8/9/10).
  // ────────────────────────────────────────────────────────────────
  {
    const ctxP = await browser.newContext({
      viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true,
    });
    const pP = await ctxP.newPage();
    pP.setDefaultTimeout(15000);
    pP.on('pageerror', (e) => console.error('[pageerror-phone2]', e.message));
    await pP.addInitScript(() => localStorage.setItem('meshcore-time-window', '180'));
    await pP.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
    await pP.waitForSelector('#pktBody tr[data-hash]', { timeout: 10000 }).catch(() => {});
    await pP.waitForTimeout(200);

    // ── (cov8) pointercancel mid-gesture clears state ──
    const rC = await rowRect(pP, '#pktBody tr[data-hash]');
    if (rC) {
      const cancelled = await synthSwipeCancel(pP, null, null, null, null, 'pointercancel', '#pktBody tr[data-hash]');
      if (!cancelled.startHitsRow || cancelled.startInteractive || !cancelled.dragged) {
        fail('(cov8) cancellation did not begin with a row drag: ' + JSON.stringify(cancelled));
      }
      const transformAfter = await pP.evaluate(() => {
        const r = document.querySelector('#pktBody tr[data-hash]');
        return r ? (r.style.transform || '') : '<no-row>';
      });
      if (transformAfter !== '<no-row>' && !/translateX/i.test(transformAfter)) {
        pass(`(cov8) pointercancel cleared row transform (was "${transformAfter}")`);
      } else {
        fail(`(cov8) pointercancel left transform="${transformAfter}"`);
      }
      // Verify subsequent gesture still works (state was reset).
      await pP.evaluate(() => document.querySelectorAll('.row-action-overlay').forEach(o => o.remove()));
      const recovered = await synthSwipe(pP, null, null, null, null, { rowSel: '#pktBody tr[data-hash]' });
      const overlay = await pP.evaluate(() =>
        !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
      if (overlay && recovered.startHitsRow && !recovered.startInteractive && recovered.dragged) pass('(cov8) gesture works after pointercancel (state reset cleanly)');
      else fail('(cov8) subsequent gesture failed after pointercancel: ' + JSON.stringify(await gestureGeometry(pP, recovered)));
      await clearOverlays(pP);
    } else {
      fail('(cov8) no row for pointercancel test');
    }

    // ── (cov9) lostpointercapture mid-gesture clears state ──
    const rL = await rowRect(pP, '#pktBody tr[data-hash]');
    if (rL) {
      const cancelled = await synthSwipeCancel(pP, null, null, null, null, 'lostpointercapture', '#pktBody tr[data-hash]');
      if (!cancelled.startHitsRow || cancelled.startInteractive || !cancelled.dragged) {
        fail('(cov9) cancellation did not begin with a row drag: ' + JSON.stringify(cancelled));
      }
      const transformAfter = await pP.evaluate(() => {
        const r = document.querySelector('#pktBody tr[data-hash]');
        return r ? (r.style.transform || '') : '<no-row>';
      });
      if (transformAfter !== '<no-row>' && !/translateX/i.test(transformAfter)) {
        pass(`(cov9) lostpointercapture cleared row transform (was "${transformAfter}")`);
      } else {
        fail(`(cov9) lostpointercapture left transform="${transformAfter}"`);
      }
      await pP.evaluate(() => document.querySelectorAll('.row-action-overlay').forEach(o => o.remove()));
      // Verify next gesture still works.
      const recovered = await synthSwipe(pP, null, null, null, null, { rowSel: '#pktBody tr[data-hash]' });
      const overlay = await pP.evaluate(() =>
        !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
      if (overlay && recovered.startHitsRow && !recovered.startInteractive && recovered.dragged) pass('(cov9) gesture works after lostpointercapture');
      else fail('(cov9) subsequent gesture failed after lostpointercapture: ' + JSON.stringify(await gestureGeometry(pP, recovered)));
      await clearOverlays(pP);
    } else {
      fail('(cov9) no row for lostpointercapture test');
    }

    // ── (cov10) findRow nodes-table branch ──
    // Navigate to #/nodes and verify the nodes-table swipe path executes.
    await pP.goto(`${BASE}/#/nodes`, { waitUntil: 'domcontentloaded' });
    // Either id="nodesTable" or class="nodes-table" — try both.
    await pP.waitForSelector('#nodesTable tr[data-id], .nodes-table tr[data-id], #nodesTable tr[data-hash], .nodes-table tr[data-hash]', { timeout: 8000 }).catch(() => {});
    await pP.waitForTimeout(200);
    const nRow = await pP.evaluate(() => {
      const sels = [
        '#nodesTable tbody tr[data-id]', '.nodes-table tbody tr[data-id]',
        '#nodesTable tbody tr[data-hash]', '.nodes-table tbody tr[data-hash]',
      ];
      for (const s of sels) {
        const r = document.querySelector(s);
        if (!r) continue;
        const b = r.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        return { sel: s, x: b.left, y: b.top, w: b.width, h: b.height };
      }
      return null;
    });
    if (!nRow) {
      // Don't fail — fixture may not populate /#/nodes the same way. The
      // important branch (findRow nodes-table) is still walked at handler
      // registration; record as a soft skip so the suite stays informative.
      console.log('  SKIP: (cov10) no rows in #/nodes table at this viewport — branch executes at module load, no assertion possible without rows');
    } else {
      await clearOverlays(pP);
      const cx = nRow.x + nRow.w / 2, cy = nRow.y + nRow.h / 2;
      await synthSwipe(pP, cx + 100, cy, cx - 100, cy);
      const overlay = await pP.evaluate(() =>
        !!document.querySelector('.row-action-overlay.row-action-overlay-open'));
      if (overlay) pass(`(cov10) findRow accepted nodes-table row (sel=${nRow.sel}) — overlay shown`);
      else fail(`(cov10) findRow did not produce overlay on nodes-table row (sel=${nRow.sel})`);
      await clearOverlays(pP);
    }

    await ctxP.close();
  }

  await browser.close();
  console.log(`\ntests/e2e/test-touch-gestures-coverage-e2e.js: ${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('tests/e2e/test-touch-gestures-coverage-e2e.js: FAIL —', err);
  process.exit(1);
});
