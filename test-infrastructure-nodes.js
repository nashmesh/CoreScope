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

console.log('\n=== infrastructure.js: dedicated page ===');

const infraPageSrc = fs.readFileSync(path.join(__dirname, 'public', 'infrastructure.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const navDrawerSrc = fs.readFileSync(path.join(__dirname, 'public', 'nav-drawer.js'), 'utf8');
const bottomNavSrc = fs.readFileSync(path.join(__dirname, 'public', 'bottom-nav.js'), 'utf8');

assert(/registerPage\('infrastructure',\s*\{\s*init,\s*destroy\s*\}\)/.test(infraPageSrc),
  'infrastructure.js registers the page module');
// Perf contract: exactly two data sources — fetchAllNodes + scoped bulk-health.
assert(/fetchAllNodes\(/.test(infraPageSrc) && /bulk-health\?limit=.*&nodes=/.test(infraPageSrc),
  'page loads via fetchAllNodes + scoped bulk-health');
{
  const apiCalls = infraPageSrc.match(/\bapi\('[^']+/g) || [];
  assert(apiCalls.length === 1 && /bulk-health/.test(apiCalls[0]),
    `page makes exactly one api() call (scoped bulk-health); got ${JSON.stringify(apiCalls)}`);
}
assert(/sa === 'stale' \? -1 : 1/.test(infraPageSrc),
  'page sorts stale infra nodes first');
assert(/\/analytics"/.test(infraPageSrc) && /\/reach"/.test(infraPageSrc),
  'cards link to node analytics + reach (history stays one click away)');
assert(/el\.hidden = false;[\s\S]{0,300}L\.map\(/.test(infraPageSrc),
  'map container un-hidden BEFORE L.map() (Leaflet 0×0 init guard)');
assert(/offWS\(wsHandler\)/.test(infraPageSrc) && /map\.remove\(\)/.test(infraPageSrc),
  'destroy() releases WS handler and Leaflet map');

// Wiring: script tag, top nav, and BOTH mobile navs (sync requirement).
assert(/<script src="infrastructure\.js\?v=__BUST__"/.test(indexSrc),
  'index.html loads infrastructure.js with cache buster');
assert(/data-route="infrastructure"/.test(indexSrc),
  'top nav links #/infrastructure');
assert(/route:\s*'infrastructure'/.test(navDrawerSrc),
  'nav-drawer ROUTES includes infrastructure');
assert(/route:\s*'infrastructure'/.test(bottomNavSrc),
  'bottom-nav MORE_ROUTES includes infrastructure');
assert(/infra-panel-viewall/.test(nodesSrc) && /#\/infrastructure/.test(nodesSrc),
  'nodes-page panel links View all → #/infrastructure');
assert(!/<button[^>]*class="infra-panel-header"[\s\S]{0,400}<a /.test(nodesSrc),
  'View-all link is NOT nested inside the header <button> (invalid HTML + double-fire)');

// InfraSummary functional check in a vm sandbox.
{
  const m = infraPageSrc.match(/window\.InfraSummary\s*=\s*\{[\s\S]*?\n\};/);
  assert(!!m, 'InfraSummary extractable');
  if (m) {
    const sandbox = {
      window: {
        getNodeStatus: (role, lastMs) => (Date.now() - lastMs < 86400000 ? 'active' : 'stale'),
      },
      Date: Date,
      Array: Array,
    };
    vm.createContext(sandbox);
    vm.runInContext(m[0], sandbox);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const s = sandbox.window.InfraSummary.compute([
      { name: 'Fresh', role: 'repeater', last_seen: now, relay_active: true },
      { name: 'Silent', role: 'repeater', last_seen: old },
    ]);
    assert(s.total === 2 && s.active === 1 && s.stale === 1 && s.relaying === 1,
      `summary counts: got ${JSON.stringify(s)}`);
    assert(s.oldestSilent && s.oldestSilent.name === 'Silent',
      'oldestSilent identifies the longest-silent node');
    const empty = sandbox.window.InfraSummary.compute([]);
    assert(empty.total === 0 && empty.oldestSilent === null, 'empty list → zero counts');
  }
}

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
