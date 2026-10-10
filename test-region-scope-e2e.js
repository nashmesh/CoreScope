#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, 'public');
let savedPayload = null;
let delayNextDefinitions = false;
let failCounties = false;
let failAdminDefinitions = false;
let definitionRequestCount = 0;
const definitions = [
  { name: '#tn', color: '#12abef', description: '<img src=x onerror=alert(1)> Tennessee', geometry: { type: 'Polygon', coordinates: [[[-90, 34], [-81, 34], [-81, 37], [-90, 37], [-90, 34]]] } },
  { name: '#middle', parentName: '#tn', description: 'Middle Tennessee', geometry: { type: 'Polygon', coordinates: [[[-88, 35], [-85, 35], [-85, 37], [-88, 37], [-88, 35]]] } },
  { name: '#manual', description: 'Manual option' },
  { name: '#us-ky', description: 'Kentucky', geometry: { type: 'Polygon', coordinates: [[[-89.6, 36.5], [-82, 36.5], [-82, 39.2], [-89.6, 39.2], [-89.6, 36.5]]] } },
];

function send(response, status, type, body) {
  response.writeHead(status, { 'Content-Type': type });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/config/hash-region-definitions') {
    definitionRequestCount++;
    const reply = () => send(response, 200, 'application/json', JSON.stringify(definitions));
    if (delayNextDefinitions) {
      delayNextDefinitions = false;
      setTimeout(reply, 300);
    } else {
      reply();
    }
    return;
  }
  if (url.pathname === '/api/config/client') {
    return send(response, 200, 'application/json', JSON.stringify({
      map: {
        tiles: {
          lightDefault: 'osm-standard',
          darkDefault: 'osm-dark',
          providers: { carto: { enabled: false }, osm: { enabled: true } },
        },
      },
    }));
  }
  if (url.pathname === '/geo/us-counties.geojson' && failCounties) {
    return send(response, 503, 'application/json', JSON.stringify({ error: 'county fixture unavailable' }));
  }
  if (url.pathname === '/api/admin/me') return send(response, 200, 'application/json', JSON.stringify({ username: 'test', role: 'super_admin' }));
  if (url.pathname === '/api/admin/hash-regions') {
    if (request.method === 'PUT') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        savedPayload = JSON.parse(body);
        send(response, 200, 'application/json', '{}');
      });
      return;
    }
    if (failAdminDefinitions) return send(response, 503, 'application/json', JSON.stringify({ error: 'definitions unavailable' }));
    const persisted = savedPayload || { hashRegions: definitions.map(d => d.name), hashRegionDefinitions: definitions };
    return send(response, 200, 'application/json', JSON.stringify(persisted));
  }
  if (url.pathname.startsWith('/api/')) return send(response, 200, 'application/json', '{}');

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin/hash-regions') pathname = '/admin/hash-regions.html';
  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(response, 404, 'text/plain', 'not found');
  const ext = path.extname(file);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/geo+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  let body = fs.readFileSync(file);
  if (ext === '.html') body = Buffer.from(body.toString().replaceAll('__BUST__', 'test'));
  send(response, 200, types[ext] || 'application/octet-stream', body);
});

