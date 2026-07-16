/* === CoreScope — infrastructure.js (#infra) ===
 *
 * Dedicated performance view for operator-curated infrastructure nodes
 * (nodes.infrastructure flag, set via scripts/set-infra.sh).
 *
 * Perf contract: exactly TWO API calls per load —
 *   1. /api/nodes/infrastructure            → the flagged set only (indexed
 *      WHERE, same shape + enrichment as /api/nodes — no paging the whole
 *      node table to keep a handful)
 *   2. /api/nodes/bulk-health?nodes=pk,…    → SNR / packets-today / observers
 * No per-node fetches; per-node history stays one click away on the
 * node-analytics page.
 */
'use strict';

// Pure summary helper — window global so unit tests can drive it without
// a DOM (same pattern as ObserversSummary).
window.InfraSummary = {
  compute: function (infraNodes) {
    var list = Array.isArray(infraNodes) ? infraNodes : [];
    var active = 0, stale = 0, relaying = 0;
    var oldestSilent = null; // {name, ms} of the longest-silent stale node
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var t = n.last_heard || n.last_seen;
      var lastMs = t ? new Date(t).getTime() : 0;
      var status = (typeof window.getNodeStatus === 'function')
        ? window.getNodeStatus((n.role || 'companion').toLowerCase(), lastMs)
        : 'stale';
      if (status === 'active') active++;
      else {
        stale++;
        var silentMs = Date.now() - lastMs;
        if (!oldestSilent || silentMs > oldestSilent.ms) {
          oldestSilent = { name: n.name || '(unnamed)', ms: silentMs };
        }
      }
      if (n.relay_active) relaying++;
    }
    return { total: list.length, active: active, stale: stale, relaying: relaying, oldestSilent: oldestSilent };
  },
};

