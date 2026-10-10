// Hash Region Coverage overlay — shared between map.js and live.js.
//
// Renders administrator-defined region boundaries from
// /api/config/hash-region-definitions, joined to /api/scope-coverage's
// observed relay counts. Relay nodes remain countable and visible even when
// they sit outside the saved boundary; observations never expand a polygon.
//
// Usage (per Leaflet map instance):
//   const overlay = createScopeCoverageOverlay(map, {
//     checkboxId: 'mcScopeCoverage', labelId: 'mcScopeCoverageLabel',
//     storageKey: 'meshcore-map-scope-coverage'
//   });
//   overlay.load();          // fetch + render, wires checkbox + map events (async, fire-and-forget)
//   overlay.refreshTheme();  // call on 'theme-refresh' — colors are baked into shape styles
//   overlay.destroy();       // call when leaving the page
//
// Each call to createScopeCoverageOverlay owns its own state (layer, fetched
// data, shape-by-name index, shared hover tooltip) — safe to have one
// instance per map even if more than one were ever alive at once.

// Deterministic string -> 8-hex-char digest (FNV-1a 32-bit) so region
// names (arbitrary strings like "#eu", not hex hashes) can feed
// HashColor.hashToHsl the same way packet-hash coloring does elsewhere
// (live.js, packets.js) — same visual language, no new color system.
// Module-level (not per-overlay-instance) and unprefixed because other
// pages that show region-tagged nodes without their own coverage overlay
// (e.g. the standalone Regions page) need the exact same name -> color
// mapping to stay visually consistent with the coverage shapes.
function scopeCoverageRegionNameToHex(name) {
  var h = 0x811c9dc5;
  for (var i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function scopeCoverageIsDarkTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// Structured region definitions may assign an exact display color in the
// Regions admin tool. Keep those assignments shared at module scope so the
// coverage polygons, Regions legend, and Regions node markers all resolve a
// name through the same table. When the shared region helper is loaded, its
// active-set allocator also prevents automatic colors from colliding.
var scopeCoverageAssignedRegionColors = Object.create(null);
function scopeCoverageSetRegionColors(definitions, activeRegions) {
  definitions = Array.isArray(definitions) ? definitions : [];
  activeRegions = Array.isArray(activeRegions) ? activeRegions : definitions;
  if (window.RegionScopeHelpers && typeof RegionScopeHelpers.buildRegionColorTable === 'function') {
    var definitionByName = Object.create(null);
    definitions.forEach(function (definition) {
      if (definition && typeof definition.name === 'string') definitionByName[definition.name] = definition;
    });
    var activeDefinitions = activeRegions.map(function (region) {
      var definition = region && definitionByName[region.name];
      return {
        name: region && region.name,
        color: definition && definition.color
      };
    });
    var configuredNames = definitions.map(function (definition) { return definition && definition.name; });
    scopeCoverageAssignedRegionColors = RegionScopeHelpers.buildRegionColorTable(activeDefinitions, configuredNames);
    return;
  }
  var assigned = Object.create(null);
  definitions.forEach(function (definition) {
    if (!definition || typeof definition.name !== 'string') return;
    var color = typeof definition.color === 'string' ? definition.color.trim() : '';
    if (/^#[0-9a-f]{6}$/i.test(color)) assigned[definition.name] = color;
  });
  scopeCoverageAssignedRegionColors = assigned;
}

// The name-to-color mapping itself — the only place a region name becomes
// an actual color. Every polygon fill, marker fill, and swatch anywhere in
// the app must go through this so the same region always renders the same
// color no matter which page/overlay is drawing it.
function scopeCoverageRegionColor(name) {
  if (scopeCoverageAssignedRegionColors[name]) return scopeCoverageAssignedRegionColors[name];
  if (window.RegionScopeHelpers) {
    return RegionScopeHelpers.regionColorToken(name, null);
  }
  return window.HashColor ? HashColor.hashToHsl(scopeCoverageRegionNameToHex(name), scopeCoverageIsDarkTheme() ? 'dark' : 'light') : '#888';
}
function scopeCoverageRegionOutline(name) {
  if (scopeCoverageAssignedRegionColors[name]) return scopeCoverageAssignedRegionColors[name];
  return window.HashColor ? HashColor.hashToOutline(scopeCoverageRegionNameToHex(name), scopeCoverageIsDarkTheme() ? 'dark' : 'light') : '#444';
}
function scopeCoverageRegionSwatchHtml(name) {
  return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' +
    scopeCoverageRegionColor(name) + ';margin-right:5px;vertical-align:middle;"></span>';
}

// Leaflet's Canvas renderer cannot resolve CSS custom properties. Resolve the
// shared DOM color token before it is baked into a polygon style while leaving
// the original token available to ordinary DOM swatches and markers.
function scopeCoverageResolveColor(token) {
  if (!/var\(|color-mix\(/.test(String(token || ''))) return token;
  if (!document.createElement || !document.body || typeof getComputedStyle !== 'function') return token;
  var probe = document.createElement('span');
  probe.style.color = token;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  var resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || token;
}

// Join observed relay membership/counts to the administrator-owned region
// boundaries. Definitions own geometry: a relay outside the saved boundary
// still contributes to nodeCount and remains available to the Regions page,
// but it never expands (or invents) a polygon. Configured regions with no
// observed relays remain visible with a zero count; observed names without a
// saved definition remain countable/filterable with no polygon.
function scopeCoverageCombineRegions(coverageRegions, definitions) {
  var coverageByName = Object.create(null);
  (Array.isArray(coverageRegions) ? coverageRegions : []).forEach(function (region) {
    if (region && typeof region.name === 'string') coverageByName[region.name] = region;
  });
  var included = Object.create(null);
  var combined = [];
  (Array.isArray(definitions) ? definitions : []).forEach(function (definition) {
    if (!definition || typeof definition.name !== 'string' || included[definition.name]) return;
    var observed = coverageByName[definition.name];
    combined.push({
      name: definition.name,
      nodeCount: observed && Number.isFinite(Number(observed.nodeCount)) ? Number(observed.nodeCount) : 0,
      geometry: definition.geometry || null
    });
    included[definition.name] = true;
  });
  Object.keys(coverageByName).sort().forEach(function (name) {
    if (included[name]) return;
    var observed = coverageByName[name];
    combined.push({
      name: name,
      nodeCount: Number.isFinite(Number(observed.nodeCount)) ? Number(observed.nodeCount) : 0,
      geometry: null
    });
  });
  return combined;
}

// GeoJSON stores [longitude, latitude]; Leaflet expects [latitude, longitude].
// Preserve every ring and MultiPolygon member so holes and disjoint areas are
// rendered exactly as saved by the administrator.
function scopeCoverageGeometryLatLngs(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  function ringLatLngs(ring) {
    return ring.map(function (position) { return [position[1], position[0]]; });
  }
  function polygonLatLngs(polygon) { return polygon.map(ringLatLngs); }
  if (geometry.type === 'Polygon') return polygonLatLngs(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygonLatLngs);
  return null;
}

function scopeCoverageVisibleNamesFromHash(regions, params) {
  var configured = new Set((regions || []).map(function (region) { return region.name; }));
  if (params && params.has('regions')) {
    return new Set(params.getAll('regions').filter(function (name) { return configured.has(name); }));
  }
  return new Set((regions || []).map(function (region) { return region.name; }).filter(function (name) {
    return name !== '#us' && name !== '#us-southeast';
  }));
}

function scopeCoverageWriteVisibleNames(params, names) {
  params.delete('regions');
  var selected = Array.from(names || []).sort();
  if (!selected.length) {
    params.append('regions', '');
    return params;
  }
  selected.forEach(function (name) { params.append('regions', name); });
  return params;
}

function scopeCoverageActiveScopedNodes(nodes, memberships, selectedNames, statusForNode) {
  var nodeByPubkey = new Map();
  (nodes || []).forEach(function (node) {
    if (node && node.public_key) nodeByPubkey.set(String(node.public_key).toLowerCase(), node);
  });
  var selected = selectedNames instanceof Set ? selectedNames : new Set(selectedNames || []);
  var result = [];
  (memberships || []).forEach(function (membership) {
    var node = membership && nodeByPubkey.get(String(membership.pubkey || '').toLowerCase());
    var regions = membership && Array.isArray(membership.regions) ? membership.regions : [];
    if (!node || !regions.some(function (name) { return selected.has(name); })) return;
    var lastSeenMs = new Date(node.last_heard || node.last_seen || '').getTime();
    if (statusForNode(node.role, lastSeenMs) !== 'active') return;
    result.push({ node: node, regions: regions });
  });
  return result;
}

function createScopeCoverageOverlay(map, opts) {
  var checkboxId = opts.checkboxId;
  var labelId = opts.labelId;
  var storageKey = opts.storageKey;

  var esc = (typeof escapeHtml === 'function') ? escapeHtml : function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var layer = null;
  var data = null; // last-fetched /api/scope-coverage response, kept for theme re-render
  var shapesByName = null; // region name -> its Leaflet shape, for highlight wiring
  var hoverTooltip = null; // shared tooltip instance for the map-level mousemove handler
  // True once the layer has actually been built and the map-level
  // hover/click listeners registered — NOT the same as "data has been
  // fetched". load() always fetches (needed just to know whether to
  // reveal the checkbox at all), but building shapes + wiring
  // mousemove/click is deferred until the overlay is actually turned on,
  // so a page load with the toggle off (the default) does none of that
  // work. See activate() below.
  var activated = false;
  var destroyed = false;
  var loadGeneration = 0;

  // Region name to isolate, or null to show every region. Set via
  // setRegionFilter() (e.g. from a page-level legend) — consumed by both
  // render() (which shape to draw) and _polygonMatchesAt() (which regions
  // hover/click can find), so a filtered-out region is fully inert, not
  // just invisible.
  var visibleRegionNames = null;

  function _visibleRegions() {
    if (!data || !data.regions) return [];
    if (visibleRegionNames === null) return data.regions;
    return data.regions.filter(function (r) { return visibleRegionNames.has(r.name); });
  }

  // Rough planar polygon area (shoelace formula) — not a real geographic
  // measurement, just a relative size used to (a) paint larger regions
  // first so they sit visually "under" smaller ones by default, and (b)
  // order a multi-region match list smallest/most-specific first. Actual
  // hover/click selection does NOT depend on paint order — see
  // _pointInHull below — because regions often overlap in ways that
  // aren't cleanly nested (a "smaller-sounding" region's hull can end up
  // numerically larger than a region that contains it, if even one member
  // node's position pulls it wide), so no fixed z-order can guarantee
  // every region keeps an exposed, clickable sliver.
  function _hullArea(hull) {
    if (!hull || hull.length < 3) return 0;
    var area = 0;
    for (var i = 0; i < hull.length; i++) {
      var p1 = hull[i], p2 = hull[(i + 1) % hull.length];
      area += p1[0] * p2[1] - p2[0] * p1[1];
    }
    return Math.abs(area / 2);
  }

  function _ringArea(ring) {
    if (!ring || ring.length < 3) return 0;
    var area = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return Math.abs(area / 2);
  }

  function _polygonArea(polygon) {
    if (!polygon || !polygon.length) return 0;
    var area = _ringArea(polygon[0]);
    for (var i = 1; i < polygon.length; i++) area -= _ringArea(polygon[i]);
    return Math.max(0, area);
  }

  function _geometryArea(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return 0;
    if (geometry.type === 'Polygon') return _polygonArea(geometry.coordinates);
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.reduce(function (total, polygon) { return total + _polygonArea(polygon); }, 0);
    }
    return 0;
  }

  function _regionArea(region) {
    return Object.prototype.hasOwnProperty.call(region, 'geometry')
      ? _geometryArea(region.geometry)
      : _hullArea(region.hull);
  }

  // Ray-casting point-in-polygon test. hull is [[lat,lon], ...]; treats
  // lat/lon as generic planar x/y, consistent with _hullArea/convexHull.
  function _pointInHull(latlng, hull) {
    if (!hull || hull.length < 3) return false;
    var x = latlng.lat, y = latlng.lng;
    var inside = false;
    for (var i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      var xi = hull[i][0], yi = hull[i][1];
      var xj = hull[j][0], yj = hull[j][1];
      var intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function _pointInGeoJSONRing(latlng, ring) {
    if (!ring || ring.length < 4) return false;
    var x = latlng.lng, y = latlng.lat;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      var intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function _pointInGeoJSONPolygon(latlng, polygon) {
    if (!polygon || !polygon.length || !_pointInGeoJSONRing(latlng, polygon[0])) return false;
    for (var i = 1; i < polygon.length; i++) {
      if (_pointInGeoJSONRing(latlng, polygon[i])) return false;
    }
    return true;
  }

  function _pointInGeometry(latlng, geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return false;
    if (geometry.type === 'Polygon') return _pointInGeoJSONPolygon(latlng, geometry.coordinates);
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some(function (polygon) { return _pointInGeoJSONPolygon(latlng, polygon); });
    }
    return false;
  }

  function _regionContains(latlng, region) {
    return Object.prototype.hasOwnProperty.call(region, 'geometry')
      ? _pointInGeometry(latlng, region.geometry)
      : _pointInHull(latlng, region.hull);
  }

  // Every polygon region whose saved boundary actually contains
  // latlng — computed directly by geometry, not by which shape happens to
  // be drawn on top, so a region buried under several others at a given
  // pixel is still found here. Sorted smallest-area first (most specific).
  function _polygonMatchesAt(latlng) {
    return _visibleRegions()
      .filter(function (r) { return _regionContains(latlng, r); })
      .sort(function (a, b) { return _regionArea(a) - _regionArea(b); });
  }

  // Single source of truth for "which regions are currently highlighted."
  // Resets every shape not in names to its base style, applies the hover
  // style + bringToFront to every shape in names.
  function _setHighlighted(names) {
    var wanted = {};
    (names || []).forEach(function (n) { wanted[n] = true; });
    Object.keys(shapesByName || {}).forEach(function (name) {
      var shape = shapesByName[name];
      if (!shape) return;
      if (wanted[name]) {
        if (shape._scopeHoverStyle) shape.setStyle(shape._scopeHoverStyle);
        if (shape.bringToFront) shape.bringToFront();
      } else if (shape._scopeBaseStyle) {
        shape.setStyle(shape._scopeBaseStyle);
      }
    });
  }

  // Rebuilds the layer from `data`. Called on initial load and again on
  // theme-refresh (colors are baked into shape styles via HashColor, not
  // CSS vars, so they need an explicit re-render).
  function render() {
    if (layer) { map.removeLayer(layer); layer = null; }
    shapesByName = {};
    var visibleRegions = _visibleRegions();
    if (!visibleRegions.length) return;
    // Largest-area first so smaller/nested regions draw on top — see _hullArea.
    var regionsByZOrder = visibleRegions.slice().sort(function (a, b) {
      return _regionArea(b) - _regionArea(a);
    });

    var shapes = [];
    regionsByZOrder.forEach(function (region) {
      var fill = scopeCoverageResolveColor(scopeCoverageRegionColor(region.name));
      var outline = scopeCoverageResolveColor(scopeCoverageRegionOutline(region.name));
      var shape, baseStyle, hoverStyle;
      var latlngs = scopeCoverageGeometryLatLngs(region.geometry);
      if (!latlngs) return; // Count/membership remains visible; no inferred polygon.
      baseStyle = { color: outline, weight: 2, opacity: 0.8, fillColor: fill, fillOpacity: 0.15 };
      hoverStyle = { weight: 4, opacity: 1, fillOpacity: 0.4 };
      shape = L.polygon(latlngs, baseStyle);

      shape._scopeBaseStyle = baseStyle;
      shape._scopeHoverStyle = hoverStyle;

      // No native hover/click bindings here: with overlapping boundaries,
      // Leaflet would only reach whichever polygon is topmost at that pixel.
      // Map-level handlers below test every saved geometry instead.

      shapes.push(shape);
      shapesByName[region.name] = shape;
    });
    layer = L.layerGroup(shapes);
    var el = document.getElementById(checkboxId);
    if (el && el.checked) layer.addTo(map);
  }

  // Map-level mousemove: finds every polygon region containing the cursor
  // (not just whichever shape is visually on top) and highlights all of
  // them, with a tooltip listing every match. This is what makes a region
  // buried under several overlapping siblings still discoverable by hover.
  function onMouseMove(e) {
    if (!layer || !map.hasLayer(layer)) return;
    var matches = _polygonMatchesAt(e.latlng);
    if (!matches.length) {
      _setHighlighted([]);
      if (hoverTooltip) { map.closeTooltip(hoverTooltip); hoverTooltip = null; }
      return;
    }
    _setHighlighted(matches.map(function (r) { return r.name; }));
    var content = matches.length === 1
      ? scopeCoverageRegionSwatchHtml(matches[0].name) + esc(matches[0].name) + ' <span style="opacity:0.75">(' + matches[0].nodeCount + ')</span>'
      : '<strong>' + matches.length + ' overlapping here:</strong><br>' + matches.map(function (r) {
          return scopeCoverageRegionSwatchHtml(r.name) + esc(r.name) + ' <span style="opacity:0.75">(' + r.nodeCount + ')</span>';
        }).join('<br>');
    if (!hoverTooltip) {
      hoverTooltip = L.tooltip({ sticky: true, direction: 'top', opacity: 0.95 }).setLatLng(e.latlng).setContent(content).openOn(map);
    } else {
      hoverTooltip.setLatLng(e.latlng).setContent(content);
    }
  }

  // Map-level click: same point-in-polygon match set as hover, but opens a
  // persistent popup. A single match gets its info directly; multiple
  // matches get a clickable list so any region — no matter how deeply
  // buried — can be definitively selected and highlighted.
  function onMapClick(e) {
    if (!layer || !map.hasLayer(layer)) return;
    var matches = _polygonMatchesAt(e.latlng);
    if (!matches.length) return;
    if (matches.length === 1) {
      var r = matches[0];
      L.popup({ maxWidth: 260 }).setLatLng(e.latlng)
        .setContent(scopeCoverageRegionSwatchHtml(r.name) + '<strong>' + esc(r.name) + '</strong><br>' + r.nodeCount + ' node' + (r.nodeCount === 1 ? '' : 's'))
        .openOn(map);
      return;
    }
    var container = document.createElement('div');
    var header = document.createElement('strong');
    header.textContent = matches.length + ' overlapping regions here:';
    container.appendChild(header);
    matches.forEach(function (region) {
      var row = document.createElement('div');
      var swatch = document.createElement('span');
      swatch.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;background:' +
        scopeCoverageRegionColor(region.name) + ';margin-right:5px;vertical-align:middle;';
      row.appendChild(swatch);
      row.appendChild(document.createTextNode(region.name + ' (' + region.nodeCount + ')'));
      row.style.cssText = 'cursor:pointer;padding:2px 0;';
      row.addEventListener('mouseenter', function () { _setHighlighted([region.name]); });
      row.addEventListener('click', function () {
        _setHighlighted([region.name]);
        container.querySelectorAll('div').forEach(function (r2) { r2.style.fontWeight = 'normal'; });
        row.style.fontWeight = '700';
      });
      container.appendChild(row);
    });
    L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(container).openOn(map);
  }

  // Builds the layer and wires the map-level hover/click listeners.
  // Idempotent — safe to call from both the checkbox's 'change' handler
  // and load()'s localStorage-restore path without double-registering.
  // Deliberately NOT called just because data was fetched — only because
  // the overlay is actually about to be shown, so a page load with the
  // toggle off does none of this work.
  function activate() {
    if (activated) return;
    activated = true;
    render();
    map.on('mousemove', onMouseMove);
    map.on('click', onMapClick);
  }

  async function load() {
    if (destroyed) return false;
    var generation = ++loadGeneration;
    try {
      var results = await Promise.all([
        api('/scope-coverage', { ttl: 30000 }),
        api('/config/hash-region-definitions', { ttl: 30000 })
          .then(function (definitions) { return Array.isArray(definitions) ? definitions : []; })
          .catch(function () { return []; /* keep observed membership/counts, but never infer geometry */ })
      ]);
      if (destroyed || generation !== loadGeneration) return false;
      var resp = results[0] || { regions: [] };
      var definitions = results[1];
      data = Array.isArray(definitions)
        ? { regions: scopeCoverageCombineRegions(resp.regions || [], definitions) }
        : resp;
      scopeCoverageSetRegionColors(definitions, data.regions || []);
      if (!data.regions || !data.regions.length) return true;
      var label = document.getElementById(labelId);
      var el = document.getElementById(checkboxId);
      if (label) label.style.display = '';
      if (el) {
        var saved = localStorage.getItem(storageKey);
        if (saved === 'true') el.checked = true;
        el.addEventListener('change', function (e) {
          localStorage.setItem(storageKey, e.target.checked);
          if (e.target.checked) {
            if (!activated) activate(); // first time on — builds + adds the layer + registers listeners
            else if (layer) layer.addTo(map); // already built once — just re-show it
          } else if (layer) {
            map.removeLayer(layer);
          }
        });
        // Preserve "remembers your last setting" — if it was on last
        // session, build it now rather than waiting for a click that
        // isn't coming.
        if (el.checked) activate();
      }
      return true;
    } catch (e) { return false; /* no hash regions configured / endpoint unavailable */ }
  }

  function refreshTheme() {
    // Colors are baked into shape styles at render() time — nothing to
    // refresh if the overlay was never turned on in the first place.
    if (activated) render();
  }

  // Isolates a single region — every other region's shape stops being
  // drawn AND stops being hit-testable (see _visibleRegions() above), so a
  // filtered-out region can't be hovered/clicked just because it's still
  // technically on the map under lower opacity. Pass a falsy name (or call
  // clearRegionFilter()) to show every region again. No-op until the
  // overlay is activated — there's no layer to rebuild yet.
  function setRegionFilter(name) {
    visibleRegionNames = name ? new Set([name]) : null;
    if (activated) render();
  }
  function clearRegionFilter() { setRegionFilter(null); }

  function setVisibleRegions(names) {
    visibleRegionNames = new Set(names || []);
    if (activated) render();
  }

  function getVisibleRegions() {
    if (visibleRegionNames === null) {
      return new Set(((data && data.regions) || []).map(function (region) { return region.name; }));
    }
    return new Set(visibleRegionNames);
  }

  // The full, unfiltered region list from the last successful load() — for
  // a page-level legend to enumerate every region the overlay knows about,
  // independent of the current filter.
  function getRegions() { return (data && data.regions) || []; }

  function destroy() {
    destroyed = true;
    loadGeneration++;
    if (layer) { map.removeLayer(layer); layer = null; }
    map.off('mousemove', onMouseMove);
    map.off('click', onMapClick);
    data = null;
    shapesByName = null;
    hoverTooltip = null;
    visibleRegionNames = null;
  }

  return {
    load: load, refreshTheme: refreshTheme, destroy: destroy,
    setRegionFilter: setRegionFilter, clearRegionFilter: clearRegionFilter,
    setVisibleRegions: setVisibleRegions, getVisibleRegions: getVisibleRegions, getRegions: getRegions
  };
}
