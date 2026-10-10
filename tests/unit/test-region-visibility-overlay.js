#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { fromRepositoryRoot } = require('../helpers/repository-root');

const source = fs.readFileSync(fromRepositoryRoot('public/scope-coverage.js'), 'utf8');
const toggle = { checked: true, addEventListener() {} };
let polygonNames = [];
const definitions = ['US', 'Southeast', 'Tennessee'].map((name, index) => ({
  name,
  geometry: { type: 'Polygon', coordinates: [[[index, 0], [index + 0.5, 0], [index, 0.5], [index, 0]]] },
}));
const context = {
  window: { matchMedia: () => ({ matches: false }) },
  document: {
    documentElement: { getAttribute: () => 'light' },
    getElementById: id => id === 'toggle' ? toggle : (id === 'label' ? { style: {} } : null),
  },
  localStorage: { getItem: () => null, setItem() {} },
  api: async path => path === '/config/hash-region-definitions' ? definitions : { regions: [] },
  L: {
    polygon(latlngs) {
      polygonNames.push(latlngs[0][0][1]);
      return { setStyle() {}, bringToFront() {} };
    },
    layerGroup() { return { addTo() {} }; },
  },
  URLSearchParams,
  console,
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

(async () => {
  const overlay = context.createScopeCoverageOverlay({
    on() {}, off() {}, removeLayer() {}, hasLayer() { return true; },
  }, { checkboxId: 'toggle', labelId: 'label', storageKey: 'test' });
  await overlay.load();
  polygonNames = [];
  overlay.setVisibleRegions(new Set(['Tennessee']));
  assert.deepStrictEqual(polygonNames, [2], 'multi-region visibility selection redraws only selected saved polygons');
  assert.deepStrictEqual(Array.from(overlay.getVisibleRegions()), ['Tennessee'], 'overlay exposes the current selection for controls');

  let resolveCoverage;
  let resolveDefinitions;
  let staleListenerBindings = 0;
  let staleMapBindings = 0;
  const staleToggle = { checked: true, addEventListener() { staleListenerBindings++; } };
  const staleLabel = { style: { display: 'none' } };
  context.document.getElementById = id => id === 'stale-toggle' ? staleToggle : (id === 'stale-label' ? staleLabel : null);
  context.api = path => new Promise(resolve => {
    if (path === '/scope-coverage') resolveCoverage = resolve;
    if (path === '/config/hash-region-definitions') resolveDefinitions = resolve;
  });
  const staleOverlay = context.createScopeCoverageOverlay({
    on() { staleMapBindings++; }, off() {}, removeLayer() {}, hasLayer() { return false; },
  }, { checkboxId: 'stale-toggle', labelId: 'stale-label', storageKey: 'stale' });
  const staleLoad = staleOverlay.load();
  staleOverlay.destroy();
  resolveCoverage({ regions: [] });
  resolveDefinitions(definitions);
  await staleLoad;
  assert.strictEqual(staleLabel.style.display, 'none', 'destroyed async load cannot reveal controls on a later route');
  assert.strictEqual(staleListenerBindings, 0, 'destroyed async load cannot bind listeners to remounted controls');
  assert.strictEqual(staleMapBindings, 0, 'destroyed async load cannot reactivate a removed map');

  console.log('tests/unit/test-region-visibility-overlay.js: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