async function clipboardText(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base + '/#/tools', { waitUntil: 'domcontentloaded' });
    assert.strictEqual(await page.locator('.nav-link[data-route="region-scope"]').count(), 0, 'helper has no standalone desktop navigation tab');
    const helperCard = page.locator('a.tools-card[href="#/tools/region-scope"]');
    await helperCard.waitFor();
    await helperCard.click();
    await page.getByRole('heading', { name: 'Region Scope Helper' }).waitFor();
    assert.strictEqual(await page.locator('.nav-link[data-route="tools"]').evaluate(node => node.classList.contains('active')), true, 'helper route highlights the parent Tools tab');
    await page.locator('#region-scope-list .region-scope-item').first().waitFor();
    assert.strictEqual(await page.locator('#region-scope-list img').count(), 0, 'description HTML is not interpreted');
    assert.match(await page.locator('#region-scope-list').textContent(), /<img src=x onerror=alert\(1\)> Tennessee/);
    const regionColors = await page.locator('#region-scope-list .region-scope-item').evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue('--region-scope-color')));
    assert.strictEqual(new Set(regionColors).size, regionColors.length, 'visible regions receive distinct colors');
    assert.strictEqual(regionColors.every(Boolean), true, 'every region card exposes its color');
    assert.strictEqual(await page.getByLabel('Select #tn').evaluate(node => node.closest('.region-scope-item').style.getPropertyValue('--region-scope-color')), '#12abef', 'saved admin color overrides the automatic palette');
    const collapsedThemeColorCount = await page.evaluate(() => {
      const root = document.documentElement;
      const anchors = ['--accent', '--warning', '--success', '--status-purple', '--danger', '--status-info', '--status-orange', '--link-color'];
      const previous = anchors.map(name => root.style.getPropertyValue(name));
      anchors.forEach(name => root.style.setProperty(name, '#123456'));
      const colors = Array.from({ length: 100 }, (_, index) => {
        const probe = document.createElement('span');
        probe.style.color = RegionScopeHelpers.regionColorToken(index, 100);
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      anchors.forEach((name, index) => previous[index] ? root.style.setProperty(name, previous[index]) : root.style.removeProperty(name));
      return new Set(colors).size;
    });
    assert.strictEqual(collapsedThemeColorCount, 100, 'automatic colors remain distinct when custom theme anchors are identical');
    const boundaryColors = JSON.parse(await page.locator('#region-scope-map').getAttribute('data-boundary-colors'));
    assert.strictEqual(boundaryColors.length, 3, 'map records one rendered color per saved boundary');
    assert.strictEqual(boundaryColors.some(color => /var\(|color-mix/.test(color)), false, 'Canvas boundaries receive concrete computed colors');

    await page.locator('#region-scope-list').evaluate(node => { node.style.maxHeight = '90px'; });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(() => /More regions below/.test(document.querySelector('#region-scope-list-cue').textContent));
    assert.strictEqual(await page.locator('#region-scope-list-frame').getAttribute('data-scrollable'), 'true', 'overflowing available regions is explicitly marked scrollable');
    await page.locator('#region-scope-list').evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => /End of region list/.test(document.querySelector('#region-scope-list-cue').textContent));
    await page.locator('#region-scope-list').evaluate(node => { node.style.maxHeight = ''; node.scrollTop = 0; });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));

    const home = page.getByLabel('Optional home region');
    const defaultScope = page.getByLabel('Optional default scope');
    assert.strictEqual(await home.inputValue(), '', 'home has no default choice');
    assert.strictEqual(await defaultScope.inputValue(), '', 'default scope has no default choice');
    assert.deepStrictEqual(await home.locator('option').allTextContents(), ['No choice'], 'selectors only offer selected regions');

    const publicMapBox = await page.locator('#region-scope-map').boundingBox();
    await page.mouse.click(publicMapBox.x + publicMapBox.width / 2, publicMapBox.y + publicMapBox.height / 2);
    await page.getByText(/direct boundary match/).first().waitFor();
    const clickedLatitude = Number(await page.getByLabel('Latitude').inputValue());
    const clickedLongitude = Number(await page.getByLabel('Longitude').inputValue());
    assert(clickedLatitude >= 34 && clickedLatitude <= 37, `public map click updates latitude inside saved boundary: ${clickedLatitude}`);
    assert(clickedLongitude >= -90 && clickedLongitude <= -81, `public map click updates longitude inside saved boundary: ${clickedLongitude}`);

    await page.getByLabel('Latitude').fill('35.85');
    await page.getByLabel('Longitude').fill('-86.4');
    await page.getByLabel('Longitude').press('Enter');
    await page.getByText(/direct boundary match/).first().waitFor();
    assert.match(await page.locator('#region-scope-status').textContent(), /2 direct boundary matches, 0 required ancestors/);
    assert.deepStrictEqual(await home.locator('option').allTextContents(), ['No choice', '#middle', '#tn'], 'selected regions populate explicit selectors');

    await page.getByLabel('Latitude').fill('36.30');
    await page.getByLabel('Longitude').fill('-87.35');
    await page.getByRole('button', { name: 'Recommend regions' }).click();
    await page.getByText(/Nearby border: about .* km away \(not selected\)/).waitFor();
    assert.strictEqual(await page.getByLabel('Select #us-ky').isChecked(), false, 'nearby Kentucky is suggested without imposing forwarding policy');

    await page.getByLabel('Latitude').fill('35.85');
    await page.getByLabel('Longitude').fill('-86.4');
    await page.getByRole('button', { name: 'Recommend regions' }).click();

    const middle = page.getByLabel('Select #middle');
    await middle.uncheck();
    assert.strictEqual(await middle.isChecked(), false, 'manual removal suppresses the current recommendation');
    await page.getByLabel('Latitude').fill('35.9');
    await page.getByLabel('Longitude').fill('-86.5');
    await page.getByRole('button', { name: 'Recommend regions' }).click();
    assert.strictEqual(await middle.isChecked(), true, 'manual removal resets when the proposed location changes');

    const mutations = await page.locator('#region-scope-mutations').textContent();
    assert.match(mutations, /region def #tn #middle/);
    assert.doesNotMatch(mutations, /region put/, 'helper uses the current one-line hierarchy command');
    assert.doesNotMatch(mutations, /region (home|default|save)/, 'primary mutation stage excludes optional and persistence commands');
    assert.strictEqual((await page.locator('#region-scope-verification').textContent()).trim(), 'region');
    assert.strictEqual((await page.locator('#region-scope-save-command').textContent()).trim(), 'region save');

    await home.selectOption('#tn');
    await defaultScope.selectOption('#middle');
    const optional = await page.locator('#region-scope-home-default-commands').textContent();
    assert.match(optional, /region home #tn/);
    assert.match(optional, /region default #middle/);
    assert.match(await page.locator('.region-scope-card').nth(1).textContent(), /persists immediately/);

    await page.getByRole('button', { name: 'Copy region def' }).click();
    assert.match(await clipboardText(page), /^region def /, 'one-shot hierarchy copy uses region def');
    assert.doesNotMatch(await clipboardText(page), /region (home|default|save|put)/, 'hierarchy copy is staged');
    await page.getByRole('button', { name: 'Copy verification' }).click();
    assert.strictEqual(await clipboardText(page), 'region', 'verification copy is staged');
    await page.getByRole('button', { name: 'Copy optional choices' }).click();
    assert.match(await clipboardText(page), /region default #middle/, 'optional copy is staged');
    await page.getByRole('button', { name: 'Copy save' }).click();
    assert.strictEqual(await clipboardText(page), 'region save', 'save copy is staged');

    const manual = page.getByLabel('Select #manual');
    await manual.check();
    await page.getByLabel('Latitude').fill('0');
    await page.getByLabel('Longitude').fill('0');
    await page.getByRole('button', { name: 'Recommend regions' }).click();
    await page.getByText(/Prior automatic geography was cleared/).waitFor();
    assert.strictEqual(await manual.isChecked(), true, 'manual addition survives a changed/outside location');
    assert.strictEqual(await page.getByLabel('Select #tn').isChecked(), false, 'old automatic geography does not accumulate');
    assert.strictEqual(await page.getByLabel('Select #middle').isChecked(), false, 'old automatic descendants do not accumulate');
    assert.match(await page.locator('#region-scope-mutations').textContent(), /region def #manual/);
    assert.doesNotMatch(await page.locator('#region-scope-mutations').textContent(), /#tn|#middle/);

    const cachedRequestCount = definitionRequestCount;
    await page.goto(base + '/#/tools');
    await page.goto(base + '/#/tools/region-scope');
    await page.locator('#region-scope-list .region-scope-item').first().waitFor();
    assert.strictEqual(definitionRequestCount, cachedRequestCount, 'unchanged definitions are cached across helper route mounts');
    await page.evaluate(() => localStorage.setItem('corescope-hash-regions-version', String(Date.now())));
    await page.goto(base + '/#/tools');
    await page.goto(base + '/#/tools/region-scope');
    await page.locator('#region-scope-list .region-scope-item').first().waitFor();
    assert.strictEqual(definitionRequestCount, cachedRequestCount + 1, 'admin-save version invalidation refreshes definitions on the next helper mount');

    const loadingContext = await browser.newContext();
    const loadingPage = await loadingContext.newPage();
    delayNextDefinitions = true;
    await loadingPage.goto(base + '/#/tools/region-scope', { waitUntil: 'domcontentloaded' });
    await loadingPage.getByText(/Loading saved region definitions/).waitFor();
    const loadingMapBox = await loadingPage.locator('#region-scope-map').boundingBox();
    await loadingPage.mouse.click(loadingMapBox.x + loadingMapBox.width / 2, loadingMapBox.y + loadingMapBox.height / 2);
    await loadingPage.locator('#region-scope-list .region-scope-item').first().waitFor();
    assert.strictEqual(await loadingPage.getByLabel('Select #tn').isChecked(), true, 'location chosen during definition loading is recomputed when definitions arrive');
    await loadingContext.close();

    const raceContext = await browser.newContext();
    const racePage = await raceContext.newPage();
    delayNextDefinitions = true;
    await racePage.goto(base + '/#/tools/region-scope', { waitUntil: 'domcontentloaded' });
    await racePage.goto(base + '/#/tools');
    await racePage.goto(base + '/#/tools/region-scope');
    await racePage.locator('#region-scope-list .region-scope-item').first().waitFor();
    await racePage.waitForTimeout(450);
    assert.strictEqual(await racePage.locator('#region-scope-list .region-scope-item').count(), 4, 'teardown/remount ignores stale fetch and does not append duplicates');
    await raceContext.close();

    await page.goto(base + '/#/tools');
    await page.evaluate(() => {
      window.__tileListenerCounts = { added: 0, removed: 0 };
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      window.addEventListener = function (type, listener, options) {
        if (type === 'mc-tile-provider-changed') window.__tileListenerCounts.added++;
        return add(type, listener, options);
      };
      window.removeEventListener = function (type, listener, options) {
        if (type === 'mc-tile-provider-changed') window.__tileListenerCounts.removed++;
        return remove(type, listener, options);
      };
    });
    await page.goto(base + '/#/tools/region-scope');
    await page.locator('#region-scope-list .region-scope-item').first().waitFor();
    await page.goto(base + '/#/tools');
    assert.deepStrictEqual(await page.evaluate(() => window.__tileListenerCounts), { added: 1, removed: 1 }, 'tile provider listener is removed on route teardown');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mc-tile-provider-changed')));

    await page.goto(base + '/admin/hash-regions', { waitUntil: 'domcontentloaded' });
    await page.locator('.region-definition-card').first().waitFor();
    assert.strictEqual(await page.locator('.region-definition-card').count(), 4);
    assert.deepStrictEqual(await page.locator('.region-definition-card input[id^="region-name-"]').evaluateAll(nodes => nodes.map(node => node.value)), ['#tn', '#middle', '#manual', '#us-ky'], 'admin rows render each parent immediately before its children');
    assert.strictEqual(await page.locator('.region-definition-card').nth(1).getAttribute('aria-label'), 'Child region level 1: #middle', 'child depth is exposed accessibly');
    assert.strictEqual(await page.locator('input[type="color"]').first().inputValue(), '#12abef', 'admin color picker loads the saved region color');
    await page.waitForFunction(() => {
      const tile = document.querySelector('#geometry-map .leaflet-tile');
      return tile && /tile\.openstreetmap\.org/.test(tile.src);
    });

    const rootName = page.locator('#region-name-0');
    await rootName.fill('#tennessee');
    await rootName.blur();
    assert.strictEqual(await page.locator('#region-parent-1').inputValue(), '#tennessee', 'rename updates child parent in the live form');
    assert.deepStrictEqual(await page.locator('#region-parent-0 option').allTextContents(), ['Wildcard root (*)', '#manual', '#us-ky'], 'parent choices exclude self and descendants');
    await rootName.fill('#tn');
    await rootName.blur();

    await page.getByRole('button', { name: 'Edit boundary' }).first().click();
    await page.locator('#state-select').selectOption(['TN', 'KY', 'AL']);
    await page.locator('#county-select').selectOption({ label: 'TN — Davidson County' });
    await page.locator('#county-select').selectOption([
      { label: 'TN — Davidson County' },
      { label: 'KY — Christian County' },
      { label: 'AL — Madison County' },
    ]);
    await page.getByRole('button', { name: 'Use selected counties' }).click();
    const crossStateGeometry = JSON.parse(await page.locator('#geojson-import').inputValue());
    assert.strictEqual(crossStateGeometry.type, 'MultiPolygon', 'counties from multiple states create one region boundary');
    assert.ok(crossStateGeometry.coordinates.length >= 3, 'cross-state county selection preserves every selected county polygon');
    await page.getByRole('button', { name: 'Clear boundary' }).click();
    await page.getByRole('button', { name: 'Draw polygon' }).click();
    const mapBox = await page.locator('#geometry-map').boundingBox();
    const sampleX = mapBox.x + mapBox.width * 0.35;
    const sampleY = mapBox.y + mapBox.height * 0.35;
    await page.mouse.click(sampleX, sampleY);
    const clickPoint = (await page.locator('#geometry-coordinates').inputValue()).trim();
    await page.getByRole('button', { name: 'Clear boundary' }).click();
    await page.getByRole('button', { name: 'Draw polygon' }).click();
    await page.locator('#freehand-mode').check();
    await page.mouse.move(sampleX, sampleY);
    await page.mouse.down();
    await page.mouse.move(sampleX + 20, sampleY + 20, { steps: 3 });
    await page.mouse.up();
    const freehandPoint = (await page.locator('#geometry-coordinates').inputValue()).trim().split('\n')[0];
    const parseCoordinate = value => value.split(',').map(Number);
    const clickCoordinate = parseCoordinate(clickPoint);
    const freehandCoordinate = parseCoordinate(freehandPoint);
    assert(Math.abs(clickCoordinate[0] - freehandCoordinate[0]) < 0.05 && Math.abs(clickCoordinate[1] - freehandCoordinate[1]) < 0.05,
      `freehand starts at pointer location: click=${clickPoint} freehand=${freehandPoint}`);
    await page.locator('#freehand-mode').uncheck();

    const polygonWithHole = { type: 'Polygon', coordinates: [
      [[-90, 35], [-88, 35], [-88, 37], [-90, 37], [-90, 35]],
      [[-89.7, 35.3], [-89.4, 35.3], [-89.4, 35.6], [-89.7, 35.6], [-89.7, 35.3]],
    ] };
    await page.locator('#geojson-import').fill(JSON.stringify(polygonWithHole));
    await page.getByRole('button', { name: 'Import GeoJSON' }).click();
    const firstVertex = await page.locator('#geometry-map .leaflet-marker-icon').first().boundingBox();
    await page.mouse.move(firstVertex.x + firstVertex.width / 2, firstVertex.y + firstVertex.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstVertex.x + firstVertex.width / 2 + 12, firstVertex.y + firstVertex.height / 2 + 8, { steps: 4 });
    await page.mouse.up();
    const draggedGeometry = JSON.parse(await page.locator('#geojson-import').inputValue());
    assert.deepStrictEqual(draggedGeometry.coordinates[1], polygonWithHole.coordinates[1], 'real Leaflet vertex drag preserves holes');

    await page.locator('#geojson-import').fill('{invalid json');
    await page.getByRole('button', { name: 'Import GeoJSON' }).click();
    await page.locator('#regions-error').getByText(/Expected|Unexpected|JSON/).waitFor();
    await page.locator('#geojson-import').fill(JSON.stringify({
      type: 'MultiPolygon',
      coordinates: [polygonWithHole.coordinates, [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]]],
    }));
    await page.getByRole('button', { name: 'Import GeoJSON' }).click();
    assert.strictEqual(await page.getByRole('button', { name: 'Draw polygon' }).isDisabled(), true, 'MultiPolygon disables Polygon-only drawing controls');

    await page.locator('#geojson-import').fill('{"type":"Polygon","coordinates":[[[-90,35],[-89,35],[-89,36],[-90,35]]]}');
    await page.getByRole('button', { name: 'Import GeoJSON' }).click();
    await page.locator('#region-description-0').evaluate((node) => {
      node.value = 'é'.repeat(600000);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.match(await page.locator('#payload-size-status').textContent(), /over 1 MiB limit/, 'browser measures serialized UTF-8 payload bytes');
    assert.strictEqual(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), true, 'oversized payload disables save');
    await page.locator('#region-description-0').fill('Tennessee');
    assert.strictEqual(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), false, 'save re-enables after payload repair');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Saved\. Changes take effect/).waitFor();
    assert(savedPayload && Array.isArray(savedPayload.hashRegionDefinitions), 'admin saves structured definitions');
    const persisted = await page.evaluate(() => fetch('/api/admin/hash-regions').then(response => response.json()));
    assert.strictEqual(persisted.hashRegionDefinitions[0].geometry.type, 'Polygon', 'GET after PUT returns persisted mock state');
    assert.deepStrictEqual(persisted.hashRegionDefinitions[0].geometry.coordinates[0][0], [-90, 35]);

    failCounties = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.region-definition-card').first().waitFor();
    assert.strictEqual(await page.locator('.region-definition-card').count(), 4, 'region definitions still load when optional county data fails');
    assert.strictEqual(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), false, 'save is available after definitions load');
    assert.strictEqual(await page.getByRole('button', { name: 'Use selected counties' }).isDisabled(), true, 'county controls fail closed without blocking the editor');
    failCounties = false;

    failAdminDefinitions = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#regions-error').getByText(/definitions unavailable/).waitFor();
    assert.strictEqual(await page.locator('.region-definition-card').count(), 0, 'failed definition load never exposes stale or empty editable rows');
    assert.strictEqual(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), true, 'failed definition load keeps save disabled');
    failAdminDefinitions = false;

    const relevantErrors = pageErrors.filter(message => !/WebSocket|Failed to fetch|Unexpected end of JSON/.test(message));
    assert.deepStrictEqual(relevantErrors, [], 'no unexpected browser errors: ' + relevantErrors.join('; '));
    await context.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await mobileContext.newPage();
    await mobile.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await mobile.getByRole('button', { name: 'More' }).click();
    assert.strictEqual(await mobile.getByRole('menuitem', { name: 'Scope Helper' }).count(), 0, 'mobile More sheet has no standalone helper entry');
    const toolsLink = mobile.getByRole('menuitem', { name: 'Tools' });
    await toolsLink.waitFor();
    await toolsLink.click();
    const mobileHelperCard = mobile.locator('a.tools-card[href="#/tools/region-scope"]');
    await mobileHelperCard.waitFor();
    await mobileHelperCard.click();
    await mobile.getByRole('heading', { name: 'Region Scope Helper' }).waitFor();
    assert.strictEqual(await mobile.locator('[data-bottom-nav-tab="more"]').evaluate(node => node.classList.contains('active')), true, 'helper route keeps the mobile More tab active through its Tools parent');
    await mobile.locator('#region-scope-list .region-scope-item').first().waitFor();
    const cards = await mobile.locator('.region-scope-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    assert(cards[1].top >= cards[0].bottom, 'mobile layout stacks location and command cards');
    assert((await mobile.locator('#region-scope-map').boundingBox()).height >= 300, 'mobile map remains usable');
    await mobileContext.close();

    console.log('test-region-scope-e2e.js: all tests passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  server.close();
  process.exit(1);
});
