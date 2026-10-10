#!/usr/bin/env node
'use strict';

const assert = require('assert');
const helpers = require('./public/region-scope-helpers.js');

const squareWithHole = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
  ],
};

assert.strictEqual(helpers.pointInGeometry([1, 1], squareWithHole), true, 'point in polygon shell');
assert.strictEqual(helpers.pointInGeometry([5, 5], squareWithHole), false, 'point in polygon hole');
assert.strictEqual(helpers.pointInGeometry([0, 5], squareWithHole), true, 'outer boundary is included');
assert.strictEqual(helpers.pointInGeometry([3, 5], squareWithHole), true, 'hole boundary is included');
assert.strictEqual(helpers.pointInGeometry([12, 5], squareWithHole), false, 'point outside polygon');
assert.strictEqual(helpers.pointInGeometry([21, 1], {
  type: 'MultiPolygon',
  coordinates: [squareWithHole.coordinates, [[[20, 0], [22, 0], [22, 2], [20, 2], [20, 0]]]],
}), true, 'point in later MultiPolygon member');

const definitions = [
  { name: '#country', description: 'Country', geometry: null },
  { name: '#west', parentName: '#country', geometry: { type: 'Polygon', coordinates: [[[-10, -10], [5, -10], [5, 10], [-10, 10], [-10, -10]]] } },
  { name: '#east', parentName: '#country', geometry: { type: 'Polygon', coordinates: [[[0, -10], [10, -10], [10, 10], [0, 10], [0, -10]]] } },
  { name: '#city', parentName: '#east', geometry: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] } },
  { name: '#manual', geometry: null },
];
assert.deepStrictEqual(
  helpers.recommendRegions(definitions, [1.5, 1.5]).map((d) => d.name),
  ['#country', '#east', '#city', '#west'],
  'recommendations contain complete ancestor chains in deterministic parent-before-child order'
);

assert.deepStrictEqual(
  helpers.updateSelection(['#country', '#east'], '#east', false),
  ['#country'],
  'manual removal changes selection without mutating recommendations'
);
assert.deepStrictEqual(
  helpers.updateSelection(['#country'], '#west', true),
  ['#country', '#west'],
  'manual addition is deterministic'
);
assert.deepStrictEqual(
  helpers.updateHierarchySelection(definitions, [], '#city', true),
  ['#city', '#country', '#east'],
  'selecting a child also selects the ancestors needed by its command'
);
assert.deepStrictEqual(
  helpers.updateHierarchySelection(definitions, ['#country', '#east', '#city'], '#east', false),
  ['#country'],
  'removing a parent also removes selected descendants'
);

assert.strictEqual(
  helpers.escapeHTML('<img src=x onerror="alert(1)"> Tom & \'Sue\''),
  '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Tom &amp; &#39;Sue&#39;',
  'descriptions are safe for HTML output'
);

const generated = helpers.buildCommands(definitions, ['#city', '#west']);
assert.deepStrictEqual(generated.mutationCommands, [
  'region def #country #east #city|#country #west',
], 'hierarchy mutation uses the current one-line region def syntax with a sibling jump');
assert.deepStrictEqual(generated.verificationCommands, ['region'], 'verification is a separate stage');
assert.deepStrictEqual(generated.persistenceCommands, ['region save'], 'persistence is a separate stage');
assert.deepStrictEqual(generated.homeCommands, [], 'home is not chosen by default');
assert.deepStrictEqual(generated.defaultCommands, [], 'default is not chosen by default');
assert.deepStrictEqual(generated.commands, generated.mutationCommands, 'legacy commands alias contains only the primary mutation block');
assert.match(generated.warning, /do not remove existing regions/i);
assert.match(generated.defaultWarning, /persists immediately/i, 'default persistence is explained');
assert.strictEqual(generated.mutationCommands.every((line) => Buffer.byteLength(line, 'utf8') <= 158), true,
  'region def commands respect the repeater serial byte limit');

assert.deepStrictEqual(
  helpers.buildCommands(definitions, ['#manual', '#west']).mutationCommands,
  ['region def #country #west|* #manual'],
  'separate root branches jump back to the wildcard in one region def command'
);

