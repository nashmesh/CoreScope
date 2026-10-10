(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HashRegionAdminCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var MAX_PAYLOAD_BYTES = 1024 * 1024;

  function normalize(name) {
    name = String(name || '').trim();
    if (!name) return '';
    return name.charAt(0) === '#' ? name : '#' + name;
  }

  function normalizeColor(value) {
    var color = String(value || '').trim();
    if (!color) return '';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Region color must use #RRGGBB format.');
    return color.toLowerCase();
  }

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

  function renameDefinition(definitions, index, requestedName) {
    var next = normalize(requestedName);
    var previous = normalize(definitions[index].name);
    if (!next || next === '#') throw new Error('Every region needs a name after #.');
    if (definitions.some(function (item, itemIndex) { return itemIndex !== index && normalize(item.name) === next; })) {
      throw new Error('Duplicate region name: ' + next);
    }
    definitions[index].name = next;
    definitions.forEach(function (item, itemIndex) {
      if (itemIndex !== index && normalize(item.parentName) === previous) item.parentName = next;
    });
    return next;
  }

  function descendantNames(definitions, index) {
    var descendants = new Set();
    var frontier = [normalize(definitions[index].name)];
    while (frontier.length) {
      var parent = frontier.pop();
      definitions.forEach(function (item) {
        var name = normalize(item.name);
        if (name && normalize(item.parentName) === parent && !descendants.has(name)) {
          descendants.add(name);
          frontier.push(name);
        }
      });
    }
    return descendants;
  }

  function parentCandidateNames(definitions, index) {
    var blocked = descendantNames(definitions, index);
    blocked.add(normalize(definitions[index].name));
    return definitions.map(function (item) { return normalize(item.name); }).filter(function (name) {
      return name && !blocked.has(name);
    });
  }

  function validateHierarchy(definitions) {
    var names = new Set();
    var parents = {};
    definitions.forEach(function (item) {
      var name = normalize(item.name);
      var parent = normalize(item.parentName);
      if (!name || name === '#') throw new Error('Every region needs a name after #.');
      if (names.has(name)) throw new Error('Duplicate region name: ' + name);
      names.add(name);
      parents[name] = parent;
    });
    Object.keys(parents).forEach(function (name) {
      if (parents[name] && !names.has(parents[name])) throw new Error('Missing parent ' + parents[name] + ' for ' + name + '.');
      if (parents[name] === name) throw new Error(name + ' cannot be its own parent.');
    });
    var state = {};
    function visit(name) {
      if (state[name] === 1) throw new Error('Region hierarchy contains a cycle at ' + name + '.');
      if (state[name] === 2) return;
      state[name] = 1;
      if (parents[name]) visit(parents[name]);
      state[name] = 2;
    }
    Object.keys(parents).forEach(visit);
    return true;
  }

  function orderDefinitionsParentFirst(definitions) {
    var byParent = new Map();
    var names = new Set((definitions || []).map(function (item) { return normalize(item.name); }));
    (definitions || []).forEach(function (definition) {
      var parent = normalize(definition.parentName);
      if (!parent || !names.has(parent)) parent = '';
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(definition);
    });
    var ordered = [];
    var visited = new Set();
    function visit(definition, depth) {
      if (visited.has(definition)) return;
      visited.add(definition);
      ordered.push({ definition: definition, depth: depth });
      (byParent.get(normalize(definition.name)) || []).forEach(function (child) { visit(child, depth + 1); });
    }
    (byParent.get('') || []).forEach(function (definition) { visit(definition, 0); });
    (definitions || []).forEach(function (definition) { visit(definition, 0); });
    return ordered;
  }

  function replacePolygonOuterRing(geometry, points) {
    if (geometry && geometry.type !== 'Polygon') throw new Error('Use full GeoJSON editing for MultiPolygon boundaries.');
    var ring = points.map(function (position) { return [Number(position[0]), Number(position[1])]; });
    if (ring.length < 3) throw new Error('Enter at least three vertices.');
    ring.push(ring[0].slice());
    var holes = geometry && geometry.coordinates ? clone(geometry.coordinates.slice(1)) : [];
    return { type: 'Polygon', coordinates: [ring].concat(holes) };
  }

  function geometryToEditableGeoJSON(geometry) {
    return geometry ? JSON.stringify(geometry, null, 2) : '';
  }

  function parseEditableGeoJSON(text) {
    var geometry = JSON.parse(String(text || ''));
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || !Array.isArray(geometry.coordinates)) {
      throw new Error('GeoJSON must be a Polygon or MultiPolygon geometry.');
    }
    return clone(geometry);
  }

  function sampleFreehandPoint(points, point, minimumDistance) {
    var result = points.slice();
    if (!result.length) { result.push(point.slice()); return result; }
    var previous = result[result.length - 1];
    var dx = point[0] - previous[0];
    var dy = point[1] - previous[1];
    if (Math.sqrt(dx * dx + dy * dy) >= minimumDistance) result.push(point.slice());
    return result;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
    return unescape(encodeURIComponent(text)).length;
  }

  function payloadByteStatus(payload) {
    var bytes = utf8Bytes(JSON.stringify(payload));
    var overLimit = bytes > MAX_PAYLOAD_BYTES;
    return {
      bytes: bytes,
      overLimit: overLimit,
      message: bytes.toLocaleString() + ' bytes — ' + (overLimit ? 'over 1 MiB limit' : 'under 1 MiB limit'),
    };
  }

  function backupImportSummary(result) {
    result = result || {};
    var mode = result.mode === 'replace' ? 'replace' : 'merge';
    var parts = [Number(result.added || 0) + ' added', Number(result.updated || 0) + ' updated'];
    if (mode === 'merge') parts.push(Number(result.preserved || 0) + ' preserved');
    else parts.push(Number(result.removed || 0) + ' removed');
    return 'Valid ' + mode + ' backup: ' + parts.join(', ') + '; ' + Number(result.total || 0) + ' regions after import.';
  }

  function isCurrentBackupPreview(generation, currentGeneration, mode, currentMode, text, currentText) {
    return generation === currentGeneration && mode === currentMode && text === currentText;
  }

  return {
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
    normalize: normalize,
    normalizeColor: normalizeColor,
    renameDefinition: renameDefinition,
    descendantNames: descendantNames,
    parentCandidateNames: parentCandidateNames,
    validateHierarchy: validateHierarchy,
    orderDefinitionsParentFirst: orderDefinitionsParentFirst,
    replacePolygonOuterRing: replacePolygonOuterRing,
    geometryToEditableGeoJSON: geometryToEditableGeoJSON,
    parseEditableGeoJSON: parseEditableGeoJSON,
    sampleFreehandPoint: sampleFreehandPoint,
    payloadByteStatus: payloadByteStatus,
    backupImportSummary: backupImportSummary,
    isCurrentBackupPreview: isCurrentBackupPreview,
  };
});

