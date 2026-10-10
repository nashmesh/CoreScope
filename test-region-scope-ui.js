#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const scopeJS = fs.readFileSync('public/region-scope.js', 'utf8');
const scopeCSS = fs.readFileSync('public/region-scope.css', 'utf8');
const adminCSS = fs.readFileSync('public/admin/admin.css', 'utf8');
const bottomNav = fs.readFileSync('public/bottom-nav.js', 'utf8');
const testAll = fs.readFileSync('test-all.sh', 'utf8');
const packageJSON = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const adminHTML = fs.readFileSync('public/admin/hash-regions.html', 'utf8');
const adminJS = fs.readFileSync('public/admin/hash-regions.js', 'utf8');

assert.doesNotMatch(index, /data-route="region-scope"/, 'desktop navigation does not expose the helper as its own tab');
assert.match(app, /href="#\/tools\/region-scope" class="tools-card"/, 'Tools landing page links the helper');
assert.match(index, /region-scope-helpers\.js\?v=__BUST__/, 'shared helper is loaded by browser');
assert.match(index, /region-scope\.js\?v=__BUST__/, 'helper page module is loaded');
assert.match(index, /region-scope\.css\?v=__BUST__/, 'helper page CSS is loaded');
assert.match(app, /region-scope/, 'router recognizes helper as a Tools route');
assert.match(scopeJS, /id="region-scope-lat"/, 'helper provides an accessible latitude input');
assert.match(scopeJS, /id="region-scope-lon"/, 'helper provides an accessible longitude input');
assert.match(scopeJS, /id="region-scope-recommend"/, 'helper provides a keyboard-operable recommendation button');
assert.match(scopeJS, /id="region-scope-home"/, 'helper provides an explicit home selector');
assert.match(scopeJS, /id="region-scope-default"/, 'helper provides an explicit default selector');
assert.match(scopeJS, /Home region marks this repeater’s local place in the displayed hierarchy/, 'home region has a concise operational description');
assert.match(scopeJS, /Default scope is attached to this repeater’s flooded adverts/, 'default scope has a concise operational description');
assert.match(scopeJS, /Creates or reparents the complete selected tree in one current-firmware command/, 'region def stage explains its effect');
assert.match(scopeJS, /If firmware reports an error, earlier mutations from that command may remain in memory/, 'region def help explains partial failure behavior');
assert.match(scopeJS, /Displays the repeater’s resulting in-memory tree so you can verify parentage before saving/, 'verification stage explains its safety purpose');
assert.match(scopeJS, /Writes the verified in-memory hierarchy to persistent storage/, 'save stage explains persistence');
assert.match(scopeJS, /<option value="">No choice<\/option>/, 'home/default selectors start with no choice');
assert.match(scopeJS, /<h3 id="region-mutations-title">1\. Define hierarchy \(one-shot\)<\/h3>/, 'helper labels the current one-shot region definition workflow');
assert.match(scopeJS, />Copy region def<\/button>/, 'hierarchy copy control names the current CLI command');
assert.match(scopeJS, /copy-region-mutations/, 'hierarchy definition has a separate copy control');
assert.match(scopeJS, /copy-region-verification/, 'verification has a separate copy control');
assert.match(scopeJS, /copy-region-home-default/, 'optional home/default has a separate copy control');
assert.match(scopeJS, /copy-region-save/, 'persistence has a separate copy control');
assert.match(scopeJS, /persists immediately/, 'UI explains immediate default persistence');
assert.match(scopeJS, /recommendRegionDetails/, 'UI exposes direct-vs-ancestor recommendation provenance');
assert.match(scopeJS, /Nearby border: about/, 'UI identifies nearby border suggestions and their distance');
assert.match(scopeJS, /item\.reason !== 'nearby'/, 'nearby border suggestions are not selected automatically');
assert.match(scopeJS, /id="region-scope-list-cue"/, 'available regions includes a visible scroll cue');
assert.match(scopeJS, /More regions below/, 'scroll cue explicitly tells operators when more regions are below');
assert.match(scopeJS, /regionColorToken/, 'regions receive deterministic distinct colors');
assert.match(scopeJS, /--region-scope-color/, 'region colors are exposed to list styling');
assert.match(scopeJS, /getComputedStyle\(probe\)\.color/, 'theme color tokens are resolved before Canvas map rendering');
assert.match(scopeJS, /addEventListener\('theme-changed', themeColorHandler\)/, 'map colors redraw after theme changes');
assert.match(scopeJS, /removeEventListener\('theme-changed', themeColorHandler\)/, 'theme color listener is removed on route teardown');
assert.match(scopeJS, /AbortController|loadGeneration/, 'definition loading guards against stale SPA fetches');
assert.match(scopeJS, /replaceChildren\(\)|textContent\s*=\s*''/, 'definition target is cleared before append');
assert.match(scopeJS, /_applyTilesToNodeMap/, 'helper uses the established tile provider path');
assert.doesNotMatch(scopeJS, /basemaps\.cartocdn\.com/, 'helper does not bypass configured tile providers');
assert.doesNotMatch(bottomNav, /route:\s*'region-scope'/, 'mobile navigation does not expose the helper as its own tab');
assert.match(bottomNav, /route:\s*'tools'/, 'mobile navigation keeps the Tools entry that contains the helper');
assert.doesNotMatch(bottomNav, /if \(h === 'tools\/region-scope'\) return 'region-scope'/, 'helper route activates the parent Tools tab');
assert.match(scopeCSS, /@media \(max-width: 800px\)/, 'helper has mobile layout coverage');
assert.match(scopeCSS, /scrollbar-gutter:\s*stable/, 'available region list reserves visible scrollbar space');
assert.match(scopeCSS, /region-scope-list-frame\.is-scrollable/, 'scrollable list has a distinct visual treatment');
assert.match(scopeCSS, /var\(--region-scope-color, var\(--accent\)\)/, 'region cards retain an accent fallback when no assigned color is present');
assert.match(adminCSS, /var\(--region-tree-depth, 0\)/, 'nested region cards retain a zero-depth fallback when depth is unset');
assert.match(testAll, /run-manifest\.js --profile local-package-and-test-all/, 'canonical full test runner delegates to the manifest orchestrator');
const testManifest = JSON.parse(fs.readFileSync('tests/manifest.json', 'utf8'));
assert.ok(testManifest.tests.some(test => test.path === 'test-region-scope-e2e.js' && test.suite === 'e2e' && test.status === 'active'), 'canonical manifest retains real Chromium coverage');
assert.doesNotMatch(packageJSON.scripts['test:unit'], /region-scope-e2e/, 'fast unit runner does not require a browser');

