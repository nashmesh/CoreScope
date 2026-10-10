#!/usr/bin/env node
'use strict';

const { repositoryRoot } = require('../helpers/repository-root');

const assert = require('assert');
const fs = require('fs');
const core = require('../../public/admin/hash-regions.js');

const hierarchy = [
  { name: '#root', parentName: '', description: 'Root', geometry: null },
  { name: '#child', parentName: '#root', description: 'Child', geometry: null },
  { name: '#grandchild', parentName: '#child', description: 'Grandchild', geometry: null },
];
core.renameDefinition(hierarchy, 0, '#renamed');
assert.equal(hierarchy[0].name, '#renamed', 'rename updates node');
assert.equal(hierarchy[1].parentName, '#renamed', 'rename transactionally updates direct children');
assert.equal(hierarchy[2].parentName, '#child', 'unrelated parent remains intact');
assert.throws(() => core.renameDefinition(hierarchy, 0, '#child'), /duplicate/i, 'rename rejects duplicate atomically');
assert.equal(hierarchy[0].name, '#renamed', 'rejected rename does not mutate node');
assert.deepEqual(core.parentCandidateNames(hierarchy, 0), [], 'parent choices exclude every descendant');

const cyclic = [
  { name: '#a', parentName: '#b' },
  { name: '#b', parentName: '#c' },
  { name: '#c', parentName: '#a' },
];
assert.throws(() => core.validateHierarchy(cyclic), /cycle/i, 'multi-node cycle is rejected before submit');
assert.equal(core.normalizeColor('#12ABef'), '#12abef', 'custom colors are canonicalized');
assert.equal(core.normalizeColor(''), '', 'blank color keeps automatic assignment');
assert.throws(() => core.normalizeColor('red'), /#RRGGBB/, 'named colors are rejected');
assert.throws(() => core.normalizeColor('#123456; background:red'), /#RRGGBB/, 'CSS injection is rejected');

const unordered = [
  { name: '#grandchild', parentName: '#child' },
  { name: '#other', parentName: '' },
  { name: '#child', parentName: '#root' },
  { name: '#root', parentName: '' },
];
assert.deepStrictEqual(core.orderDefinitionsParentFirst(unordered).map((item) => [item.definition.name, item.depth]), [
  ['#other', 0], ['#root', 0], ['#child', 1], ['#grandchild', 2],
], 'admin rows are ordered as a deterministic parent/child tree with depth metadata');

const countyData = JSON.parse(fs.readFileSync(repositoryRoot + '/public/geo/us-counties.geojson', 'utf8'));
const countyStates = new Set(countyData.features.map((feature) => feature.properties.STUSPS));
['TN', 'KY', 'AL'].forEach((state) => assert.ok(countyStates.has(state), 'county picker includes ' + state));
assert.ok(countyData.features.every((feature) => feature.properties.GEOID && feature.properties.STUSPS),
  'US county choices have stable cross-state identifiers');
const adminHTML = fs.readFileSync(repositoryRoot + '/public/admin/hash-regions.html', 'utf8');
const adminJS = fs.readFileSync(repositoryRoot + '/public/admin/hash-regions.js', 'utf8');
assert.match(adminHTML, /id="state-select"[\s\S]*multiple/, 'admin exposes a multi-state county filter');
assert.match(adminJS, /fetch\('\/geo\/us-counties\.geojson'\)/, 'admin loads the nationwide county dataset');
assert.match(adminHTML, /id="export-regions-btn"/, 'admin exposes one-file region export');
assert.match(adminHTML, /type="file"[^>]*id="region-backup-file"/, 'admin exposes JSON backup file selection');
assert.match(adminHTML, /value="merge"[\s\S]*value="replace"/, 'admin makes merge and replace modes explicit');
assert.match(adminHTML, /id="region-replace-confirm"/, 'admin requires a separate destructive replacement acknowledgement');
assert.match(adminJS, /\/api\/admin\/hash-regions\/export/, 'admin downloads the authenticated server export');
assert.match(adminJS, /\/api\/admin\/hash-regions\/import\?mode=[\s\S]*dryRun=true/, 'admin validates imports server-side before applying them');
assert.match(adminJS, /expectedRevision=' \+ encodeURIComponent\(expectedRevision\)/, 'admin binds apply to the exact dry-run state revision');
assert.match(adminJS, /mode === 'replace' \? '&confirm=true'/, 'admin only sends destructive confirmation for replace mode');
assert.equal(core.backupImportSummary({ mode: 'merge', added: 2, updated: 3, preserved: 4, total: 9 }),
  'Valid merge backup: 2 added, 3 updated, 4 preserved; 9 regions after import.');
assert.equal(core.backupImportSummary({ mode: 'replace', added: 1, updated: 2, removed: 6, total: 3 }),
  'Valid replace backup: 1 added, 2 updated, 6 removed; 3 regions after import.');
assert.equal(core.isCurrentBackupPreview(4, 4, 'replace', 'replace', 'backup-b', 'backup-b'), true,
  'latest preview for the current file and mode may authorize import');
assert.equal(core.isCurrentBackupPreview(3, 4, 'replace', 'replace', 'backup-a', 'backup-b'), false,
  'a stale reordered preview cannot authorize a newly selected backup');
assert.equal(core.isCurrentBackupPreview(4, 4, 'merge', 'replace', 'backup-b', 'backup-b'), false,
  'a preview for another mode cannot authorize import');

const polygonWithHole = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]],
    [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
  ],
};
const moved = core.replacePolygonOuterRing(polygonWithHole, [[0, 0], [9, 0], [9, 9], [0, 9]]);
assert.deepEqual(moved.coordinates[1], polygonWithHole.coordinates[1], 'outer vertex drag preserves all holes');
assert.notStrictEqual(moved.coordinates[1], polygonWithHole.coordinates[1], 'result is safely cloned');

