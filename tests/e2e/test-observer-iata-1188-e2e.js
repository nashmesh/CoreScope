/**
 * E2E test (#1188): observer IATA must render alongside observer name
 * on packets rows and in the detail pane. Plus, the wireshark-style
 * filter grammar must accept `observer_iata` / `iata` expressions.
 *
 * Runs against the e2e fixture (see test-fixtures/e2e-fixture.db).
 * Observers in the fixture carry IATA codes (e.g. SJC, OAK, MRY),
 * so once the UI changes land, at least one rendered packet row must
 * carry one of those codes next to its observer name.
 *
 * Usage: BASE_URL=http://localhost:13581 node tests/e2e/test-observer-iata-1188-e2e.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let diagnosticPage;

async function captureTableLayout() {
  if (!diagnosticPage) return;
  const metrics = await diagnosticPage.evaluate(() => {
    const measure = el => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      return { tag: el.tagName, display: style.display, visibility: style.visibility,
        width: box.width, height: box.height, x: box.x, y: box.y,
        hidden: el.hidden, inPacketsPage: !!el.closest('#page-packets') };
    };
    const rows = [...document.querySelectorAll('table tbody tr:not([id^=vscroll])')];
    return { viewport: { width: innerWidth, height: innerHeight }, rowCount: rows.length,
      tables: [...document.querySelectorAll('table')].map(measure),
      rows: rows.slice(0, 3).map(row => {
        const ancestors = [];
        for (let el = row.parentElement; el && ancestors.length < 8; el = el.parentElement)
          ancestors.push(measure(el));
        return { ...measure(row), cells: [...row.cells].map(measure), ancestors };
      }) };
  }).catch(() => ({ probeUnavailable: true }));
  // Geometry and visibility only: never persist DOM text, raw attributes,
  // packet identities, URLs, or client/network details.
  console.log('IATA layout evidence:', JSON.stringify(metrics));
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    console.log(`  \u274c ${name}: ${err.message}`);
    await captureTableLayout();
    process.exit(1);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  diagnosticPage = page;
  page.setDefaultTimeout(15000);

  console.log(`\nRunning observer-IATA E2E tests against ${BASE}\n`);

  await test('Packets table renders an IATA badge in an observer cell', async () => {
    await page.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
    // Wide time window so fixture rows are in scope
    await page.evaluate(() => localStorage.setItem('meshcore-time-window', '525600'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('[data-loaded="true"]', { timeout: 20000 });
    await page.waitForSelector('table tbody tr:not([id^=vscroll])', { timeout: 15000 });

    // Cells in the Observer column should contain a `.badge-iata` element
    // for at least one row that has a known IATA.
    const iataBadges = await page.$$('td.col-observer .badge-iata');
    assert(iataBadges.length > 0,
      `expected at least one .badge-iata inside a .col-observer cell; got ${iataBadges.length}`);

    // The badge text should be a recognizable IATA code (3 uppercase letters)
    const text = (await iataBadges[0].textContent() || '').trim();
    assert(/^[A-Z]{3}$/.test(text), `expected 3-letter IATA in badge, got "${text}"`);
  });

  await test('Filter grammar: observer_iata == "<code>" narrows the table', async () => {
    await page.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-loaded="true"]', { timeout: 20000 });
    await page.waitForSelector('table tbody tr:not([id^=vscroll])', { timeout: 15000 });

    // Pick the first IATA shown in any badge in the table
    const firstBadge = await page.$('td.col-observer .badge-iata');
    assert(firstBadge, 'no .badge-iata found to pick a filter value from');
    const iata = (await firstBadge.textContent() || '').trim();
    assert(/^[A-Z]{3}$/.test(iata), `expected IATA, got "${iata}"`);

    // Apply the filter — `iata == "XXX"` should leave rows visible
    const input = await page.$('#packetFilterInput');
    assert(input, 'packet filter input not found');
    await input.fill(`iata == "${iata}"`);
    await page.waitForTimeout(500); // debounce

    const rowsAfter = await page.$$('table tbody tr:not([id^=vscroll])');
    assert(rowsAfter.length > 0, `expected matching rows for iata == "${iata}"`);

    // Every remaining observer cell should carry the same IATA
    const badges = await page.$$('td.col-observer .badge-iata');
    for (const b of badges) {
      const t = (await b.textContent() || '').trim();
      assert(t === iata, `unexpected IATA ${t} in row when filter is iata == "${iata}"`);
    }
  });

  await test('Mobile viewport (375px): observer column drops from row, but IATA badge still appears in expanded detail panel (#1415 locked spec)', async () => {
    // #1415 locked column-priority spec: col-observer is tier-3 (desktop only,
    // hidden ≤1024px). The iron rule: anything hidden from the row at the
    // current viewport MUST appear in the expanded Details pane. So at 375px:
    //   (a) `td.col-observer` is hidden (display:none via .col-hidden)
    //   (b) tapping a row opens the panel whose .detail-meta carries the
    //       Observer row + .badge-iata next to the observer name.
    const mobile = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mpage = await mobile.newPage();
    diagnosticPage = mpage;
    mpage.setDefaultTimeout(15000);
    await mpage.goto(`${BASE}/#/packets`, { waitUntil: 'domcontentloaded' });
    // Mobile intentionally rejects windows above 180 minutes and resets them
    // to 15. A late canonical entry outlives that 15-minute fixture freshness;
    // use the supported mobile window instead of weakening the production cap.
    await mpage.evaluate(() => localStorage.setItem('meshcore-time-window', '180'));
    await mpage.reload({ waitUntil: 'load' });
    await mpage.waitForSelector('[data-loaded="true"]', { timeout: 20000 });
    await mpage.waitForSelector('table tbody tr:not([id^=vscroll])', { timeout: 15000 });

    // (a) observer column hidden in the row at 375px
    const rowObserverVisible = await mpage.$eval(
      'td.col-observer',
      el => window.getComputedStyle(el).display !== 'none'
    ).catch(() => false);
    assert(!rowObserverVisible,
      'observer column should be hidden in rows at 375px (tier-3, desktop-only per #1415 spec)');

    // (b) tap first row → detail panel renders observer + IATA badge
    // A live/virtualized table can replace rows after load. A locator re-resolves
    // the current row instead of clicking a detached ElementHandle snapshot.
    const firstRow = mpage.locator('#pktBody tr[data-hash]').first();
    assert(await firstRow.count(), 'no packet row found to tap');
    await firstRow.click();
    await mpage.waitForSelector('.detail-meta', { timeout: 10000 });
    const detailIata = await mpage.$('.detail-meta .badge-iata');
    assert(detailIata, '.badge-iata must appear in .detail-meta after tapping a row at 375px');
    const box = await detailIata.boundingBox();
    assert(box && box.width > 0 && box.height > 0,
      `.detail-meta .badge-iata has zero/no dimensions: ${box && (box.width + 'x' + box.height)}`);
    await mobile.close();
  });

  await browser.close();
  console.log(`\nAll observer-IATA E2E tests passed.\n`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