(function () {
  let map = null;
  let wsHandler = null;
  let container = null;

  function statusOf(n) {
    const t = n.last_heard || n.last_seen;
    const lastMs = t ? new Date(t).getTime() : 0;
    return getNodeStatus((n.role || 'companion').toLowerCase(), lastMs);
  }

  // Compact score bar (thresholds mirror the node-detail rows, #1456/#672).
  function scoreBar(label, value, kind, tooltip) {
    if (value == null) return '';
    const s = Number(value) || 0;
    const pct = (s * 100).toFixed(1);
    let color;
    if (kind === 'traffic') {
      color = s >= 0.6 ? 'var(--status-green)' : s >= 0.3 ? 'var(--status-yellow)' : s >= 0.1 ? 'var(--status-orange, #e67e22)' : 'var(--status-red)';
    } else {
      color = s >= 0.2 ? 'var(--status-green)' : s >= 0.05 ? 'var(--status-yellow)' : s > 0 ? 'var(--status-orange, #e67e22)' : 'var(--text-muted)';
    }
    const w = Math.max(2, Math.round(s * 100));
    return `<div class="infrap-score" title="${tooltip}">
      <span class="infrap-score-label">${label}</span>
      <span class="infrap-score-track"><span class="infrap-score-fill" style="width:${w}%;background:${color}"></span></span>
      <span class="infrap-score-val" style="color:${color}">${pct}%</span>
    </div>`;
  }

  function renderCard(n, health) {
    const status = statusOf(n);
    const roleColor = ROLE_COLORS[n.role] || '#6b7280';
    const stats = (health && health.stats) || {};
    const topObs = ((health && health.observers) || []).slice(0, 3);
    const battery = (n.battery_mv != null) ? (n.battery_mv / 1000).toFixed(2) + 'V' : '—';
    const temp = (n.temperature_c != null) ? Number(n.temperature_c).toFixed(1) + '°C' : '—';
    const isRelayRole = n.role === 'repeater' || n.role === 'room';
    const pk = encodeURIComponent(n.public_key);

    return `<div class="infrap-card" data-key="${n.public_key}">
      <div class="infrap-card-head">
        <span class="infra-card-status ${status === 'active' ? 'infra-status-active' : 'infra-status-stale'}" title="${status}">●</span>
        <a href="#/nodes/${pk}" class="infrap-name">${escapeHtml(n.name || '(unnamed)')}</a>
        <span class="badge" style="${(window.aaBadgeStyle && window.aaBadgeStyle(roleColor)) || ('background:' + roleColor + ';color:#fff')}">${n.role || '?'}</span>
        ${n.relay_active ? '<span class="badge infrap-relay-badge" title="Relayed traffic within the active window">relaying</span>' : ''}
      </div>
      <div class="infrap-grid">
        <div class="infrap-stat"><span class="infrap-stat-label">Last heard</span><span class="${status === 'active' ? 'last-seen-active' : ''}">${timeAgo(n.last_heard || n.last_seen) || '—'}</span></div>
        <div class="infrap-stat"><span class="infrap-stat-label">Battery</span><span>${battery}</span></div>
        <div class="infrap-stat"><span class="infrap-stat-label">Temp</span><span>${temp}</span></div>
        <div class="infrap-stat"><span class="infrap-stat-label">Adverts</span><span>${n.advert_count || 0}</span></div>
        <div class="infrap-stat"><span class="infrap-stat-label">Packets today</span><span>${stats.packetsToday != null ? stats.packetsToday : '—'}</span></div>
        <div class="infrap-stat"><span class="infrap-stat-label">Avg SNR</span><span>${stats.avgSnr != null ? Number(stats.avgSnr).toFixed(1) + ' dB' : '—'}</span></div>
        ${isRelayRole ? `<div class="infrap-stat"><span class="infrap-stat-label">Relays 24h</span><span>${n.relay_count_24h != null ? n.relay_count_24h : '—'}</span></div>` : ''}
        <div class="infrap-stat"><span class="infrap-stat-label">Seen by</span><span>${((health && health.observers) || []).length || '—'} obs</span></div>
      </div>
      ${isRelayRole ? scoreBar('Traffic share', n.traffic_share_score != null ? n.traffic_share_score : n.usefulness_score, 'traffic',
        "Fraction of non-advert mesh traffic that transited this node as a relay hop") : ''}
      ${isRelayRole ? scoreBar('Bridge', n.bridge_score, 'bridge',
        'Normalized betweenness centrality — structural importance regardless of current traffic') : ''}
      ${topObs.length ? `<div class="infrap-obs" title="Observers hearing this node, by packet count">
        <span class="infrap-stat-label">Heard by:</span>
        ${topObs.map(o => `<span class="infrap-obs-chip">${escapeHtml(o.observer_name || o.observer_id || '?')}${o.avgSnr != null ? ' <span class="infrap-obs-snr">' + Number(o.avgSnr).toFixed(1) + 'dB</span>' : ''}</span>`).join('')}
      </div>` : ''}
      <div class="infrap-links">
        <a href="#/nodes/${pk}">Detail</a>
        <a href="#/nodes/${pk}/analytics">Analytics</a>
        <a href="#/nodes/${pk}/reach">Reach</a>
      </div>
    </div>`;
  }

  function renderMap(infra) {
    const el = document.getElementById('infraPageMap');
    if (!el || typeof L === 'undefined') return;
    const located = infra.filter(n => n.lat && n.lon);
    if (!located.length) { el.hidden = true; return; }

    // Un-hide BEFORE L.map() — Leaflet must measure a laid-out container,
    // or it initializes at 0×0 and tiles never render.
    el.hidden = false;
    map = L.map('infraPageMap', { zoomControl: true, attributionControl: true });
    const tileUrl = (window.getTileUrl && window.getTileUrl()) || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const provider = window.getActiveTileProvider && window.getActiveTileProvider();
    L.tileLayer(tileUrl, { maxZoom: 18, attribution: (provider && provider.attribution) || '© OpenStreetMap contributors' }).addTo(map);

    located.forEach(n => {
      const svg = (window.makeRoleMarkerSVG && window.makeRoleMarkerSVG(n.role || 'companion', ROLE_COLORS[n.role] || '#6b7280', 16)) || '';
      const icon = L.divIcon({
        html: '<div class="infrap-map-marker">' + svg + '</div>',
        className: 'meshcore-marker',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      L.marker([n.lat, n.lon], { icon: icon, alt: (n.name || 'Unknown') + ' (infrastructure)' })
        .bindPopup(`<strong>${escapeHtml(n.name || '(unnamed)')}</strong><br><a href="#/nodes/${encodeURIComponent(n.public_key)}">View node →</a>`)
        .addTo(map);
    });

    if (located.length === 1) map.setView([located[0].lat, located[0].lon], 10);
    else map.fitBounds(L.latLngBounds(located.map(n => [n.lat, n.lon])), { padding: [30, 30], maxZoom: 12 });
  }

  async function load() {
    const listEl = document.getElementById('infraPageCards');
    if (!listEl) return;

    try {
      const data = await api('/nodes/infrastructure', { ttl: CLIENT_TTL.nodeList });
      const infra = (data && Array.isArray(data.nodes)) ? data.nodes : [];

      // Health for exactly the infra set — single scoped bulk call (#infra).
      let healthByPk = new Map();
      if (infra.length) {
        const pks = infra.map(n => n.public_key).join(',');
        const health = await api('/nodes/bulk-health?limit=' + infra.length + '&nodes=' + encodeURIComponent(pks),
          { ttl: CLIENT_TTL.bulkHealth }).catch(() => []);
        (health || []).forEach(h => healthByPk.set(h.public_key, h));
      }

      const s = window.InfraSummary.compute(infra);
      const summaryEl = document.getElementById('infraPageSummary');
      if (summaryEl) {
        summaryEl.innerHTML = infra.length ? `
          <span class="infrap-chip"><strong>${s.total}</strong> node${s.total === 1 ? '' : 's'}</span>
          <span class="infrap-chip infra-status-active">● <strong>${s.active}</strong> active</span>
          <span class="infrap-chip ${s.stale ? 'infra-status-stale' : ''}">● <strong>${s.stale}</strong> stale</span>
          ${s.relaying ? `<span class="infrap-chip"><strong>${s.relaying}</strong> relaying</span>` : ''}
          ${s.oldestSilent ? `<span class="infrap-chip infrap-chip-warn" title="Longest-silent infrastructure node">${escapeHtml(s.oldestSilent.name)} silent ${(timeAgo(new Date(Date.now() - s.oldestSilent.ms).toISOString()) || '').replace(/\s*ago$/, '')}</span>` : ''}
        ` : '';
      }

      if (!infra.length) {
        listEl.innerHTML = `<div class="infrap-empty">
          <p>No infrastructure nodes currently exist.</p>
        </div>`;
        const mapEl = document.getElementById('infraPageMap');
        if (mapEl) mapEl.hidden = true;
        return;
      }

      // Stale first — surfacing outages is the point of the page.
      const sorted = infra.slice().sort((a, b) => {
        const sa = statusOf(a), sb = statusOf(b);
        if (sa !== sb) return sa === 'stale' ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '');
      });

      listEl.innerHTML = sorted.map(n => renderCard(n, healthByPk.get(n.public_key))).join('');
      if (!map) renderMap(infra);
    } catch (e) {
      console.error('Failed to load infrastructure page:', e);
      listEl.innerHTML = '<div class="infrap-empty" role="alert">Failed to load infrastructure data. Please try again.</div>';
    } finally {
      const root = document.getElementById('infraPage');
      if (root) root.setAttribute('data-loaded', 'true');
    }
  }

  function init(c) {
    container = c;
    container.innerHTML = `
      <div id="infraPage" class="infrap">
        <div class="infrap-header">
          <h2><span class="badge infra-badge" title="${window.INFRA_BADGE_TITLE}">INFRA</span> Infrastructure</h2>
          <div id="infraPageSummary" class="infrap-summary"></div>
        </div>
        <p class="infrap-blurb text-muted">Community-deployed nodes in privileged positions (towers, peaks) that anchor mesh connectivity.</p>
        <div id="infraPageMap" class="infrap-map" hidden></div>
        <div id="infraPageCards" class="infrap-cards"><div class="text-muted" style="padding:24px">Loading…</div></div>
      </div>`;

    load();
    // Refresh on packet flow, debounced; api() TTL caches keep this cheap.
    wsHandler = debouncedOnWS(function (msgs) {
      if (msgs.some(function (m) { return m.type === 'packet'; })) load();
    }, 15000);
  }

  function destroy() {
    if (wsHandler) offWS(wsHandler);
    wsHandler = null;
    if (map) { map.remove(); map = null; }
    if (container) { container.innerHTML = ''; container = null; }
  }

  registerPage('infrastructure', { init, destroy });
})();