const staged = helpers.buildCommands(definitions, ['#city'], { home: '#east', defaultRegion: '#city' });
assert.deepStrictEqual(staged.homeCommands, ['region home #east'], 'explicit home selection generates its own stage');
assert.deepStrictEqual(staged.defaultCommands, ['region default #city'], 'explicit default selection generates its own stage');
assert.strictEqual(staged.commands.includes('region save'), false, 'primary copied block never contains persistence');

assert.throws(
  () => helpers.buildCommands([{ name: '#child', parentName: '#missing' }], ['#child']),
  /missing parent/i,
  'commands reject a selected hierarchy with a missing parent'
);
assert.throws(
  () => helpers.buildCommands([
    { name: '#a', parentName: '#b' },
    { name: '#b', parentName: '#a' },
  ], ['#a']),
  /cycle/i,
  'commands reject cyclic hierarchies'
);
assert.throws(
  () => helpers.buildCommands([{ name: '#' + 'a'.repeat(30) }], ['#' + 'a'.repeat(30)]),
  /30 UTF-8 bytes/,
  'commands reject names that firmware RegionEntry would truncate'
);
assert.doesNotThrow(
  () => helpers.buildCommands([{ name: '#' + 'a'.repeat(29) }], ['#' + 'a'.repeat(29)]),
  'commands accept the firmware maximum of 30 UTF-8 bytes'
);
const tooManyDefinitions = Array.from({ length: 33 }, (_, index) => ({ name: '#r' + index }));
assert.throws(
  () => helpers.buildCommands(tooManyDefinitions, tooManyDefinitions.map((definition) => definition.name)),
  /32 regions/,
  'commands reject a selection larger than the firmware region table'
);
const maximumDefinitions = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'.split('').map((name) => ({ name }));
assert.doesNotThrow(
  () => helpers.buildCommands(maximumDefinitions, maximumDefinitions.map((definition) => definition.name)),
  'one-shot region def accepts the firmware maximum of 32 short region entries'
);
assert.strictEqual(
  helpers.buildCommands(maximumDefinitions, maximumDefinitions.map((definition) => definition.name)).mutationCommands.length,
  1,
  'maximum short selection remains one one-shot command'
);

function chainWithLengths(lengths) {
  return lengths.map((length, index) => ({
    name: '#' + String.fromCharCode(65 + index).repeat(length - 1),
    parentName: index ? '#' + String.fromCharCode(64 + index).repeat(lengths[index - 1] - 1) : '',
  }));
}
const exactLimitChain = chainWithLengths([29, 29, 29, 28, 28]);
assert.doesNotThrow(
  () => helpers.buildCommands(exactLimitChain, [exactLimitChain.at(-1).name]),
  '158-byte region def command fits the repeater serial input buffer'
);
const oversizedASCIIChain = chainWithLengths([29, 29, 29, 28, 29]);
assert.throws(
  () => helpers.buildCommands(oversizedASCIIChain, [oversizedASCIIChain.at(-1).name]),
  /158 UTF-8 bytes/,
  '159-byte region def command is rejected before serial truncation'
);
const oversizedMultibyteRoots = Array.from({ length: 6 }, (_, index) => ({
  name: '#' + 'é'.repeat(13) + String.fromCharCode(65 + index),
}));
assert.throws(
  () => helpers.buildCommands(oversizedMultibyteRoots, oversizedMultibyteRoots.map((definition) => definition.name)),
  /158 UTF-8 bytes/,
  'aggregate command limit is measured in UTF-8 bytes rather than JavaScript code units'
);
['#bad.name', '#bad/name', '#bad:name', '#bad@name', ''].forEach((name) => {
  assert.throws(() => helpers.buildCommands([{ name }], [name]), /firmware/i, 'reject firmware-invalid name bytes: ' + JSON.stringify(name));
});
assert.throws(
  () => helpers.buildCommands([{ name: '#root|jump' }], ['#root|jump']),
  /region def delimiter/i,
  'root names cannot inject a region def cursor jump'
);
assert.throws(
  () => helpers.buildCommands([{ name: '#root' }, { name: '#child|jump', parentName: '#root' }], ['#child|jump']),
  /region def delimiter/i,
  'child names cannot inject a region def cursor jump'
);
['#GOOD-name', '$private', '#café', '#[odd]'].forEach((name) => {
  assert.doesNotThrow(() => helpers.buildCommands([{ name }], [name]), 'accept every name whose UTF-8 bytes satisfy firmware: ' + name);
});

