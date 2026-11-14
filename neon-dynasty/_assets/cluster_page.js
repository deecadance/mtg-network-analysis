/* cluster_page.js — archetype (cluster) page: Core / Synergy / Picks views, side lists,
 * card spotlight, pan/zoom, labels, layout persistence. Reads the inline
 * <script id="payloadData"> JSON (see render/cluster_page.py for the field allowlist)
 * and the shared helpers in mtgnet.js (load it first). */
(function () {
  'use strict';
  var M = window.MTGNET;
  var esc = M.esc, fin = M.fin, F = M.fmt, svgEl = M.svgEl;
  var noteEl = document.getElementById('cpGraphNote');
  var payload;
  try {
    payload = JSON.parse(document.getElementById('payloadData').textContent);
  } catch (err) {
    noteEl.hidden = false;
    noteEl.textContent = 'Could not read the page data: ' + String(err);
    return;
  }
  var meta = payload.meta || {};
  var seg = payload.segment || {};
  var V3 = meta.analysis_version === 'v3';
  var DEV = /(?:^|[?&])dev=1(?:&|$)/.test(location.search);
  var hasGames = meta.has_game_data !== false;
  var archName = seg.color_name || String(seg.title || '').split('|')[0].trim() || 'this archetype';
  var baseWR = fin(seg.win_rate);
  var SLUG = String(seg.slug || ('cluster-' + seg.cluster_id));

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function hypot(a, b) { return Math.sqrt(a * a + b * b); }

  // ── Archetype links (overview rows carry href relative to this page) ──
  var hrefBySlug = Object.create(null), hrefById = Object.create(null);
  (payload.overview || []).forEach(function (row) {
    if (!row || !row.href) return;
    if (row.slug) hrefBySlug[row.slug] = row.href;
    if (row.cluster_id !== undefined) hrefById[String(row.cluster_id)] = row.href;
  });

  // ── Nodes ─────────────────────────────────────────────────────────────
  var RING_OK = { core: 1, support: 1, periphery: 1, island: 1 };
  var RING_NAME = { core: 'Core', support: 'Support', periphery: 'Periphery', island: 'Bomb' };
  // A bomb that is also core keeps coreness_ring 'core' (and its core-ring position): only
  // only bombs that would otherwise be peripheral leave the rings for the island (payload/onion_layout.py);
  // core and support bombs keep their ring.
  var ROLE_OK = { payoff: 1, enabler: 1 };
  var ROLE_NAME = { payoff: 'payoff', enabler: 'engine' };
  var nodes = (seg.nodes || []).filter(function (r) { return r && r.id !== undefined && r.id !== null; }).map(function (r) {
    var play = fin(r.play_rate);
    if (play === null) play = fin(r.deck_prevalence);
    var n = {
      raw: r, id: String(r.id), label: String(r.label || r.id), mana: M.manaKeys(r.color_identity),
      play: play === null ? 0 : play, coreness: fin(r.coreness), ring: RING_OK[r.coreness_ring] ? r.coreness_ring : null,
      bomb: !!r.bomb || r.coreness_ring === 'island', x0: fin(r.x), y0: fin(r.y),
      community: fin(r.community) === null ? -1 : r.community, pick: fin(r.pick_priority_score) || 0,
      // payoff / enabler (contract v3 amendment; slim_cluster_payload keeps it only for directed payloads)
      role: ROLE_OK[r.flow_role] ? r.flow_role : null
    };
    if (n.bomb && !n.ring) n.ring = 'island';
    return n;
  });
  function inIsland(n) { return n.ring === 'island'; }
  var byId = Object.create(null);
  nodes.forEach(function (n) { byId[n.id] = n; });
  if (nodes.some(function (n) { return n.coreness === null; })) {
    nodes.forEach(function (n) { if (n.coreness === null) n.coreness = clamp(n.play, 0, 1); });
  }
  var legacyRings = !nodes.some(function (n) { return n.ring && n.ring !== 'island'; });
  var byCoreness = nodes.slice().sort(function (a, b) { return (b.coreness - a.coreness) || (b.play - a.play) || (a.id < b.id ? -1 : 1); });
  if (legacyRings) {
    var rank = 0;
    byCoreness.forEach(function (n) {
      if (n.ring === 'island') return;
      n.ring = rank < 8 ? 'core' : (rank < 16 ? 'support' : 'periphery');
      rank += 1;
    });
  }
  byCoreness.forEach(function (n, i) { n.rank = i + 1; });
  // core_kind tag ('signature' | 'staple') exactly as the payload sets it; nothing otherwise
  nodes.forEach(function (n) {
    var k = n.raw.core_kind;
    n.kind = (k === 'signature' || k === 'staple') ? k : '';
  });
  byCoreness.filter(function (n) { return n.ring === 'core'; }).forEach(function (n, i) { n.coreRank = i; });
  function ringOf(n) { return n.ring || 'periphery'; }

  // ── Edges ─────────────────────────────────────────────────────────────
  function pairKey(a, b) { return a < b ? a + '\u0001' + b : b + '\u0001' + a; }
  // Arrow (contract v3 amendment, owner decision): edge.direction = {from, to, z} points FROM the
  // card that wins more when drawn without its partner (the payoff) TO the partner (the engine it
  // rewards); null / absent when |z| < 1.96. Arrowheads are drawn only for these.
  function dirOf(e, a, b) {
    var d = e.direction;
    if (!d || typeof d !== 'object') return null;
    var f = String(d.from), t = String(d.to);
    if (!((f === a && t === b) || (f === b && t === a))) return null;
    return { from: f, to: t, z: fin(d.z) };
  }
  var synEdges = [], synByPair = Object.create(null);
  (seg.edges || []).forEach(function (e) {
    if (!e || (e.kind && e.kind !== 'synergy')) return;
    var a = String(e.from), b = String(e.to);
    if (!byId[a] || !byId[b] || a === b) return;
    var lam = fin(e.synergy_logit);
    if (lam === null) lam = fin(e.synergy_delta_logit);
    if (lam === null) lam = 0;
    var se = fin(e.synergy_se);
    if (se === null && fin(e.ci_low) !== null && fin(e.ci_high) !== null) se = (e.ci_high - e.ci_low) / 3.92;
    var tier = (e.display_tier === 'tentative' || e.display_tier === 'extended') ? 'tentative' : 'verified';
    var edge = { kind: 'synergy', a: a, b: b, raw: e, lam: lam, se: se, tier: tier, conf: fin(e.confidence_probability), dir: dirOf(e, a, b) };
    synEdges.push(edge);
    synByPair[pairKey(a, b)] = edge;
  });
  synEdges.sort(function (x, y) { return y.lam - x.lam; });
  var copEdges = [];
  (seg.coplay_edges || []).forEach(function (e) {
    var a = String(e.from), b = String(e.to);
    if (!byId[a] || !byId[b] || a === b) return;
    copEdges.push({ kind: 'coplay', a: a, b: b, raw: e, dir: dirOf(e, a, b) });
  });
  // co-play lift (decks with both vs chance), shown only when it says something (>= 1.1x)
  function coplayLiftText(raw) {
    var lift = raw && fin(raw.log_lift) !== null ? Math.exp(raw.log_lift) : null;
    return lift !== null && lift >= 1.1 ? lift.toFixed(1) + '&times; more often than chance' : '';
  }
  var pickPairs = [];
  (seg.top_pick_pairs || []).forEach(function (row) {
    var cards = row.cards || [];
    if (cards.length !== 2 || !byId[cards[0]] || !byId[cards[1]]) return;
    pickPairs.push({ kind: 'pick', a: String(cards[0]), b: String(cards[1]), raw: row });
  });
  var synDegree = Object.create(null);
  synEdges.forEach(function (e) { synDegree[e.a] = (synDegree[e.a] || 0) + 1; synDegree[e.b] = (synDegree[e.b] || 0) + 1; });
  var nVerified = synEdges.filter(function (e) { return e.tier === 'verified'; }).length;
  var nTentative = synEdges.length - nVerified;

  // ── Onion layout (payload) or a client-side fallback for legacy payloads ──
  var L = seg.layout;
  var hasPos = nodes.length && nodes.every(function (n) { return n.x0 !== null && n.y0 !== null; });
  if (!(L && L.mode === 'onion' && Array.isArray(L.rings) && L.rings.length && hasPos)) L = legacyOnion();
  var CX = (L.center && fin(L.center[0]) !== null) ? L.center[0] : 900;
  var CY = (L.center && fin(L.center[1]) !== null) ? L.center[1] : 560;
  var ASP = fin(L.aspect) || 1;
  var LAYOUT_VERSION = String(L.version || 'onion');

  function legacyOnion() {
    // Concentric rings by coreness rank; angles follow synergy neighbours (as the audit prototype).
    var R = { core: 170, support: 330, periphery: 480 };
    var adj = Object.create(null);
    nodes.forEach(function (n) { adj[n.id] = []; });
    synEdges.forEach(function (e) { adj[e.a].push(e.b); adj[e.b].push(e.a); });
    var placedTheta = Object.create(null);
    function place(list, radius) {
      if (!list.length) return;
      list.forEach(function (n) {
        var sx = 0, sy = 0, k = 0;
        adj[n.id].forEach(function (m) { if (placedTheta[m] !== undefined) { sx += Math.cos(placedTheta[m]); sy += Math.sin(placedTheta[m]); k += 1; } });
        n._want = k ? Math.atan2(sy, sx) : ((n.community + 1) * 2.399) % (2 * Math.PI);
      });
      list.sort(function (a, b) { return a._want - b._want; });
      var step = 2 * Math.PI / list.length, bestOff = 0, bestCost = Infinity;
      for (var t = 0; t < 72; t += 1) {
        var off = t * 2 * Math.PI / 72, cost = 0;
        list.forEach(function (n, i) { cost += Math.abs(((i * step + off) - n._want + 3 * Math.PI) % (2 * Math.PI) - Math.PI); });
        if (cost < bestCost) { bestCost = cost; bestOff = off; }
      }
      list.forEach(function (n, i) {
        var th = i * step + bestOff;
        placedTheta[n.id] = th;
        n.x0 = 900 + 1.25 * radius * Math.cos(th);
        n.y0 = 560 + radius * Math.sin(th);
      });
    }
    var core = nodes.filter(function (n) { return n.ring === 'core'; });
    core.sort(function (a, b) { return (a.community - b.community) || (b.coreness - a.coreness); });
    place(core, R.core);
    place(nodes.filter(function (n) { return n.ring === 'support'; }), R.support);
    place(nodes.filter(function (n) { return n.ring !== 'core' && n.ring !== 'support'; }), R.periphery);
    return { mode: 'onion', version: 'client-fallback', center: [900, 560], aspect: 1.25,
             rings: [{ ring: 'core', radius: 250 }, { ring: 'support', radius: 405 }, { ring: 'periphery', radius: 545 }],
             island: null, extent: null };
  }

  // ── Saved card angles (Core view): {layout_version, slug, theta: {card: radians}} ──
  var LAYOUT_KEY = 'mtgnet_layout_' + (meta.format || '') + '_' + SLUG;
  var savedLayout = M.store.get(LAYOUT_KEY);
  var thetaOverride = Object.create(null);
  if (savedLayout && savedLayout.layout_version === LAYOUT_VERSION && savedLayout.slug === SLUG && savedLayout.theta) {
    Object.keys(savedLayout.theta).forEach(function (k) {
      if (byId[k] && fin(savedLayout.theta[k]) !== null && byId[k].ring !== 'island') thetaOverride[k] = savedLayout.theta[k];
    });
  }
  function persistLayout() {
    if (Object.keys(thetaOverride).length) M.store.set(LAYOUT_KEY, { layout_version: LAYOUT_VERSION, slug: SLUG, theta: thetaOverride });
    else M.store.remove(LAYOUT_KEY);
    syncRestoreBtn();
  }
  function polar(n) {
    var dx = (n.x0 - CX) / ASP, dy = n.y0 - CY;
    return { rho: hypot(dx, dy), th: Math.atan2(dy, dx) };
  }
  function layoutPos(n) {
    if (thetaOverride[n.id] !== undefined) {
      var p = polar(n), th = thetaOverride[n.id];
      return [CX + ASP * p.rho * Math.cos(th), CY + p.rho * Math.sin(th)];
    }
    return [n.x0, n.y0];
  }

  // ── State ─────────────────────────────────────────────────────────────
  var state = { view: 'core', coplay: true, allLabels: false, hover: null, selected: null, activeEdge: null, pickRarity: 'all' };
  var access = {
    formatLocked: false,
    premiumFilters: { buildArounds: false, topSynergies: false, coreOnly: false },
    premiumDrawer: { buildAroundDetector: false, bestPairSynergies: false, tripletMotifs: false, communities: false },
    premiumQuickRead: { buildArounds: false },
    premiumReport: false
  };
  var view = null;          // geometry of the current view
  var rotate = false;       // portrait phones: onion rotated 90 degrees (island below)
  var cam = { s: 1, tx: 0, ty: 0 }, fitCam = null;
  var svg = document.getElementById('cpSvg');
  var graphEl = document.getElementById('cpGraph');
  var canvasEl = document.getElementById('cpCanvas');
  var gView, gGuides, gEdges, gNodes, gLabels;
  var nodeEls = Object.create(null), edgeEls = [], labelEls = Object.create(null), labelBoxes = [], hoverLabel = null;

  function T(x, y) { return rotate ? [CX - (y - CY), CY + (x - CX)] : [x, y]; }
  function Tinv(x, y) { return rotate ? [CX + (y - CY), CY - (x - CX)] : [x, y]; }
  function isNarrow() { return (svg.clientWidth || graphEl.clientWidth || window.innerWidth) < 600; }

  // ── Radii ─────────────────────────────────────────────────────────────
  function coreRadius(n) {
    var r = 8.5 + 15 * Math.sqrt(clamp(n.coreness || 0, 0, 1));
    return n.bomb ? Math.max(r, 14) : r;
  }

  // ── View geometry ─────────────────────────────────────────────────────
  function ellipse(cx, cy, rx, ry, keepAxes) {
    var c = T(cx, cy);
    return (rotate && !keepAxes) ? { cx: c[0], cy: c[1], rx: ry, ry: rx } : { cx: c[0], cy: c[1], rx: rx, ry: ry };
  }
  // The island is a column of bombs with labels on the right. On rotated (portrait phone) layouts
  // it moves below the onion but keeps its own orientation (translated, not rotated), so the
  // column stays a column and its labels still fit.
  function islandBox() {
    var isl = L.island;
    return (isl && fin(isl.cx) !== null && fin(isl.cy) !== null && fin(isl.rx) !== null && fin(isl.ry) !== null) ? isl : null;
  }
  function viewPos(n, p) {
    var isl = rotate && inIsland(n) ? islandBox() : null;
    if (isl) {
      var c = T(isl.cx, isl.cy);
      return [c[0] + (p[0] - isl.cx), c[1] + (p[1] - isl.cy)];
    }
    return T(p[0], p[1]);
  }
  function boxOfDiscs(list) {
    var b = null;
    list.forEach(function (n) { b = M.unionBox(b, { x0: n.vx - n.vr, y0: n.vy - n.vr, x1: n.vx + n.vr, y1: n.vy + n.vr }); });
    return b;
  }
  function onionGuides(g) {
    var rings = (L.rings || []).filter(function (r) { return fin(r.radius) !== null; })
      .slice().sort(function (a, b) { return a.radius - b.radius; });
    g.rings = rings.map(function (r) { var e = ellipse(CX, CY, ASP * r.radius, r.radius); e.ring = r.ring; return e; });
    var isl = islandBox();
    if (isl && nodes.some(inIsland)) {
      g.island = ellipse(isl.cx, isl.cy, isl.rx, isl.ry, true);
      g.island.label = isl.label || 'Bombs - strong on their own';
    }
    var b = null;
    g.rings.concat(g.island ? [g.island] : []).forEach(function (e) { b = M.unionBox(b, { x0: e.cx - e.rx, y0: e.cy - e.ry, x1: e.cx + e.rx, y1: e.cy + e.ry }); });
    if (Array.isArray(L.extent) && L.extent.length === 4) {
      var p0 = T(L.extent[0], L.extent[1]), p1 = T(L.extent[2], L.extent[3]);
      b = M.unionBox(b, { x0: Math.min(p0[0], p1[0]), y0: Math.min(p0[1], p1[1]), x1: Math.max(p0[0], p1[0]), y1: Math.max(p0[1], p1[1]) });
    }
    return b;
  }
  function computeView() {
    var v = { name: state.view, rings: [], island: null, hulls: [], shelf: null, edges: [], guideLabels: [] };
    nodes.forEach(function (n) { n.faded = false; n.shelf = false; });
    if (state.view === 'synergy') {
      synergyLayout(v);
    } else {
      nodes.forEach(function (n) {
        var q = viewPos(n, layoutPos(n));
        n.vx = q[0]; n.vy = q[1];
        n.vr = state.view === 'picks' ? 6 + 1.8 * clamp(n.pick, 0, 10) : coreRadius(n);
      });
      var gb = onionGuides(v);
      if (state.view === 'core') {
        // played-together skeleton; links into the bomb island are left to the card spotlight
        if (state.coplay) copEdges.forEach(function (e) { if (!inIsland(byId[e.a]) && !inIsland(byId[e.b])) v.edges.push(e); });
        synEdges.forEach(function (e) { v.edges.push(e); });
      } else {
        nodes.forEach(function (n) {
          var r = n.raw;
          n.faded = !((fin(r.draft_win_lift) || 0) > 0 && (fin(r.pick_priority_score_raw) === null || r.pick_priority_score_raw > 0));
        });
        picksRanked = nodes.filter(function (n) { return !n.faded; }).sort(function (a, b) { return b.pick - a.pick; });
        pickPairs.forEach(function (e) { v.edges.push(e); });
      }
      v.baseBox = M.unionBox(gb, boxOfDiscs(nodes));
    }
    view = v;
  }

  // Synergy view: verified + tentative edges only. Each connected component gets its own
  // deterministic force layout; components are packed in rows (largest first), communities
  // become soft backdrops inside their component, and unlinked cards sit on a shelf below.
  function forceLayout(comp, edges) {
    var K = 115, idx = Object.create(null);
    comp.forEach(function (n, i) { idx[n.id] = i; });
    var cx = 0, cy = 0;
    comp.forEach(function (n) { cx += n.x0; cy += n.y0; });
    cx /= comp.length; cy /= comp.length;
    comp.forEach(function (n) { n.vx = (n.x0 - cx) * 0.5; n.vy = (n.y0 - cy) * 0.5; });
    if (comp.length === 2) {
      comp[0].vx = -K / 2; comp[0].vy = 0; comp[1].vx = K / 2; comp[1].vy = 0;
      return;
    }
    var temp = 50;
    for (var it = 0; it < 320; it += 1) {
      var dx = new Array(comp.length).fill(0), dy = new Array(comp.length).fill(0);
      for (var i = 0; i < comp.length; i += 1) {
        for (var j = i + 1; j < comp.length; j += 1) {
          var ex = comp[i].vx - comp[j].vx, ey = comp[i].vy - comp[j].vy;
          if (Math.abs(ex) + Math.abs(ey) < 1e-6) { ex = 1 + i; ey = j; }
          var d = Math.max(1, hypot(ex, ey));
          var f = K * K / d * (comp[i].community === comp[j].community ? 0.75 : 1.1);
          dx[i] += ex / d * f; dy[i] += ey / d * f; dx[j] -= ex / d * f; dy[j] -= ey / d * f;
        }
      }
      edges.forEach(function (e) {
        var a = idx[e.a], b = idx[e.b];
        var ex = comp[a].vx - comp[b].vx, ey = comp[a].vy - comp[b].vy, d = Math.max(1, hypot(ex, ey));
        var f = d * d / K * (e.tier === 'verified' ? 1.2 : 0.9);
        dx[a] -= ex / d * f; dy[a] -= ey / d * f; dx[b] += ex / d * f; dy[b] += ey / d * f;
      });
      comp.forEach(function (n, k) {
        dx[k] -= n.vx * 0.08; dy[k] -= n.vy * 0.08;
        var d = Math.max(1e-6, hypot(dx[k], dy[k])), step = Math.min(d, temp);
        n.vx += dx[k] / d * step; n.vy += dy[k] / d * step;
      });
      temp = Math.max(1, temp * 0.982);
    }
  }
  function synergyLayout(v) {
    var conn = nodes.filter(function (n) { return synDegree[n.id]; });
    var iso = nodes.filter(function (n) { return !synDegree[n.id]; }).sort(function (a, b) { return b.coreness - a.coreness; });
    conn.forEach(function (n) { n.vr = 9 + 6 * Math.sqrt(synDegree[n.id]); });
    // connected components
    var adj = Object.create(null), seen = Object.create(null), comps = [];
    synEdges.forEach(function (e) { (adj[e.a] = adj[e.a] || []).push(e.b); (adj[e.b] = adj[e.b] || []).push(e.a); });
    conn.slice().sort(function (a, b) { return b.coreness - a.coreness; }).forEach(function (n) {
      if (seen[n.id]) return;
      var comp = [], stack = [n.id];
      seen[n.id] = 1;
      while (stack.length) {
        var id = stack.pop();
        comp.push(byId[id]);
        (adj[id] || []).forEach(function (m) { if (!seen[m]) { seen[m] = 1; stack.push(m); } });
      }
      comps.push(comp);
    });
    comps.sort(function (a, b) { return b.length - a.length; });
    var boxes = comps.map(function (comp) {
      var ids = Object.create(null);
      comp.forEach(function (n) { ids[n.id] = 1; });
      forceLayout(comp, synEdges.filter(function (e) { return ids[e.a] && ids[e.b]; }));
      return boxOfDiscs(comp);
    });
    // pack components in rows. The row width is the one whose packed block (plus the shelf of
    // unlinked cards) best fills the canvas shape: a fixed row width stacked tall components into
    // a narrow column on wide screens and shrank the whole graph.
    var GAPX = 170, GAPY = 90, SHELF_MIN_W = 900;
    function packRows(rowW) {
      var x = 0, y = 0, rowH = 0, w = 0, pos = [];
      boxes.forEach(function (b) {
        var bw = b.x1 - b.x0, bh = b.y1 - b.y0;
        if (x > 0 && x + bw > rowW) { x = 0; y += rowH + GAPY; rowH = 0; }
        pos.push([x - b.x0, y - b.y0]);
        x += bw + GAPX; rowH = Math.max(rowH, bh); w = Math.max(w, x - GAPX);
      });
      return { pos: pos, w: w, h: y + rowH };
    }
    function shelfSize(width) {
      if (!iso.length) return { w: 0, h: 0 };
      var cols = clamp(Math.round(width / 230), 3, 5);
      return { w: width, h: 140 + Math.ceil(iso.length / cols) * 46 + 24 };
    }
    var canvasW = svg.clientWidth || graphEl.clientWidth || window.innerWidth;
    var canvasH = window.matchMedia('(max-width: 900px)').matches ? window.innerHeight * 0.74 : (svg.clientHeight || window.innerHeight);
    var aspect = canvasW > 0 && canvasH > 0 ? canvasW / canvasH : 1.4;
    var widths = boxes.map(function (b) { return b.x1 - b.x0; });
    var cands = [SHELF_MIN_W], run = 0;
    widths.forEach(function (w, k) { run += w + (k ? GAPX : 0); cands.push(run, w); });
    var best = null;
    cands.forEach(function (rowW) {
      var p = packRows(rowW), sw = Math.max(p.w, SHELF_MIN_W), sh = shelfSize(sw);
      var W = Math.max(p.w, sh.w), H = p.h + sh.h;
      var score = Math.min(aspect / Math.max(1, W), 1 / Math.max(1, H));   // proportional to the fit zoom
      if (!best || score > best.score * 1.0001) best = { score: score, pack: p };
    });
    var packing = best ? best.pack : packRows(SHELF_MIN_W);
    comps.forEach(function (comp, k) {
      var ox = packing.pos[k][0], oy = packing.pos[k][1];
      comp.forEach(function (n) { n.vx += ox; n.vy += oy; });
      var byComm = Object.create(null);
      comp.forEach(function (n) { (byComm[n.community] = byComm[n.community] || []).push(n); });
      Object.keys(byComm).forEach(function (c) {
        var mem = byComm[c];
        if (mem.length < 2) return;
        var hb = boxOfDiscs(mem);
        v.hulls.push({ x0: hb.x0 - 30, y0: hb.y0 - 30, x1: hb.x1 + 30, y1: hb.y1 + 30 });
      });
    });
    var cb = boxOfDiscs(conn);
    var width = Math.max(cb ? cb.x1 - cb.x0 : 0, SHELF_MIN_W);
    var left = cb ? (cb.x0 + cb.x1) / 2 - width / 2 : -width / 2;
    var cols = clamp(Math.round(width / 230), 3, 5), cellW = width / cols, cellH = 46;
    var top = cb ? cb.y1 + 140 : 0;
    iso.forEach(function (n, k) {
      n.vr = 7;
      n.shelf = true;
      n.vx = left + (k % cols) * cellW + 18;
      n.vy = top + Math.floor(k / cols) * cellH + 30;
    });
    if (iso.length) {
      var rows = Math.ceil(iso.length / cols);
      v.shelf = { x0: left - 6, y0: top - 6, x1: left + width + 6, y1: top + rows * cellH + 24 };
      // the title sits just above the shelf box (placed at label time: its height is in screen px)
      v.guideLabels.push({ text: conn.length ? 'No verified synergy partner (' + iso.length + ')' : 'No pair cleared the evidence bar', x: left + 10, above: v.shelf.y0, anchor: 'start' });
    }
    synEdges.forEach(function (e) { v.edges.push(e); });
    v.baseBox = M.unionBox(boxOfDiscs(nodes), v.shelf);
    v.hulls.forEach(function (h) { v.baseBox = M.unionBox(v.baseBox, h); });
  }

  // ── Drawing ───────────────────────────────────────────────────────────
  function starPath(cx, cy, R) {
    var pts = [];
    for (var k = 0; k < 10; k += 1) {
      var rr = k % 2 ? R * 0.45 : R, a = -Math.PI / 2 + k * Math.PI / 5;
      pts.push((cx + rr * Math.cos(a)).toFixed(2) + ' ' + (cy + rr * Math.sin(a)).toFixed(2));
    }
    return 'M' + pts.join('L') + 'Z';
  }
  function synStroke(e) {
    var w = 1.6 + 7 * clamp(e.lam, 0, 0.5) / 0.5;
    var op;
    if (e.se !== null && e.se > 0) {
      var prec = 1 / e.se;
      op = 0.38 + 0.57 * clamp((Math.log(prec) - Math.log(4)) / (Math.log(40) - Math.log(4)), 0, 1);
    } else if (e.conf !== null) {
      op = 0.38 + 0.57 * clamp((e.conf - 0.85) / 0.15, 0, 1);   // legacy edges: confidence in [0.85, 1]
    } else {
      op = 0.75;
    }
    if (e.tier === 'tentative') { w = Math.min(w, 3.2) * 0.8; op *= 0.6; }
    return { w: w, op: op };
  }
  // payoff / engine rings go with the arrows: Core and Synergy views only
  function showRoles() { return state.view !== 'picks'; }
  var anyRole = nodes.some(function (n) { return n.role; });
  // Line + arrowhead geometry. Arrowheads keep a constant screen size (like the non-scaling
  // strokes), so they are recomputed whenever the zoom changes (layoutLabels) or a card moves.
  function positionEdge(x) {
    var e = x.e, A = byId[e.a], B = byId[e.b];
    var x1 = A.vx, y1 = A.vy, x2 = B.vx, y2 = B.vy;
    if (x.head) {
      var S = byId[e.dir.from], D = byId[e.dir.to];
      var dx = D.vx - S.vx, dy = D.vy - S.vy, len = hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      var s = cam.s || 1, cop = e.kind === 'coplay';
      var Lh = (cop ? 7 : clamp(x.w * 2.2, 9, 16)) / s, Wh = (cop ? 6 : clamp(x.w * 1.7, 7.5, 13)) / s;
      var tip = D.vr + 2.5 / s;
      if (len > S.vr + tip + Lh) {
        var tx = D.vx - ux * tip, ty = D.vy - uy * tip, bx = tx - ux * Lh, by = ty - uy * Lh;
        x.head.setAttribute('d', 'M' + tx.toFixed(2) + ' ' + ty.toFixed(2) +
          'L' + (bx - uy * Wh / 2).toFixed(2) + ' ' + (by + ux * Wh / 2).toFixed(2) +
          'L' + (bx + uy * Wh / 2).toFixed(2) + ' ' + (by - ux * Wh / 2).toFixed(2) + 'Z');
        x.head.removeAttribute('display');
        // the line stops inside the arrowhead so its round cap never pokes through the tip
        x1 = S.vx; y1 = S.vy; x2 = bx + ux * Lh * 0.3; y2 = by + uy * Lh * 0.3;
      } else {
        x.head.setAttribute('display', 'none');   // discs (almost) touching: no room for a head
      }
    }
    x.line.setAttribute('x1', x1); x.line.setAttribute('y1', y1); x.line.setAttribute('x2', x2); x.line.setAttribute('y2', y2);
    x.hit.setAttribute('x1', A.vx); x.hit.setAttribute('y1', A.vy); x.hit.setAttribute('x2', B.vx); x.hit.setAttribute('y2', B.vy);
  }
  function draw() {
    M.clear(svg);
    nodeEls = Object.create(null); edgeEls = []; labelEls = Object.create(null); hoverLabel = null;
    gView = svgEl('g'); gGuides = svgEl('g'); gEdges = svgEl('g'); gNodes = svgEl('g'); gLabels = svgEl('g');
    gView.appendChild(gGuides); gView.appendChild(gEdges); gView.appendChild(gNodes); gView.appendChild(gLabels);
    svg.appendChild(gView);
    // guides
    var order = { periphery: 0, support: 1, core: 2 };
    view.rings.slice().sort(function (a, b) { return (order[a.ring] || 0) - (order[b.ring] || 0); }).forEach(function (e) {
      gGuides.appendChild(svgEl('ellipse', { cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, class: 'ring-band ' + e.ring }));
    });
    view.rings.forEach(function (e) {
      gGuides.appendChild(svgEl('ellipse', { cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, class: 'ring-line' }));
    });
    if (view.island) gGuides.appendChild(svgEl('ellipse', { cx: view.island.cx, cy: view.island.cy, rx: view.island.rx, ry: view.island.ry, class: 'island' }));
    view.hulls.forEach(function (h) {
      gGuides.appendChild(svgEl('rect', { x: h.x0, y: h.y0, width: h.x1 - h.x0, height: h.y1 - h.y0, rx: 40, class: 'hull' }));
    });
    if (view.shelf) {
      var s = view.shelf;
      gGuides.appendChild(svgEl('rect', { x: s.x0, y: s.y0, width: s.x1 - s.x0, height: s.y1 - s.y0, rx: 18, class: 'shelf' }));
    }
    // edges: coplay first (beneath), then pick pairs, then synergy (strongest on top)
    var kindOrder = { coplay: 0, pick: 1, synergy: 2 };
    view.edges.slice().sort(function (x, y) { return (kindOrder[x.kind] - kindOrder[y.kind]) || ((x.lam || 0) - (y.lam || 0)); }).forEach(function (e) {
      var g = svgEl('g', { class: 'cp-edge' });
      var line = svgEl('line'), head = null, w = 1;
      if (e.kind === 'coplay') {
        line.setAttribute('class', 'cp-coplay');
        if (e.dir) head = svgEl('path', { class: 'cp-arrow cop' });
      } else if (e.kind === 'pick') {
        line.setAttribute('class', 'cp-pickpair');
        line.setAttribute('stroke-width', (1 + 3 * clamp((fin(e.raw.pick_score) || 0) / 10, 0, 1)).toFixed(2));
        line.setAttribute('stroke-opacity', '0.6');
      } else {
        var st = synStroke(e);
        w = st.w;
        line.setAttribute('class', 'cp-syn' + (e.tier === 'tentative' ? ' tentative' : ''));
        line.setAttribute('stroke-width', st.w.toFixed(2));
        line.setAttribute('stroke-opacity', st.op.toFixed(2));
        if (e.dir) head = svgEl('path', { class: 'cp-arrow syn', 'fill-opacity': Math.min(1, st.op + 0.1).toFixed(2) });
      }
      var hit = svgEl('line');
      hit.setAttribute('class', 'edge-hit');
      hit.setAttribute('stroke-width', e.kind === 'coplay' ? '7' : '13');
      g.appendChild(line);
      if (head) g.appendChild(head);
      g.appendChild(hit);
      g._edge = e;
      gEdges.appendChild(g);
      var x = { el: g, e: e, line: line, hit: hit, head: head, w: w };
      positionEdge(x);
      edgeEls.push(x);
    });
    // nodes: small first so large discs stay clickable on top
    nodes.slice().sort(function (a, b) { return a.vr - b.vr; }).forEach(function (n) {
      var g = svgEl('g', {
        class: 'cp-node ring-' + ringOf(n) + (n.faded ? ' faded' : ''),
        transform: 'translate(' + n.vx.toFixed(2) + ' ' + n.vy.toFixed(2) + ')',
        tabindex: 0, role: 'button', 'aria-label': nodeAria(n)
      });
      g.setAttribute('data-id', n.id);
      var r = n.vr;
      g.appendChild(svgEl('circle', { r: r, class: 'node-hit' }));
      if (n.mana.length === 2) {
        g.appendChild(svgEl('path', { d: 'M0 ' + (-r) + 'A' + r + ' ' + r + ' 0 0 0 0 ' + r + 'Z', class: 'mf-' + n.mana[0] }));
        g.appendChild(svgEl('path', { d: 'M0 ' + (-r) + 'A' + r + ' ' + r + ' 0 0 1 0 ' + r + 'Z', class: 'mf-' + n.mana[1] }));
      } else {
        g.appendChild(svgEl('circle', { r: r, class: 'mf-' + n.mana[0] }));
      }
      g.appendChild(svgEl('circle', { r: r, class: 'disc-stroke' }));
      var roleRing = showRoles() && n.role;
      if (roleRing) g.appendChild(svgEl('circle', { r: r + 3, class: 'role-ring ' + n.role }));
      if (n.bomb) {
        var R = Math.max(5.5, r * 0.5);
        g.appendChild(svgEl('path', { d: starPath(r * 0.72, -r * 0.72, R), class: 'bomb-mark' }));
      }
      g.appendChild(svgEl('circle', { r: r + (roleRing ? 7 : 4), class: 'sel-ring' }));
      nodeEls[n.id] = g;
      gNodes.appendChild(g);
    });
    markSelected();
  }
  function nodeAria(n) {
    var parts = [n.label];
    if (state.view === 'picks') parts.push('pick score ' + (fin(n.raw.pick_priority_score) !== null ? n.raw.pick_priority_score.toFixed(1) : 'unknown') + ' of 10');
    else if (state.view === 'synergy') parts.push((synDegree[n.id] || 0) + ' synergy partners');
    if (!inIsland(n)) parts.push(RING_NAME[ringOf(n)].toLowerCase() + ' card');
    if (n.kind) parts.push(n.kind);
    if (n.bomb) parts.push('bomb, strong on its own');
    if (n.role) parts.push(ROLE_NAME[n.role]);
    parts.push('in ' + F.pct0(n.play) + ' of decks');
    return parts.join(', ');
  }

  // ── Camera: fit-to-content, zoom, pan ─────────────────────────────────
  function viewportBounds(margin) {
    var W = svg.clientWidth, H = svg.clientHeight, s = cam.s, m = (margin || 4) / s;
    return { x0: -cam.tx / s + m, y0: -cam.ty / s + m, x1: (W - cam.tx) / s - m, y1: (H - cam.ty) / s - m };
  }
  function applyCam() {
    if (!gView) return;
    gView.setAttribute('transform', 'translate(' + cam.tx.toFixed(2) + ' ' + cam.ty.toFixed(2) + ') scale(' + cam.s.toFixed(5) + ')');
  }
  var labelRaf = 0;
  function scheduleLabels() {
    if (labelRaf) return;
    labelRaf = requestAnimationFrame(function () { labelRaf = 0; layoutLabels(true); });
  }
  function zoomBarH() {
    var z = document.querySelector('.cp-zoom');
    return z && z.offsetHeight ? z.offsetHeight + 8 : 0;
  }
  function sizeGraph() {
    // Stacked layout: the graph height follows the content's aspect ratio.
    if (window.matchMedia('(max-width: 900px)').matches && view && view.baseBox) {
      var W = graphEl.clientWidth || window.innerWidth;
      var b = view.baseBox, ratio = (b.y1 - b.y0) / Math.max(1, b.x1 - b.x0);
      var H = clamp(Math.round(W * ratio * 1.04 + 24 + zoomBarH()), 300, Math.round(window.innerHeight * 0.74));
      canvasEl.style.height = H + 'px';
    } else {
      canvasEl.style.height = '';
    }
  }
  function fit() {
    var W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H || !view || !view.baseBox) return;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var pad = isNarrow() ? 8 : 16;
    var legend = document.getElementById('cpLegend');
    var stacked = window.matchMedia('(max-width: 900px)').matches;
    // keep the bottom strip clear: the legend overlay (desktop) or the zoom buttons (stacked)
    var bottom = stacked ? zoomBarH() : ((legend && legend.offsetHeight) ? legend.offsetHeight + 8 : 0);
    var Hf = H - bottom;
    cam = M.fitBox(view.baseBox, W, Hf, pad);
    for (var pass = 0; pass < 2; pass += 1) {
      layoutLabels(false);
      var box = view.baseBox;
      labelBoxes.forEach(function (b) { box = M.unionBox(box, b); });
      cam = M.fitBox(box, W, Hf, pad);
    }
    fitCam = { s: cam.s, tx: cam.tx, ty: cam.ty };
    applyCam();
    layoutLabels(true);
  }
  function zoomAt(factor, sx, sy) {
    if (!fitCam) return;
    var W = svg.clientWidth, H = svg.clientHeight;
    if (sx === undefined) { sx = W / 2; sy = H / 2; }
    var s1 = clamp(cam.s * factor, fitCam.s * 0.6, fitCam.s * 8);
    var ux = (sx - cam.tx) / cam.s, uy = (sy - cam.ty) / cam.s;
    cam.s = s1; cam.tx = sx - ux * s1; cam.ty = sy - uy * s1;
    applyCam(); scheduleLabels();
  }
  function screenPoint(evt) {
    var r = svg.getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  }
  function toUser(p) { return { x: (p.x - cam.tx) / cam.s, y: (p.y - cam.ty) / cam.s }; }

  // ── Labels: constant screen size, halo, greedy collision avoidance ────
  function labelTier(n) {
    if (state.view === 'synergy') return synDegree[n.id] ? 'core' : 'support';
    if (state.view === 'picks') {
      if (n.bomb) return 'island';
      var top = picksRanked.indexOf(n);
      return top >= 0 && top < 10 ? 'core' : (top >= 0 && top < 16 ? 'support' : 'periphery');
    }
    return ringOf(n);
  }
  var picksRanked = [];
  function labelPolicy(n) {
    // returns null (no label) or {px, weight, force, cls}
    var tier = labelTier(n);
    var zoomed = fitCam ? cam.s / fitCam.s : 1;
    var narrow = isNarrow();
    // phones: core labels only; the four most central are always shown, the rest when they fit
    if (tier === 'core') return { px: narrow ? 11.5 : 13, weight: 650, force: !narrow || n.coreRank < 4, cls: 'lbl-core', pr: 0 };
    // bombs are labelled on phones too whenever the label fits (forced on desktop)
    if (tier === 'island') return { px: narrow ? 11 : 12, weight: 500, force: !narrow, cls: 'lbl-island', pr: 1 };
    if (tier === 'support') {
      if (narrow && zoomed < 1.6 && !state.allLabels) return null;
      return { px: 12, weight: 400, force: false, cls: 'lbl-support', pr: 2 };
    }
    if (state.allLabels || zoomed >= (narrow ? 2.4 : 1.7)) return { px: 11, weight: 400, force: false, cls: 'lbl-periphery', pr: 3 };
    return null;
  }
  function placeGuideLabels(obstacles, out, s) {
    var narrow = isNarrow();
    var fsPx = narrow ? 9.5 : 10.5, fs = fsPx / s, h = fs * 1.3;
    view.rings.forEach(function (e) {
      var text = String(e.ring || '').toUpperCase();
      if (!text) return;
      var w = M.textWidth(text, fsPx, 700) / s * 1.12;
      var angles = [-90, -70, -110, -50, -130, -30, -150, 90];
      for (var i = 0; i < angles.length; i += 1) {
        var a = angles[i] * Math.PI / 180;
        var cx = e.cx + (e.rx - h) * Math.cos(a), cy = e.cy + (e.ry - h) * Math.sin(a);
        var b = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
        var hit = obstacles.some(function (o) {
          if (o.r === undefined) return b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1;
          var qx = clamp(o.x, b.x0, b.x1), qy = clamp(o.y, b.y0, b.y1);
          return hypot(o.x - qx, o.y - qy) < o.r + 2 / s;
        });
        if (!hit || i === angles.length - 1) {
          out.push({ text: text, x: cx, y: cy, fs: fs, anchor: 'middle', cls: 'guide-lbl', box: b });
          obstacles.push(b);
          return;
        }
      }
    });
    if (view.island) {
      var isl = view.island;
      var full = String(isl.label || 'Bombs - strong on their own');
      var fsPxI = narrow ? 11 : 12, fsI = fsPxI / s;
      var wFull = M.textWidth(full, fsPxI, 600) / s;
      // Title candidates: top edge (the layout reserves room there), then the bottom edge, then
      // the short text. The bombs' own labels (placed later, beside each disc) count as obstacles.
      var lblPx = narrow ? 11 : 12, est = [];
      nodes.forEach(function (n) {
        if (!inIsland(n)) return;
        var lw = M.textWidth(n.label, lblPx, 500) / s, lh = lblPx * 1.3 / s, x0 = n.vx <= isl.cx ? n.vx + n.vr + 3 / s : n.vx - n.vr - 3 / s - lw;
        est.push({ x0: x0, y0: n.vy - lh / 2, x1: x0 + lw, y1: n.vy + lh / 2 });
      });
      var cands = [];
      // inside the top / bottom edge first; then just outside the ellipse (small zooms on phones
      // leave no room inside, and the fallback used to sit on top of the first bomb)
      [[isl.cy - isl.ry + fsI * 1.2, isl.cy + isl.ry - fsI * 1.2], [isl.cy + isl.ry + fsI * 0.9, isl.cy - isl.ry - fsI * 0.9]].forEach(function (ys) {
        (wFull <= isl.rx * 2.1 ? [full, 'Bombs'] : ['Bombs']).forEach(function (text) {
          ys.forEach(function (y) {
            var w = M.textWidth(text, fsPxI, 600) / s;
            cands.push({ text: text, y: y, box: { x0: isl.cx - w / 2, y0: y - fsI * 0.65, x1: isl.cx + w / 2, y1: y + fsI * 0.65 } });
          });
        });
      });
      var pick = cands.filter(function (c) {
        var b = c.box;
        return !obstacles.some(function (o) {
          if (o.r === undefined) return false;
          var qx = clamp(o.x, b.x0, b.x1), qy = clamp(o.y, b.y0, b.y1);
          return hypot(o.x - qx, o.y - qy) < o.r + 2 / s;
        }) && !est.some(function (o) { return b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1; });
      })[0] || cands[0];
      out.push({ text: pick.text, x: isl.cx, y: pick.y, fs: fsI, anchor: 'middle', cls: 'guide-lbl island-lbl', box: pick.box });
      obstacles.push(pick.box);
    }
    view.guideLabels.forEach(function (gl) {
      var pxG = narrow ? 10.5 : 11.5, fsG = pxG / s;
      // .guide-lbl adds letter-spacing: .12em per character (cluster_page.css)
      var w = (M.textWidth(gl.text, pxG, 700) + 0.12 * pxG * gl.text.length) / s;
      // 'above': a box top edge the title must clear at any zoom (the shelf of unlinked cards)
      var y = fin(gl.above) !== null ? gl.above - fsG * 0.9 : gl.y;
      var b = { x0: gl.x, y0: y - fsG * 0.65, x1: gl.x + w, y1: y + fsG * 0.65 };
      out.push({ text: gl.text, x: gl.x, y: y, fs: fsG, anchor: 'start', cls: 'guide-lbl', box: b });
      obstacles.push(b);
    });
  }
  // Label halos are strokes inside the zoomed group: like the font size, their width is set in
  // user units (px / zoom) so the halo stays the same on screen at every zoom level.
  function halo(px, s) { return 'stroke-width:' + (px / s).toFixed(3) + 'px'; }
  function layoutLabels(bounded) {
    if (!gLabels) return;
    M.clear(gLabels);
    labelEls = Object.create(null); labelBoxes = []; hoverLabel = null;
    edgeEls.forEach(function (x) { if (x.head) positionEdge(x); });   // arrowheads track the zoom
    var s = cam.s;
    var obstacles = nodes.map(function (n) { return { id: n.id, x: n.vx, y: n.vy, r: n.vr + (n.bomb ? 2 / s : 0) }; });
    var guides = [];
    placeGuideLabels(obstacles, guides, s);
    guides.forEach(function (gl) {
      var t = svgEl('text', { x: gl.x, y: gl.y, 'font-size': gl.fs.toFixed(3), 'text-anchor': gl.anchor, 'dominant-baseline': 'central', class: gl.cls, style: halo(3, s) });
      t.textContent = gl.text;
      gLabels.appendChild(t);
      labelBoxes.push(gl.box);
    });
    var items = [];
    nodes.forEach(function (n) {
      var pol = labelPolicy(n);
      if (!pol) return;
      var w = M.textWidth(n.label, pol.px, pol.weight) / s, h = pol.px * 1.3 / s;
      var dx = n.vx - (view.name === 'synergy' ? 0 : T(CX, CY)[0]), dy = n.vy - (view.name === 'synergy' ? 0 : T(CX, CY)[1]);
      var d = hypot(dx, dy) || 1;
      if (n.shelf) { dx = 1; dy = 0; d = 1; }
      // island bombs: label toward the open side of the island (the column sits off-centre)
      if (view.island && inIsland(n) && view.name !== 'synergy') { dx = n.vx <= view.island.cx ? 1 : -1; dy = 0; d = 1; }
      items.push({ id: n.id, x: n.vx, y: n.vy, r: n.vr + (n.bomb ? 2 / s : 0), w: w, h: h, dir: { x: dx / d, y: dy / d }, force: pol.force, pol: pol, n: n });
    });
    items.sort(function (a, b) { return (a.pol.pr - b.pol.pr) || (b.n.coreness - a.n.coreness); });
    var bounds = bounded ? viewportBounds(4) : null;
    var placed = M.placeLabels(items, obstacles, bounds, 3 / s);
    var itemById = Object.create(null);
    items.forEach(function (it) { itemById[it.id] = it; });
    placed.forEach(function (p) {
      var it = itemById[p.id];
      var t = svgEl('text', { x: p.cx.toFixed(2), y: p.cy.toFixed(2), 'font-size': (it.pol.px / s).toFixed(3), 'dominant-baseline': 'central', class: 'mtg-lbl ' + it.pol.cls, style: halo(4, s) });
      t.textContent = it.n.label;
      t.setAttribute('data-id', p.id);
      gLabels.appendChild(t);
      labelEls[p.id] = t;
      labelBoxes.push(p);
    });
    // generous hit targets for small discs (>= 12 px screen radius, 20 px on touch)
    var minR = (window.matchMedia('(pointer: coarse)').matches ? 20 : 12) / s;
    nodes.forEach(function (n) {
      var g = nodeEls[n.id];
      if (g && g.firstChild) g.firstChild.setAttribute('r', Math.max(n.vr, minR).toFixed(2));
    });
    if (state.hover) applyFocus(state.hover);
  }
  function showHoverLabel(id) {
    if (hoverLabel) { hoverLabel.remove(); hoverLabel = null; }
    if (!id || labelEls[id]) return;
    var n = byId[id], s = cam.s, px = 12.5;
    var w = M.textWidth(n.label, px, 650) / s, h = px * 1.3 / s;
    var obstacles = nodes.map(function (m) { return { id: m.id, x: m.vx, y: m.vy, r: m.vr }; }).concat(labelBoxes);
    var p = M.placeLabels([{ id: id, x: n.vx, y: n.vy, r: n.vr, w: w, h: h, dir: { x: 1, y: 0 }, force: true }], obstacles, viewportBounds(4), 3 / s)[0];
    if (!p) return;
    hoverLabel = svgEl('text', { x: p.cx.toFixed(2), y: p.cy.toFixed(2), 'font-size': (px / s).toFixed(3), 'dominant-baseline': 'central', class: 'mtg-lbl lbl-hover', style: halo(4, s) });
    hoverLabel.textContent = n.label;
    gLabels.appendChild(hoverLabel);
  }

  // ── Focus / hover highlighting ────────────────────────────────────────
  function neighbours(id) {
    var set = Object.create(null);
    set[id] = 1;
    view.edges.forEach(function (e) { if (e.a === id) set[e.b] = 1; else if (e.b === id) set[e.a] = 1; });
    return set;
  }
  function applyFocus(id) {
    var nb = id ? neighbours(id) : null;
    Object.keys(nodeEls).forEach(function (k) {
      nodeEls[k].classList.toggle('dim', !!nb && !nb[k]);
      nodeEls[k].classList.toggle('is-hover', k === id && k !== state.selected);
    });
    edgeEls.forEach(function (x) { x.el.classList.toggle('dim', !!id && x.e.a !== id && x.e.b !== id); });
    Object.keys(labelEls).forEach(function (k) { labelEls[k].classList.toggle('dim', !!nb && !nb[k]); });
    document.querySelectorAll('.cp-row[data-id]').forEach(function (b) { b.classList.toggle('is-hover', b.getAttribute('data-id') === id); });
  }
  function setHover(id) {
    if (state.hover === id) return;
    state.hover = id;
    applyFocus(id);
    showHoverLabel(id);
  }
  function markSelected() {
    Object.keys(nodeEls).forEach(function (k) { nodeEls[k].classList.toggle('is-selected', k === state.selected); });
    document.querySelectorAll('.cp-row[data-id]').forEach(function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-id') === state.selected ? 'true' : 'false');
    });
  }

  // ── Edge info card ────────────────────────────────────────────────────
  var edgeInfo = document.getElementById('cpEdgeInfo');
  function ciText(lo, hi) {
    if (fin(lo) === null || fin(hi) === null) return '';
    return '95% CI ' + F.odds(lo) + ' to ' + F.odds(hi);
  }
  function arrowHtml(e) {
    if (!e.dir) return '';
    return '<p><b>Arrow ' + esc(e.dir.from) + ' &rarr; ' + esc(e.dir.to) + '</b>: ' + esc(e.dir.from) + ' wins more when drawn without ' +
      esc(e.dir.to) + ' than the other way round' + (e.dir.z !== null ? ' (z = ' + e.dir.z.toFixed(1) + ')' : '') +
      (e.kind === 'coplay'
        ? '. On a played-together line the arrow only shows which card wins more on its own; it does not set roles.</p>'
        : ', so it is the payoff and ' + esc(e.dir.to) + ' the engine it rewards.</p>');
  }
  function edgeHtml(e) {
    var r = e.raw, html = '<strong>' + esc(e.a) + ' + ' + esc(e.b) + '</strong>';
    if (e.kind === 'synergy') {
      var label = e.tier === 'verified' ? (V3 ? 'Verified synergy' : 'Synergy link') : 'Tentative synergy';
      html += ' <span class="cp-tag">' + label + '</span>';
      html += '<p><b>' + F.odds(e.lam) + ' odds</b> of winning when both are in hand, compared with what each card does on its own' +
        (ciText(r.ci_low, r.ci_high) ? ' (' + ciText(r.ci_low, r.ci_high) + ')' : '') + '.</p>';
      var bits = [];
      if (fin(r.pair_win_rate) !== null) bits.push(F.pct1(r.pair_win_rate) + ' win rate together');
      if (fin(r.pair_games) !== null) bits.push(F.num(r.pair_games) + ' games');
      if (fin(r.q_value) !== null) bits.push('q = ' + (r.q_value < 0.001 ? '<0.001' : r.q_value.toFixed(3)));
      if (bits.length) html += '<p>' + bits.join(' &middot; ') + '</p>';
      if (V3) html += '<p>Games-in-hand data, adjusted for game length and play/draw; false discoveries controlled' + (e.tier === 'tentative' ? ' at a looser level, so treat it as a lead.' : '.') + '</p>';
      html += arrowHtml(e);
    } else if (e.kind === 'coplay') {
      var lift = coplayLiftText(r);
      html += ' <span class="cp-tag">Played together</span><p>In ' + F.num(r.deck_count) + ' decks of this archetype' +
        (lift ? ', ' + lift : '') + '. A drafting signal, not a win-rate claim.</p>';
      html += arrowHtml(e);
    } else {
      html += ' <span class="cp-tag">Drafted together</span><p>Pair pick score ' + (fin(r.pick_score) !== null ? r.pick_score.toFixed(1) + ' / 10' : '–') +
        (fin(r.draft_pair_events) !== null ? ' &middot; ' + F.num(r.draft_pair_events) + ' drafts with both' : '') +
        (fin(r.pair_win_rate) !== null ? ' &middot; ' + F.pct1(r.pair_win_rate) + ' win rate over ' + F.num(r.pair_games) + ' games' : '') + '.</p>';
    }
    return html;
  }
  function showEdge(e) {
    state.activeEdge = e;
    edgeEls.forEach(function (x) { x.el.classList.toggle('is-active', x.e === e); });
    if (!e) { edgeInfo.hidden = true; edgeInfo.innerHTML = ''; return; }
    edgeInfo.innerHTML = '<button type="button" class="cp-btn icon cp-x" aria-label="Close link details">&times;</button>' + edgeHtml(e);
    edgeInfo.hidden = false;
    edgeInfo.querySelector('.cp-x').addEventListener('click', function () { showEdge(null); });
  }

  // ── Legend: one row per encoding actually drawn ───────────────────────
  function renderLegend() {
    var rows = [], items = [];
    function add(sample, short, long) {   // short = null: explained only under "What the marks mean"
      if (short !== null) items.push('<span><svg aria-hidden="true" viewBox="0 0 26 14">' + sample.small + '</svg>' + short + '</span>');
      rows.push('<div class="cp-legend-row"><svg aria-hidden="true" viewBox="0 0 46 20">' + sample.big + '</svg><div>' + long + '</div></div>');
    }
    function line(cls, w, extra) {
      return { small: '<line x1="1" y1="7" x2="25" y2="7" class="' + cls + '" stroke-width="' + w + '" ' + (extra || '') + ' />',
               big: '<line x1="3" y1="10" x2="43" y2="10" class="' + cls + '" stroke-width="' + w + '" ' + (extra || '') + ' />' };
    }
    var sizes = { small: '<circle cx="4" cy="7" r="2.5" class="mf-C" /><circle cx="12" cy="7" r="4" class="mf-C" /><circle cx="22" cy="7" r="5.5" class="mf-C" />',
                  big: '<circle cx="8" cy="10" r="4" class="mf-C" /><circle cx="22" cy="10" r="6.5" class="mf-C" /><circle cx="38" cy="10" r="9" class="mf-C" />' };
    if (state.view === 'core' || state.view === 'picks') {
      add({ small: '<ellipse cx="13" cy="7" rx="12" ry="6" class="ring-band periphery" /><ellipse cx="13" cy="7" rx="8" ry="4" class="ring-band support" /><ellipse cx="13" cy="7" rx="4" ry="2" class="ring-band core" /><ellipse cx="13" cy="7" rx="12" ry="6" class="ring-line" />',
            big: '<ellipse cx="23" cy="10" rx="21" ry="9" class="ring-band periphery" /><ellipse cx="23" cy="10" rx="14" ry="6" class="ring-band support" /><ellipse cx="23" cy="10" rx="7" ry="3" class="ring-band core" /><ellipse cx="23" cy="10" rx="21" ry="9" class="ring-line" />' },
          'core &rarr; periphery', '<b>Core &rarr; Support &rarr; Periphery</b>: how central a card is to the deck (played in many of these decks, characteristic of them, connected to the rest).');
    }
    if (state.view === 'core') add(sizes, 'size = coreness', 'Bigger disc = higher coreness. Fill = the card’s colour identity (split for two colours, gold for three or more).');
    else if (state.view === 'synergy') add(sizes, 'size = synergy partners', 'Bigger disc = more synergy partners. Fill = colour identity.');
    else add(sizes, 'size = pick score', 'Bigger disc = higher pick score (0–10). Faded = no measurable draft win lift in this archetype.');
    if (state.view === 'synergy' && view.hulls.length) {
      add({ small: '<rect x="1" y="1" width="24" height="12" rx="5" class="hull" />', big: '<rect x="3" y="2" width="40" height="16" rx="7" class="hull" />' },
          'card group', 'Shaded area = a group of cards that tend to appear together.');
    }
    if (nodes.some(function (n) { return n.bomb; })) {
      add({ small: '<path d="' + starPath(13, 7, 6) + '" class="bomb-mark" />', big: '<path d="' + starPath(23, 10, 8) + '" class="bomb-mark" />' },
          'bomb', '<b>Bomb</b>: strong on its own. Bombs that are part of the deck keep their ring; those otherwise on its edge sit in the island beside the rings.');
    }
    if (state.view !== 'picks' && view.edges.some(function (e) { return e.dir; })) {
      add({ small: '<line x1="1" y1="7" x2="17" y2="7" class="cp-syn" stroke-width="2" /><path d="M25 7L16 2.5L16 11.5Z" class="cp-arrow syn" />',
            big: '<line x1="3" y1="10" x2="33" y2="10" class="cp-syn" stroke-width="2.5" /><path d="M43 10L31 4L31 16Z" class="cp-arrow syn" />' },
          'payoff &rarr; engine', '<b>Arrow</b>: points from the payoff (the card that wins more when drawn) to the engine it rewards. Drawn only where that difference is significant; the synergy itself has no direction.' +
          (view.edges.some(function (e) { return e.kind === 'coplay' && e.dir; }) ? ' Arrows on played-together lines show which card wins more on its own; they do not set roles.' : ''));
    }
    if (showRoles() && anyRole) {
      // roles need directed synergy edges, which are always drawn here: the arrow item covers the strip
      add({ big: '<circle cx="11" cy="10" r="6" class="mf-C" /><circle cx="11" cy="10" r="8.5" class="role-ring payoff" /><circle cx="34" cy="10" r="6" class="mf-C" /><circle cx="34" cy="10" r="8.5" class="role-ring enabler" />' },
          null, '<b class="role-txt payoff">Payoff</b> ring: most of its synergy arrows point out of it, so it is what the deck converts into wins. <b class="role-txt enabler">Engine</b> ring: most of its synergy arrows point into it; its partners win more than it does, it sets them up. Roles come from synergy arrows only.');
    }
    if (state.view === 'picks') {
      if (view.edges.length) add(line('cp-pickpair', 3, 'stroke-opacity=".7"'), 'drafted together', 'Often drafted together, and the pair wins.');
    } else {
      var anyV = view.edges.some(function (e) { return e.kind === 'synergy' && e.tier === 'verified'; });
      var anyT = view.edges.some(function (e) { return e.kind === 'synergy' && e.tier === 'tentative'; });
      if (anyV) add(line('cp-syn', 4), V3 ? 'verified synergy' : 'synergy', (V3 ? '<b>Verified synergy</b>: the pair wins more often when both are in hand than the two cards predict apart.' : '<b>Synergy link</b> (older analysis).') + ' Thicker = bigger effect; more opaque = more precise estimate.');
      if (anyT) add(line('cp-syn tentative', 2, 'stroke-opacity=".6"'), 'tentative', '<b>Tentative synergy</b>: same test, weaker evidence. Treat as a lead.');
      if (!anyV && !anyT) items.push('<span>no synergy cleared the evidence bar</span>');
      if (view.edges.some(function (e) { return e.kind === 'coplay'; })) {
        add(line('cp-coplay', 1.5, 'style="stroke-width:1.5px"'), 'played together', '<b>Played together</b> in many decks of this archetype: a drafting signal, not a win-rate claim.');
      }
    }
    document.getElementById('cpLegendItems').innerHTML = items.join('');
    document.getElementById('cpLegendBody').innerHTML = rows.join('');
  }

  // ── Side panel ────────────────────────────────────────────────────────
  var sideView = document.getElementById('cpSideView');
  function rowButton(n, mainExtra, valHtml, sub) {
    var r = n.raw;
    var tag = '';
    if (n.kind === 'signature') tag = '<span class="cp-tag sig">signature</span>';
    else if (n.kind === 'staple') tag = '<span class="cp-tag">staple</span>';
    if (n.role) tag += '<span class="cp-tag ' + n.role + '">' + ROLE_NAME[n.role] + '</span>';
    return '<li><button type="button" class="cp-row" data-id="' + esc(n.id) + '" aria-label="' + esc(nodeAria(n)) + '. Open card details">' +
      M.pipsHtml(r.color_identity) +
      // the name truncates on its own so long names (DFCs, rooms) keep their tags and bomb star visible
      '<span style="min-width:0"><span class="cp-row-name has-tags"><span class="cp-row-label">' + esc(n.label) + '</span>' + tag + (n.bomb ? '<span class="cp-star" aria-hidden="true">&#9733;</span>' : '') + '</span>' +
      (sub ? '<span class="cp-row-sub">' + sub + '</span>' : '') + (mainExtra || '') + '</span>' +
      '<span class="cp-row-val">' + valHtml + '</span></button></li>';
  }
  function meter(x) { return '<span class="cp-meter" aria-hidden="true"><i style="width:' + Math.round(100 * clamp(x || 0, 0, 1)) + '%"></i></span>'; }
  function lockedNote() {
    return '<div class="cp-note"><b>Members-only format.</b> This set is behind the paywall; the archetype list stays public.</div>';
  }
  function premiumNote(what) { return '<div class="cp-note"><b>Premium feature.</b> ' + esc(what) + ' is part of the premium version.</div>'; }
  function synergySentence() {
    var ss = seg.synergy_summary || {};
    var tested = fin(ss.valid_pairs) !== null ? ss.valid_pairs : fin(ss.tested_pairs);
    if (!V3) return synEdges.length + ' synergy links (older analysis; not individually verified).';
    var t = nVerified + ' verified and ' + nTentative + ' tentative synerg' + (nVerified + nTentative === 1 ? 'y' : 'ies');
    if (tested !== null) t += ' among ' + F.num(tested) + ' testable pairs';
    return t + ' (games-in-hand data, adjusted for game length and play/draw; false discoveries controlled).';
  }
  function renderSide() {
    if (access.formatLocked) { sideView.innerHTML = lockedNote(); return; }
    var html = '';
    if (state.view === 'core') {
      var core = byCoreness.filter(function (n) { return n.ring === 'core'; });
      var bombs = nodes.filter(function (n) { return n.bomb; }).sort(function (a, b) { return (fin(b.raw.bomb_lift) || 0) - (fin(a.raw.bomb_lift) || 0); });
      var support = byCoreness.filter(function (n) { return n.ring === 'support'; });
      var periph = byCoreness.filter(function (n) { return ringOf(n) === 'periphery'; });
      html += '<h2>The core of this deck</h2><p class="cp-h2-note">% of decks playing it &middot; bar = coreness</p>';
      if (seg.coreness_diffuse) html += '<div class="cp-note">This archetype has no tight core: few cards are both widely played and characteristic of it.</div>';
      if (legacyRings) html += '<div class="cp-note">Older analysis: rings are ranked by share of decks.</div>';
      html += '<ol class="cp-list" id="cpCoreList">' + core.map(function (n) {
        return rowButton(n, meter(n.coreness), F.pct0(n.play) + '<small>of decks</small>');
      }).join('') + '</ol>';
      if (bombs.length) {
        html += '<h2>Bombs &ndash; strong on their own</h2><p class="cp-h2-note">Win-rate lift when in hand vs a typical card of this deck &middot; chance it beats a typical card</p>';
        html += '<ol class="cp-list">' + bombs.map(function (n) {
          var r = n.raw, p = fin(r.bomb_probability);
          var sub = (hasGames && fin(r.win_rate) !== null ? 'wins ' + F.pct1(r.win_rate) + ' when in hand' : '') ;
          return rowButton(n, '', (fin(r.bomb_lift) !== null ? F.pp1(r.bomb_lift) : '–') + '<small>' + (p !== null ? (p >= 0.995 ? '&gt;99%' : F.pct0(p)) : '') + '</small>', sub);
        }).join('') + '</ol>';
      }
      if (support.length) {
        html += '<h2>Support</h2><ol class="cp-list">' + support.map(function (n) {
          return rowButton(n, meter(n.coreness), F.pct0(n.play) + '<small>of decks</small>');
        }).join('') + '</ol>';
      }
      if (periph.length) {
        html += '<details class="cp-more-inline"><summary class="cp-btn" style="margin-top:14px">Periphery &middot; ' + periph.length + ' cards</summary><ol class="cp-list" style="margin-top:6px">' + periph.map(function (n) {
          return rowButton(n, meter(n.coreness), F.pct0(n.play) + '<small>of decks</small>');
        }).join('') + '</ol></details>';
      }
      html += '<h2>Synergy evidence</h2><p class="cp-h2-note" style="margin:0">' + esc(synergySentence()) + '</p>';
    } else if (state.view === 'synergy') {
      html += '<h2>Synergies in this deck</h2><p class="cp-h2-note">' + esc(synergySentence()) + '</p>';
      if (access.premiumDrawer.bestPairSynergies) {
        html += premiumNote('The pair synergy list');
      } else if (!synEdges.length) {
        html += '<div class="cp-note">No pair cleared the false-discovery bar. The cards in this archetype mostly win on their own; see the Core view for what the deck is built from.</div>';
      } else {
        ['verified', 'tentative'].forEach(function (tier) {
          var list = synEdges.filter(function (e) { return e.tier === tier; });
          if (!list.length) return;
          html += '<h2>' + (tier === 'verified' ? (V3 ? 'Verified' : 'Synergy links') : 'Tentative') + '</h2><ol class="cp-list">' + list.map(function (e) {
            var r = e.raw, sub = [ciText(r.ci_low, r.ci_high), fin(r.pair_games) !== null ? F.num(r.pair_games) + ' games together' : ''].filter(Boolean).join(' &middot; ');
            return '<li><button type="button" class="cp-row" data-edge="' + esc(pairKey(e.a, e.b)) + '">' +
              '<span class="cp-star" aria-hidden="true" style="color:rgb(var(--edge))">&#9135;</span>' +
              '<span style="min-width:0"><span class="cp-row-name wrap">' + (e.dir
                ? esc(e.dir.from) + ' <span aria-hidden="true">&rarr;</span><span class="sr-only">(payoff) with engine</span> ' + esc(e.dir.to)
                : esc(e.a) + ' + ' + esc(e.b)) + '</span><span class="cp-row-sub">' + sub + '</span></span>' +
              '<span class="cp-row-val">' + F.odds(e.lam) + '<small>odds</small></span></button></li>';
          }).join('') + '</ol>';
        });
      }
    } else {
      html += '<h2>Best picks for this deck</h2><p class="cp-h2-note">Pick score (0&ndash;10) blends how much the card raises draft win rate in this archetype with how contested it is.</p>';
      html += '<div class="cp-chips" role="group" aria-label="Rarity">' + ['all', 'common', 'uncommon', 'rare', 'mythic'].map(function (r) {
        return '<button type="button" class="cp-btn" data-rarity="' + r + '" aria-pressed="' + (state.pickRarity === r) + '">' + r.charAt(0).toUpperCase() + r.slice(1) + '</button>';
      }).join('') + '</div>';
      var rows = pickRows();
      if (!rows.length) html += '<div class="cp-note">No ' + (state.pickRarity === 'all' ? '' : esc(state.pickRarity) + ' ') + 'cards with a measurable draft win lift.</div>';
      html += '<ol class="cp-list">' + rows.map(function (row) {
        var n = byId[row.card];
        var sub = [esc(row.rarity), fin(row.draft_win_lift) !== null ? F.pp1(row.draft_win_lift) + ' draft win rate' : '', fin(row.alsa) !== null ? 'last seen ~pick ' + row.alsa.toFixed(1) : ''].filter(Boolean).join(' &middot; ');
        if (n) return rowButton(n, '', (fin(row.pick_priority_score) !== null ? row.pick_priority_score.toFixed(1) : '–') + '<small>/ 10</small>', sub);
        return '<li><div class="cp-row" style="cursor:default"><span></span><span><span class="cp-row-name">' + esc(row.card) + '</span><span class="cp-row-sub">' + sub + '</span></span><span class="cp-row-val">' + (fin(row.pick_priority_score) !== null ? row.pick_priority_score.toFixed(1) : '–') + '</span></div></li>';
      }).join('') + '</ol>';
    }
    sideView.innerHTML = html;
    markSelected();
  }
  function pickRows() {
    var rows = [];
    var pbr = seg.pick_by_rarity || {};
    Object.keys(pbr).forEach(function (rarity) {
      (pbr[rarity] || []).forEach(function (row) {
        if (!row || !row.card) return;
        var lift = fin(row.draft_win_lift);
        if (lift === null || lift <= 0) return;
        var r = Object.assign({ rarity: rarity }, row), n = byId[row.card];
        // node fields are authoritative (v3: ALSA is 1-based and pack-rotation corrected)
        if (n && fin(n.raw.alsa) !== null) r.alsa = n.raw.alsa;
        rows.push(r);
      });
    });
    if (!rows.length) {
      nodes.forEach(function (n) {
        var r = n.raw;
        if ((fin(r.draft_win_lift) || 0) > 0) rows.push({ card: n.id, rarity: r.rarity || '', pick_priority_score: r.pick_priority_score, draft_win_lift: r.draft_win_lift, alsa: r.alsa });
      });
    }
    if (state.pickRarity !== 'all') rows = rows.filter(function (r) { return r.rarity === state.pickRarity; });
    rows.sort(function (a, b) { return ((fin(b.pick_priority_score) || 0) - (fin(a.pick_priority_score) || 0)) || ((fin(b.draft_win_lift) || 0) - (fin(a.draft_win_lift) || 0)); });
    return rows.slice(0, state.pickRarity === 'all' ? 12 : 20);
  }

  // "More about this archetype": the old drawer contents, collapsed.
  function renderMore() {
    var el = document.getElementById('cpMore');
    if (access.formatLocked) { el.innerHTML = ''; return; }
    function sec(title, body, open) { return '<details' + (open ? ' open' : '') + '><summary>' + title + '</summary>' + body + '</details>'; }
    function table(rows) { return rows.length ? '<div class="cp-table">' + rows.join('') + '</div>' : '<p class="muted">Nothing cleared the support threshold.</p>'; }
    function tr(left, sub, right) { return '<div class="tr"><div>' + left + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div><div class="num">' + right + '</div></div>'; }
    function cardBtn(name) { return byId[name] ? '<button type="button" class="cp-linkbtn" data-card="' + esc(name) + '">' + esc(name) + '</button>' : esc(name); }
    var html = '<h2>More about this archetype</h2>';
    html += sec('Signposts &ndash; what defines the deck', table((seg.signposts || []).map(function (r) {
      return tr(cardBtn(r.card), F.pct0(fin(r.play_rate) !== null ? r.play_rate : r.cluster_prevalence) + ' of decks', fin(r.lift) !== null ? r.lift.toFixed(1) + '&times; lift' : '');
    })));
    html += sec('Build-around detector', access.premiumDrawer.buildAroundDetector ? premiumNote('The build-around detector') : table((seg.build_arounds || []).map(function (r) {
      var shell = fin(r.shell_dependence_score) !== null ? r.shell_dependence_score : fin(r.build_around_score);
      return tr(cardBtn(r.card), 'with support ' + F.pct1(r.supported_win_rate) + ' vs alone ' + F.pct1(r.isolated_win_rate) +
        (fin(r.supported_games) !== null ? ' &middot; ' + F.num(r.supported_games) + ' games' : ''), shell !== null ? shell.toFixed(1) + ' / 10' : '');
    })));
    html += sec('Weaker together (anti-synergies)', table((seg.top_anti_pairs || []).map(function (r) {
      return tr(esc((r.cards || []).join(' + ')), F.pct1(r.pair_win_rate) + ' together &middot; ' + F.num(r.pair_games) + ' games', F.odds(r.synergy_delta_logit) + ' odds');
    })) + '<p class="cp-h2-note">Point estimates, not significance-tested.</p>');
    html += sec('Three-card motifs', access.premiumDrawer.tripletMotifs ? premiumNote('Triplet motifs') : table((seg.triplets || []).map(function (r) {
      return tr(esc((r.cards || []).join(' + ')), F.pct1(r.win_rate) + ' win rate &middot; ' + F.num(r.games) + ' games', fin(r.quality) !== null ? r.quality.toFixed(2) : '');
    })));
    html += sec('Drafted together', access.premiumDrawer.bestPairSynergies ? premiumNote('Draft-supported pairs') : table((seg.top_pick_pairs || []).map(function (r) {
      return tr(esc((r.cards || []).join(' + ')), F.num(r.draft_pair_events) + ' drafts with both &middot; ' + F.num(r.pair_games) + ' games', fin(r.pick_score) !== null ? r.pick_score.toFixed(1) + ' / 10' : '');
    })));
    html += sec('Card groups (communities)', access.premiumDrawer.communities ? premiumNote('Card groups') : table((seg.communities || []).filter(function (r) { return (r.size || 0) > 1; }).map(function (r) {
      return tr('Group ' + esc(r.community_id), esc((r.top_cards || []).join(', ')), esc(r.size) + ' cards');
    })));
    var dm = fin(seg.draft_match_win_rate);
    html += '<p class="cp-h2-note" style="margin-top:12px">' + F.num(seg.deck_count) + ' decks &middot; ' + F.num(seg.games) + (hasGames ? ' games' : ' matches') +
      (dm !== null ? ' &middot; draft match win rate ' + F.pct1(dm) : '') + (seg.color_signature ? ' &middot; colours ' + esc(seg.color_signature) : '') + '</p>';
    el.innerHTML = html;
  }

  // ── Card spotlight (dialog) ───────────────────────────────────────────
  var spot = document.getElementById('cpSpot'), spotBody = document.getElementById('cpSpotBody');
  var spotClose = document.getElementById('cpSpotClose'), spotOpener = null;
  function kpi(label, value, small) { return '<div class="cp-kpi"><dt>' + label + '</dt><dd>' + value + (small ? '<small>' + small + '</small>' : '') + '</dd></div>'; }
  function scryImg(name) { return 'https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(name) + '&format=image&version=normal'; }
  function spotHtml(n) {
    var r = n.raw, html = '';
    var ring = inIsland(n) ? 'Bomb' : RING_NAME[ringOf(n)] + (n.bomb ? ' &middot; bomb' : '');
    var kind = n.kind ? ' &middot; ' + n.kind : '';
    html += '<div class="cp-spot-grid"><figure class="cp-shot"><img src="' + esc(scryImg(n.id)) + '" alt="' + esc(n.label) + ' card image" loading="lazy" decoding="async" width="488" height="680" />' +
      '<figcaption><a href="https://scryfall.com/search?q=' + encodeURIComponent('!"' + n.id + '"') + '" target="_blank" rel="noopener">Open on Scryfall</a></figcaption></figure><div class="cp-spot-body">';
    html += '<h2 id="cpSpotTitle">' + esc(n.label) + '</h2>';
    html += '<div class="cp-spot-badges">' + M.pipsHtml(r.color_identity, true) + '<span class="cp-tag' + (n.bomb ? ' bomb' : (n.kind === 'signature' ? ' sig' : '')) + '">' + ring + kind + '</span>' +
      (r.rarity ? '<span>' + esc(r.rarity) + '</span>' : '') + '<span>in ' + esc(archName) + '</span></div>';
    var lead = 'Played in <b>' + F.pct0(n.play) + '</b> of ' + esc(archName) + ' decks.';
    var wr = fin(r.win_rate), sd = fin(r.standalone_delta);
    if (sd === null && wr !== null && baseWR !== null) sd = wr - baseWR;
    if (hasGames && wr !== null) {
      lead += ' When it is in hand the deck wins <b>' + F.pct1(wr) + '</b>' + (fin(r.draw_games) !== null ? ' of ' + F.num(r.draw_games) + ' games' : '') +
        (sd !== null && baseWR !== null ? ', ' + F.pp1(sd) + ' vs the archetype’s ' + F.pct1(baseWR) : '') + '.';
    }
    html += '<p class="cp-spot-lead">' + lead + '</p>';
    var m = fin(r.coreness_membership), c = fin(r.coreness_connectivity);
    html += '<p class="cp-explain muted" style="margin:6px 0 0;font-size:13px"><b>Coreness ' + (n.coreness || 0).toFixed(2) + '</b>: how central the card is here. ' +
      (m !== null && c !== null ? 'It combines <b>membership ' + m.toFixed(2) + '</b> (played in many of these decks and characteristic of them) with <b>connectivity ' + c.toFixed(2) + '</b> (played together with, and synergising with, the rest of the deck).' : 'Ranked by share of decks (older analysis).') + '</p>';
    // what the core_kind tag in the badge means (payload/assemble.py _assign_core_kinds)
    if (n.kind) html += '<p class="cp-explain muted" style="margin:6px 0 0;font-size:13px">' + (n.kind === 'signature'
      ? '<b>Signature card</b>: played in at least 15% of these decks and in at most one other archetype at that rate.'
      : '<b>Staple</b>: played in at least 25% of these decks and in at least 15% of the decks of three or more archetypes.') + '</p>';
    if (n.bomb) {
      var bl = fin(r.bomb_lift), bp = fin(r.bomb_probability);
      html += '<div class="cp-note" style="margin-top:10px"><span class="cp-star">&#9733;</span> <b>Strong on its own.</b> ' +
        (bl !== null ? 'In hand it adds about <b>' + F.pp1(bl) + '</b> of win rate over a typical card of this deck (estimate shrunk across the set’s archetypes)' : 'Flagged as a bomb') +
        (bp !== null ? '; chance it beats a typical card of this deck: <b>' + (bp >= 0.995 ? '&gt;99%' : F.pct0(bp)) + '</b>.' : '.') + '</div>';
    }
    if (n.role) {
      // roles come from synergy arrows only: count this card's directed synergy edges on the page
      var fo = 0, fi = 0;
      synEdges.forEach(function (e) {
        if (!e.dir || (e.a !== n.id && e.b !== n.id)) return;
        if (e.dir.from === n.id) fo += 1; else fi += 1;
      });
      var tot = fo + fi;
      var why = n.role === 'payoff'
        ? 'it wins more when drawn than the partners it pairs with, so it is what the deck converts into wins.'
        : 'its partners win more when drawn than it does; it sets them up.';
      html += '<div class="cp-note" style="margin-top:10px"><b class="role-txt ' + n.role + '">' + (n.role === 'payoff' ? 'Payoff' : 'Engine') + '.</b> ' +
        (tot ? (n.role === 'payoff' ? fo + ' of its ' + tot + ' synergy arrows point out of it: ' : fi + ' of its ' + tot + ' synergy arrows point into it: ') + why
             : why.charAt(0).toUpperCase() + why.slice(1)) + '</div>';
    }
    html += '<dl class="cp-kpis">';
    html += kpi('In decks', F.pct0(n.play));
    if (hasGames && wr !== null) html += kpi('Win rate in hand', F.pct1(wr), sd !== null ? F.pp1(sd) + ' vs deck' : '');
    html += kpi('Coreness', (n.coreness || 0).toFixed(2), inIsland(n) ? 'bomb island' : RING_NAME[ringOf(n)] + ' ring');
    if (fin(r.pick_priority_score) !== null) html += kpi('Pick score', r.pick_priority_score.toFixed(1) + ' / 10');
    if (fin(r.pick_urgency_score) !== null) html += kpi('Pick urgency', r.pick_urgency_score.toFixed(1) + ' / 10', '10 = take it now');
    if (fin(r.alsa) !== null) html += kpi('Last seen at', 'pick ' + r.alsa.toFixed(1), 'average (ALSA)');
    if (fin(r.wheel_likelihood) !== null) html += kpi('Wheels', F.pct0(r.wheel_likelihood), 'chance a seen copy comes back');
    if (fin(r.draft_win_lift) !== null) html += kpi('Draft win lift', F.pp1(r.draft_win_lift), fin(r.draft_drafts) !== null ? F.num(r.draft_drafts) + ' drafts' : '');
    var shell = fin(r.shell_dependence_score) !== null ? r.shell_dependence_score : fin(r.build_around_score);
    if (shell !== null) html += kpi('Shell dependence', shell.toFixed(1) + ' / 10', r.is_build_around ? 'flagged build-around' : '');
    html += '</dl>';
    // verified synergies
    var syn = (r.top_synergies || []).slice(0, 5);
    html += '<section class="cp-spot-sec"><h3>Wins more with</h3>';
    if (syn.length) {
      if (V3) html += '<p class="cp-explain">These pairs win more often when both are in hand than their separate effects predict (games in hand, adjusted for game length and play/draw, false discoveries controlled).</p>';
      html += '<div class="cp-table">' + syn.map(function (row) {
        var lam = fin(row.synergy_logit) !== null ? row.synergy_logit : fin(row.synergy_delta_logit);
        var e = synByPair[pairKey(n.id, String(row.card))];
        var tierTag = e ? (e.tier === 'tentative' ? ' <span class="cp-tag">tentative</span>' : '') : '';
        // arrow of this pair, from this card's point of view
        if (e && e.dir) tierTag += e.dir.from === n.id ? ' <span class="cp-tag payoff">this card is the payoff</span>' : ' <span class="cp-tag enabler">this card is the engine</span>';
        var sub = [ciText(row.ci_low, row.ci_high), fin(row.pair_win_rate) !== null ? F.pct1(row.pair_win_rate) + ' together' : '', fin(row.pair_games) !== null ? F.num(row.pair_games) + ' games' : ''].filter(Boolean).join(' &middot; ');
        var name = byId[row.card] ? '<button type="button" class="cp-linkbtn" data-card="' + esc(row.card) + '">' + esc(row.card) + '</button>' : esc(row.card);
        return '<div class="tr"><div>' + name + tierTag + '<span class="sub">' + sub + '</span></div><div class="num">' + (lam !== null ? F.odds(lam) + ' odds' : '') + '</div></div>';
      }).join('') + '</div>';
    } else {
      html += '<p class="cp-explain">No verified synergy partner: the card is good on its own here, or there are not enough games to tell.</p>';
    }
    html += '</section>';
    var anti = (r.top_anti_synergies || []).slice(0, 4);
    if (anti.length) {
      html += '<section class="cp-spot-sec"><h3>Weaker with</h3><p class="cp-explain">Point estimates, not significance-tested.</p><div class="cp-table">' + anti.map(function (row) {
        var lam = fin(row.synergy_logit) !== null ? row.synergy_logit : fin(row.synergy_delta_logit);
        return '<div class="tr"><div>' + esc(row.card) + '<span class="sub">' + (fin(row.pair_games) !== null ? F.num(row.pair_games) + ' games' : '') + '</span></div><div class="num">' + (lam !== null ? F.odds(lam) + ' odds' : '') + '</div></div>';
      }).join('') + '</div></section>';
    }
    var cop = copEdges.filter(function (e) { return e.a === n.id || e.b === n.id; })
      .sort(function (x, y) { return (fin(y.raw.deck_count) || 0) - (fin(x.raw.deck_count) || 0); }).slice(0, 4);
    if (cop.length) {
      html += '<section class="cp-spot-sec"><h3>Played together most with</h3><p class="cp-explain">Decks of this archetype that play both: a drafting signal, not a win-rate claim.</p><div class="cp-table">' + cop.map(function (e) {
        var other = e.a === n.id ? e.b : e.a, lift = coplayLiftText(e.raw);
        return '<div class="tr"><div><button type="button" class="cp-linkbtn" data-card="' + esc(other) + '">' + esc(other) + '</button>' + (lift ? '<span class="sub">' + lift + '</span>' : '') + '</div><div class="num">' + F.num(e.raw.deck_count) + ' decks</div></div>';
      }).join('') + '</div></section>';
    }
    var others = (r.archetype_presence || []).filter(function (p) {
      return !(p.slug && p.slug === seg.slug) && !(p.slug === undefined && String(p.cluster_id) === String(seg.cluster_id)) && String(p.cluster_id) !== String(seg.cluster_id);
    });
    html += '<section class="cp-spot-sec"><h3>Also played in</h3>';
    if (others.length) {
      html += '<div class="cp-table">' + others.map(function (p) {
        var name = p.color_name || String(p.title || '').split('|')[0].trim() || 'Archetype';
        var href = (p.slug && hrefBySlug[p.slug]) || hrefById[String(p.cluster_id)];
        var link = href ? '<a href="' + esc(href) + '#card=' + encodeURIComponent(n.id) + '">' + esc(name) + '</a>' : esc(name);
        return '<div class="tr"><div>' + link + '</div><div class="num">' + F.pct0(p.deck_prevalence) + ' of its decks</div></div>';
      }).join('') + '</div>';
    } else {
      html += '<p class="cp-explain">Only in this archetype.</p>';
    }
    html += '</section></div></div>';
    return html;
  }
  function openSpot(id, opts) {
    var n = byId[id];
    if (!n) return;
    if (spot.hidden) spotOpener = (opts && opts.opener) || document.activeElement;
    state.selected = id;
    markSelected();
    spotBody.innerHTML = spotHtml(n);
    var img = spotBody.querySelector('img');
    if (img) img.addEventListener('error', function () {
      var d = document.createElement('div');
      d.className = 'cp-noimg';
      d.textContent = 'Card image unavailable';
      img.replaceWith(d);
    });
    spot.hidden = false;
    document.body.classList.add('cp-modal-open');
    spot.scrollTop = 0;
    spotClose.focus();
    if (!(opts && opts.fromHash)) {
      try { history.replaceState(null, '', '#card=' + encodeURIComponent(id)); } catch (e) { /* file:// */ }
    }
  }
  function closeSpot() {
    if (spot.hidden) return;
    spot.hidden = true;
    document.body.classList.remove('cp-modal-open');
    state.selected = null;
    markSelected();
    if (location.hash.indexOf('#card=') === 0) {
      var keep = state.view === 'core' ? '' : '#view=' + state.view;   // the current view stays linkable
      try { history.replaceState(null, '', location.pathname + location.search + keep); } catch (e) { /* ignore */ }
    }
    var back = spotOpener;
    spotOpener = null;
    if (back && back.focus && document.contains(back)) back.focus();
  }
  spotClose.addEventListener('click', closeSpot);
  spot.addEventListener('click', function (evt) { if (evt.target === spot) closeSpot(); });
  spot.addEventListener('keydown', function (evt) {
    if (evt.key === 'Escape') { evt.preventDefault(); closeSpot(); return; }
    if (evt.key !== 'Tab') return;
    var f = Array.prototype.filter.call(spot.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])'), function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    if (evt.shiftKey && document.activeElement === f[0]) { evt.preventDefault(); f[f.length - 1].focus(); }
    else if (!evt.shiftKey && document.activeElement === f[f.length - 1]) { evt.preventDefault(); f[0].focus(); }
  });
  spotBody.addEventListener('click', function (evt) {
    var b = evt.target.closest('[data-card]');
    if (b) openSpot(b.getAttribute('data-card'));
  });
  function openFromHash() {
    var h = location.hash || '';
    if (h.indexOf('#card=') !== 0) return;
    var name;
    try { name = decodeURIComponent(h.slice(6)); } catch (e) { return; }
    if (byId[name]) openSpot(name, { fromHash: true });
  }
  window.addEventListener('hashchange', function () {
    var hv = /^#view=(core|synergy|picks)$/.exec(location.hash || '');
    if (hv) { closeSpot(); setView(hv[1]); return; }
    openFromHash();
  });

  // ── Side panel / more-panel interactions (delegated) ──────────────────
  function sideClick(evt) {
    var row = evt.target.closest('[data-id]');
    if (row && row.classList.contains('cp-row')) { openSpot(row.getAttribute('data-id'), { opener: row }); return; }
    var card = evt.target.closest('[data-card]');
    if (card) { openSpot(card.getAttribute('data-card'), { opener: card }); return; }
    var er = evt.target.closest('[data-edge]');
    if (er) {
      var e = synByPair[er.getAttribute('data-edge')];
      if (e) { showEdge(e); setHover(null); applyFocusEdge(e); }
      return;
    }
    var rb = evt.target.closest('[data-rarity]');
    if (rb) { state.pickRarity = rb.getAttribute('data-rarity'); renderSide(); }
  }
  function applyFocusEdge(e) {
    Object.keys(nodeEls).forEach(function (k) { nodeEls[k].classList.toggle('dim', k !== e.a && k !== e.b); });
    edgeEls.forEach(function (x) { x.el.classList.toggle('dim', x.e !== e); });
    Object.keys(labelEls).forEach(function (k) { labelEls[k].classList.toggle('dim', k !== e.a && k !== e.b); });
  }
  document.getElementById('cpSide').addEventListener('click', sideClick);
  document.getElementById('cpSide').addEventListener('pointerover', function (evt) {
    if (evt.pointerType !== 'mouse') return;
    var row = evt.target.closest('.cp-row[data-id]');
    setHover(row ? row.getAttribute('data-id') : null);
  });
  document.getElementById('cpSide').addEventListener('pointerleave', function () { setHover(null); });
  document.getElementById('cpSide').addEventListener('focusin', function (evt) {
    var row = evt.target.closest('.cp-row[data-id]');
    if (row) setHover(row.getAttribute('data-id'));
  });

  // ── Graph pointer interaction: click, hover, pan, pinch, wheel, drag ──
  var pointers = Object.create(null), gesture = null, suppressClick = false;
  function nodeFromTarget(t) { var g = t && t.closest ? t.closest('.cp-node') : null; return g ? g.getAttribute('data-id') : null; }
  function edgeFromTarget(t) { var g = t && t.closest ? t.closest('.cp-edge') : null; return g ? g._edge : null; }
  svg.addEventListener('pointerdown', function (evt) {
    if (evt.button !== undefined && evt.button !== 0) return;
    var p = screenPoint(evt);
    pointers[evt.pointerId] = p;
    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      gesture = { type: 'pinch', d0: hypot(a.x - b.x, a.y - b.y) || 1, s0: cam.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: { s: cam.s, tx: cam.tx, ty: cam.ty } };
      return;
    }
    var nodeId = nodeFromTarget(evt.target);
    // resolve the edge now: after setPointerCapture the pointerup target is the <svg> itself
    gesture = { type: nodeId ? 'node' : 'pan', id: nodeId, edge: nodeId ? null : edgeFromTarget(evt.target),
                start: p, cam0: { s: cam.s, tx: cam.tx, ty: cam.ty }, moved: false, pointerType: evt.pointerType };
    try { svg.setPointerCapture(evt.pointerId); } catch (e) { /* ignore */ }
  });
  svg.addEventListener('pointermove', function (evt) {
    var p = screenPoint(evt);
    if (pointers[evt.pointerId]) pointers[evt.pointerId] = p;
    if (!gesture) {
      if (evt.pointerType === 'mouse') setHover(nodeFromTarget(evt.target));
      return;
    }
    if (gesture.type === 'pinch') {
      var ids = Object.keys(pointers);
      if (ids.length < 2) return;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var d = hypot(a.x - b.x, a.y - b.y) || 1, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      var s1 = clamp(gesture.s0 * d / gesture.d0, fitCam.s * 0.6, fitCam.s * 8);
      var ux = (gesture.mid.x - gesture.cam0.tx) / gesture.cam0.s, uy = (gesture.mid.y - gesture.cam0.ty) / gesture.cam0.s;
      cam.s = s1; cam.tx = mid.x - ux * s1; cam.ty = mid.y - uy * s1;
      applyCam(); scheduleLabels();
      suppressClick = true;
      return;
    }
    var dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (!gesture.moved && hypot(dx, dy) > 5) {
      gesture.moved = true;
      if (gesture.type === 'pan') svg.classList.add('is-panning');
    }
    if (!gesture.moved) return;
    if (gesture.type === 'pan' || (gesture.type === 'node' && (gesture.pointerType !== 'mouse' || !canDrag(gesture.id)))) {
      cam.tx = gesture.cam0.tx + dx; cam.ty = gesture.cam0.ty + dy;
      applyCam(); scheduleLabels();
      return;
    }
    // drag a card along its ring (Core view): only its angle changes
    var n = byId[gesture.id], u = toUser(p), q = Tinv(u.x, u.y);
    thetaOverride[n.id] = Math.atan2(q[1] - CY, (q[0] - CX) / ASP);
    var lp = layoutPos(n), v = T(lp[0], lp[1]);
    n.vx = v[0]; n.vy = v[1];
    nodeEls[n.id].setAttribute('transform', 'translate(' + n.vx.toFixed(2) + ' ' + n.vy.toFixed(2) + ')');
    edgeEls.forEach(function (x) { if (x.e.a === n.id || x.e.b === n.id) positionEdge(x); });
    gesture.dragged = true;
    scheduleLabels();
  });
  function canDrag(id) { return state.view === 'core' && id && byId[id] && !inIsland(byId[id]); }
  function endPointer(evt) {
    delete pointers[evt.pointerId];
    try { svg.releasePointerCapture(evt.pointerId); } catch (e) { /* ignore */ }
    if (!gesture) return;
    if (gesture.type === 'pinch') { if (!Object.keys(pointers).length) gesture = null; return; }
    var g = gesture;
    gesture = null;
    svg.classList.remove('is-panning');
    if (evt.type === 'pointercancel') return;
    if (g.dragged) { persistLayout(); return; }
    if (g.moved || suppressClick) { suppressClick = false; return; }
    if (g.type === 'node') {
      openSpot(g.id, { opener: nodeEls[g.id] });
    } else {
      var e = g.edge || edgeFromTarget(evt.target);
      if (e) { showEdge(e); applyFocusEdge(e); }
      else { showEdge(null); setHover(null); applyFocus(null); }
    }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', function (evt) { if (evt.pointerType === 'mouse' && !gesture) setHover(null); });
  svg.addEventListener('wheel', function (evt) {
    // stacked layout: a plain wheel scrolls the page; ctrl+wheel / trackpad pinch zooms the map
    if (!evt.ctrlKey && window.matchMedia('(max-width: 900px)').matches) return;
    evt.preventDefault();
    var p = screenPoint(evt);
    zoomAt(Math.exp(-clamp(evt.deltaY, -120, 120) * 0.0022), p.x, p.y);
  }, { passive: false });
  svg.addEventListener('dblclick', function (evt) {
    if (nodeFromTarget(evt.target)) return;
    var p = screenPoint(evt);
    zoomAt(1.6, p.x, p.y);
  });
  svg.addEventListener('keydown', function (evt) {
    var id = nodeFromTarget(evt.target);
    if (id && (evt.key === 'Enter' || evt.key === ' ')) { evt.preventDefault(); openSpot(id, { opener: evt.target.closest('.cp-node') }); }
  });
  svg.addEventListener('focusin', function (evt) { var id = nodeFromTarget(evt.target); if (id) setHover(id); });
  svg.addEventListener('focusout', function () { setHover(null); });
  document.addEventListener('keydown', function (evt) {
    if (evt.key !== 'Escape' || !spot.hidden) return;
    if (!menu.hidden) { closeMenu(true); return; }
    showEdge(null); setHover(null); applyFocus(null);
    state.selected = null; markSelected();
  });

  // ── Controls ──────────────────────────────────────────────────────────
  var segBtns = Array.prototype.slice.call(document.querySelectorAll('.cp-seg [data-view]'));
  segBtns.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
  });
  // previous / next archetype links carry the current view (#view=synergy|picks)
  var archLinks = Array.prototype.slice.call(document.querySelectorAll('.cp-archnav a[href]'));
  archLinks.forEach(function (a) { a.setAttribute('data-base-href', String(a.getAttribute('href') || '').split('#')[0]); });
  function viewHash() { return state.view === 'core' ? '' : '#view=' + state.view; }
  function syncArchLinks() {
    archLinks.forEach(function (a) { a.setAttribute('href', a.getAttribute('data-base-href') + viewHash()); });
  }
  function setView(v) {
    if (v === state.view) return;
    state.view = v;
    segBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
    try { history.replaceState(null, '', location.pathname + location.search + viewHash()); } catch (e) { /* ignore */ }
    syncArchLinks();
    rebuild();
  }
  function toggleCoplay() {
    if (this && this.getAttribute && this.getAttribute('aria-disabled') === 'true') return;   // keyboard users too
    state.coplay = !state.coplay;
    ['cpCoplayBtn', 'cpCoplayBtnM'].forEach(function (id) { var b = document.getElementById(id); if (b) b.setAttribute('aria-pressed', String(state.coplay)); });
    rebuild();
  }
  ['cpCoplayBtn', 'cpCoplayBtnM'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', toggleCoplay);
  });
  document.getElementById('cpLabelsBtn').addEventListener('click', function () {
    state.allLabels = !state.allLabels;
    this.setAttribute('aria-pressed', String(state.allLabels));
    fit();
  });
  document.getElementById('cpZoomIn').addEventListener('click', function () { zoomAt(1.3); });
  document.getElementById('cpZoomOut').addEventListener('click', function () { zoomAt(1 / 1.3); });
  document.getElementById('cpFitBtn').addEventListener('click', fit);
  document.getElementById('cpFitBtnM').addEventListener('click', function () { closeMenu(); fit(); });
  var themeBtn = document.getElementById('cpThemeBtn');
  function syncThemeBtn() {
    var t = M.theme.current();
    themeBtn.setAttribute('aria-label', t === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    themeBtn.setAttribute('aria-pressed', String(t === 'light'));
    var m = document.getElementById('cpThemeBtnM');
    if (m) m.setAttribute('aria-pressed', String(t === 'light'));
  }
  themeBtn.addEventListener('click', function () { M.theme.toggle(); syncThemeBtn(); });
  var themeBtnM = document.getElementById('cpThemeBtnM');
  if (themeBtnM) themeBtnM.addEventListener('click', function () { M.theme.toggle(); syncThemeBtn(); });
  syncThemeBtn();
  var archSelect = document.getElementById('cpArchSelect');
  if (archSelect) archSelect.addEventListener('change', function () { if (archSelect.value) location.href = archSelect.value.split('#')[0] + viewHash(); });
  // menu
  var menu = document.getElementById('cpMenu'), menuBtn = document.getElementById('cpMenuBtn');
  function openMenu() {
    menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true');
    var first = menu.querySelector('button:not([hidden]), a');
    if (first && first.offsetParent === null) first = Array.prototype.find.call(menu.querySelectorAll('button, a'), function (el) { return el.offsetParent !== null; });
    if (first) first.focus();
  }
  function closeMenu(refocus) { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); if (refocus) menuBtn.focus(); }
  menuBtn.addEventListener('click', function () { if (menu.hidden) openMenu(); else closeMenu(); });
  document.addEventListener('click', function (evt) {
    if (!menu.hidden && !evt.target.closest('.cp-menu-wrap')) closeMenu();
  });
  menu.addEventListener('keydown', function (evt) { if (evt.key === 'Escape') { evt.stopPropagation(); closeMenu(true); } });
  // layout restore / dev tools
  var restoreBtn = document.getElementById('cpRestoreBtn');
  function syncRestoreBtn() { restoreBtn.hidden = !Object.keys(thetaOverride).length; }
  function resetLayout() {
    thetaOverride = Object.create(null);
    persistLayout();
    rebuild();
  }
  restoreBtn.addEventListener('click', function () { closeMenu(); resetLayout(); });
  if (DEV) {
    document.getElementById('cpDevTools').hidden = false;
    document.getElementById('cpResetLayoutBtn').addEventListener('click', function () { closeMenu(); resetLayout(); });
    document.getElementById('cpExportBtn').addEventListener('click', function () {
      var positions = {};
      nodes.forEach(function (n) { var p = layoutPos(n); positions[n.id] = { x: Math.round(p[0] * 100) / 100, y: Math.round(p[1] * 100) / 100 }; });
      var data = { format: meta.format || '', slug: SLUG, layout_version: LAYOUT_VERSION, theta: thetaOverride, positions: positions };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = String(meta.format || 'layout').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '_' + SLUG + '_layout.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }
  syncRestoreBtn();

  // ── Site config (access / premium flags; default open) ────────────────
  function applyAccess(cfg) {
    access.formatLocked = !!cfg.formatLocked;
    ['premiumFilters', 'premiumDrawer', 'premiumQuickRead'].forEach(function (k) { access[k] = Object.assign({}, access[k], cfg[k] || {}); });
    access.premiumReport = !!cfg.premiumReport;
    rebuild();
  }
  function loadAccess() {
    var href = payload.config_href;
    if (!href || typeof fetch !== 'function') return;
    function get(u) { return fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }); }
    get(href).catch(function () { return null; }).then(function (cfg) {
      if (cfg || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href)) return cfg;
      return get('../' + href).catch(function () { return null; });
    }).then(function (cfg) {
      if (!cfg) return;
      var fc = (cfg.formats && (cfg.formats[meta.format] || cfg.formats[meta.slug])) || {};
      applyAccess(Object.assign({}, cfg['default'] || {}, fc));
    }).catch(function () { /* the page stays fully open */ });
  }

  // ── Build / rebuild ───────────────────────────────────────────────────
  function rebuild() {
    ['cpCoplayBtn', 'cpCoplayBtnM'].forEach(function (id) {
      var b = document.getElementById(id);
      if (!b) return;
      b.setAttribute('aria-disabled', String(state.view !== 'core' || !copEdges.length));
      b.setAttribute('aria-pressed', String(state.coplay));
    });
    rotate = state.view !== 'synergy' && isNarrow() && window.innerHeight > window.innerWidth;
    computeView();
    noteEl.hidden = true;
    if (access.formatLocked) {
      M.clear(svg); view.edges = [];
      noteEl.textContent = 'Members-only format: the archetype map for this set is part of the premium version.';
      noteEl.hidden = false;
      renderSide(); renderMore(); renderLegend();
      return;
    }
    if (!nodes.length) {
      M.clear(svg);
      noteEl.textContent = 'No cards to show for this archetype.';
      noteEl.hidden = false;
      renderSide(); renderMore();
      return;
    }
    draw();
    renderLegend();
    renderSide();
    renderMore();
    sizeGraph();
    fit();
    if (state.view === 'synergy' && !synEdges.length) {
      noteEl.textContent = 'No pair cleared the synergy evidence bar here: these cards mostly win on their own.';
      noteEl.hidden = false;
    }
    if (state.activeEdge && state.view !== 'picks') {
      var still = edgeEls.some(function (x) { return x.e === state.activeEdge; });
      if (still) showEdge(state.activeEdge); else showEdge(null);
    } else {
      showEdge(null);
    }
  }

  // sticky offsets + resize handling
  var bar = document.getElementById('cpBar');
  var crumbRow = document.querySelector('.cp-crumbrow');
  function syncBar() {
    var desktop = window.matchMedia('(min-width: 901px)').matches;
    var crumb = desktop && crumbRow ? crumbRow.offsetHeight : 0;
    document.documentElement.style.setProperty('--crumb-h', crumb + 'px');
    document.documentElement.style.setProperty('--bar-h', (crumb + bar.offsetHeight) + 'px');
  }
  var resizeTimer = 0, lastW = 0, lastH = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      syncBar();
      var W = window.innerWidth, H = window.innerHeight;
      if (W === lastW && Math.abs(H - lastH) < 80 && svg.clientWidth) return;   // ignore mobile URL-bar jitter
      lastW = W; lastH = H;
      var wantRotate = state.view !== 'synergy' && isNarrow() && H > W;
      if (wantRotate !== rotate) rebuild(); else { sizeGraph(); fit(); }
    }, 120);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // initial view from #view=synergy|picks (card deep links use #card=)
  var hv = /^#view=(core|synergy|picks)$/.exec(location.hash || '');
  if (hv) {
    state.view = hv[1];
    segBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === state.view)); });
  }
  syncArchLinks();
  if (!copEdges.length) state.coplay = false;
  syncBar();
  lastW = window.innerWidth; lastH = window.innerHeight;
  rebuild();
  openFromHash();
  loadAccess();
  window.__clusterPage = { nodes: nodes, view: function () { return view; }, cam: function () { return cam; }, labels: function () { return labelBoxes.slice(); }, state: state };
})();
