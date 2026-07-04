/* mtgnet.js — shared helpers for MTGNET graph pages.
 *
 * Small, framework-free utilities that were duplicated verbatim across
 * cluster_page.html.jinja2, network.html.jinja2 and landing_page.html.jinja2.
 * Page-specific rendering/interaction code stays inline in each template.
 */
(function (global) {
  'use strict';

  function pct(x) { return (100 * x).toFixed(2) + '%'; }
  function fmtPP(x) { return (100 * x).toFixed(2) + ' pp'; }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function svgEl(name, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', name);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    return node;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function polarArc(cx, cy, r, startDeg, endDeg) {
    var start = (Math.PI / 180) * startDeg;
    var end = (Math.PI / 180) * endDeg;
    var x1 = cx + r * Math.cos(start);
    var y1 = cy + r * Math.sin(start);
    var x2 = cx + r * Math.cos(end);
    var y2 = cy + r * Math.sin(end);
    var large = (endDeg - startDeg) <= 180 ? 0 : 1;
    return ['M', cx, cy, 'L', x1, y1, 'A', r, r, 0, large, 1, x2, y2, 'Z'].join(' ');
  }

  /**
   * Edge-density tier helpers.
   *
   * Payload edges may carry `display_tier` ("core" | "extended") and a
   * `q_value` used to order extended edges from strongest to weakest.
   * Old payloads lack both fields entirely -- treat every such edge as
   * "core" so pages regenerated from old JSON still show everything.
   */
  function edgeTier(edge) {
    var tier = edge && edge.display_tier;
    return tier === 'extended' ? 'extended' : 'core';
  }

  // Higher = stronger edge. q_value is an FDR q-value (smaller = more
  // significant), so it enters negated and only when quality_score is absent.
  function edgeOrderValue(edge) {
    if (!edge) return 0;
    if (typeof edge.quality_score === 'number') return edge.quality_score;
    if (typeof edge.q_value === 'number') return -edge.q_value;
    return 0;
  }

  /**
   * Given a full edge list and a density in [0, 1], return the edges that
   * should be visible: all "core" edges, plus the top
   * `round(density * extendedCount)` "extended" edges ordered by
   * edgeOrderValue (descending). density 0 => core only, density 1 => all.
   */
  function filterEdgesByDensity(edges, density) {
    density = Math.max(0, Math.min(1, Number(density) || 0));
    var core = [];
    var extended = [];
    (edges || []).forEach(function (edge) {
      if (edgeTier(edge) === 'extended') extended.push(edge);
      else core.push(edge);
    });
    extended.sort(function (a, b) { return edgeOrderValue(b) - edgeOrderValue(a); });
    var keepCount = Math.round(density * extended.length);
    return core.concat(extended.slice(0, keepCount));
  }

  /**
   * localStorage-backed persistence for a single numeric slider value,
   * namespaced per page slug so different archetype/network pages don't
   * clash. Mirrors the pattern used by the layout-persistence code.
   */
  function loadEdgeDensity(slug) {
    try {
      var raw = global.localStorage.getItem('mtgnet_edge_density_' + slug);
      if (raw === null) return 0;
      var value = parseFloat(raw);
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    } catch (e) {
      return 0;
    }
  }

  function saveEdgeDensity(slug, density) {
    try {
      global.localStorage.setItem('mtgnet_edge_density_' + slug, String(density));
    } catch (e) { /* ignore */ }
  }

  global.MTGNET = {
    pct: pct,
    fmtPP: fmtPP,
    esc: esc,
    svgEl: svgEl,
    clear: clear,
    polarArc: polarArc,
    edgeTier: edgeTier,
    edgeOrderValue: edgeOrderValue,
    filterEdgesByDensity: filterEdgesByDensity,
    loadEdgeDensity: loadEdgeDensity,
    saveEdgeDensity: saveEdgeDensity
  };
}(typeof window !== 'undefined' ? window : this));
