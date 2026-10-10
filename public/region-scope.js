/* Public Region Scope Helper page. */
(function () {
  'use strict';

  var map = null;
  var marker = null;
  var boundaryLayer = null;
  var definitions = [];
  var selected = [];
  var recommendationDetails = [];
  var manualAdditions = new Set();
  var manualRemovals = new Set();
  var lastRecommendationPoint = null;
  var rowByName = new Map();
  var colorByName = new Map();
  var loadGeneration = 0;
  var definitionsCache = null;
  var definitionsCacheVersion = '';
  var definitionsPromise = null;
  var definitionsPromiseVersion = '';
  var listResizeHandler = null;
  var themeColorHandler = null;
  var pendingURLState = null;
  var urlStateDirty = false;
  var URL_STATE_LIMIT = 8192;
  var URL_NAMES_LIMIT = 256;

  // Helper-only keys: never consume the shared overlay's `regions` parameter.
  // Read a bounded hash before parsing; only saved definitions may reach commands.
  function readURLState() {
    var hash = location.hash;
    if (hash.length > URL_STATE_LIMIT || hash.split('?')[0] !== '#/tools/region-scope') return null;
    var params = new URLSearchParams(hash.split('?')[1] || '');
    for (var key of ['scopeRegion', 'scopeAdd']) {
      if (params.getAll(key).length > URL_NAMES_LIMIT) return null;
    }
    return params;
  }

  function singleValue(params, key) {
    var values = params.getAll(key);
    return values.length === 1 ? values[0] : '';
  }

  function validPoint(lat, lon) {
    return String(lat).trim() !== '' && String(lon).trim() !== '' &&
      Number.isFinite(Number(lat)) && Number(lat) >= -90 && Number(lat) <= 90 &&
      Number.isFinite(Number(lon)) && Number(lon) >= -180 && Number(lon) <= 180;
  }

  function persistURLState() {
    if (!map || location.hash.split('?')[0] !== '#/tools/region-scope') return;
    var params = new URLSearchParams();
    if (lastRecommendationPoint) {
      params.set('scopeLat', lastRecommendationPoint[1].toFixed(5));
      params.set('scopeLon', lastRecommendationPoint[0].toFixed(5));
    }
    // Repeated names preserve commas, hashes and other saved punctuation.
    (selected.length ? selected : ['']).forEach(function (name) { params.append('scopeRegion', name); });
    (manualAdditions.size ? Array.from(manualAdditions) : ['']).forEach(function (name) { params.append('scopeAdd', name); });
    params.set('scopeHome', element('region-scope-home').value);
    params.set('scopeDefault', element('region-scope-default').value);
    var hash = '#/tools/region-scope?' + params.toString();
    if (hash.length > URL_STATE_LIMIT || selected.length > URL_NAMES_LIMIT || manualAdditions.size > URL_NAMES_LIMIT) {
      element('region-scope-status').textContent = 'This selection is too large to bookmark. Reduce the selected regions.';
      return;
    }
    // Allowlist only: never carry credentials or arbitrary query values forward.
    // replaceState does not emit hashchange or reinitialize the SPA router.
    if (hash !== location.hash) history.replaceState(history.state, '', hash);
  }

  function restoreURLState(params) {
    var lat = singleValue(params, 'scopeLat');
    var lon = singleValue(params, 'scopeLon');
    if (validPoint(lat, lon)) {
      chooseLocation({ lat: Number(lat), lng: Number(lon) }, false);
      map.setView([Number(lat), Number(lon)], Math.max(map.getZoom(), 7));
    }
    var known = new Set(definitions.map(function (definition) { return definition.name; }));
    function names(key) { return params.getAll(key).filter(function (name) { return known.has(name); }); }
    if (params.has('scopeRegion')) {
      var explicit = new Set(names('scopeRegion'));
      var automatic = new Set(recommendationDetails.filter(function (item) { return item.reason !== 'nearby'; })
        .map(function (item) { return item.definition.name; }));
      manualAdditions = new Set(names('scopeAdd').filter(function (name) { return explicit.has(name); }));
      explicit.forEach(function (name) { if (!automatic.has(name)) manualAdditions.add(name); });
      manualRemovals = new Set(Array.from(automatic).filter(function (name) { return !explicit.has(name); }));
      reconcileSelection();
      updateRowsAndCommands();
    }
    ['home', 'default'].forEach(function (choice) {
      var value = singleValue(params, choice === 'home' ? 'scopeHome' : 'scopeDefault');
      element('region-scope-' + choice).value = selected.indexOf(value) >= 0 ? value : '';
    });
    renderCommands();
  }

  function element(id) { return document.getElementById(id); }

  function definitionsVersion() {
    try { return localStorage.getItem('corescope-hash-regions-version') || ''; } catch (_) { return ''; }
  }

  function color(token, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return value || fallback;
  }

  function selectedAncestors(name) {
    var byName = new Map(definitions.map(function (definition) { return [definition.name, definition]; }));
    var names = [];
    var current = name;
    var seen = new Set();
    while (current && byName.has(current) && !seen.has(current)) {
      seen.add(current);
      names.push(current);
      current = byName.get(current).parentName || '';
    }
    return names;
  }

  function reconcileSelection() {
    selected = RegionScopeHelpers.reconcileRecommendationSelection(
      definitions,
      recommendationDetails.filter(function (item) { return item.reason !== 'nearby'; })
        .map(function (item) { return item.definition.name; }),
      Array.from(manualAdditions),
      Array.from(manualRemovals)
    );
  }

  function createRow(definition) {
    var label = document.createElement('label');
    label.className = 'region-scope-item';
    label.dataset.regionName = definition.name;
    label.style.setProperty('--region-scope-color', colorByName.get(definition.name));
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', 'Select ' + definition.name);
    var text = document.createElement('span');
    var name = document.createElement('span');
    name.className = 'region-scope-name';
    name.textContent = definition.name;
    var description = document.createElement('span');
    description.className = 'region-scope-description';
    description.textContent = definition.description || 'No description provided.';
    text.appendChild(name);
    text.appendChild(description);
    var badge = document.createElement('span');
    badge.className = 'region-scope-badge';
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) {
        manualAdditions.add(definition.name);
        selectedAncestors(definition.name).forEach(function (ancestor) { manualRemovals.delete(ancestor); });
      } else {
        manualAdditions.delete(definition.name);
        manualRemovals.add(definition.name);
      }
      reconcileSelection();
      updateRowsAndCommands();
      element('region-scope-status').textContent =
        (checkbox.checked ? 'Added ' : 'Removed ') + definition.name + ' as a manual override.';
      persistURLState();
    });
    label.appendChild(checkbox);
    label.appendChild(text);
    label.appendChild(badge);
    rowByName.set(definition.name, { root: label, checkbox: checkbox, badge: badge });
    return label;
  }

  function updateListAffordance() {
    var frame = element('region-scope-list-frame');
    var list = element('region-scope-list');
    var cue = element('region-scope-list-cue');
    if (!frame || !list || !cue) return;
    var count = rowByName.size;
    var scrollable = list.scrollHeight > list.clientHeight + 1;
    var atEnd = !scrollable || list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    frame.classList.toggle('is-scrollable', scrollable);
    frame.classList.toggle('is-at-end', atEnd);
    frame.dataset.scrollable = String(scrollable);
    if (!count) {
      cue.textContent = 'No regions available';
    } else if (scrollable && !atEnd) {
      cue.textContent = count + ' regions · More regions below ↓';
    } else if (scrollable) {
      cue.textContent = count + ' regions · End of region list';
    } else {
      cue.textContent = count + ' regions shown';
    }
  }

  function resolveRegionColor(name) {
    var token = colorByName.get(name) || color('--accent', 'currentColor');
    var probe = document.createElement('span');
    probe.style.color = token;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    var resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }

  function setCommandStage(id, commands, emptyText) {
    var output = element(id);
    output.textContent = commands.length ? commands.join('\n') : emptyText;
    output.dataset.copyText = commands.join('\n');
  }

  function updateSelector(id) {
    var select = element(id);
    var previous = select.value;
    select.replaceChildren();
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'No choice';
    select.appendChild(none);
    selected.slice().sort().forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = selected.indexOf(previous) >= 0 ? previous : '';
  }

  function updateRowsAndCommands() {
    var selectedSet = new Set(selected);
    var detailByName = new Map(recommendationDetails.map(function (item) {
      return [item.definition.name, item];
    }));
    rowByName.forEach(function (row, name) {
      var detail = detailByName.get(name);
      var reason = detail && detail.reason;
      row.checkbox.checked = selectedSet.has(name);
      row.root.classList.toggle('is-selected', selectedSet.has(name));
      row.root.classList.toggle('is-recommended', !!reason);
      row.badge.textContent = reason === 'direct'
        ? 'Recommended: direct boundary match'
        : reason === 'ancestor' ? 'Recommended: required ancestor'
          : reason === 'nearby' ? 'Nearby border: about ' + Math.round(detail.distanceKm) + ' km away (not selected)' : '';
    });
    updateSelector('region-scope-home');
    updateSelector('region-scope-default');
    renderCommands();
  }

  function renderCommands() {
    var warning = element('region-scope-warning');
    try {
      var generated = RegionScopeHelpers.buildCommands(definitions, selected, {
        home: element('region-scope-home').value,
        defaultRegion: element('region-scope-default').value,
      });
      setCommandStage('region-scope-mutations', generated.mutationCommands, 'Select at least one region to generate a one-shot region def command.');
      setCommandStage('region-scope-verification', generated.verificationCommands, 'region');
      setCommandStage('region-scope-home-default-commands',
        generated.homeCommands.concat(generated.defaultCommands),
        'No optional home/default choice.');
      setCommandStage('region-scope-save-command', generated.persistenceCommands, 'region save');
      warning.textContent = generated.warning + ' ' + generated.defaultWarning;
    } catch (error) {
      setCommandStage('region-scope-mutations', [], 'Commands unavailable: ' + error.message);
      setCommandStage('region-scope-verification', ['region'], 'region');
      setCommandStage('region-scope-home-default-commands', [], 'No optional home/default choice.');
      setCommandStage('region-scope-save-command', ['region save'], 'region save');
      warning.textContent = 'Correct the selected region hierarchy before using commands.';
    }
  }

  function showBoundaries() {
    if (!boundaryLayer) return;
    boundaryLayer.clearLayers();
    var recommendedSet = new Set(recommendationDetails.map(function (item) { return item.definition.name; }));
    var renderedColors = [];
    definitions.forEach(function (definition) {
      if (!definition.geometry) return;
      var renderedColor = resolveRegionColor(definition.name);
      renderedColors.push(renderedColor);
      L.geoJSON(definition.geometry, {
        style: function () {
          return {
            color: renderedColor,
            weight: recommendedSet.has(definition.name) ? 3 : 1,
            fillOpacity: recommendedSet.has(definition.name) ? 0.16 : 0.04,
          };
        },
        interactive: false,
      }).addTo(boundaryLayer);
    });
    if (map) map.getContainer().dataset.boundaryColors = JSON.stringify(renderedColors);
  }

  function chooseLocation(latlng, writeURL) {
    if (!map || !validPoint(latlng.lat, latlng.lng)) return;
    if (writeURL !== false) { pendingURLState = null; urlStateDirty = true; }
    var nextPoint = [Number(latlng.lng), Number(latlng.lat)];
    if (lastRecommendationPoint &&
        (lastRecommendationPoint[0] !== nextPoint[0] || lastRecommendationPoint[1] !== nextPoint[1])) {
      manualRemovals.clear();
    }
    lastRecommendationPoint = nextPoint;
    if (marker) marker.setLatLng(latlng); else marker = L.marker(latlng).addTo(map);
    element('region-scope-lat').value = Number(latlng.lat).toFixed(5);
    element('region-scope-lon').value = Number(latlng.lng).toFixed(5);
    recommendationDetails = RegionScopeHelpers.recommendRegionDetails(definitions, nextPoint);
    reconcileSelection();
    updateRowsAndCommands();
    showBoundaries();
    var directCount = recommendationDetails.filter(function (item) { return item.reason === 'direct'; }).length;
    var ancestorCount = recommendationDetails.filter(function (item) { return item.reason === 'ancestor'; }).length;
    var nearbyCount = recommendationDetails.filter(function (item) { return item.reason === 'nearby'; }).length;
    var status = element('region-scope-status');
    status.textContent = recommendationDetails.length
      ? 'Recommended ' + directCount + ' direct boundary match' + (directCount === 1 ? '' : 'es') +
        ', ' + ancestorCount + ' required ancestor' + (ancestorCount === 1 ? '' : 's') +
        ', and ' + nearbyCount + ' nearby border suggestion' + (nearbyCount === 1 ? '' : 's') +
        ' for ' + Number(latlng.lat).toFixed(5) + ', ' + Number(latlng.lng).toFixed(5) + '.'
      : 'No saved boundary contains ' + Number(latlng.lat).toFixed(5) + ', ' + Number(latlng.lng).toFixed(5) +
        '. Prior automatic geography was cleared; manual overrides remain.';
    if (writeURL !== false) persistURLState();
  }

  function recommendFromInputs() {
    var lat = Number(element('region-scope-lat').value);
    var lon = Number(element('region-scope-lon').value);
    if (!validPoint(element('region-scope-lat').value, element('region-scope-lon').value)) {
      element('region-scope-status').textContent = 'Enter a latitude from -90 to 90 and longitude from -180 to 180.';
      return;
    }
    chooseLocation({ lat: lat, lng: lon });
    map.setView([lat, lon], Math.max(map.getZoom(), 7));
  }

  function initMap() {
    map = L.map('region-scope-map', { preferCanvas: true }).setView([35.85, -86.4], 7);
    if (typeof window._applyTilesToNodeMap === 'function') {
      window._applyTilesToNodeMap(map);
    } else {
      console.warn('[region-scope] _applyTilesToNodeMap unavailable — using OSM fallback');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19,
      }).addTo(map);
    }
    boundaryLayer = L.layerGroup().addTo(map);
    map.on('click', function (event) { chooseLocation(event.latlng); });
    showBoundaries();
  }

  function renderLoadedDefinitions(body, generation) {
    if (generation !== loadGeneration) return;
    definitions = Array.isArray(body) ? body : [];
    definitions.sort(function (a, b) { return a.name.localeCompare(b.name); });
    colorByName.clear();
    definitions.forEach(function (definition, index) {
      colorByName.set(definition.name, RegionScopeHelpers.regionColorToken(index, definitions.length, definition.color));
    });
    var list = element('region-scope-list');
    list.replaceChildren();
    rowByName.clear();
    if (!definitions.length) {
      var empty = document.createElement('p');
      empty.className = 'region-scope-empty';
      empty.textContent = 'No region definitions have been configured.';
      list.appendChild(empty);
    } else {
      var fragment = document.createDocumentFragment();
      definitions.forEach(function (definition) { fragment.appendChild(createRow(definition)); });
      list.appendChild(fragment);
    }
    requestAnimationFrame(updateListAffordance);
    if (lastRecommendationPoint) {
      chooseLocation({ lat: lastRecommendationPoint[1], lng: lastRecommendationPoint[0] }, false);
    } else {
      reconcileSelection();
      updateRowsAndCommands();
      showBoundaries();
      element('region-scope-status').textContent = 'Click the map or enter coordinates for recommendations.';
    }
    if (pendingURLState) {
      var state = pendingURLState;
      pendingURLState = null;
      restoreURLState(state);
    } else if (urlStateDirty) {
      persistURLState();
    }
  }

  function loadDefinitions(generation) {
    var status = element('region-scope-status');
    var list = element('region-scope-list');
    list.replaceChildren();
    var version = definitionsVersion();
    if (definitionsCache && definitionsCacheVersion === version) {
      renderLoadedDefinitions(definitionsCache, generation);
      return Promise.resolve();
    }
    status.textContent = 'Loading saved region definitions…';
    if (!definitionsPromise || definitionsPromiseVersion !== version) {
      definitionsPromiseVersion = version;
      definitionsPromise = fetch('/api/config/hash-region-definitions').then(function (response) {
        if (!response.ok) throw new Error('request failed (' + response.status + ')');
        return response.json();
      }).then(function (body) {
        var loaded = Array.isArray(body) ? body : [];
        if (definitionsVersion() === version) {
          definitionsCache = loaded;
          definitionsCacheVersion = version;
        }
        return loaded;
      }).finally(function () {
        if (definitionsPromiseVersion === version) definitionsPromise = null;
      });
    }
    return definitionsPromise.then(function (body) {
      if (generation !== loadGeneration) return;
      renderLoadedDefinitions(body, generation);
    }).catch(function (error) {
      if (generation !== loadGeneration) return;
      status.textContent = 'Could not load region definitions: ' + error.message;
    });
  }

  function copyStage(buttonId, outputId, label) {
    var generation = loadGeneration;
    var status = element('region-scope-status');
    element(buttonId).addEventListener('click', function () {
      var text = element(outputId).dataset.copyText || '';
      if (!text) {
        element('region-scope-status').textContent = 'Nothing to copy for ' + label + '.';
        return;
      }
      navigator.clipboard.writeText(text).then(function () {
        if (generation !== loadGeneration || element('region-scope-status') !== status) return;
        status.textContent = label + ' copied to clipboard.';
      }).catch(function () {
        if (generation !== loadGeneration || element('region-scope-status') !== status) return;
        status.textContent = 'Copy failed. Select the stage and copy it manually.';
      });
    });
  }

  registerPage('region-scope', {
    init: function (container) {
      var generation = ++loadGeneration;
      definitions = []; selected = []; recommendationDetails = [];
      manualAdditions = new Set(); manualRemovals = new Set(); rowByName = new Map();
      colorByName = new Map();
      lastRecommendationPoint = null;
      pendingURLState = readURLState();
      urlStateDirty = false;
      container.innerHTML =
        '<section class="region-scope-page" aria-labelledby="region-scope-title">' +
          '<header class="region-scope-header"><h2 id="region-scope-title">Region Scope Helper</h2>' +
          '<p>Choose a proposed repeater location, review the recommendation reasons, then inspect each command stage before applying it.</p></header>' +
          '<div class="region-scope-layout">' +
            '<section class="region-scope-card" aria-labelledby="region-map-title"><h3 id="region-map-title">Proposed location</h3>' +
              '<p class="region-scope-help">Enter coordinates or click the map. The helper compares that point with saved administrative boundaries; it does not estimate radio coverage.</p>' +
              '<form id="region-scope-coordinate-form" class="region-scope-coordinate-form">' +
                '<label for="region-scope-lat">Latitude</label><input id="region-scope-lat" name="latitude" type="number" min="-90" max="90" step="any" required>' +
                '<label for="region-scope-lon">Longitude</label><input id="region-scope-lon" name="longitude" type="number" min="-180" max="180" step="any" required>' +
                '<button type="submit" class="btn-secondary" id="region-scope-recommend">Recommend regions</button>' +
              '</form>' +
              '<div id="region-scope-map" role="application" aria-label="Map for choosing a proposed repeater location"></div>' +
              '<p id="region-scope-status" class="region-scope-status" role="status" aria-live="polite"></p></section>' +
            '<section class="region-scope-card" aria-labelledby="region-list-title"><h3 id="region-list-title">Available regions</h3>' +
              '<p class="region-scope-help">Checked regions are included in the repeater’s forwarding hierarchy. Selecting a child also includes every required ancestor.</p>' +
              '<p class="region-scope-status">Recommendation labels identify direct boundary matches, required ancestors, and nearby borders. Nearby regions are suggestions only and stay unchecked until you choose them.</p>' +
              '<div id="region-scope-list-frame" class="region-scope-list-frame" data-scrollable="false">' +
                '<div class="region-scope-list-heading"><strong>Select regions</strong><span id="region-scope-list-cue">Loading regions…</span></div>' +
                '<div id="region-scope-list" class="region-scope-list" tabindex="0" aria-describedby="region-scope-list-cue"></div>' +
              '</div>' +
              '<div class="region-scope-selectors">' +
                '<label for="region-scope-home">Optional home region</label><select id="region-scope-home" aria-describedby="region-scope-home-help"><option value="">No choice</option></select>' +
                '<p id="region-scope-home-help" class="region-scope-help">Home region marks this repeater’s local place in the displayed hierarchy with <code>^</code>. It does not choose the scope for outgoing messages.</p>' +
                '<label for="region-scope-default">Optional default scope</label><select id="region-scope-default" aria-describedby="region-scope-default-help"><option value="">No choice</option></select>' +
                '<p id="region-scope-default-help" class="region-scope-help">Default scope is attached to this repeater’s flooded adverts and is used for flood replies when the request’s scope cannot be reused.</p>' +
              '</div>' +
              '<p class="region-scope-warning">The <code>region default</code> command persists immediately. Inspect the hierarchy before applying it.</p>' +
              '<section class="region-scope-stage" aria-labelledby="region-mutations-title"><div class="region-scope-command-head"><h3 id="region-mutations-title">1. Define hierarchy (one-shot)</h3><button type="button" class="btn-secondary" id="copy-region-mutations">Copy region def</button></div><p class="region-scope-help">Creates or reparents the complete selected tree in one current-firmware command. It does not remove unselected regions already on the repeater. If firmware reports an error, earlier mutations from that command may remain in memory; inspect the result before saving.</p><pre id="region-scope-mutations" class="region-scope-commands" tabindex="0"></pre></section>' +
              '<section class="region-scope-stage" aria-labelledby="region-verification-title"><div class="region-scope-command-head"><h3 id="region-verification-title">2. Inspect result</h3><button type="button" class="btn-secondary" id="copy-region-verification">Copy verification</button></div><p class="region-scope-help">Displays the repeater’s resulting in-memory tree so you can verify parentage before saving.</p><pre id="region-scope-verification" class="region-scope-commands" tabindex="0"></pre></section>' +
              '<section class="region-scope-stage" aria-labelledby="region-optional-title"><div class="region-scope-command-head"><h3 id="region-optional-title">3. Optional home/default</h3><button type="button" class="btn-secondary" id="copy-region-home-default">Copy optional choices</button></div><p class="region-scope-help">Applies only the home and default choices selected above. Leave both at “No choice” to skip this step.</p><pre id="region-scope-home-default-commands" class="region-scope-commands" tabindex="0"></pre></section>' +
              '<section class="region-scope-stage" aria-labelledby="region-save-title"><div class="region-scope-command-head"><h3 id="region-save-title">4. Persist hierarchy</h3><button type="button" class="btn-secondary" id="copy-region-save">Copy save</button></div><p class="region-scope-help">Writes the verified in-memory hierarchy to persistent storage so it survives a reboot.</p><pre id="region-scope-save-command" class="region-scope-commands" tabindex="0"></pre></section>' +
              '<p id="region-scope-warning" class="region-scope-warning"></p>' +
            '</section>' +
          '</div>' +
        '</section>';
      element('region-scope-coordinate-form').addEventListener('submit', function (event) {
        event.preventDefault();
        recommendFromInputs();
      });
      function changeChoice() { renderCommands(); persistURLState(); }
      element('region-scope-home').addEventListener('change', changeChoice);
      element('region-scope-default').addEventListener('change', changeChoice);
      element('region-scope-list').addEventListener('scroll', updateListAffordance);
      listResizeHandler = updateListAffordance;
      window.addEventListener('resize', listResizeHandler);
      themeColorHandler = showBoundaries;
      window.addEventListener('theme-changed', themeColorHandler);
      copyStage('copy-region-mutations', 'region-scope-mutations', 'Region definition command');
      copyStage('copy-region-verification', 'region-scope-verification', 'Verification command');
      copyStage('copy-region-home-default', 'region-scope-home-default-commands', 'Optional home/default commands');
      copyStage('copy-region-save', 'region-scope-save-command', 'Persistence command');
      initMap();
      loadDefinitions(generation);
    },
    destroy: function () {
      loadGeneration++;
      if (listResizeHandler) { window.removeEventListener('resize', listResizeHandler); listResizeHandler = null; }
      if (themeColorHandler) { window.removeEventListener('theme-changed', themeColorHandler); themeColorHandler = null; }
      if (map) { map.remove(); map = null; }
      marker = null; boundaryLayer = null; rowByName.clear(); colorByName.clear();
    },
  });
})();