const multi = { type: 'MultiPolygon', coordinates: [polygonWithHole.coordinates, [[[20, 20], [21, 20], [21, 21], [20, 20]]]] };
const raw = core.geometryToEditableGeoJSON(multi);
assert.deepEqual(core.parseEditableGeoJSON(raw), multi, 'full editable GeoJSON repairs/applies MultiPolygon without loss');
assert.deepEqual(core.parseEditableGeoJSON(core.geometryToEditableGeoJSON(polygonWithHole)), polygonWithHole, 'full editable GeoJSON preserves Polygon holes');

let sampled = [];
sampled = core.sampleFreehandPoint(sampled, [0, 0], 0.01);
sampled = core.sampleFreehandPoint(sampled, [0.001, 0.001], 0.01);
sampled = core.sampleFreehandPoint(sampled, [0.02, 0.02], 0.01);
assert.equal(sampled.length, 2, 'freehand continuously samples meaningful pointer movement');

const under = core.payloadByteStatus({ hashRegionDefinitions: hierarchy });
assert.equal(under.overLimit, false);
assert.match(under.message, /under 1 MiB/i);
const over = core.payloadByteStatus({ hashRegionDefinitions: [{ name: '#x', description: 'x'.repeat(1024 * 1024) }] });
assert.equal(over.overLimit, true);
assert.match(over.message, /over 1 MiB/i);