assert.match(adminHTML, /id="region-editor-list"/, 'admin has structured editor list');
assert.match(adminHTML, /id="county-select"/, 'admin has bundled county selection');
assert.match(adminHTML, /id="state-select"[\s\S]*multiple/, 'admin can select counties across multiple states');
assert.match(adminHTML, /id="geometry-map"/, 'admin has boundary preview/editor map');
assert.match(adminHTML, /id="geometry-coordinates"/, 'admin has accessible coordinate editing');
assert.match(adminHTML, /id="geojson-import"/, 'admin has GeoJSON import');
assert.match(adminJS, /hashRegionDefinitions/, 'admin persists structured definitions');
assert.match(adminJS, /\/geo\/us-counties\.geojson/, 'admin loads bundled nationwide counties once');
assert.match(adminJS, /orderDefinitionsParentFirst/, 'admin presents definitions in parent/child order');
assert.match(adminJS, /corescope-hash-regions-version/, 'saving definitions invalidates the public helper cache');
assert.doesNotMatch(adminJS, /\.innerHTML\s*=\s*[^'"`]/, 'admin does not inject untrusted values through innerHTML');

// Exercise the registered production page and click handlers, not extracted copies.
// DOM/Leaflet seams cover only the browser APIs needed to mount an empty page.
const vm = require('vm');
function clipboardPage(options = {}) {
  let nodes = new Map();
  let page;
  const writes = [];
  const replacements = [];
  const location = { hash: options.hash || '#/tools/region-scope' };
  let mapClick;
  let fetchCount = 0;
  function node() {
    const listeners = new Map();
    return {
      dataset: {}, style: { setProperty() {} }, classList: { toggle() {} },
      textContent: '', value: '', scrollHeight: 0, clientHeight: 0, scrollTop: 0,
      children: [], checked: false,
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      setAttribute() {}, remove() {},
      addEventListener(type, handler) { listeners.set(type, handler); },
      fire(type) { listeners.get(type)({ preventDefault() {} }); },
      click() { this.fire('click'); },
    };
  }
  const container = {
    set innerHTML(html) {
      nodes = new Map(Array.from(html.matchAll(/id="([^"]+)"/g), match => [match[1], node()]));
    },
  };
  const context = vm.createContext({
    console, Set, Map, Promise, URLSearchParams, location,
    history: { state: { router: 'preserved' }, replaceState(state, title, hash) {
      assert.strictEqual(state.router, 'preserved');
      replacements.push(hash); location.hash = hash;
    } },
    getComputedStyle: () => ({ getPropertyValue: () => '', color: 'rgb(1, 2, 3)' }),
    document: { getElementById: id => nodes.get(id) || null, createElement: node,
      createDocumentFragment: node, documentElement: node(), body: node() },
    localStorage: { getItem: () => null },
    fetch: () => { fetchCount++; return options.response || Promise.resolve({ ok: true,
      json: () => Promise.resolve(options.definitions || []) }); },
    requestAnimationFrame: handler => handler(),
    window: { addEventListener() {}, removeEventListener() {}, _applyTilesToNodeMap() {} },
    navigator: { clipboard: { writeText(text) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      writes.push({ text, resolve, reject });
      return promise;
    } } },
    L: {
      map: () => ({ setView() { return this; }, on(type, handler) { mapClick = handler; }, remove() {},
        getZoom: () => 7, getContainer: () => nodes.get('region-scope-map') }),
      marker: () => ({ addTo() { return this; }, setLatLng() {} }),
      geoJSON: () => ({ addTo() { return this; } }),
      layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }),
    },
    registerPage(name, handlers) {
      assert.strictEqual(name, 'region-scope');
      page = handlers;
    },
  });
  // In a browser, window properties are also global bindings.
  Object.assign(context, context.window);
  context.window = context;
  vm.runInContext(fs.readFileSync('public/region-scope-helpers.js', 'utf8'), context);
  vm.runInContext(scopeJS, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    writes, flush, location, replacements,
    get fetchCount() { return fetchCount; },
    get: id => nodes.get(id),
    rows() {
      const list = nodes.get('region-scope-list');
      return list.children.flatMap(child => child.dataset.regionName ? [child] : child.children);
    },
    toggle(name, checked) {
      const checkbox = this.rows().find(row => row.dataset.regionName === name).children[0];
      checkbox.checked = checked; checkbox.fire('change');
    },
    selected() { return this.rows().filter(row => row.children[0].checked).map(row => row.dataset.regionName).sort(); },
    point(lat, lng) { mapClick({ latlng: { lat, lng } }); },
    async mount() { page.init(container); await flush(); },
    teardown() { page.destroy(); nodes.clear(); },
  };
}

