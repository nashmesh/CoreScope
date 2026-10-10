#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { fromRepositoryRoot } = require('../helpers/repository-root');

const source = fs.readFileSync(fromRepositoryRoot('public/scope-coverage.js'), 'utf8');
const context = {
  window: { matchMedia: () => ({ matches: false }) },
  document: { documentElement: { getAttribute: () => 'light' } },
  URLSearchParams,
  console,
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

const regions = [
  { name: '#us' },
  { name: '#us-southeast' },
  { name: '#southeast' },
  { name: '#us-tn' },
  { name: '#us-tn-middle' },
];

assert.deepStrictEqual(
  Array.from(context.scopeCoverageVisibleNamesFromHash(regions, new URLSearchParams())),
  ['#southeast', '#us-tn', '#us-tn-middle'],
  'only canonical #us and #us-southeast default hidden'
);
assert.deepStrictEqual(
  Array.from(context.scopeCoverageVisibleNamesFromHash(regions, new URLSearchParams('regions=%23us&regions=%23us-tn-middle'))),
  ['#us', '#us-tn-middle'],
  'an explicit hash selection overrides defaults and keeps configured names'
);
assert.deepStrictEqual(
  Array.from(context.scopeCoverageVisibleNamesFromHash(regions, new URLSearchParams('regions='))),
  [],
  'an empty explicit selection bookmarks all regions hidden'
);

const punctuationRegions = [{ name: '#alpha,beta' }, { name: '#other' }];
const punctuationParams = new URLSearchParams();
context.scopeCoverageWriteVisibleNames(punctuationParams, new Set(['#alpha,beta', '#other']));
assert.deepStrictEqual(
  punctuationParams.getAll('regions'),
  ['#alpha,beta', '#other'],
  'URL state writes one reversible parameter per selected region'
);
assert.deepStrictEqual(
  Array.from(context.scopeCoverageVisibleNamesFromHash(punctuationRegions, punctuationParams)),
  ['#alpha,beta', '#other'],
  'URL state round-trips valid region names containing commas'
);

const active = new Date(Date.now() - 60 * 1000).toISOString();
const stale = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
const filtered = context.scopeCoverageActiveScopedNodes([
  { public_key: 'A', role: 'repeater', last_heard: active, lat: 1, lon: 2 },
  { public_key: 'B', role: 'repeater', last_seen: stale, lat: 3, lon: 4 },
  { public_key: 'C', role: 'repeater', last_seen: active, lat: 5, lon: 6 },
], [
  { pubkey: 'a', regions: ['Tennessee', '#middle'] },
  { pubkey: 'b', regions: ['Tennessee'] },
  { pubkey: 'c', regions: ['US'] },
], new Set(['Tennessee']), (role, lastSeenMs) => Date.now() - lastSeenMs < 72 * 60 * 60 * 1000 ? 'active' : 'stale');
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(filtered)),
  [{ node: { public_key: 'A', role: 'repeater', last_heard: active, lat: 1, lon: 2 }, regions: ['Tennessee', '#middle'] }],
  'Regions map keeps only active nodes whose region membership intersects the selection'
);

console.log('tests/unit/test-region-visibility.js: all tests passed');