// Execute the complete production UI closure; only replace network startup with
// fixture setup/inspection. DOM and Leaflet stubs do not replace UI handlers.
function drawingHarness() {
  const vm = require('vm');
  function element() {
    const handlers = {};
    return {
      handlers, children: [], value: '', checked: false, disabled: false,
      style: { setProperty() {}, removeProperty() {} },
      classList: { toggle() {}, add() {} },
      setAttribute() {}, getAttribute() { return ''; },
      addEventListener(type, callback) { handlers[type] = callback; },
      fire(type, event = {}) { if (handlers[type]) handlers[type](event); },
      appendChild(child) { this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      get firstChild() { return this.children[0]; },
      get options() { return this.children; },
      getBoundingClientRect() { return { left: 0, top: 0 }; },
      setPointerCapture(id) { this.pointerId = id; },
      hasPointerCapture(id) { return this.pointerId === id; },
      releasePointerCapture() { this.pointerId = null; },
    };
  }
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element, createTextNode: element, documentElement: element(),
  };
  const container = element();
  const map = {
    handlers: {}, dragging: { enabled: true, enable() { this.enabled = true; }, disable() { this.enabled = false; } },
    setView() { return this; }, on(type, callback) { this.handlers[type] = callback; },
    getContainer() { return container; }, getPane() { return null; }, fitBounds() {},
    containerPointToLatLng(point) { return { lng: point.x, lat: point.y }; },
  };
  const markers = [];
  function layer() {
    return { layers: [], addTo(target) { if (target.layers) target.layers.push(this); return this; },
      clearLayers() { this.layers = []; }, getBounds() { return { isValid() { return true; } }; } };
  }
  const L = {
    map() { return map; }, tileLayer: layer, layerGroup: layer, geoJSON: layer, polyline: layer,
    point(x, y) { return { x, y }; },
    marker(coords) {
      const marker = Object.assign(layer(), {
        coords, handlers: {}, on(type, callback) { this.handlers[type] = callback; },
        getLatLng() { return { lng: this.coords[1], lat: this.coords[0] }; },
      });
      markers.push(marker);
      return marker;
    },
  };
  const fixture = [
    { name: '#a', geometry: polygonWithHole },
    { name: '#b', geometry: { type: 'Polygon', coordinates: [[[20, 20], [24, 20], [24, 24], [20, 20]]] } },
  ];
  const startup = '  loadCounties();\n  Promise.all([fetchJSON';
  assert.equal(adminJS.split(startup).length, 2, 'test seam uniquely replaces startup, not handlers');
  const source = adminJS.slice(0, adminJS.indexOf(startup)) + `
  definitions = JSON.parse(fixtureJSON);
  regionsLoaded = true;
  initMap();
  renderRows();
  window.inspect = function () {
    return JSON.parse(JSON.stringify({ definitions: definitions, drawing: drawing,
      points: drawingPoints, pointerDown: freehandPointerDown }));
  };
})();`;
  const window = { addEventListener() {} };
  vm.runInNewContext(source, {
    window, document, L, fixtureJSON: JSON.stringify(fixture),
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    MutationObserver: class { observe() {} },
  }, { filename: 'public/admin/hash-regions.js' });
  const inspect = window.inspect;
  window.inspect = () => JSON.parse(JSON.stringify(inspect()));
  return {
    window, map, container, markers, fixture,
    control(id) { return document.getElementById(id); },
    edit(index) {
      const card = document.getElementById('region-editor-list').children[index];
      card.children[4].children[0].fire('click');
    },
    click(id) { document.getElementById(id).fire('click'); },
  };
}

const drawingFailures = [];
function drawingRegression(name, test) {
  try { test(); console.log('PASS: ' + name); }
  catch (error) { drawingFailures.push(error); console.error('FAIL: ' + name + '\n' + error.stack); }
}

drawingRegression('switching A to B cancels drawing and Finish preserves both geometries', () => {
  const h = drawingHarness();
  h.edit(0);
  h.click('draw-polygon-btn');
  assert.equal(h.control('finish-polygon-btn').disabled, false, 'existing A vertices enable Finish');
  h.edit(1);
  // Invoke the actual handler even if disabled: cancellation must be semantic.
  h.click('finish-polygon-btn');
  assert.deepStrictEqual(h.window.inspect().definitions.map((item) => item.geometry),
    h.fixture.map((item) => item.geometry), 'Finish must not copy the A ring into B');
  assert.equal(h.control('finish-polygon-btn').disabled, true, 'owner change disables Finish');
  assert.equal(h.window.inspect().drawing, false);
  assert.deepStrictEqual(h.window.inspect().points, []);
});