async function clipboardRegression(outcome, lifecycle) {
  const fixture = clipboardPage();
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fixture.mount();
    const oldStatus = fixture.get('region-scope-status');
    oldStatus.textContent = 'Original status';
    fixture.get('copy-region-verification').click();
    assert.strictEqual(fixture.writes.length, 1, 'real click invokes clipboard once');
    assert.strictEqual(fixture.writes[0].text, 'region', 'real command output reaches clipboard');
    if (lifecycle !== 'mounted') fixture.teardown();
    if (lifecycle === 'remounted') {
      await fixture.mount();
      fixture.get('region-scope-status').textContent = 'New mount status';
    }
    if (outcome === 'success') fixture.writes[0].resolve();
    else fixture.writes[0].reject(new Error('clipboard denied'));
    await fixture.flush();
    assert.strictEqual(unhandled.length, 0, 'settlement must not produce an unhandled rejection');
    if (lifecycle === 'mounted') {
      assert.strictEqual(oldStatus.textContent, outcome === 'success'
        ? 'Verification command copied to clipboard.'
        : 'Copy failed. Select the stage and copy it manually.');
    } else {
      assert.strictEqual(oldStatus.textContent, 'Original status', 'detached status remains untouched');
      if (lifecycle === 'remounted') {
        assert.strictEqual(fixture.get('region-scope-status').textContent, 'New mount status',
          'old clipboard settlement must not overwrite the new mount status');
      }
    }
  } finally {
    fixture.teardown();
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

const scopeDefinitions = [
  { name: '#root', parentName: '' },
  { name: 'local', parentName: '#root', geometry: { type: 'Polygon',
    coordinates: [[[-87, 35], [-86, 35], [-86, 36], [-87, 36], [-87, 35]]] } },
  { name: 'manual', parentName: '#root' },
  { name: 'comma,area', parentName: '' },
];
const scopeHash = params => '#/tools/region-scope?' + new URLSearchParams(params);
async function deepLinkRoundTrip() {
  const fixture = clipboardPage({ definitions: scopeDefinitions });
  await fixture.mount();
  fixture.get('region-scope-lat').value = '35.85';
  fixture.get('region-scope-lon').value = '-86.4';
  fixture.get('region-scope-coordinate-form').fire('submit');
  let params = new URLSearchParams(fixture.location.hash.split('?')[1]);
  assert.strictEqual(params.get('scopeLat'), '35.85000', 'actual recommendation writes latitude into the hash');
  assert.strictEqual(params.get('scopeLon'), '-86.40000');
  fixture.toggle('local', false);
  fixture.toggle('manual', true);
  fixture.get('region-scope-home').value = 'manual';
  fixture.get('region-scope-home').fire('change');
  fixture.get('region-scope-default').value = '#root';
  fixture.get('region-scope-default').fire('change');
  const bookmark = fixture.location.hash;
  const commands = fixture.get('region-scope-home-default-commands').dataset.copyText;
  const selection = fixture.selected();
  fixture.teardown();
  await fixture.mount();
  assert.strictEqual(fixture.fetchCount, 1, 'restoration preserves the definitions cache');
  assert.strictEqual(fixture.get('region-scope-lat').value, '35.85000');
  assert.deepStrictEqual(fixture.selected(), selection);
  assert.strictEqual(fixture.get('region-scope-home').value, 'manual');
  assert.strictEqual(fixture.get('region-scope-default').value, '#root');
  assert.strictEqual(fixture.get('region-scope-home-default-commands').dataset.copyText, commands);
  assert.strictEqual(fixture.location.hash, bookmark, 'restore must not rewrite or loop');
  const fresh = clipboardPage({ definitions: scopeDefinitions, hash: bookmark });
  await fresh.mount();
  assert.deepStrictEqual(fresh.selected(), selection, 'a fresh page restores the same selection');
  fresh.point(36.5, -85);
  assert.deepStrictEqual(fresh.selected(), ['#root', 'manual'], 'old automatic geography does not become manual after restore');
  fresh.point(35.85, -86.4);
  assert(fresh.selected().includes('local'), 'location transition clears manual removal suppression');
  fresh.toggle('comma,area', true);
  params = new URLSearchParams(fresh.location.hash.split('?')[1]);
  assert(params.getAll('scopeRegion').includes('comma,area'), 'punctuation is one repeated encoded name, not CSV');
  const punctuationBookmark = fresh.location.hash;
  fresh.teardown(); await fresh.mount();
  assert(fresh.selected().includes('comma,area'));
  for (const name of ['#root', 'comma,area']) fresh.toggle(name, false);
  params = new URLSearchParams(fresh.location.hash.split('?')[1]);
  assert.deepStrictEqual(params.getAll('scopeRegion'), [''], 'explicit empty selection has a sentinel');
  assert.strictEqual(params.get('scopeHome'), '');
  assert.strictEqual(params.get('scopeDefault'), '');
  fresh.teardown(); await fresh.mount();
  assert.deepStrictEqual(fresh.selected(), []);
  assert.strictEqual(fresh.get('region-scope-home').value, '');
  assert.strictEqual(fresh.get('region-scope-default').value, '');
  assert(fixture.replacements.length > 0, 'writes use replaceState without hashchange/router reinitialization');
  assert(punctuationBookmark.startsWith('#/tools/region-scope?'));
  fixture.teardown(); fresh.teardown();
}

async function deepLinkValidation() {
  const invalidPoints = [['NaN', '0'], ['Infinity', '0'], ['91', '0'], ['0', '-181'], ['', '0'], ['1junk', '0'], ['0', '']];
  for (const [lat, lon] of invalidPoints) {
    const fixture = clipboardPage({ definitions: scopeDefinitions, hash: scopeHash({ scopeLat: lat, scopeLon: lon }) });
    await fixture.mount();
    assert.strictEqual(fixture.get('region-scope-lat').value, '', 'invalid URL point is not restored');
    fixture.teardown();
  }
  const fixture = clipboardPage({ definitions: scopeDefinitions, hash: scopeHash([
    ['scopeLat', '-90'], ['scopeLon', '180'], ['scopeRegion', 'manual'],
    ['scopeRegion', 'unknown\nregion save'], ['scopeHome', 'unknown\nregion save'],
    ['scopeDefault', 'local'], ['regions', 'shared-overlay-only'], ['token', 'sentinel-not-state'],
  ]) });
  await fixture.mount();
  assert.strictEqual(fixture.get('region-scope-lat').value, '-90.00000', 'finite boundary coordinates restore');
  assert.deepStrictEqual(fixture.selected(), ['#root', 'manual'], 'only known definitions plus required ancestors restore');
  assert.strictEqual(fixture.get('region-scope-home').value, '');
  assert.strictEqual(fixture.get('region-scope-default').value, '', 'choice must belong to selected set');
  assert(!fixture.get('region-scope-mutations').dataset.copyText.includes('unknown'));
  fixture.point(0, 0);
  const params = new URLSearchParams(fixture.location.hash.split('?')[1]);
  assert(!params.has('token'), 'unrelated credentials are not copied into generated URLs');
  assert(!params.has('regions'), 'helper does not consume shared overlay keys');
  fixture.teardown();
  for (const hash of [scopeHash({ scopeLat: '0', scopeLon: '0', scopeRegion: 'x'.repeat(8192) }),
    scopeHash(Array.from({ length: 257 }, () => ['scopeRegion', 'manual']))]) {
    const bounded = clipboardPage({ definitions: scopeDefinitions, hash });
    await bounded.mount();
    assert.deepStrictEqual(bounded.selected(), [], 'oversized state is rejected before restoration');
    assert.strictEqual(bounded.get('region-scope-lat').value, '');
    bounded.teardown();
  }
  const duplicate = clipboardPage({ definitions: scopeDefinitions, hash: scopeHash([
    ['scopeLat', '0'], ['scopeLat', '35.85'], ['scopeLon', '-86.4'],
  ]) });
  await duplicate.mount();
  assert.strictEqual(duplicate.get('region-scope-lat').value, '', 'ambiguous scalar coordinates are rejected');
  duplicate.teardown();
}

async function delayedDeepLinkRestore() {
  let resolve;
  const response = new Promise(yes => { resolve = yes; });
  const fixture = clipboardPage({ response, hash: scopeHash({ scopeLat: '35.85', scopeLon: '-86.4',
    scopeRegion: 'manual', scopeHome: 'manual' }) });
  await fixture.mount();
  assert.strictEqual(fixture.rows().length, 0, 'selection waits for authoritative definitions');
  fixture.teardown();
  fixture.location.hash = scopeHash({ scopeRegion: 'local', scopeHome: 'local' });
  await fixture.mount();
  resolve({ ok: true, json: () => Promise.resolve(scopeDefinitions) });
  await fixture.flush();
  assert.deepStrictEqual(fixture.selected(), ['#root', 'local'], 'only current mount restores after delayed load');
  assert.strictEqual(fixture.get('region-scope-home').value, 'local');
  assert.strictEqual(fixture.get('region-scope-lat').value, '', 'old mount coordinates cannot leak');
  assert.strictEqual(fixture.replacements.length, 0, 'restoration never rewrites the hash');
  fixture.teardown();
}

async function deepLinkWriteBounds() {
  const definitions = Array.from({ length: 24 }, (_, index) => ({ name: 'é'.repeat(30) + index, parentName: '' }));
  const fixture = clipboardPage({ definitions });
  await fixture.mount();
  for (const definition of definitions) fixture.toggle(definition.name, true);
  assert(fixture.location.hash.length <= 8192, 'encoded bookmark output is bounded');
  assert.match(fixture.get('region-scope-status').textContent, /too large to bookmark/, 'oversized output is explicit, not silently truncated');
  assert.strictEqual(fixture.selected().length, definitions.length, 'URL bound must not silently erase the UI selection');
  fixture.teardown();
}

async function inputDuringDeferredRestore() {
  let resolve;
  const response = new Promise(yes => { resolve = yes; });
  const fixture = clipboardPage({ response, hash: scopeHash({ scopeLat: '35.85', scopeLon: '-86.4', scopeRegion: 'manual' }) });
  await fixture.mount();
  fixture.point(0, 0);
  resolve({ ok: true, json: () => Promise.resolve(scopeDefinitions) });
  await fixture.flush();
  assert.strictEqual(fixture.get('region-scope-lat').value, '0.00000', 'new input wins over pending restoration');
  assert.deepStrictEqual(fixture.selected(), []);
  assert.strictEqual(new URLSearchParams(fixture.location.hash.split('?')[1]).get('scopeLat'), '0.00000');
  const hash = fixture.location.hash;
  fixture.get('region-scope-lat').value = '';
  fixture.get('region-scope-lon').value = '';
  fixture.get('region-scope-coordinate-form').fire('submit');
  assert.strictEqual(fixture.location.hash, hash, 'blank coordinates do not publish a fabricated zero point');
  fixture.point(Infinity, 0);
  assert.strictEqual(fixture.location.hash, hash, 'non-finite map points cannot enter URL state');
  fixture.teardown();
}

(async function () {
  let failures = 0;
  for (const [name, regression] of [['deep-link actual-handler round trip', deepLinkRoundTrip],
    ['deep-link tampering and payload bounds', deepLinkValidation],
    ['deep-link deferred definitions and mount generation', delayedDeepLinkRestore],
    ['deep-link bounded URL writes', deepLinkWriteBounds],
    ['deep-link newer input during deferred restoration', inputDuringDeferredRestore]]) {
    try { await regression(); console.log('PASS: ' + name); }
    catch (error) { failures++; console.error('FAIL: ' + name + '\n' + error.stack); }
  }
  for (const lifecycle of ['mounted', 'teardown', 'remounted']) {
    for (const outcome of ['success', 'failure']) {
      const name = `clipboard ${outcome} after ${lifecycle}`;
      try {
        await clipboardRegression(outcome, lifecycle);
        console.log('PASS: ' + name);
      } catch (error) {
        failures++;
        console.error('FAIL: ' + name + '\n' + error.stack);
      }
    }
  }
  if (failures) process.exitCode = 1;
  else console.log('test-region-scope-ui.js: all structural assertions, 5 deep-link and 6 clipboard behavior tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