const details = helpers.recommendRegionDetails(definitions, [1.5, 1.5]);
assert.deepStrictEqual(details.map((item) => [item.definition.name, item.reason]), [
  ['#country', 'ancestor'], ['#east', 'direct'], ['#city', 'direct'], ['#west', 'direct'],
], 'recommendation details distinguish direct boundary matches from required ancestors');

const borderDefinitions = [
  { name: '#us', geometry: null },
  { name: '#us-tn', parentName: '#us', geometry: { type: 'Polygon', coordinates: [[[-88, 35], [-84, 35], [-84, 36.5], [-88, 36.5], [-88, 35]]] } },
  { name: '#us-ky', parentName: '#us', geometry: { type: 'Polygon', coordinates: [[[-89.6, 36.5], [-82, 36.5], [-82, 39.2], [-89.6, 39.2], [-89.6, 36.5]]] } },
];
const borderDetails = helpers.recommendRegionDetails(borderDefinitions, [-87.35, 36.30]);
assert.deepStrictEqual(borderDetails.map((item) => item.definition.name), ['#us', '#us-tn', '#us-ky'],
  'a location near a neighboring boundary includes that region as a border suggestion');
assert.strictEqual(borderDetails.find((item) => item.definition.name === '#us-ky').reason, 'nearby',
  'neighboring boundary suggestion is distinguished from automatic direct matches');
assert.ok(borderDetails.find((item) => item.definition.name === '#us-ky').distanceKm > 0,
  'border suggestions expose their approximate distance');
assert.strictEqual(helpers.recommendRegionDetails(borderDefinitions, [-87.35, 35.5]).some((item) => item.definition.name === '#us-ky'), false,
  'faraway boundaries are not suggested');

assert.deepStrictEqual(
  helpers.reconcileRecommendationSelection(definitions, ['#west'], ['#manual'], ['#east']),
  ['#country', '#manual', '#west'],
  'a new recommendation replaces old automatic geography while preserving manual additions and removals'
);
assert.deepStrictEqual(
  helpers.reconcileRecommendationSelection(definitions, ['#city'], [], ['#east']),
  ['#country'],
  'manual parent removal also suppresses invalid automatically recommended descendants'
);

const counties = [
  { geometry: { type: 'Polygon', coordinates: squareWithHole.coordinates } },
  { geometry: { type: 'MultiPolygon', coordinates: [
    [[[20, 0], [21, 0], [21, 1], [20, 0]]],
    [[[30, 0], [31, 0], [31, 1], [30, 0]]],
  ] } },
];
assert.deepStrictEqual(helpers.countiesToMultiPolygon(counties), {
  type: 'MultiPolygon',
  coordinates: [squareWithHole.coordinates, counties[1].geometry.coordinates[0], counties[1].geometry.coordinates[1]],
}, 'county geometries concatenate into a valid MultiPolygon without computational union');

assert.deepStrictEqual(helpers.parseGeoJSONGeometry({
  type: 'Feature',
  properties: {},
  geometry: squareWithHole,
}), squareWithHole, 'GeoJSON Feature import extracts Polygon geometry');
assert.throws(() => helpers.parseGeoJSONGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), /Polygon or MultiPolygon/);

const regionColors = Array.from({ length: 100 }, (_, index) => helpers.regionColorToken(index, 100));
assert.strictEqual(new Set(regionColors).size, 100, 'every supported region receives a distinct color token');
assert.strictEqual(regionColors.every((value) => /var\(--/.test(value)), true, 'region colors derive from theme CSS variables');
assert.strictEqual(regionColors.some((value) => /#[0-9a-f]/i.test(value)), false, 'region colors do not hardcode hex values');
assert.strictEqual(helpers.regionColorToken(0, 1, '#12ABef'), '#12abef', 'saved admin color overrides automatic assignment');
assert.match(helpers.regionColorToken(0, 1, 'red'), /var\(--/, 'invalid custom color falls back to a theme-derived token');

console.log('test-region-scope-helper.js: all tests passed');