drawingRegression('captured old vertex callbacks cannot mutate B or its new drawing', () => {
  const h = drawingHarness();
  h.edit(0);
  const oldEditMarker = h.markers[h.markers.length - 1];
  h.edit(1);
  oldEditMarker.coords = [60, 60];
  oldEditMarker.handlers.dragend();
  assert.deepStrictEqual(h.window.inspect().definitions, h.fixture, 'old edit callback cannot write into B');
  h.edit(0);
  h.click('draw-polygon-btn');
  const oldDrawMarker = h.markers[h.markers.length - 1];
  h.edit(1);
  h.click('draw-polygon-btn');
  const before = h.window.inspect();
  oldDrawMarker.coords = [70, 70];
  oldDrawMarker.handlers.dragend();
  assert.deepStrictEqual(h.window.inspect(), before, 'old drawing callback cannot change the new session');
  const currentMarker = h.markers[h.markers.length - 1];
  currentMarker.coords = [25, 25];
  currentMarker.handlers.dragend();
  h.click('finish-polygon-btn');
  assert.deepStrictEqual(h.window.inspect().definitions[1].geometry.coordinates[0][2], [25, 25],
    'current drawing drag and Finish still work');
  assert.deepStrictEqual(h.window.inspect().definitions[0].geometry, h.fixture[0].geometry);
});

drawingRegression('owner change cancels freehand capture and rejects old pointer events', () => {
  const h = drawingHarness();
  const pointer = (id, x) => ({ pointerId: id, clientX: x, clientY: x,
    type: 'pointermove', cancelable: true, preventDefault() {} });
  h.edit(0);
  h.click('draw-polygon-btn');
  h.control('freehand-mode').checked = true;
  h.container.fire('pointerdown', pointer(1, 10));
  h.edit(1);
  assert.equal(h.map.dragging.enabled, true, 'cancellation restores map dragging');
  assert.equal(h.container.hasPointerCapture(1), false, 'cancellation releases the old pointer');
  assert.equal(h.window.inspect().pointerDown, false);
  h.click('draw-polygon-btn');
  h.container.fire('pointerdown', pointer(2, 30));
  const before = h.window.inspect();
  h.container.fire('pointermove', pointer(1, 80));
  h.container.fire('pointerup', pointer(1, 80));
  assert.deepStrictEqual(h.window.inspect(), before, 'old pointer cannot append or end new freehand');
  h.container.fire('pointermove', pointer(2, 31));
  assert.equal(h.window.inspect().points.length, before.points.length + 1, 'current pointer still samples');
});
if (drawingFailures.length) process.exitCode = 1;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

(async function testReorderedBackupValidationPromises() {
  let generation = 0;
  let currentText = '';
  let currentMode = 'merge';
  let authorizedPreview = '';

  function startValidation(text, mode, response) {
    const requestGeneration = ++generation;
    currentText = text;
    currentMode = mode;
    return response.promise.then((preview) => {
      if (core.isCurrentBackupPreview(
        requestGeneration, generation, mode, currentMode, text, currentText
      )) authorizedPreview = preview;
    });
  }

  const backupA = deferred();
  const backupB = deferred();
  const pendingA = startValidation('backup-a', 'replace', backupA);
  const pendingB = startValidation('backup-b', 'replace', backupB);
  backupB.resolve('preview-b');
  await pendingB;
  assert.equal(authorizedPreview, 'preview-b', 'latest backup preview authorizes import');
  backupA.resolve('preview-a');
  await pendingA;
  assert.equal(authorizedPreview, 'preview-b', 'late preview for the old backup is ignored');

  if (!drawingFailures.length) console.log('test-hash-region-admin.js: all tests passed');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
