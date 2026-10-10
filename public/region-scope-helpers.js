/* Shared Region Scope Helper logic. Browser global + CommonJS, no dependencies. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegionScopeHelpers = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function pointOnSegment(point, a, b) {
    var x = point[0], y = point[1];
    var cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
    if (Math.abs(cross) > 1e-10) return false;
    return x >= Math.min(a[0], b[0]) - 1e-10 && x <= Math.max(a[0], b[0]) + 1e-10 &&
      y >= Math.min(a[1], b[1]) - 1e-10 && y <= Math.max(a[1], b[1]) + 1e-10;
  }

  // Returns 1 inside, 0 outside, and 2 on the ring boundary.
  function pointInRing(point, ring) {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[j], b = ring[i];
      if (pointOnSegment(point, a, b)) return 2;
      var crosses = ((b[1] > point[1]) !== (a[1] > point[1])) &&
        (point[0] < (a[0] - b[0]) * (point[1] - b[1]) / (a[1] - b[1]) + b[0]);
      if (crosses) inside = !inside;
    }
    return inside ? 1 : 0;
  }

  function pointInPolygon(point, polygon) {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    var shell = pointInRing(point, polygon[0]);
    if (shell === 0) return false;
    if (shell === 2) return true;
    for (var i = 1; i < polygon.length; i++) {
      var hole = pointInRing(point, polygon[i]);
      if (hole === 2) return true;
      if (hole === 1) return false;
    }
    return true;
  }

  function pointInGeometry(point, geometry) {
    if (!geometry || !Array.isArray(point) || point.length < 2) return false;
    if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
    if (geometry.type === 'MultiPolygon') {
      return Array.isArray(geometry.coordinates) && geometry.coordinates.some(function (polygon) {
        return pointInPolygon(point, polygon);
      });
    }
    return false;
  }

  function pointToSegmentDistanceKm(point, a, b) {
    var latitudeRadians = point[1] * Math.PI / 180;
    var xScale = 111.32 * Math.cos(latitudeRadians);
    var yScale = 110.574;
    var px = (point[0] - a[0]) * xScale;
    var py = (point[1] - a[1]) * yScale;
    var bx = (b[0] - a[0]) * xScale;
    var by = (b[1] - a[1]) * yScale;
    var denominator = bx * bx + by * by;
    var t = denominator ? Math.max(0, Math.min(1, (px * bx + py * by) / denominator)) : 0;
    var dx = px - t * bx;
    var dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distanceToGeometryKm(point, geometry) {
    if (!geometry || !Array.isArray(point) || point.length < 2) return Infinity;
    if (pointInGeometry(point, geometry)) return 0;
    var polygons = geometry.type === 'Polygon' ? [geometry.coordinates] :
      (geometry.type === 'MultiPolygon' ? geometry.coordinates : []);
    var minimum = Infinity;
    (polygons || []).forEach(function (polygon) {
      (polygon || []).forEach(function (ring) {
        for (var i = 1; Array.isArray(ring) && i < ring.length; i++) {
          minimum = Math.min(minimum, pointToSegmentDistanceKm(point, ring[i - 1], ring[i]));
        }
      });
    });
    return minimum;
  }

  function definitionIndex(definitions) {
    var byName = new Map();
    (definitions || []).forEach(function (definition) {
      if (definition && definition.name) byName.set(definition.name, definition);
    });
    return byName;
  }

  function ancestorClosure(definitions, names) {
    var byName = definitionIndex(definitions);
    var included = new Set();
    (names || []).forEach(function (name) {
      var current = name;
      var path = new Set();
      while (current && byName.has(current) && !path.has(current)) {
        path.add(current);
        included.add(current);
        current = byName.get(current).parentName || '';
      }
    });
    return { byName: byName, included: included };
  }

  function parentBeforeChild(definitions, included) {
    var byName = definitionIndex(definitions);
    var children = new Map();
    included.forEach(function (name) {
      var definition = byName.get(name);
      var parent = definition && definition.parentName && included.has(definition.parentName)
        ? definition.parentName : '';
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(name);
    });
    children.forEach(function (names) { names.sort(); });
    var ordered = [];
    var visited = new Set();
    function visit(name) {
      if (visited.has(name)) return;
      visited.add(name);
      ordered.push(byName.get(name));
      (children.get(name) || []).forEach(visit);
    }
    (children.get('') || []).forEach(visit);
    // Malformed cyclic input stays bounded and deterministic.
    Array.from(included).sort().forEach(visit);
    return ordered;
  }

  function recommendRegions(definitions, point) {
    var direct = (definitions || []).filter(function (definition) {
      return pointInGeometry(point, definition && definition.geometry);
    }).map(function (definition) { return definition.name; });
    var closure = ancestorClosure(definitions, direct);
    return parentBeforeChild(definitions, closure.included);
  }

  function recommendRegionDetails(definitions, point, nearbyDistanceKm) {
    nearbyDistanceKm = Number.isFinite(nearbyDistanceKm) ? nearbyDistanceKm : 40;
    var directNames = new Set((definitions || []).filter(function (definition) {
      return pointInGeometry(point, definition && definition.geometry);
    }).map(function (definition) { return definition.name; }));
    var details = recommendRegions(definitions, point).map(function (definition) {
      return { definition: definition, reason: directNames.has(definition.name) ? 'direct' : 'ancestor' };
    });
    var included = new Set(details.map(function (item) { return item.definition.name; }));
    var nearby = (definitions || []).filter(function (definition) {
      return definition && definition.geometry && !included.has(definition.name);
    }).map(function (definition) {
      return { definition: definition, reason: 'nearby', distanceKm: distanceToGeometryKm(point, definition.geometry) };
    }).filter(function (item) {
      return item.distanceKm > 0 && item.distanceKm <= nearbyDistanceKm;
    }).sort(function (a, b) {
      return a.distanceKm - b.distanceKm || a.definition.name.localeCompare(b.definition.name);
    });
    return details.concat(nearby);
  }

  function updateSelection(selectedNames, name, selected) {
    var next = new Set(selectedNames || []);
    if (selected) next.add(name); else next.delete(name);
    return Array.from(next).sort();
  }

  function updateHierarchySelection(definitions, selectedNames, name, selected) {
    var byName = definitionIndex(definitions);
    var next = new Set(selectedNames || []);
    if (selected) {
      var current = name;
      var seen = new Set();
      while (current && byName.has(current) && !seen.has(current)) {
        seen.add(current);
        next.add(current);
        current = byName.get(current).parentName || '';
      }
    } else {
      next.delete(name);
      var changed = true;
      while (changed) {
        changed = false;
        next.forEach(function (candidate) {
          var definition = byName.get(candidate);
          if (definition && definition.parentName && !next.has(definition.parentName)) {
            next.delete(candidate);
            changed = true;
          }
        });
      }
    }
    return Array.from(next).sort();
  }

  function reconcileRecommendationSelection(definitions, automaticNames, manualAdditions, manualRemovals) {
    var next = [];
    (automaticNames || []).concat(manualAdditions || []).forEach(function (name) {
      next = updateHierarchySelection(definitions, next, name, true);
    });
    (manualRemovals || []).forEach(function (name) {
      next = updateHierarchySelection(definitions, next, name, false);
    });
    return next;
  }

  function escapeHTML(value) {
    if (value == null) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function depthOf(name, byName) {
    var depth = 0, seen = new Set(), current = name;
    while (byName.has(current) && byName.get(current).parentName && !seen.has(current)) {
      seen.add(current);
      current = byName.get(current).parentName;
      depth++;
    }
    return depth;
  }

  function utf8ByteLength(value) {
    var length = 0;
    for (var character of String(value)) {
      var codePoint = character.codePointAt(0);
      length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    }
    return length;
  }

  function commandName(name) {
    if (!name) {
      throw new Error('Firmware region names cannot be empty.');
    }
    if (utf8ByteLength(name) > 30) {
      throw new Error('MeshCore region names used in commands cannot exceed 30 UTF-8 bytes.');
    }
    if (String(name).indexOf('|') >= 0) {
      throw new Error('MeshCore region names used in region def commands cannot contain the | region def delimiter.');
    }
    for (var character of String(name)) {
      var codePoint = character.codePointAt(0);
      if (codePoint <= 0x7f && character !== '-' && character !== '$' && character !== '#' &&
          !(character >= '0' && character <= '9') && codePoint < 0x41) {
        throw new Error('Firmware rejects one or more bytes in region name "' + name + '".');
      }
    }
    return name;
  }

  function validatedClosure(definitions, selectedNames) {
    var byName = definitionIndex(definitions);
    var included = new Set();
    (selectedNames || []).forEach(function (name) {
      commandName(name);
      if (!byName.has(name)) throw new Error('Selected region is missing from definitions: ' + name);
      var current = name;
      var path = new Set();
      while (current) {
        if (path.has(current)) throw new Error('Region hierarchy contains a cycle at ' + current + '.');
        path.add(current);
        included.add(current);
        var definition = byName.get(current);
        var parent = definition && definition.parentName;
        if (parent && !byName.has(parent)) {
          throw new Error('Region "' + current + '" has missing parent "' + parent + '".');
        }
        current = parent || '';
      }
    });
    return { byName: byName, included: included };
  }

  function buildCommands(definitions, selectedNames, options) {
    options = options || {};
    var closure = validatedClosure(definitions, selectedNames);
    var ordered = parentBeforeChild(definitions, closure.included);
    if (ordered.length > 32) {
      throw new Error('MeshCore firmware stores at most 32 regions. Reduce the selection before generating commands.');
    }
    var children = new Map();
    ordered.forEach(function (definition) {
      var parent = definition.parentName && closure.included.has(definition.parentName)
        ? definition.parentName : '';
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(definition.name);
    });
    function subtreeTokens(name) {
      var tokens = [commandName(name)];
      var childNames = children.get(name) || [];
      childNames.forEach(function (childName, index) {
        var childTokens = subtreeTokens(childName);
        if (index < childNames.length - 1) {
          childTokens[childTokens.length - 1] += '|' + commandName(name);
        }
        tokens = tokens.concat(childTokens);
      });
      return tokens;
    }
    var roots = children.get('') || [];
    var allTokens = [];
    roots.forEach(function (rootName, index) {
      var tokens = subtreeTokens(rootName);
      if (index < roots.length - 1) tokens[tokens.length - 1] += '|*';
      allTokens = allTokens.concat(tokens);
    });
    var mutationCommands = allTokens.length ? ['region def ' + allTokens.join(' ')] : [];
    if (mutationCommands.length && utf8ByteLength(mutationCommands[0]) > 158) {
      throw new Error('The selected hierarchy cannot fit one region def command within the repeater serial limit of 158 UTF-8 bytes. Reduce the selection.');
    }
    function optionalCommand(value, prefix) {
      if (!value) return [];
      if (!closure.included.has(value)) throw new Error(prefix + ' region must be selected.');
      return [prefix + ' ' + commandName(value)];
    }
    return {
      commands: mutationCommands,
      mutationCommands: mutationCommands,
      verificationCommands: ['region'],
      homeCommands: optionalCommand(options.home, 'region home'),
      defaultCommands: optionalCommand(options.defaultRegion, 'region default'),
      persistenceCommands: ['region save'],
      selectedDefinitions: ordered,
      warning: 'These commands add or update the selected hierarchy; they do not remove existing regions. Review the node region tree before saving.',
      defaultWarning: '`region default` persists immediately; inspect the hierarchy before applying an optional default.',
    };
  }

  function countiesToMultiPolygon(features) {
    var coordinates = [];
    (features || []).forEach(function (feature) {
      var geometry = feature && feature.geometry;
      if (!geometry) return;
      if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
        coordinates.push(geometry.coordinates);
      } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
        geometry.coordinates.forEach(function (polygon) { coordinates.push(polygon); });
      }
    });
    return { type: 'MultiPolygon', coordinates: coordinates };
  }

  function parseGeoJSONGeometry(value) {
    var input = typeof value === 'string' ? JSON.parse(value) : value;
    if (!input) throw new Error('GeoJSON is required.');
    if (input.type === 'Feature') input = input.geometry;
    if (input && input.type === 'FeatureCollection') {
      input = countiesToMultiPolygon(input.features || []);
    }
    if (!input || (input.type !== 'Polygon' && input.type !== 'MultiPolygon') || !Array.isArray(input.coordinates) || !input.coordinates.length) {
      throw new Error('GeoJSON must contain a Polygon or MultiPolygon.');
    }
    return input;
  }

  function regionNameHashHex(name) {
    var hash = 0x811c9dc5;
    var value = String(name || 'region');
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  function regionColorSlot(name) {
    return parseInt(regionNameHashHex(name), 16) % 360;
  }

  function automaticRegionColor(slot) {
    return 'oklch(var(--region-scope-auto-lightness) var(--region-scope-auto-chroma) ' + slot + ')';
  }

  function regionColorToken(name, customColor) {
    var normalizedCustom = String(customColor || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(normalizedCustom)) return normalizedCustom;
    return automaticRegionColor(regionColorSlot(name));
  }

  // Allocate the active automatic palette as a set. Name hashing supplies a
  // stable first choice; deterministic linear probing only moves names whose
  // first-choice hue collides. Preferred names reserve their slots first so
  // adding observed-only names cannot change configured regions across views.
  // MeshCore supports at most 32 active regions, well below the 360 slots.
  function buildRegionColorTable(definitions, preferredNames) {
    var table = Object.create(null);
    var usedSlots = new Set();
    var preferred = new Set(Array.isArray(preferredNames) ? preferredNames : []);
    var byName = new Map();
    (Array.isArray(definitions) ? definitions : []).forEach(function (definition) {
      if (definition && typeof definition.name === 'string' && !byName.has(definition.name)) {
        byName.set(definition.name, definition);
      }
    });
    Array.from(byName.keys()).sort(function (a, b) {
      var aPreferred = preferred.has(a);
      var bPreferred = preferred.has(b);
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      return a.localeCompare(b);
    }).forEach(function (name) {
      var definition = byName.get(name);
      var normalizedCustom = String(definition.color || '').trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(normalizedCustom)) {
        table[name] = normalizedCustom;
        return;
      }
      var slot = regionColorSlot(name);
      var attempts = 0;
      while (usedSlots.has(slot) && attempts < 360) {
        slot = (slot + 1) % 360;
        attempts++;
      }
      if (attempts === 360) throw new Error('Automatic region palette supports at most 360 active names.');
      usedSlots.add(slot);
      table[name] = automaticRegionColor(slot);
    });
    return table;
  }

  return {
    pointInGeometry: pointInGeometry,
    distanceToGeometryKm: distanceToGeometryKm,
    recommendRegions: recommendRegions,
    recommendRegionDetails: recommendRegionDetails,
    updateSelection: updateSelection,
    updateHierarchySelection: updateHierarchySelection,
    reconcileRecommendationSelection: reconcileRecommendationSelection,
    escapeHTML: escapeHTML,
    buildCommands: buildCommands,
    countiesToMultiPolygon: countiesToMultiPolygon,
    parseGeoJSONGeometry: parseGeoJSONGeometry,
    regionColorToken: regionColorToken,
    buildRegionColorTable: buildRegionColorTable,
  };
});
