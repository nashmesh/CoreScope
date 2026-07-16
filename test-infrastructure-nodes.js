/**
 * Infrastructure nodes (#infra) — frontend surface tests.
 *
 * Acceptance:
 *   - roles.js exposes window.isInfrastructureNode(n) reading the
 *     server's `infrastructure` boolean, plus INFRA_BADGE_TITLE.
 *   - nodes.js renders an INFRA badge (detail badges + table rows) and
 *     has a persisted infra-only filter applied client-side.
 *   - map.js: infra-only filter (checkbox + persisted state), marker
 *     ring drawn via the --mc-infra CSS var, label markers get the
 *     mc-infra-label class, popup shows an INFRA badge.
 *   - style.css declares --mc-infra/--mc-infra-text and the badge/label
 *     classes.
 *
 * Pure-string assertions + a vm functional check of the helper; no
 * DOM/browser required (same harness style as test-issue-1293).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

const rolesSrc = fs.readFileSync(path.join(__dirname, 'public', 'roles.js'), 'utf8');
const nodesSrc = fs.readFileSync(path.join(__dirname, 'public', 'nodes.js'), 'utf8');
const mapSrc   = fs.readFileSync(path.join(__dirname, 'public', 'map.js'),   'utf8');
const cssSrc   = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');

console.log('\n=== roles.js: shared helper ===');

assert(/window\.isInfrastructureNode\s*=\s*function/.test(rolesSrc),
  'roles.js exposes window.isInfrastructureNode');
assert(/window\.INFRA_BADGE_TITLE\s*=/.test(rolesSrc),
  'roles.js exposes window.INFRA_BADGE_TITLE');

// Functional check: run the helper in a sandbox.
{
  const m = rolesSrc.match(/window\.isInfrastructureNode\s*=\s*(function[\s\S]*?\n\s*\};)/);
  assert(!!m, 'isInfrastructureNode body extractable');
  if (m) {
    const sandbox = {};
    vm.createContext(sandbox);
    const fn = vm.runInContext('(' + m[1].replace(/;\s*$/, '') + ')', sandbox);
    assert(fn({ infrastructure: true }) === true,  'helper: {infrastructure:true} → true');
    assert(fn({ infrastructure: false }) === false, 'helper: {infrastructure:false} → false');
    assert(fn({}) === false, 'helper: missing field → false');
    assert(fn(null) === false, 'helper: null node → false');
  }
}

console.log('\n=== nodes.js: badge + filter ===');

assert(/isInfrastructureNode\(n\)[\s\S]{0,200}infra-badge/.test(nodesSrc),
  'renderNodeBadges / rows gate the infra-badge on isInfrastructureNode');
assert((nodesSrc.match(/infra-badge/g) || []).length >= 2,
  'INFRA badge appears in both detail badges and table rows');
assert(/meshcore-nodes-infra-filter/.test(nodesSrc),
  'infra-only filter persisted under meshcore-nodes-infra-filter');
assert(/if\s*\(infraOnly\)\s*\{\s*\n?\s*filtered\s*=\s*filtered\.filter\(n\s*=>\s*window\.isInfrastructureNode\(n\)\)/.test(nodesSrc),
  'infra-only filter applied client-side to the node list');
assert(/id="nodeInfraFilter"/.test(nodesSrc),
  'nodes page renders the Infra filter toggle');
assert(/aria-pressed/.test(nodesSrc),
  'Infra toggle exposes aria-pressed state');

console.log('\n=== map.js: filter + marker ring + popup ===');

assert(/infraOnly:\s*localStorage\.getItem\('meshcore-map-infra-only'\)\s*===\s*'true'/.test(mapSrc),
  'map filters state includes persisted infraOnly');
assert(/filters\.infraOnly\s*&&\s*!window\.isInfrastructureNode\(n\)/.test(mapSrc),
  'renderMarkers applies the infra-only filter');
assert(/id="mcInfraOnly"/.test(mapSrc),
  'map controls render the Infrastructure only checkbox');
assert(/makeMarkerIcon\(role,\s*isStale,\s*isAlsoObserver,\s*colorOverride,\s*isInfraNode\)/.test(mapSrc),
  'makeMarkerIcon accepts the isInfraNode parameter');
assert(/stroke="var\(--mc-infra\)"/.test(mapSrc),
  'infra marker ring strokes with var(--mc-infra)');
assert(/mc-infra-label/.test(mapSrc),
  'repeater hash-label markers get the mc-infra-label class');
assert(/infraBadge/.test(mapSrc) && /INFRA<\/span>/.test(mapSrc),
  'map popup renders an INFRA badge');

// The ring must ENLARGE the icon canvas (outer > size) so it does not
// overlap the role shape — and anchors must use the outer center.
assert(/outer\s*=\s*size\s*\+\s*pad\s*\*\s*2/.test(mapSrc),
  'infra ring pads the SVG canvas instead of overdrawing the shape');
assert(/iconSize:\s*\[outer,\s*outer\]/.test(mapSrc) && /iconAnchor:\s*\[oc,\s*oc\]/.test(mapSrc),
  'divIcon size/anchor track the padded canvas');

console.log('\n=== nodes.js: at-a-glance panel ===');

assert(/function renderInfraPanel\(\)/.test(nodesSrc),
  'nodes.js defines renderInfraPanel');
assert(/id="infraPanel"/.test(nodesSrc),
  'renderLeft mounts the infraPanel container');
assert(/_allNodes\.filter\(n => window\.isInfrastructureNode\(n\)\)/.test(nodesSrc),
  'panel is built from already-fetched _allNodes (no extra API calls)');
assert(!/api\(['"`]\/nodes[\s\S]{0,400}renderInfraPanel/.test(
  nodesSrc.slice(nodesSrc.indexOf('function renderInfraPanel'), nodesSrc.indexOf('function renderInfraPanel') + 4000)),
  'renderInfraPanel body performs no API fetches');
assert(/meshcore-infra-panel-collapsed/.test(nodesSrc),
  'panel collapse state persisted in localStorage');
assert(/a\.status === 'stale' \? -1 : 1/.test(nodesSrc),
  'stale infra nodes sort first (outage surfacing)');
assert(/aria-expanded/.test(nodesSrc),
  'panel header exposes aria-expanded');

console.log('\n=== style.css: accent vars + classes ===');

assert(/--mc-infra:\s*#E69F00/i.test(cssSrc),
  'style.css declares --mc-infra (Wong orange)');
assert(/--mc-infra-text:/.test(cssSrc),
  'style.css declares --mc-infra-text');
assert(/\.infra-badge\s*\{[\s\S]*?var\(--mc-infra\)/.test(cssSrc),
  '.infra-badge uses the accent var');
assert(/\.mc-mb-label\.mc-infra-label\s*\{[\s\S]*?var\(--mc-infra\)/.test(cssSrc),
  '.mc-infra-label ring uses the accent var');
assert(/\.infra-panel\s*\{/.test(cssSrc) && /\.infra-card\s*\{/.test(cssSrc),
  'panel + card classes styled');
assert(/\.infra-status-stale\s*\{\s*color:\s*var\(--status-red\)/.test(cssSrc),
  'stale infra status renders red (outage signal)');

console.log('\n=== Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) { console.error('\n#infra frontend FAIL'); process.exit(1); }
console.log('\n#infra frontend PASS');
