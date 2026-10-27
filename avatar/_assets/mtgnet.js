/* mtgnet.js — shared helpers for MTGNET pages.
 *
 * Small, framework-free utilities shared by the landing, archetype (cluster),
 * splash and legacy network pages. Page-specific rendering/interaction code
 * stays inline in each template. Everything hangs off window.MTGNET.
 *
 * Contents: formatting + escaping, SVG helpers, edge-density helpers (landing
 * and legacy pages), safe localStorage, theme (light/dark toggle), colour
 * identity -> mana tint classes, text measurement, greedy label placement and
 * fit-to-content camera maths.
 */
(function (global) {
  'use strict';

  function pct(x) { return (100 * x).toFixed(2) + '%'; }
  function fmtPP(x) { return (100 * x).toFixed(2) + ' pp'; }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
   * Edge-density tier helpers (landing and legacy pages).
   *
   * Payload edges may carry `display_tier` ("core" | "extended") and a
   * `q_value` used to order extended edges from strongest to weakest.
   * Old payloads lack both fields entirely -- treat every such edge as
   * "core" so pages regenerated from old JSON still show everything.
   */
  function edgeTier(edge) {
    var tier = edge && edge.display_tier;
    return (tier === 'extended' || tier === 'tentative') ? 'extended' : 'core';
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

  // ── Safe localStorage (private mode / blocked storage must never throw) ──
  function storeGet(key) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function storeRemove(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /**
   * localStorage-backed persistence for a single numeric slider value,
   * namespaced per page slug so different archetype/network pages don't
   * clash.
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

  // ── Number formatting ────────────────────────────────────────────────────
  function fin(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function num(v) { var x = fin(v); return x === null ? '–' : Math.round(x).toLocaleString('en-US'); }
  function pct0(x) { x = fin(x); return x === null ? '–' : Math.round(100 * x) + '%'; }
  function pct1(x) { x = fin(x); return x === null ? '–' : (100 * x).toFixed(1) + '%'; }
  function signed(v, digits) {
    var s = v.toFixed(digits);
    if (Number(s) === 0) s = (0).toFixed(digits);
    return (v > 0 && Number(s) !== 0 ? '+' : (v < 0 && Number(s) !== 0 ? '−' : '')) + s.replace('-', '');
  }
  function pp1(x) { x = fin(x); return x === null ? '–' : signed(100 * x, 1) + ' pp'; }
  // Interaction log-odds -> "+17% odds" (multiplicative change in the odds of winning).
  function oddsPct(logit) {
    logit = fin(logit);
    if (logit === null) return '–';
    return signed(100 * (Math.exp(logit) - 1), 0) + '%';
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  var THEME_KEY = 'mtgnet_theme';
  var theme = {
    current: function () {
      var t = document.documentElement.getAttribute('data-theme');
      if (t === 'light' || t === 'dark') return t;
      return (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    },
    set: function (t) {
      document.documentElement.setAttribute('data-theme', t);
      try { global.localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
      try { document.dispatchEvent(new CustomEvent('mtgnet:theme', { detail: { theme: t } })); } catch (e) { /* old browsers */ }
    },
    toggle: function () { theme.set(theme.current() === 'light' ? 'dark' : 'light'); return theme.current(); },
    // Apply a remembered choice (pages also do this inline in <head> to avoid a flash).
    init: function () {
      var t = null;
      try { t = global.localStorage.getItem(THEME_KEY); } catch (e) { t = null; }
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    }
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ── Colour identity -> mana tint class letters ───────────────────────────
  // 'WR' -> ['W','R'];  3+ colours -> ['M'] (gold);  none -> ['C'].
  function manaKeys(colorIdentity) {
    var seen = {};
    var out = [];
    String(colorIdentity || '').toUpperCase().replace(/[WUBRG]/g, function (c) {
      if (!seen[c]) { seen[c] = 1; out.push(c); }
      return c;
    });
    if (!out.length) return ['C'];
    if (out.length > 2) return ['M'];
    return out;
  }
  function pipsHtml(colorIdentity, all) {
    var keys = all ? String(colorIdentity || '').toUpperCase().replace(/[^WUBRG]/g, '').split('') : manaKeys(colorIdentity);
    if (!keys.length) keys = ['C'];
    return '<span class="pips" aria-hidden="true">' + keys.map(function (k) {
      return '<span class="pip pip-' + k + '"></span>';
    }).join('') + '</span>';
  }

  // ── Text measurement (canvas; width scales linearly with font size) ─────
  var measureCtx = null;
  var measureCache = Object.create(null);
  var fontFamily = null;
  function textWidth(text, px, weight) {
    var key = (weight || 400) + '|' + text;
    var w100 = measureCache[key];
    if (w100 === undefined) {
      if (!measureCtx) {
        try { measureCtx = document.createElement('canvas').getContext('2d'); } catch (e) { measureCtx = null; }
        fontFamily = (document.body && getComputedStyle(document.body).fontFamily) || 'sans-serif';
      }
      if (measureCtx) {
        measureCtx.font = (weight || 400) + ' 100px ' + fontFamily;
        w100 = measureCtx.measureText(String(text)).width;
      } else {
        w100 = 58 * String(text).length;
      }
      measureCache[key] = w100;
    }
    return w100 * px / 100;
  }

  // ── Greedy label placement ──────────────────────────────────────────────
  /**
   * items (in priority order): {id, x, y, r, w, h, dir: {x, y}, force}
   *   x, y, r: the disc the label belongs to; w, h: label box size (same units);
   *   dir: preferred outward direction (unit-ish vector); force: place even
   *   if every candidate collides (at the first candidate).
   * obstacles: discs [{x, y, r}] and boxes [{x0, y0, x1, y1}] to avoid.
   * bounds: optional {x0, y0, x1, y1}; candidates leaving it are rejected.
   * Returns [{id, x0, y0, x1, y1, cx, cy, anchor}] with the label box; the
   * text goes at (x0, cy) with text-anchor start and dominant-baseline central.
   */
  function placeLabels(items, obstacles, bounds, gap) {
    gap = gap || 3;
    var discs = [];
    var boxes = [];
    (obstacles || []).forEach(function (o) {
      if (o.r !== undefined) discs.push(o); else boxes.push(o);
    });
    function hitsDisc(b, d, pad) {
      var cx = Math.max(b.x0, Math.min(d.x, b.x1));
      var cy = Math.max(b.y0, Math.min(d.y, b.y1));
      var dx = d.x - cx, dy = d.y - cy;
      return dx * dx + dy * dy < (d.r + pad) * (d.r + pad);
    }
    function hitsBox(b, o) { return b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1; }
    function inside(b) {
      return !bounds || (b.x0 >= bounds.x0 && b.x1 <= bounds.x1 && b.y0 >= bounds.y0 && b.y1 <= bounds.y1);
    }
    var out = [];
    items.forEach(function (it) {
      var r = it.r, w = it.w, h = it.h, g = gap + r;
      var right = !it.dir || it.dir.x >= -0.15;
      var down = it.dir ? it.dir.y >= 0 : true;
      var side = [
        { x0: it.x + g, y0: it.y - h / 2 },          // right
        { x0: it.x - g - w, y0: it.y - h / 2 }       // left
      ];
      var vert = [
        { x0: it.x - w / 2, y0: it.y + r + gap },     // below
        { x0: it.x - w / 2, y0: it.y - r - gap - h }  // above
      ];
      if (!right) side.reverse();
      if (!down) vert.reverse();
      var diag = [
        { x0: side[0].x0, y0: it.y - r * 0.6 - h },
        { x0: side[0].x0, y0: it.y + r * 0.6 },
        { x0: side[1].x0, y0: it.y - r * 0.6 - h },
        { x0: side[1].x0, y0: it.y + r * 0.6 }
      ];
      // second ring of candidates: one label-height further out
      var far = [
        { x0: side[0].x0, y0: it.y - r - h * 1.6 }, { x0: side[0].x0, y0: it.y + r + h * 0.6 },
        { x0: it.x - w / 2, y0: vert[0].y0 + (down ? h : -h) }, { x0: it.x - w / 2, y0: vert[1].y0 + (down ? -h : h) },
        { x0: side[1].x0, y0: it.y - r - h * 1.6 }, { x0: side[1].x0, y0: it.y + r + h * 0.6 }
      ];
      var cands = [side[0], vert[0], side[1], vert[1]].concat(diag, far);
      var chosen = null, best = null, bestCost = Infinity;
      function overlap(a, o) {
        var ox = Math.min(a.x1, o.x1) - Math.max(a.x0, o.x0), oy = Math.min(a.y1, o.y1) - Math.max(a.y0, o.y0);
        return ox > 0 && oy > 0 ? ox * oy : 0;
      }
      for (var i = 0; i < cands.length && !chosen; i += 1) {
        var b = { x0: cands[i].x0, y0: cands[i].y0, x1: cands[i].x0 + w, y1: cands[i].y0 + h };
        var cost = inside(b) ? 0 : w * h * 4;
        var bad = cost > 0;
        for (var j = 0; j < discs.length; j += 1) {
          if (discs[j].id === it.id) continue;
          if (hitsDisc(b, discs[j], 1)) {
            bad = true;
            cost += overlap(b, { x0: discs[j].x - discs[j].r, y0: discs[j].y - discs[j].r, x1: discs[j].x + discs[j].r, y1: discs[j].y + discs[j].r }) * 0.6 + 1e-6;
          }
        }
        for (var k = 0; k < boxes.length; k += 1) {
          if (hitsBox(b, boxes[k])) { bad = true; cost += overlap(b, boxes[k]) * 2 + 1e-6; }
        }
        cost += i * 1e-4 * w * h;   // prefer earlier (closer, outward) candidates on ties
        if (!bad) chosen = b;
        else if (cost < bestCost) { bestCost = cost; best = b; }
      }
      if (!chosen && it.force) chosen = best;
      if (!chosen) return;
      boxes.push(chosen);
      out.push({ id: it.id, x0: chosen.x0, y0: chosen.y0, x1: chosen.x1, y1: chosen.y1, cx: chosen.x0, cy: (chosen.y0 + chosen.y1) / 2 });
    });
    return out;
  }

  // ── Camera maths ────────────────────────────────────────────────────────
  // Fit box {x0, y0, x1, y1} (user units) into a W x H viewport with `pad`
  // screen px on each side. Returns {s, tx, ty}: screen = user * s + t.
  function fitBox(box, W, H, pad) {
    pad = pad === undefined ? 12 : pad;
    var bw = Math.max(1, box.x1 - box.x0);
    var bh = Math.max(1, box.y1 - box.y0);
    var s = Math.max(0.02, Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh));
    return { s: s, tx: (W - bw * s) / 2 - box.x0 * s, ty: (H - bh * s) / 2 - box.y0 * s };
  }
  function unionBox(a, b) {
    if (!a) return b ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null;
    if (!b) return a;
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
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
    saveEdgeDensity: saveEdgeDensity,
    store: { get: storeGet, set: storeSet, remove: storeRemove },
    fin: fin,
    fmt: { num: num, pct0: pct0, pct1: pct1, pp1: pp1, odds: oddsPct, signed: signed },
    theme: theme,
    cssVar: cssVar,
    manaKeys: manaKeys,
    pipsHtml: pipsHtml,
    textWidth: textWidth,
    placeLabels: placeLabels,
    fitBox: fitBox,
    unionBox: unionBox
  };
}(typeof window !== 'undefined' ? window : this));