(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var core = window.HashRegionAdminCore;

  var listEl = document.getElementById('region-editor-list');
  var errorEl = document.getElementById('regions-error');
  var saveBtn = document.getElementById('save-regions-btn');
  var saveStatus = document.getElementById('save-status');
  var stateSelect = document.getElementById('state-select');
  var countySelect = document.getElementById('county-select');
  var coordinateInput = document.getElementById('geometry-coordinates');
  var geoJSONInput = document.getElementById('geojson-import');
  var payloadStatus = document.getElementById('payload-size-status');
  var freehandInput = document.getElementById('freehand-mode');
  var applyCountiesBtn = document.getElementById('apply-counties-btn');
  var exportRegionsBtn = document.getElementById('export-regions-btn');
  var chooseBackupBtn = document.getElementById('choose-region-backup-btn');
  var backupFileInput = document.getElementById('region-backup-file');
  var backupModeSelect = document.getElementById('region-backup-mode');
  var replaceConfirmInput = document.getElementById('region-replace-confirm');
  var importRegionsBtn = document.getElementById('import-regions-btn');
  var backupStatus = document.getElementById('region-backup-status');
  var definitions = [];
  var rows = [];
  var counties = [];
  var countyByGeoID = new Map();
  var activeIndex = -1;
  var map;
  var geometryLayer;
  var vertexLayer;
  var drawing = false;
  var drawingOwner = null;
  var editGeneration = 0;
  var freehandPointerDown = false;
  var freehandPointerId = null;
  var suppressNextClick = false;
  var drawingPoints = [];
  var tileLayer;
  var regionsLoaded = false;
  var backupText = '';
  var backupPreview = null;
  var backupPreviewText = '';
  var backupPreviewMode = '';
  var backupValidationGeneration = 0;

  function payloadObject() {
    return { hashRegionDefinitions: definitions.map(function (definition) {
      return {
        name: core.normalize(definition.name),
        parentName: core.normalize(definition.parentName),
        description: String(definition.description || '').trim(),
        color: core.normalizeColor(definition.color),
        geometry: definition.geometry || null,
      };
    }) };
  }

  function updatePayloadStatus() {
    var status = core.payloadByteStatus(payloadObject());
    payloadStatus.textContent = status.message;
    payloadStatus.classList.toggle('is-over-limit', status.overLimit);
    saveBtn.disabled = !regionsLoaded || status.overLimit;
    saveBtn.setAttribute('aria-disabled', saveBtn.disabled ? 'true' : 'false');
    return status;
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function csrfHeaders() {
    return { 'X-CSRF-Token': getCookie('corescope_admin_csrf') };
  }

  function fetchJSON(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers, csrfHeaders());
    return fetch(url, Object.assign({ credentials: 'same-origin' }, opts, { headers: headers })).then(function (response) {
      if (response.status === 401) {
        window.location.href = '/admin/login';
        throw new Error('not logged in');
      }
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || ('request failed (' + response.status + ')'));
        return body;
      });
    });
  }

  function backupMode() {
    return backupModeSelect.value === 'replace' ? 'replace' : 'merge';
  }

  function refreshBackupImportButton() {
    var mode = backupMode();
    var previewMatches = backupPreview && backupPreview.revision && backupPreviewText === backupText && backupPreviewMode === mode;
    var confirmed = mode !== 'replace' || replaceConfirmInput.checked;
    importRegionsBtn.disabled = !backupText || !previewMatches || !confirmed;
    replaceConfirmInput.disabled = mode !== 'replace';
  }

  function validateBackupForImport() {
    var generation = ++backupValidationGeneration;
    var text = backupText;
    var mode = backupMode();
    backupPreview = null;
    backupPreviewText = '';
    backupPreviewMode = '';
    refreshBackupImportButton();
    backupStatus.classList.toggle('is-destructive', mode === 'replace');
    if (!text) {
      backupStatus.textContent = 'Choose a backup file to validate it before import.';
      return Promise.resolve();
    }
    backupStatus.textContent = 'Validating backup without changing saved regions…';
    return fetchJSON('/api/admin/hash-regions/import?mode=' + encodeURIComponent(mode) + '&dryRun=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    }).then(function (preview) {
      if (!core.isCurrentBackupPreview(generation, backupValidationGeneration, mode, backupMode(), text, backupText)) return;
      backupPreview = preview;
      backupPreviewText = text;
      backupPreviewMode = mode;
      backupStatus.textContent = core.backupImportSummary(preview) +
        (mode === 'replace' && preview.removed ? ' Confirm the removal warning before importing.' : '');
      refreshBackupImportButton();
    }).catch(function (error) {
      if (!core.isCurrentBackupPreview(generation, backupValidationGeneration, mode, backupMode(), text, backupText)) return;
      backupStatus.textContent = 'Backup rejected: ' + (error.message || String(error));
      refreshBackupImportButton();
    });
  }

  function readBackupFile(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('Unable to read the selected backup file.')); };
      reader.readAsText(file);
    });
  }

  function normalize(name) {
    return core.normalize(name);
  }

  function cloneGeometry(geometry) {
    return geometry ? JSON.parse(JSON.stringify(geometry)) : null;
  }

  function field(labelText, control) {
    var wrap = document.createElement('div');
    wrap.className = 'region-definition-field';
    var label = document.createElement('label');
    label.textContent = labelText;
    label.htmlFor = control.id;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  function makeInput(id, value) {
    var input = document.createElement('input');
    input.id = id;
    input.type = 'text';
    input.value = value || '';
    return input;
  }

  function createRegionRow(definition, index, depth) {
    var card = document.createElement('article');
    card.className = 'region-definition-card';
    card.style.setProperty('--region-tree-depth', String(depth || 0));
    card.classList.toggle('is-child-region', depth > 0);
    card.setAttribute('aria-label', (depth ? 'Child region level ' + depth + ': ' : 'Root region: ') + (definition.name || 'unnamed'));
    var name = makeInput('region-name-' + index, definition.name);
    name.maxLength = 64;
    name.placeholder = '#region-name';
    var parent = document.createElement('select');
    parent.id = 'region-parent-' + index;
    var description = document.createElement('textarea');
    description.id = 'region-description-' + index;
    description.maxLength = 2000;
    description.value = definition.description || '';
    description.placeholder = 'Explain when and why this scope applies.';
    var colorInput = document.createElement('input');
    colorInput.id = 'region-color-' + index;
    colorInput.type = 'color';
    var customColor = core.normalizeColor(definition.color);
    if (customColor) colorInput.value = customColor;
    else {
      var themeColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      try { colorInput.value = core.normalizeColor(themeColor); } catch (_) { /* retain browser default */ }
    }
    colorInput.disabled = !customColor;
    var automaticColor = document.createElement('input');
    automaticColor.id = 'region-color-auto-' + index;
    automaticColor.type = 'checkbox';
    automaticColor.checked = !customColor;
    var automaticColorLabel = document.createElement('label');
    automaticColorLabel.className = 'region-color-auto';
    automaticColorLabel.htmlFor = automaticColor.id;
    automaticColorLabel.appendChild(automaticColor);
    automaticColorLabel.appendChild(document.createTextNode(' Automatic color'));
    var colorField = field('Color', colorInput);
    colorField.appendChild(automaticColorLabel);
    if (customColor) card.style.setProperty('--region-admin-color', customColor);

    name.addEventListener('input', function () {
      if (activeIndex === index) {
        document.getElementById('boundary-active-status').textContent = 'Editing boundary for ' + (normalize(name.value) || 'unnamed region') + '.';
      }
    });
    name.addEventListener('blur', function () {
      clearError();
      try {
        name.value = core.renameDefinition(definitions, index, name.value);
        refreshParentSelectors();
        updateActiveStatus();
        updatePayloadStatus();
      } catch (error) {
        name.value = definitions[index].name;
        showError(error);
      }
    });
    parent.addEventListener('change', function () {
      var previous = definition.parentName;
      definition.parentName = parent.value;
      try {
        core.validateHierarchy(definitions);
        renderRows();
        updatePayloadStatus();
      } catch (error) {
        definition.parentName = previous;
        parent.value = normalize(previous);
        showError(error);
      }
    });
    description.addEventListener('input', function () { definition.description = description.value; updatePayloadStatus(); });
    colorInput.addEventListener('input', function () {
      definition.color = core.normalizeColor(colorInput.value);
      card.style.setProperty('--region-admin-color', definition.color);
      renderGeometry(false);
      updatePayloadStatus();
    });
    automaticColor.addEventListener('change', function () {
      colorInput.disabled = automaticColor.checked;
      definition.color = automaticColor.checked ? '' : core.normalizeColor(colorInput.value);
      if (definition.color) card.style.setProperty('--region-admin-color', definition.color);
      else card.style.removeProperty('--region-admin-color');
      renderGeometry(false);
      updatePayloadStatus();
    });

    var actions = document.createElement('div');
    actions.className = 'region-card-actions';
    var edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'btn-secondary'; edit.textContent = 'Edit boundary';
    edit.addEventListener('click', function () { setActive(index, true); });
    var remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'toggle on'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + (definition.name || 'region'));
    remove.addEventListener('click', function () {
      var removedName = normalize(definition.name);
      var child = definitions.find(function (item) { return normalize(item.parentName) === removedName; });
      if (child) {
        showError(new Error('Move or remove child ' + normalize(child.name) + ' before removing ' + removedName + '.'));
        return;
      }
      cancelDrawing();
      definitions.splice(index, 1);
      activeIndex = -1;
      renderRows();
      renderGeometry(false);
      updatePayloadStatus();
    });
    actions.appendChild(edit);
    actions.appendChild(remove);

    card.appendChild(field('Name', name));
    card.appendChild(field('Parent', parent));
    card.appendChild(field('Description', description));
    card.appendChild(colorField);
    card.appendChild(actions);
    listEl.appendChild(card);
    rows.push({ card: card, name: name, parent: parent, description: description, color: colorInput });
  }

  function renderRows() {
    var activeDefinition = activeIndex >= 0 ? definitions[activeIndex] : null;
    var ordered = core.orderDefinitionsParentFirst(definitions);
    definitions = ordered.map(function (item) { return item.definition; });
    activeIndex = activeDefinition ? definitions.indexOf(activeDefinition) : -1;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    rows = [];
    if (!definitions.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-note';
      empty.textContent = 'No regions configured yet.';
      listEl.appendChild(empty);
    } else {
      definitions.forEach(function (definition, index) {
        var orderedItem = ordered.find(function (item) { return item.definition === definition; });
        createRegionRow(definition, index, orderedItem ? orderedItem.depth : 0);
      });
    }
    refreshParentSelectors();
    rows.forEach(function (row, index) { row.card.classList.toggle('is-active', index === activeIndex); });
  }

  function refreshParentSelectors() {
    rows.forEach(function (row, index) {
      var saved = definitions[index].parentName || '';
      while (row.parent.firstChild) row.parent.removeChild(row.parent.firstChild);
      var root = document.createElement('option');
      root.value = ''; root.textContent = 'Wildcard root (*)';
      row.parent.appendChild(root);
      core.parentCandidateNames(definitions, index).forEach(function (normalized) {
        var option = document.createElement('option');
        option.value = normalized; option.textContent = normalized;
        row.parent.appendChild(option);
      });
      var normalizedSaved = normalize(saved);
      var canSelectSaved = !normalizedSaved || Array.prototype.some.call(row.parent.options, function (option) { return option.value === normalizedSaved; });
      if (!canSelectSaved) {
        var invalid = document.createElement('option');
        invalid.value = normalizedSaved;
        invalid.textContent = normalizedSaved + ' (invalid parent — choose another)';
        row.parent.appendChild(invalid);
      }
      row.parent.value = normalizedSaved;
    });
  }

  function updateActiveStatus() {
    var status = document.getElementById('boundary-active-status');
    status.textContent = activeIndex >= 0 && definitions[activeIndex]
      ? 'Editing boundary for ' + (normalize(definitions[activeIndex].name) || 'unnamed region') + '.'
      : 'Choose “Edit boundary” on a region.';
  }

  function setActive(index, fit) {
    if (definitions[activeIndex] !== definitions[index]) cancelDrawing();
    activeIndex = index;
    rows.forEach(function (row, rowIndex) { row.card.classList.toggle('is-active', rowIndex === index); });
    updateActiveStatus();
    renderGeometry(fit);
  }

  function leafletColor(variable, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
  }

  function syncTileLayer() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var providers = window.MC_TILE_PROVIDERS || {};
    var id = dark && window.MC_getDarkTileProvider ? window.MC_getDarkTileProvider() :
      (!dark && window.MC_getLightTileProvider ? window.MC_getLightTileProvider() : (dark ? 'carto-dark' : 'carto-light'));
    var provider = providers[id];
    var url = provider ? (typeof provider.url === 'function' ? provider.url() : provider.url) :
      (dark ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png');
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(url, {
      attribution: provider ? provider.attribution : '© OpenStreetMap contributors © CARTO',
      maxZoom: provider ? provider.maxZoom : 19,
    }).addTo(map);
    var pane = map.getPane('tilePane');
    if (pane) pane.style.filter = dark && provider && provider.invertFilter ? provider.invertFilter : '';
  }

  function cancelDrawing() {
    ++editGeneration;
    drawing = false;
    drawingOwner = null;
    drawingPoints = [];
    freehandPointerDown = false;
    var pointerId = freehandPointerId;
    freehandPointerId = null;
    suppressNextClick = false;
    if (map) {
      var container = map.getContainer();
      if (pointerId !== null && container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
      map.dragging.enable();
    }
    document.getElementById('finish-polygon-btn').disabled = true;
  }

  function isCurrentDrawing() {
    return drawing && drawingOwner === definitions[activeIndex];
  }

  function addFreehandPoint(event) {
    if (!isCurrentDrawing() || event.pointerId !== freehandPointerId) return;
    var rect = map.getContainer().getBoundingClientRect();
    var point = map.containerPointToLatLng(L.point(event.clientX - rect.left, event.clientY - rect.top));
    drawingPoints = core.sampleFreehandPoint(drawingPoints, [point.lng, point.lat], 0.0001);
    renderDrawingVertices();
  }

  function initMap() {
    map = L.map('geometry-map', { preferCanvas: true }).setView([35.85, -86.4], 7);
    syncTileLayer();
    geometryLayer = L.layerGroup().addTo(map);
    vertexLayer = L.layerGroup().addTo(map);
    map.on('click', function (event) {
      if (suppressNextClick) { suppressNextClick = false; return; }
      if (!isCurrentDrawing() || freehandInput.checked || activeIndex < 0) return;
      drawingPoints.push([event.latlng.lng, event.latlng.lat]);
      renderDrawingVertices();
    });
    var container = map.getContainer();
    container.addEventListener('pointerdown', function (event) {
      if (!isCurrentDrawing() || !freehandInput.checked || activeIndex < 0 || freehandPointerDown) return;
      freehandPointerDown = true;
      freehandPointerId = event.pointerId;
      suppressNextClick = true;
      container.setPointerCapture(event.pointerId);
      map.dragging.disable();
      addFreehandPoint(event);
      event.preventDefault();
    });
    container.addEventListener('pointermove', function (event) {
      if (!freehandPointerDown || !isCurrentDrawing() || event.pointerId !== freehandPointerId) return;
      addFreehandPoint(event);
      event.preventDefault();
    });
    function endFreehand(event) {
      if (!freehandPointerDown || event.pointerId !== freehandPointerId) return;
      freehandPointerDown = false;
      freehandPointerId = null;
      if (event.type !== 'lostpointercapture' && container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      map.dragging.enable();
      if (event.cancelable) event.preventDefault();
    }
    container.addEventListener('pointerup', endFreehand);
    container.addEventListener('pointercancel', endFreehand);
    container.addEventListener('lostpointercapture', endFreehand);
    window.addEventListener('theme-changed', syncTileLayer);
    window.addEventListener('mc-tile-provider-changed', syncTileLayer);
    new MutationObserver(syncTileLayer).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function polygonOuterCoordinates(geometry) {
    if (!geometry || geometry.type !== 'Polygon' || !geometry.coordinates.length) return [];
    var ring = geometry.coordinates[0].slice();
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    return ring;
  }

  function renderCoordinateText(geometry) {
    geoJSONInput.value = core.geometryToEditableGeoJSON(geometry);
    var multiPolygon = geometry && geometry.type === 'MultiPolygon';
    document.getElementById('draw-polygon-btn').disabled = !!multiPolygon;
    freehandInput.disabled = !!multiPolygon;
    if (multiPolygon) freehandInput.checked = false;
    if (multiPolygon) {
      coordinateInput.value = '';
      coordinateInput.disabled = true;
      document.getElementById('apply-coordinates-btn').disabled = true;
      coordinateInput.placeholder = 'Use the full GeoJSON editor for MultiPolygon boundaries.';
      return;
    }
    coordinateInput.disabled = false;
    document.getElementById('apply-coordinates-btn').disabled = false;
    coordinateInput.placeholder = 'longitude, latitude — one vertex per line';
    coordinateInput.value = polygonOuterCoordinates(geometry).map(function (position) {
      return position[0] + ', ' + position[1];
    }).join('\n');
  }

  function addVertexMarkers(points) {
    var owner = definitions[activeIndex];
    var generation = editGeneration;
    points.forEach(function (position, index) {
      var marker = L.marker([position[1], position[0]], { draggable: true, keyboard: true, title: 'Boundary vertex ' + (index + 1) });
      marker.on('dragend', function () {
        if (owner !== definitions[activeIndex] || generation !== editGeneration) return;
        var latlng = marker.getLatLng();
        points[index] = [latlng.lng, latlng.lat];
        if (drawing) renderDrawingVertices(); else applyPolygonPoints(points);
      });
      marker.addTo(vertexLayer);
    });
  }

  function renderGeometry(fit) {
    geometryLayer.clearLayers();
    vertexLayer.clearLayers();
    var geometry = activeIndex >= 0 ? definitions[activeIndex].geometry : null;
    renderCoordinateText(geometry);
    if (!geometry) return;
    var layer = L.geoJSON(geometry, {
      style: { color: core.normalizeColor(definitions[activeIndex].color) || leafletColor('--accent', 'currentColor'), weight: 2, fillOpacity: 0.14 },
    }).addTo(geometryLayer);
    var points = polygonOuterCoordinates(geometry);
    if (points.length) addVertexMarkers(points);
    if (fit) {
      var bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
    }
  }

  function renderDrawingVertices() {
    geometryLayer.clearLayers();
    vertexLayer.clearLayers();
    addVertexMarkers(drawingPoints);
    if (drawingPoints.length > 1) {
      L.polyline(drawingPoints.map(function (position) { return [position[1], position[0]]; }), {
        color: leafletColor('--accent', 'currentColor'), weight: 2,
      }).addTo(geometryLayer);
    }
    coordinateInput.value = drawingPoints.map(function (position) { return position[0] + ', ' + position[1]; }).join('\n');
    document.getElementById('finish-polygon-btn').disabled = drawingPoints.length < 3;
  }

  function applyPolygonPoints(points) {
    if (activeIndex < 0 || points.length < 3) return;
    definitions[activeIndex].geometry = core.replacePolygonOuterRing(definitions[activeIndex].geometry, points);
    cancelDrawing();
    renderGeometry(false);
    updatePayloadStatus();
  }

  function setGeometry(geometry, fit) {
    if (activeIndex < 0) throw new Error('Choose a region before editing its boundary.');
    definitions[activeIndex].geometry = cloneGeometry(geometry);
    cancelDrawing();
    renderGeometry(fit);
    updatePayloadStatus();
  }

  function parseCoordinateLines(text) {
    var points = String(text || '').split(/\n+/).filter(function (line) { return line.trim(); }).map(function (line) {
      var parts = line.split(',').map(Number);
      if (parts.length !== 2 || !isFinite(parts[0]) || !isFinite(parts[1]) || parts[0] < -180 || parts[0] > 180 || parts[1] < -90 || parts[1] > 90) {
        throw new Error('Each coordinate line must be “longitude, latitude” in valid ranges.');
      }
      return parts;
    });
    if (points.length < 3) throw new Error('Enter at least three vertices.');
    return points;
  }

  function showError(error) {
    errorEl.style.display = 'block';
    errorEl.textContent = error.message || String(error);
  }

  function clearError() {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  function refreshCountyOptions() {
    var selectedStates = new Set(Array.prototype.map.call(stateSelect.selectedOptions, function (option) { return option.value; }));
    while (countySelect.firstChild) countySelect.removeChild(countySelect.firstChild);
    counties.filter(function (feature) { return selectedStates.has(feature.properties.STUSPS); })
      .sort(function (a, b) {
        return String(a.properties.STUSPS).localeCompare(String(b.properties.STUSPS)) ||
          String(a.properties.NAME).localeCompare(String(b.properties.NAME));
      }).forEach(function (feature) {
        var option = document.createElement('option');
        option.value = String(feature.properties.GEOID);
        option.textContent = feature.properties.STUSPS + ' — ' + (feature.properties.NAMELSAD || feature.properties.NAME);
        countySelect.appendChild(option);
      });
  }

  function loadCounties() {
    return fetch('/geo/us-counties.geojson').then(function (response) {
      if (!response.ok) throw new Error('county data request failed');
      return response.json();
    }).then(function (collection) {
      counties = (collection.features || []).slice();
      countyByGeoID.clear();
      counties.forEach(function (feature) { countyByGeoID.set(String(feature.properties.GEOID), feature); });
      Array.from(new Set(counties.map(function (feature) { return feature.properties.STUSPS; }))).sort().forEach(function (state) {
        var option = document.createElement('option');
        option.value = state;
        option.textContent = state;
        option.selected = state === 'TN';
        stateSelect.appendChild(option);
      });
      refreshCountyOptions();
      stateSelect.addEventListener('change', refreshCountyOptions);
      applyCountiesBtn.disabled = false;
    }).catch(function (error) {
      counties = [];
      stateSelect.disabled = true;
      countySelect.disabled = true;
      applyCountiesBtn.disabled = true;
      document.getElementById('county-help').textContent = 'County data is unavailable. Existing boundaries and GeoJSON editing remain available.';
      console.warn('[admin-hash-regions]', error);
    });
  }

  function loadMapConfig() {
    return fetchJSON('/api/config/client').then(function (body) {
      if (body && body.map) window.MC_MAP_CFG = body.map;
      if (window.MC_initTileRegistry) window.MC_initTileRegistry(true);
    }).catch(function (error) {
      if (error.message === 'not logged in') throw error;
      console.warn('[admin-hash-regions]', error);
    }).then(initMap);
  }

  function loadRegions() {
    return fetchJSON('/api/admin/hash-regions').then(function (body) {
      cancelDrawing();
      var structured = Array.isArray(body.hashRegionDefinitions) ? body.hashRegionDefinitions : [];
      definitions = structured.length ? structured.map(function (definition) {
        return {
          name: normalize(definition.name),
          parentName: normalize(definition.parentName),
          description: definition.description || '',
          color: core.normalizeColor(definition.color),
          geometry: cloneGeometry(definition.geometry),
        };
      }) : (body.hashRegions || []).map(function (name) {
        return { name: normalize(name), parentName: '', description: '', color: '', geometry: null };
      });
      regionsLoaded = true;
      renderRows();
      updatePayloadStatus();
    });
  }

  function validateAndCollect() {
    definitions.forEach(function (definition) {
      definition.name = normalize(definition.name);
      definition.parentName = normalize(definition.parentName);
      definition.description = String(definition.description || '').trim();
      definition.color = core.normalizeColor(definition.color);
    });
    core.validateHierarchy(definitions);
    return definitions.map(function (definition) {
      return {
        name: definition.name,
        parentName: definition.parentName || '',
        description: definition.description,
        color: definition.color,
        geometry: definition.geometry || null,
      };
    });
  }

  exportRegionsBtn.addEventListener('click', function () {
    var link = document.createElement('a');
    link.href = '/api/admin/hash-regions/export';
    link.download = 'corescope-hash-regions-v1.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    backupStatus.textContent = 'Region backup download requested.';
  });

  chooseBackupBtn.addEventListener('click', function () { backupFileInput.click(); });

  backupFileInput.addEventListener('change', function () {
    var file = backupFileInput.files && backupFileInput.files[0];
    var selectionGeneration = ++backupValidationGeneration;
    backupText = '';
    backupPreview = null;
    backupPreviewText = '';
    backupPreviewMode = '';
    refreshBackupImportButton();
    if (!file) return;
    if (file.size > core.MAX_PAYLOAD_BYTES) {
      backupStatus.textContent = 'Backup rejected: file exceeds the 1 MiB limit.';
      return;
    }
    backupStatus.textContent = 'Reading ' + file.name + '…';
    readBackupFile(file).then(function (text) {
      if (selectionGeneration !== backupValidationGeneration) return;
      backupText = text;
      return validateBackupForImport();
    }).catch(function (error) {
      if (selectionGeneration !== backupValidationGeneration) return;
      backupStatus.textContent = 'Backup rejected: ' + (error.message || String(error));
      refreshBackupImportButton();
    });
  });

  backupModeSelect.addEventListener('change', function () {
    replaceConfirmInput.checked = false;
    validateBackupForImport();
  });
  replaceConfirmInput.addEventListener('change', refreshBackupImportButton);

  importRegionsBtn.addEventListener('click', function () {
    var mode = backupMode();
    if (!backupText || !backupPreview || !backupPreview.revision || backupPreviewText !== backupText || backupPreviewMode !== mode) return;
    if (mode === 'replace' && !replaceConfirmInput.checked) return;
    var importedText = backupText;
    var expectedRevision = backupPreview.revision;
    importRegionsBtn.disabled = true;
    backupStatus.textContent = 'Importing validated ' + mode + ' backup…';
    var query = '?mode=' + encodeURIComponent(mode) + '&expectedRevision=' + encodeURIComponent(expectedRevision) +
      (mode === 'replace' ? '&confirm=true' : '');
    fetchJSON('/api/admin/hash-regions/import' + query, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importedText,
    }).then(function (result) {
      backupStatus.textContent = 'Import complete: ' + core.backupImportSummary(result).replace(/^Valid /, '');
      try { localStorage.setItem('corescope-hash-regions-version', String(Date.now())); } catch (_) {}
      ++backupValidationGeneration;
      backupText = '';
      backupPreview = null;
      backupPreviewText = '';
      backupPreviewMode = '';
      backupFileInput.value = '';
      replaceConfirmInput.checked = false;
      refreshBackupImportButton();
      return loadRegions();
    }).catch(function (error) {
      ++backupValidationGeneration;
      backupPreview = null;
      backupPreviewText = '';
      backupPreviewMode = '';
      backupStatus.textContent = 'Import failed without applying changes: ' + (error.message || String(error)) + ' Validate the backup again before retrying.';
      refreshBackupImportButton();
    });
  });

  document.getElementById('add-region-btn').addEventListener('click', function () {
    definitions.push({ name: '#', parentName: '', description: '', color: '', geometry: null });
    renderRows();
    rows[rows.length - 1].name.focus();
    updatePayloadStatus();
  });

  document.getElementById('draw-polygon-btn').addEventListener('click', function () {
    clearError();
    if (activeIndex < 0) { showError(new Error('Choose a region before drawing.')); return; }
    cancelDrawing();
    drawingOwner = definitions[activeIndex];
    drawing = true; drawingPoints = polygonOuterCoordinates(drawingOwner.geometry);
    renderDrawingVertices();
    document.getElementById('boundary-active-status').textContent = 'Drawing boundary: click the map to add vertices, or drag existing vertices.';
  });

  document.getElementById('finish-polygon-btn').addEventListener('click', function () {
    if (isCurrentDrawing() && drawingPoints.length >= 3) applyPolygonPoints(drawingPoints);
  });

  document.getElementById('clear-geometry-btn').addEventListener('click', function () {
    try { setGeometry(null, false); } catch (error) { showError(error); }
  });

  document.getElementById('apply-coordinates-btn').addEventListener('click', function () {
    clearError();
    try { applyPolygonPoints(parseCoordinateLines(coordinateInput.value)); } catch (error) { showError(error); }
  });

  document.getElementById('import-geojson-btn').addEventListener('click', function () {
    clearError();
    try {
      setGeometry(RegionScopeHelpers.parseGeoJSONGeometry(document.getElementById('geojson-import').value), true);
    } catch (error) { showError(error); }
  });

  applyCountiesBtn.addEventListener('click', function () {
    clearError();
    try {
      var selectedFeatures = Array.prototype.map.call(countySelect.selectedOptions, function (option) {
        return countyByGeoID.get(option.value);
      });
      if (!selectedFeatures.length) throw new Error('Select at least one county.');
      setGeometry(RegionScopeHelpers.countiesToMultiPolygon(selectedFeatures), true);
    } catch (error) { showError(error); }
  });

  saveBtn.addEventListener('click', function () {
    clearError();
    var payload;
    try {
      payload = validateAndCollect();
      var status = core.payloadByteStatus({ hashRegionDefinitions: payload });
      if (status.overLimit) throw new Error('Region definitions exceed the 1 MiB request limit. Simplify boundaries before saving.');
    } catch (error) { showError(error); return; }
    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving…';
    fetchJSON('/api/admin/hash-regions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashRegionDefinitions: payload }),
    }).then(function () {
      saveStatus.textContent = 'Saved. Changes take effect within about 15 seconds.';
      try { localStorage.setItem('corescope-hash-regions-version', String(Date.now())); } catch (_) {}
      return loadRegions();
    }).catch(function (error) {
      showError(error);
      saveStatus.textContent = '';
    }).then(function () { updatePayloadStatus(); });
  });

  loadCounties();
  Promise.all([fetchJSON('/api/admin/me'), loadRegions(), loadMapConfig()]).then(function (results) {
    window.renderAccountMenu(results[0]);
  }).then(function () {
    document.body.classList.add('authed');
  }).catch(function (error) {
    if (error.message !== 'not logged in') {
      console.error('[admin-hash-regions]', error);
      showError(error);
      document.body.classList.add('authed');
    }
  });
})();
