/* Local cache explorer for the Base core tile (owner: cache explorer).
 *
 *   window.PrismCacheExplorer.mount(holder, options) -> { dispose }
 *     options.initialProgram  workload source for the program editor
 *     options.compact  use the host page heading and fold detailed request fields
 *     options.onProgram(source)                      editor text after edits and runs
 *     options.onAccess({ op: 'lw'|'sw', address, value, mnemonic, size, cacheable, region, provenance })
 *        called after each completed data access you start (single access, or the last
 *        access of a program run). op is the load/store class; mnemonic and size give
 *        the exact width (sb, lhu, ...); value is null when a device's response is not
 *        modeled here; provenance is 'model' or 'rtl'.
 *     options.onAccess(null)
 *        the previous access no longer describes these caches: sent on a user cold
 *        reset and when a new program session starts (also when it makes no data
 *        access). Not sent on dispose, so a host keeps the last completed access
 *        when the reader moves to another tab.
 *        The handoff is always the last completed access, not the step the reader has
 *        rewound to with the player.
 *
 *   handle.snapshot() -> JSON copy of the session (steps include the view-only "read set" phase).
 *
 * Layout: toolbar, step player, then the lookup diagram (address split into
 * tag/set/word/byte, set select, per-way valid gate and tag compare, hit/miss)
 * beside tabbed cache tables and logs. Everything the diagram shows at and after
 * the probe comes from the probe-time event, never from refilled arrays.
 * These caches have only local line states; the legend links to the separate,
 * illustrative coherence demo (cache-coherence.js), which shares no state with them.
 *
 * Requires PrismCacheModel (assets/cache-model.js). Uses, when present:
 * PrismAsm (rv-asm.js) for the program editor and instruction encodings,
 * PrismTraceCompiler (core-trace-compiler.js) for disassembly and trace rows,
 * PrismSim + PRISM_SIM_MODELS (core-sim.js, data/sim-models.js) for runs on
 * the Base tile RTL, and PRISM_REFERENCE (data/reference.js) for the address map.
 * Static, offline and file:// compatible; no network access.
 */
(function () {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var serial = 0;
  var ABI = 'zero ra sp gp tp t0 t1 t2 s0 s1 a0 a1 a2 a3 a4 a5 a6 a7 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11 t3 t4 t5 t6'.split(' ');
  var OPS = { lw: [false, 4], lh: [false, 2], lhu: [false, 2], lb: [false, 1], lbu: [false, 1], sw: [true, 4], sh: [true, 2], sb: [true, 1] };
  var SPEEDS = [['0.5', '0.5×'], ['1', '1×'], ['2', '2×'], ['4', '4×'], ['8', '8×']];

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function svg(tag, attrs, children) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function hex8(n) { return ('0000000' + (n >>> 0).toString(16)).slice(-8); }
  function hx(n) { return '0x' + hex8(n); }
  function hxs(n) { var s = hex8(n); return '0x' + s.slice(0, 4) + '_' + s.slice(4); }
  function regIndex(name) {
    name = String(name || '').trim().toLowerCase();
    if (/^x([0-9]|[12][0-9]|3[01])$/.test(name)) return +name.slice(1);
    if (name === 'fp') return 8;
    return ABI.indexOf(name);
  }
  function parseNumber(text) {
    var t = String(text || '').trim().replace(/_/g, '').toLowerCase();
    if (!t) return null;
    var neg = t[0] === '-';
    if (neg || t[0] === '+') t = t.slice(1);
    var v;
    if (/^0x[0-9a-f]+$/.test(t)) v = parseInt(t.slice(2), 16);
    else if (/^0b[01]+$/.test(t)) v = parseInt(t.slice(2), 2);
    else if (/^[0-9]+$/.test(t)) v = parseInt(t, 10);
    else return null;
    if (!Number.isFinite(v)) return null;
    return neg ? -v : v;
  }
  function stripComment(text) { return String(text || '').replace(/\s*#.*$/, '').trim(); }
  function parseAccess(text) {
    var mn = /^\s*([a-z][a-z0-9.]*)/i.exec(text || '');
    if (mn && !OPS[mn[1].toLowerCase()]) return { error: '"' + mn[1] + '" is not a load or store. Use lw, lh, lhu, lb, lbu, sw, sh or sb.' };
    var m = /^\s*([a-z]+)\s+([a-z0-9]+)\s*,\s*([-+]?\s*(?:0x[0-9a-f_]+|0b[01_]+|[0-9_]+))?\s*\(\s*([a-z0-9]+)\s*\)\s*$/i.exec(text || '');
    if (!m) return { error: 'Write a RISC-V load or store, for example lw a0, 8(t0) or sw t1, -4(s0).' };
    var op = m[1].toLowerCase();
    if (!OPS[op]) return { error: '"' + m[1] + '" is not a load or store. Use lw, lh, lhu, lb, lbu, sw, sh or sb.' };
    var reg = regIndex(m[2]), base = regIndex(m[4]);
    if (reg < 0) return { error: 'Unknown register "' + m[2] + '".' };
    if (base < 0) return { error: 'Unknown register "' + m[4] + '".' };
    var off = m[3] === undefined ? 0 : parseNumber(m[3].replace(/\s+/g, ''));
    if (off === null || off < -2048 || off > 2047) return { error: 'The offset must be a 12-bit signed immediate (−2048 to 2047).' };
    return { op: op, reg: reg, base: base, offset: off };
  }

  var EXAMPLES = [
    { name: 'Three lines in one set', note: 'Cold misses fill both ways of set 0; a third tag evicts the least recently used way.',
      source: '# Three lines that share D-cache set 0 (address bits [6:4] = 0).\n.text\n    li   t0, 0x80000000\n    lw   a0, 0(t0)        # cold miss: way 0\n    lw   a1, 4(t0)        # hit: same 16-byte line\n    lw   a2, 0x80(t0)     # same set, new tag: way 1\n    lw   a3, 0(t0)        # hit way 0: way 1 becomes the victim\n    lw   a4, 0x100(t0)    # third tag replaces way 1\n    lw   a5, 0x80(t0)     # miss again: replaces way 0\n    halt\n' },
    { name: 'Store, evict, write back', note: 'A store marks its line dirty without touching RAM; evicting it costs two write-back beats before the refill.',
      source: '# A dirty line is written back only when it is evicted.\n.text\n    li   t0, 0x80000010\n    li   t1, 0x12345678\n    sw   t1, 0(t0)        # store miss: allocate, merge, dirty\n    lw   a0, 0x80(t0)     # set 1 way 1\n    lw   a1, 0x100(t0)    # evicts the dirty line: write back, then refill\n    lw   a2, 0(t0)        # refill returns the stored value\n    halt\n' },
    { name: 'Walk an array', note: 'One refill brings four words; the next three loads hit.',
      source: '# Sum 16 words: one miss per 16-byte line.\n.text\n    la   t0, table\n    li   t1, 16\n    li   a0, 0\nloop:\n    lw   t2, 0(t0)\n    add  a0, a0, t2\n    addi t0, t0, 4\n    addi t1, t1, -1\n    bnez t1, loop\n    halt\n.data\n.balign 16\ntable:\n    .word 1, 2, 3, 4, 5, 6, 7, 8\n    .word 9, 10, 11, 12, 13, 14, 15, 16\n' },
    { name: 'fence and fence.i', note: 'fence cleans dirty D lines but leaves them valid; fence.i also invalidates the I-cache.',
      source: '# Cache maintenance: clean D, then clean D and invalidate I.\n.text\n    li   t0, 0x80000040\n    li   t1, 7\n    sw   t1, 0(t0)\n    sw   t1, 0x80(t0)     # same set, second way: both dirty\n    fence                 # writes both back; lines stay valid\n    lw   a0, 0(t0)        # still a hit\n    sw   t1, 4(t0)\n    fence.i               # clean D, then invalidate every I line\n    lw   a1, 4(t0)\n    halt\n' },
    { name: 'Uncached ROM and MMIO', note: 'Addresses outside the RAM window bypass the D-cache: one masked beat each time, nothing allocated. Runs in the model; the tile bench has no peripherals.',
      source: '# Only the RAM window is cacheable. ROM and MMIO accesses are single beats.\n.text\n    li   t0, 0x00000000\n    lw   a0, 4(t0)        # boot ROM: uncached load\n    lw   a1, 4(t0)        # uncached again: nothing was allocated\n    li   t1, 0x40020000   # UART region\n    li   t2, 0x41\n    sw   t2, 0(t1)        # one write beat, mask 0x0f\n    sb   t2, 5(t1)        # one write beat, mask 0x20\n    halt\n' }
  ];

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function decodeText(word, pc) {
    var C = window.PrismTraceCompiler;
    if (!C || !C.decode) return '0x' + hex8(word);
    try { return C.decode(word >>> 0, pc >>> 0, 'base').text; } catch (e) { return '0x' + hex8(word); }
  }

  /* ---------- RTL runner: Base tile bench in a Worker, with cache and memory dumps ---------- */

  function runnerBody(factory) {
    return 'var _scriptName = "";\nvar factory = ' + factory.toString() + ';\n' +
      'self.onmessage = function (e) {\n' +
      '  var log = []; var push = function (s) { log.push(String(s)); };\n' +
      '  factory({ print: push, printErr: push, noInitialRun: true }).then(function (M) {\n' +
      '    M.FS.writeFile("/image.hex", e.data.hex); var exit = 0;\n' +
      '    try { M.callMain(["+IMAGE=/image.hex", "+PRISM_TRACE=/trace.jsonl", "+TRACE=/dev/null", "+DUMP=/dump.hex", "+CACHE_DUMP=/caches.csv"].concat(e.data.args)); }\n' +
      '    catch (x) { if (x && x.name === "ExitStatus") exit = x.status; else { push(String(x && x.message || x)); exit = -1; } }\n' +
      '    var read = function (f) { try { return M.FS.readFile(f, { encoding: "utf8" }); } catch (x) { return ""; } };\n' +
      '    self.postMessage({ log: log, exit: exit, trace: read("/trace.jsonl"), csv: read("/caches.csv"), dump: read("/dump.hex") });\n' +
      '  }, function (err) { self.postMessage({ log: [String(err && err.message || err)], exit: -1, trace: "", csv: "", dump: "" }); });\n' +
      '};\n';
  }
  var loadingBase = null;
  function loadBaseFactory() {
    if (window.PrismSim_base) return Promise.resolve(window.PrismSim_base);
    if (loadingBase) return loadingBase;
    loadingBase = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/sim/base.js'; s.charset = 'utf-8';
      s.onload = function () { window.PrismSim_base ? resolve(window.PrismSim_base) : reject(new Error('The Base RTL model did not load')); };
      s.onerror = function () { loadingBase = null; reject(new Error('Could not load assets/sim/base.js')); };
      document.head.appendChild(s);
    });
    return loadingBase;
  }
  function runBaseRtl(segments, maxCycles, signal) {
    var hex = window.PrismSim.imageHex({ segments: segments });
    var args = ['+FINISH_ON_WFI', '+LATENCY=' + ((window.PrismSim.layout && window.PrismSim.layout.latency) || 1), '+MAX_CYCLES=' + maxCycles];
    return loadBaseFactory().then(function (factory) {
      if (signal && signal.aborted) { var ab = new Error('Run cancelled'); ab.name = 'AbortError'; throw ab; }
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(new Blob([runnerBody(factory)], { type: 'text/javascript' }));
        var worker;
        try { worker = new Worker(url); } catch (e) { URL.revokeObjectURL(url); reject(new Error('This browser cannot start a Worker for the RTL run.')); return; }
        function done() { worker.terminate(); URL.revokeObjectURL(url); if (signal) signal.removeEventListener('abort', onAbort); }
        function onAbort() { done(); var e = new Error('Run cancelled'); e.name = 'AbortError'; reject(e); }
        worker.onmessage = function (e) { done(); resolve(e.data); };
        worker.onerror = function (e) { done(); if (e.preventDefault) e.preventDefault(); reject(new Error(e.message || 'The RTL worker failed')); };
        if (signal) signal.addEventListener('abort', onAbort);
        worker.postMessage({ hex: hex, args: args });
      });
    });
  }
  function stopOf(out, rows) {
    var text = (out.log || []).join('\n'), last = rows.length ? rows[rows.length - 1] : null, cycle = last ? last.c : null;
    if (/RTL completed:/.test(text)) return { reason: 'halt', cycle: cycle };
    if (/RTL timeout/.test(text)) return { reason: last && last.sleep ? 'wfi' : 'max_cycles', cycle: cycle };
    var fatal = text.split('\n').filter(function (l) { return /%Error|%Fatal|Assertion|Aborted|RuntimeError/.test(l); });
    return { reason: 'error', cycle: cycle, message: (fatal[0] || text.split('\n').filter(Boolean).pop() || 'no result').replace(/^\[\d+\]\s*/, '') };
  }

  /* ---------- transport strip: core, caches, fabric, routing, targets ---------- */

  /* Edge endpoints in the 560 x 140 strip. renderFlow moves the traffic label
     along the active cache edge, so every edge here is drawn with a matching path. */
  var FLOW_W = 560;
  var FLOW = {
    'core-i': [[50, 34], [118, 34]], 'core-d': [[50, 106], [118, 106]],
    'i-fabric': [[206, 34], [298, 34]], 'd-fabric': [[206, 106], [298, 106]],
    'fabric-route': [[366, 70], [382, 70]],
    'route-ram': [[434, 70], [448, 24]], 'route-rom': [[434, 70], [448, 70]], 'route-sys': [[434, 70], [448, 116]]
  };
  function buildFlow() {
    var root = svg('svg', { viewBox: '0 0 ' + FLOW_W + ' 140', role: 'img', class: 'cx-flow-svg' });
    var defs = svg('defs', {}, [svg('marker', { id: 'cx-arrow-' + (++serial), viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, [svg('path', { d: 'M0,0 L8,4 L0,8 z', class: 'cx-arrowhead' })])]);
    var arrowId = defs.firstChild.getAttribute('id');
    root.appendChild(defs);
    // Title then subtitle, centred in the box; renderEnvironment rewrites both texts.
    function box(x, y, w, hgt, title, sub, part, extra) {
      var g = svg('g', { class: 'cx-node ' + (extra || ''), 'data-part': part });
      var mid = y + hgt / 2;
      g.appendChild(svg('rect', { x: x, y: y, width: w, height: hgt, rx: 7 }));
      g.appendChild(svg('text', { x: x + w / 2, y: sub ? mid - 2 : mid + 5, class: 'cx-node-title', 'text-anchor': 'middle', text: title }));
      g.appendChild(svg('text', { x: x + w / 2, y: mid + 13, class: 'cx-node-sub', 'text-anchor': 'middle', text: sub || '' }));
      root.appendChild(g);
      return g;
    }
    function edge(name) {
      var p = FLOW[name];
      var g = svg('g', { class: 'cx-edge', 'data-edge': name });
      g.appendChild(svg('path', { d: 'M' + p[0][0] + ',' + p[0][1] + ' L' + p[1][0] + ',' + p[1][1], 'marker-end': 'url(#' + arrowId + ')' }));
      root.appendChild(g);
    }
    box(2, 2, 48, 136, 'Core', '', 'core', 'is-core');
    root.appendChild(svg('text', { x: 26, y: 38, class: 'cx-node-sub', 'text-anchor': 'middle', text: 'IF' }));
    root.appendChild(svg('text', { x: 26, y: 110, class: 'cx-node-sub', 'text-anchor': 'middle', text: 'MEM' }));
    box(118, 8, 88, 52, 'I-cache', '16 × 8 B', 'icache', 'is-cache');
    box(118, 80, 88, 52, 'D-cache', '8 sets × 2 ways', 'dcache', 'is-cache');
    box(298, 2, 68, 136, 'Fabric', '64-bit beats', 'fabric', 'is-fabric');
    box(382, 50, 52, 40, 'Route', '', 'route', 'is-route');
    box(448, 2, 110, 44, 'RAM', '64 KiB · 0x8000_0000', 'ram', 'is-target');
    box(448, 48, 110, 44, 'Boot ROM', '4 KiB · 0x0000_0000', 'rom', 'is-target');
    box(448, 94, 110, 44, 'Peripherals', 'MMIO · system bus', 'sys', 'is-target');
    Object.keys(FLOW).forEach(edge);
    var token = svg('g', { class: 'cx-token', 'data-hidden': 'true' }, [svg('rect', { x: -50, y: -11, width: 100, height: 20, rx: 10 }), svg('text', { x: 0, y: 3, 'text-anchor': 'middle', text: '' })]);
    root.appendChild(token);
    return { root: root, token: token };
  }

  /* ---------- lookup diagram: address split, set select, tag compare ---------- */

  var LK = { W: 560, H: 270, BW: 14, GAP: 18 };
  function fieldGroups(kind) {
    return kind === 'i'
      ? [{ key: 'tag', hi: 31, lo: 7, name: 'TAG' }, { key: 'index', hi: 6, lo: 3, name: 'LINE' }, { key: 'word', hi: 2, lo: 2, name: 'WORD' }, { key: 'byte', hi: 1, lo: 0, name: 'BYTE' }]
      : [{ key: 'tag', hi: 31, lo: 7, name: 'TAG' }, { key: 'index', hi: 6, lo: 4, name: 'SET' }, { key: 'word', hi: 3, lo: 2, name: 'WORD' }, { key: 'byte', hi: 1, lo: 0, name: 'BYTE' }];
  }
  function tagHex(t) { return '0x' + ('000000' + (t >>> 0).toString(16)).slice(-7); }
  /* Hex digits of a stored tag, marking the digits that differ from the address tag. */
  function tagSpans(value, other, cls) {
    var a = tagHex(value), b = other === null || other === undefined ? null : tagHex(other);
    var t = svg('text', { class: cls });
    for (var i = 0; i < a.length; i++) {
      var diff = b !== null && i > 1 && a[i] !== b[i];
      t.appendChild(svg('tspan', { class: diff ? 'is-diff' : null, text: a[i] }));
    }
    return t;
  }
  /* Eight hex digits with the accessed byte lanes marked (lane 0 is the last pair). */
  function wordSpans(value, lanes) {
    var s = hex8(value), t = svg('text', { class: 'cx-lk-wordtext' });
    for (var lane = 3; lane >= 0; lane--) {
      var on = lanes && lanes.indexOf(lane) >= 0;
      t.appendChild(svg('tspan', { class: on ? 'is-lane' : null, text: s.slice((3 - lane) * 2, (3 - lane) * 2 + 2) }));
    }
    return t;
  }

  /* Lookup view model for one step. Everything shown at and after the probe comes
     from the event that made the decision (probe compare, fetch-time line), never
     from the current arrays: a cold miss must not look like a match on the line
     its own refill installed. */
  var MAINT = { 'clean-start': 1, 'invalidate': 1, 'reset': 1 };
  function lookupModel(M, ev, op, inspect, st) {
    if (inspect) return { mode: inspect.cache, phase: 'inspect', index: inspect.index, st: st };
    if (!ev || !op) return null;
    var j = op.events.indexOf(ev), k, anchor = null;
    for (k = j; k >= 0; k--) {
      var e = op.events[k];
      if (e.kind === 'decode' || e.kind === 'ifetch' || e.kind === 'misaligned' || MAINT[e.kind]) { anchor = e; break; }
    }
    if (!anchor) return { mode: 'maint', cache: ev.cache || 'd', set: ev.set, way: ev.way, st: st, ev: ev, title: ev.title };
    if (anchor.kind === 'misaligned') return { mode: 'misaligned', address: anchor.address, st: st, ev: ev };
    if (MAINT[anchor.kind]) return { mode: 'maint', cache: ev.cache || anchor.cache || 'd', set: ev.set, way: ev.way, st: st, ev: ev, anchor: anchor };
    if (anchor.kind === 'ifetch') {
      var f = anchor.fields, pre = anchor.state.i.lines[f.index];
      var retained = anchor.tone === 'fault';
      var cmp = { valid: pre.valid, tag: pre.tag, match: !!(pre.valid && pre.tag === f.tag) };
      if (retained) {
        // A retained fault answers before any lookup (icache.sv fault_matches).
        cmp = null;
      }
      return { mode: 'i', phase: j === k ? 'all' : 'after', fields: f, address: f.address, index: f.index, compare: cmp, retained: retained,
        hit: cmp ? cmp.match : false, st: st, ev: ev, anchor: anchor, fault: ev.tone === 'fault' };
    }
    // data access
    var d = anchor;
    if (!d.region || !d.region.cacheable) {
      var beat = null;
      for (var b = k; b <= j; b++) if (op.events[b].kind === 'uncached') beat = op.events[b].beat;
      return { mode: 'bypass', phase: j === k ? 'decode' : 'beat', address: d.address, fields: d.fields, region: d.region, beat: beat, write: d.write, size: d.size, st: st, ev: ev };
    }
    var sel = -1, probe = -1, miss = null;
    for (var q = k + 1; q < op.events.length; q++) {
      var x = op.events[q];
      if (x.kind === 'select' && sel < 0) sel = q;
      if (x.kind === 'probe' && probe < 0) probe = q;
      if (x.kind === 'miss' && q <= j) miss = x;
      if (x.kind === 'decode' || x.kind === 'ifetch') break;
    }
    var phase = j === k ? 'split' : j === sel ? 'select' : j === probe ? 'compare' : j > probe && probe >= 0 ? 'after' : 'select';
    var probeEv = probe >= 0 ? op.events[probe] : null;
    var compare = probeEv ? probeEv.compare : null;
    var hitWay = compare ? (compare[0].match ? 0 : compare[1] && compare[1].match ? 1 : -1) : -1;
    return { mode: 'd', phase: phase, fields: d.fields, address: d.address, index: d.fields.index, write: d.write, size: d.size,
      compare: compare, hitWay: hitWay, miss: miss, st: st, ev: ev, probeState: (probeEv || d).state, fault: ev.tone === 'fault' };
  }

  function lineState(w) { return !w.valid ? 'invalid' : w.dirty ? 'dirty' : 'clean'; }

  /* Draws one lookup view. o: { M, animate, dur, decode, preview } */
  function drawLookup(v, o) {
    var M = o.M, root = svg('svg', { viewBox: '0 0 ' + LK.W + ' ' + LK.H, class: 'cx-lk-svg', role: 'img' });
    root.style.setProperty('--cx-dur', Math.round(o.dur || 900) + 'ms');
    var anim = !!o.animate;
    function add(parent, el) { (parent || root).appendChild(el); return el; }
    function tx(x, y, text, cls, anchor, parent) { return add(parent, svg('text', { x: x, y: y, class: cls || '', 'text-anchor': anchor || 'start', text: text })); }
    function rc(x, y, w, hh, cls, parent, rx) { return add(parent, svg('rect', { x: x, y: y, width: w, height: hh, rx: rx === undefined ? 4 : rx, class: cls || '' })); }
    function path(d, cls, parent) { return add(parent, svg('path', { d: d, class: cls || '' })); }
    function g(cls, parent) { return add(parent, svg('g', { class: cls || '' })); }
    function stage(el, kind, delay) {
      if (!anim) return el;
      el.classList.add('cx-a-' + kind);
      if (delay) el.style.setProperty('--cx-delay', String(delay));
      return el;
    }
    var kind = v.mode === 'i' || (v.mode === 'maint' && v.cache === 'i') ? 'i' : 'd';
    var groups = fieldGroups(kind), address = v.address;
    var allPhase = v.mode === 'i' && v.phase === 'all';

    /* address bits */
    function drawBits(split, colour, labelText) {
      var cur = split ? 29 : 56, cont = 56;
      var top = g('cx-lk-addr');
      groups.forEach(function (gr) {
        var n = gr.hi - gr.lo + 1, w = n * LK.BW, x = cur, cx0 = cont;
        cur += w + (split ? LK.GAP : 0); cont += w;
        var fg = g('cx-lk-field is-' + gr.key + (colour ? '' : ' is-plain'), top);
        if (split && anim && (v.phase === 'split' || allPhase)) { fg.style.setProperty('--dx', (cx0 - x) + 'px'); stage(fg, 'split', 0); }
        for (var b = gr.hi; b >= gr.lo; b--) {
          var bx = x + (gr.hi - b) * LK.BW, bit = address === undefined || address === null ? '·' : String(Math.floor((address >>> 0) / Math.pow(2, b)) % 2);
          rc(bx, 18, LK.BW, 20, 'cx-lk-bit', fg, 0);
          tx(bx + LK.BW / 2, 32, bit, 'cx-lk-bitv', 'middle', fg);
        }
        rc(x, 18, w, 20, 'cx-lk-fieldframe', fg, 2);
        if (split) {
          tx(x, 13, String(gr.hi), 'cx-lk-bitno', 'start', fg);
          if (n > 1) tx(x + w, 13, String(gr.lo), 'cx-lk-bitno', 'end', fg);
          var lab = g('cx-lk-flabel', fg);
          stage(lab, 'fade', allPhase ? 0.15 : 0.45);
          tx(x + w / 2, 51, gr.name, 'cx-lk-fname', 'middle', lab);
          var f = v.fields, val = gr.key === 'tag' ? tagHex(f.tag) : String(f[gr.key]);
          tx(x + w / 2, 65, val, 'cx-lk-fval', 'middle', lab);
          gr.x = x; gr.w = w;
        }
      });
      if (split) {
        var word = groups[2], byte = groups[3], end = byte.x + byte.w;
        var offset = g('cx-lk-offset', top);
        stage(offset, 'fade', allPhase ? 0.15 : 0.45);
        path('M' + word.x + ',70 v4 H' + end + ' v-4', 'cx-lk-offset-bracket', offset);
        tx((word.x + end) / 2, 83, 'BLOCK OFFSET [' + (kind === 'i' ? '2' : '3') + ':0]', 'cx-lk-offset-label', 'middle', offset);
      }
      if (labelText) tx(LK.W / 2, 58, labelText, 'cx-lk-note', 'middle');
      return top;
    }

    function strip(n, selected, st, cls) {
      var cw = kind === 'i' ? 12 : 22, x0 = 536 - n * cw;
      var s = g('cx-lk-strip ' + (cls || ''));
      tx(x0 - 6, 101, kind === 'i' ? '16 lines' : '8 sets', 'cx-lk-small', 'end', s);
      for (var i = 0; i < n; i++) {
        var on = i === selected;
        var cell = g('cx-lk-cell' + (on ? ' is-on' : ''), s);
        if (on) stage(cell, 'fade', allPhase ? 0.3 : 0);
        rc(x0 + i * cw, 90, cw - 2, 16, '', cell, 3);
        tx(x0 + i * cw + (cw - 2) / 2, 100, String(i), 'cx-lk-cellno', 'middle', cell);
        var ways = kind === 'i' ? [st.i.lines[i]] : st.d.sets[i].ways;
        ways.forEach(function (w, wi) {
          var bw = (cw - 6) / ways.length;
          rc(x0 + i * cw + 2 + wi * bw, 103, bw - 1, 2, 'cx-lk-mini is-' + lineState(w), cell, 0);
        });
      }
      return { x0: x0, cw: cw };
    }
    function setWire(gr, sx, cw, sel) {
      if (!gr || sel === null || sel === undefined) return;
      var cx = gr.x + gr.w / 2, tx0 = sx + sel * cw + (cw - 2) / 2;
      var p = path('M' + cx + ',70 V86 H' + tx0 + ' V90', 'cx-lk-wire is-index');
      stage(p, 'draw', allPhase ? 0.25 : 0);
    }

    function card(x, w, line, wi, setNo, opts) {
      var c = g('cx-lk-card is-' + lineState(line) + (opts.dim ? ' is-dim' : '') + (opts.focus ? ' is-focus' : '') + (opts.hit ? ' is-hit' : '') + (opts.victim ? ' is-victim' : ''));
      if (opts.stageDelay !== undefined) stage(c, 'fade', opts.stageDelay);
      rc(x, 110, w, 62, 'cx-lk-cardframe', c, 7);
      var head = kind === 'i' ? 'LINE ' + setNo : 'WAY ' + wi;
      tx(x + 7, 121, head, 'cx-lk-cardhead', 'start', c);
      var lineAddr = kind === 'i' ? M.iLineAddress(line.tag, setNo) : M.dLineAddress(line.tag, setNo);
      var note = !line.valid ? 'invalid' : line.dirty ? 'dirty · ' + hxs(lineAddr) : 'clean · ' + hxs(lineAddr);
      tx(x + w - 7, 121, note + (opts.lru ? '  · next victim' : ''), 'cx-lk-cardnote' + (opts.lru ? ' has-victim' : ''), 'end', c);
      var nW = kind === 'i' ? 2 : 4, ww = kind === 'i' ? 250 : 58, step = kind === 'i' ? 254 : 62;
      for (var k = 0; k < nW; k++) {
        var on = opts.words && opts.words.indexOf(k) >= 0;
        var col = opts.col === k;
        var wg = g('cx-lk-word' + (on ? ' is-on' : '') + (col ? ' is-col' : '') + (opts.wordTone ? ' tone-' + opts.wordTone : ''), c);
        rc(x + 4 + k * step, 125, ww, 18, '', wg, 3);
        var wt = wordSpans(line.data[k], on || col ? opts.lanes : null);
        wt.setAttribute('x', x + 4 + k * step + (kind === 'i' ? 8 : ww / 2)); wt.setAttribute('y', 138);
        wt.setAttribute('text-anchor', kind === 'i' ? 'start' : 'middle');
        wg.appendChild(wt);
        if (kind === 'i' && o.decode && (line.valid || line.tag || line.data[k])) tx(x + 4 + k * step + 76, 138, o.decode(line.data[k], lineAddr + 4 * k).slice(0, 26), 'cx-lk-dis', 'start', wg);
      }
      var tg = g('cx-lk-tagbox', c);
      rc(x + 4, 147, 120, 20, '', tg, 4);
      tx(x + 10, 160, 'tag', 'cx-lk-small', 'start', tg);
      var tt = tagSpans(line.tag, opts.diffWith, 'cx-lk-tagtext');
      tt.setAttribute('x', x + 118); tt.setAttribute('y', 161); tt.setAttribute('text-anchor', 'end');
      tg.appendChild(tt);
      var vb = g('cx-lk-bitbox' + (line.valid ? ' is-set' : ' is-clear'), c);
      rc(x + 168, 147, 26, 20, '', vb, 4); tx(x + 181, 161, 'V' + line.valid, 'cx-lk-bitlabel', 'middle', vb);
      if (kind === 'd') {
        var db = g('cx-lk-bitbox is-dbit' + (line.dirty ? ' is-set' : ' is-clear'), c);
        rc(x + 200, 147, 26, 20, '', db, 4); tx(x + 213, 161, 'D' + line.dirty, 'cx-lk-bitlabel', 'middle', db);
      }
      return c;
    }

    function comparator(x, cmp, incoming, state) {
      // state: 'pending' | 'done' | 'latched'
      var c = g('cx-lk-cmp is-' + state + (cmp && state !== 'pending' ? (cmp.match ? ' is-match' : !cmp.valid ? ' is-invalid' : ' is-mismatch') : ''));
      path('M' + (x + 64) + ',167 V184', 'cx-lk-wire is-tag' + (state === 'latched' ? ' is-latched' : ''), c);
      rc(x + 4, 184, 120, 36, 'cx-lk-cmpbox', c, 5);
      if (state === 'latched') tx(x + 4, 181, 'at lookup', 'cx-lk-small is-latched-label', 'start', c);
      tx(x + 10, 199, 'way', 'cx-lk-small', 'start', c);
      tx(x + 10, 214, 'addr', 'cx-lk-small', 'start', c);
      var a = tagSpans(cmp.tag, state === 'pending' ? null : incoming, 'cx-lk-cmpval');
      a.setAttribute('x', x + 118); a.setAttribute('y', 199); a.setAttribute('text-anchor', 'end'); c.appendChild(a);
      var b = tagSpans(incoming, state === 'pending' ? null : cmp.tag, 'cx-lk-cmpval is-incoming');
      b.setAttribute('x', x + 118); b.setAttribute('y', 215); b.setAttribute('text-anchor', 'end'); c.appendChild(b);
      var eq = cmp.tag === incoming;
      var glyph = g('cx-lk-glyph', c);
      if (state === 'done') stage(glyph, 'pop', allPhase ? 0.6 : 0);
      path('M' + (x + 124) + ',202 H' + (x + 130), 'cx-lk-wire', glyph);
      add(glyph, svg('circle', { cx: x + 142, cy: 202, r: 12 }));
      tx(x + 142, 207, state === 'pending' ? '?' : eq ? '=' : '≠', 'cx-lk-glyphtext', 'middle', glyph);
      path('M' + (x + 154) + ',202 H' + (x + 168), 'cx-lk-wire', glyph);
      // valid gate
      var gate = g('cx-lk-gate' + (cmp.valid ? '' : ' is-blocked'), c);
      if (state === 'done') stage(gate, 'pop', allPhase ? 0.68 : 0.15);
      path('M' + (x + 180) + ',167 V190', 'cx-lk-wire is-valid', gate);
      path('M' + (x + 168) + ',190 h12 a12,12 0 0 1 0,24 h-12 z', 'cx-lk-and', gate);
      tx(x + 177, 206, '&', 'cx-lk-andtext', 'middle', gate);
      var out = state === 'pending' ? '?' : cmp.match ? '1' : '0';
      path('M' + (x + 192) + ',202 H' + (x + 202), 'cx-lk-wire', gate);
      tx(x + 205, 206, 'hit ' + out, 'cx-lk-hitout', 'start', gate);
      if (state !== 'pending' && !cmp.valid) tx(x + 205, 218, eq ? 'V=0 blocks a match' : 'V=0', 'cx-lk-small is-blocked', 'start', gate);
      return c;
    }
    function bus(xs, incoming, state) {
      var last = xs[xs.length - 1] + 64;
      var b = g('cx-lk-bus' + (state === 'latched' ? ' is-latched' : ''));
      path('M36,70 H18 V230 H' + last, 'cx-lk-wire is-tag', b);
      xs.forEach(function (x) { path('M' + (x + 64) + ',230 V220', 'cx-lk-wire is-tag', b); });
      return b;
    }
    function result(text, tone, left, right, delay, rightLanes) {
      var r = g('cx-lk-result tone-' + tone);
      if (delay !== null && delay !== undefined) stage(r, 'fade', delay);
      rc(196, 238, 168, 28, 'cx-lk-badge', r, 14);
      tx(280, 257, text, 'cx-lk-badgetext', 'middle', r);
      if (left) tx(186, 257, left, 'cx-lk-side', 'end', r);
      if (right) {
        var splitAt = right.length > 27 ? right.lastIndexOf(' ', 27) : -1;
        if (splitAt > 0) {
          tx(374, 250, right.slice(0, splitAt), 'cx-lk-side', 'start', r);
          tx(374, 264, right.slice(splitAt + 1), 'cx-lk-side', 'start', r);
        }
        else {
          tx(374, 257, right, 'cx-lk-side', 'start', r);
        }
      }
      return r;
    }
    function hitWires(xs) {
      xs.forEach(function (x, i) { path('M' + (x + 214) + ',209 V234 H' + (i ? 300 : 260) + ' V238', 'cx-lk-wire is-hitline'); });
    }
    function placeholder(text, text2) {
      rc(40, 110, 512, 62, 'cx-lk-placeholder', null, 7);
      tx(296, 138, text, 'cx-lk-note', 'middle');
      if (text2) tx(296, 156, text2, 'cx-lk-small', 'middle');
    }

    var st = v.st;
    /* ---- mode drawings ---- */
    if (v.mode === 'inspect' || v.phase === 'inspect') {
      tx(LK.W / 2, 34, (kind === 'i' ? 'Line ' : 'Set ') + v.index + ' at this step', 'cx-lk-title', 'middle');
      tx(LK.W / 2, 56, 'Selected from the table. Step or select the row again to return to the lookup.', 'cx-lk-small', 'middle');
      var si = strip(kind === 'i' ? 16 : 8, v.index, st);
      if (kind === 'i') card(40, 512, st.i.lines[v.index], 0, v.index, {});
      else st.d.sets[v.index].ways.forEach(function (w, wi) { card(wi ? 300 : 40, 252, w, wi, v.index, { lru: st.d.sets[v.index].lru === wi && w.valid }); });
      return root;
    }
    if (v.mode === 'preview' || v.mode === 'empty') {
      var pf = v.address !== null && v.address !== undefined;
      if (pf && v.cacheable) {
        drawBits(true, true);
        var ps = strip(8, null, st);
        placeholder('Next access, not run yet: set ' + v.fields.index + ', tag ' + tagHex(v.fields.tag), 'Run it to select the set and compare both ways\' tags.');
      } else {
        drawBits(false, false, pf ? (v.note || 'Not cacheable: this access will bypass the D-cache') : 'Enter a load or store to see its address fields');
        strip(8, null, st);
        placeholder(pf ? 'No lookup for this address' : 'Run an access or a program', pf ? 'It leaves as one masked beat on the D channel.' : 'The address splits into tag, set and block offset here.');
      }
      return root;
    }
    if (v.mode === 'misaligned') {
      drawBits(false, false, 'Misaligned: the hart traps before the D-cache sees the access');
      root.querySelector('.cx-lk-addr').classList.add('is-fault');
      strip(8, null, st);
      placeholder('No cache access', 'No set is read and no state changes.');
      result('TRAP', 'fault');
      return root;
    }
    if (v.mode === 'bypass') {
      var c = v.region || {};
      drawBits(false, false, 'is_cacheable = 0 · ' + (c.label || 'outside the RAM window') + (c.register ? ' · ' + c.register : ''));
      strip(8, null, st, 'is-dim');
      placeholder('Bypass: no set is read, no tag is compared, nothing is allocated', 'The access leaves as one masked 8-byte beat.');
      var beat = v.beat, mask = beat ? beat.mask : 0;
      if (!beat) {
        var off = v.address & 7; mask = (({ 1: 1, 2: 3, 4: 15 })[v.size || 4] << off) & 0xff;
      }
      var lanes = g('cx-lk-lanes');
      if (v.phase !== 'decode') stage(lanes, 'fade', 0);
      for (var ln = 7; ln >= 0; ln--) {
        var on = (mask >> ln) & 1, lx = 120 + (7 - ln) * 40;
        var lg = g('cx-lk-lane' + (on ? ' is-on' : ''), lanes);
        rc(lx, 184, 36, 26, '', lg, 3);
        tx(lx + 18, 201, 'lane ' + ln, 'cx-lk-small', 'middle', lg);
      }
      tx(280, 228, beat ? (beat.dir === 'read' ? 'Read ' : 'Write ') + hxs(beat.address) + ' · mask 0x' + ('0' + mask.toString(16)).slice(-2) : 'Beat ' + hxs((v.address & ~7) >>> 0) + ' · mask 0x' + ('0' + mask.toString(16)).slice(-2), 'cx-lk-note', 'middle', lanes);
      var bad = v.ev && v.ev.tone === 'fault';
      result(bad ? 'FAULT' : 'UNCACHED', bad ? 'fault' : 'bypass', null, v.phase === 'decode' ? 'no lookup' : bad ? 'access fault' : 'one beat, once', v.phase === 'decode' ? null : 0.2);
      return root;
    }
    if (v.mode === 'maint') {
      var ev = v.ev;
      tx(LK.W / 2, 34, ev ? ev.title : '', 'cx-lk-title', 'middle');
      tx(LK.W / 2, 56, kind === 'i' ? 'No address: invalidation clears every valid bit.' : 'No address and no tag compare: the controller walks the sets directly.', 'cx-lk-small', 'middle');
      var ms = v.set !== undefined && v.set !== null ? v.set : null;
      strip(kind === 'i' ? 16 : 8, ms, st);
      if (kind === 'd' && ms !== null) st.d.sets[ms].ways.forEach(function (w, wi) {
        card(wi ? 300 : 40, 252, w, wi, ms, { focus: v.way === wi, dim: v.way !== undefined && v.way !== wi, words: v.way === wi ? ev.words : null, wordTone: 'dirty' });
      });
      else placeholder(ev && ev.kind === 'reset' ? 'Every valid, dirty and LRU bit cleared' : ev && ev.kind === 'invalidate' ? 'Every I-cache line is now invalid' : 'Dirty ways are written back set by set', ev && ev.kind === 'reset' ? 'Dirty data is lost: nothing is written back.' : 'Valid lines stay valid.');
      return root;
    }

    /* ---- cached lookups: D (two ways) or I (direct mapped) ---- */
    var f = v.fields, incoming = f.tag;
    drawBits(true, true);
    var idxGroup = groups[1];
    var n = kind === 'i' ? 16 : 8;
    var showSet = kind === 'i' || v.phase !== 'split';
    var sp = strip(n, showSet ? v.index : null, kind === 'd' && (v.phase === 'select' || v.phase === 'compare') ? v.probeState : st);
    if (showSet) setWire(idxGroup, sp.x0, sp.cw, v.index);
    var lanes2 = [];
    for (var lb = 0; lb < (kind === 'i' ? 4 : v.size || 4); lb++) lanes2.push((kind === 'i' ? 0 : f.byte) + lb);
    var ev2 = v.ev;

    if (kind === 'i') {
      var lineNow = st.i.lines[v.index];
      if (v.retained) {
        card(40, 512, lineNow, 0, v.index, { dim: true });
        tx(296, 202, 'Retained refill fault for this line: answered without a lookup', 'cx-lk-note is-fault', 'middle');
        result('FAULT', 'fault', null, 'no new beat', allPhase ? 0.4 : null);
        return root;
      }
      var cmpState = v.phase === 'all' ? 'done' : 'latched';
      var shownLine = v.phase === 'all' ? v.anchor.state.i.lines[v.index] : lineNow;
      var hit = v.compare.match;
      card(40, 512, shownLine, 0, v.index, { stageDelay: allPhase ? 0.3 : undefined, diffWith: v.phase === 'all' ? incoming : null, col: f.word, words: hit || (ev2 && ev2.kind === 'ifill') ? (ev2.words || [f.word]) : null, lanes: lanes2, hit: hit, wordTone: ev2 && ev2.kind === 'ifill' ? 'fill' : 'hit' });
      bus([40], incoming, cmpState);
      comparator(40, v.compare, incoming, cmpState);
      path('M254,209 V234 H280 V238', 'cx-lk-wire is-hitline');
      var rightText = hit ? 'word ' + f.word + ' → ' + (o.decode ? o.decode(shownLine.data[f.word], f.address & ~3).slice(0, 24) : hx(shownLine.data[f.word]))
        : ev2 && ev2.kind === 'ifill' ? (ev2.tone === 'fault' ? 'refill failed: no line installed' : 'refill installs tag, data, V') : 'one 8-byte refill beat';
      result(hit ? 'HIT' : 'MISS', hit ? 'hit' : v.fault ? 'fault' : 'miss', null, rightText, allPhase ? 0.78 : null);
      return root;
    }

    // D-cache
    var setNow = st.d.sets[v.index];
    var preSet = v.probeState.d.sets[v.index];
    var phase = v.phase;
    var cmpSt = phase === 'compare' ? 'done' : phase === 'after' ? 'latched' : 'pending';
    if (phase === 'split') {
      placeholder('Next: bits [6:4] select set ' + f.index, 'Both ways of that set are read and compared with tag ' + tagHex(incoming) + '.');
      result('…', 'pending', null, null, null);
      return root;
    }
    var waysShown = phase === 'after' ? setNow.ways : preSet.ways;
    var lruNow = phase === 'after' ? setNow.lru : preSet.lru;
    var xs = [40, 300];
    waysShown.forEach(function (w, wi) {
      var focusWay = ev2 && ev2.way === wi && phase === 'after';
      var hitHere = phase === 'compare' && v.hitWay === wi;
      card(xs[wi], 252, w, wi, v.index, {
        stageDelay: phase === 'select' ? 0.1 : undefined,
        diffWith: phase === 'compare' ? incoming : null,
        lru: lruNow === wi && phase !== 'after' ? true : false,
        col: f.word, lanes: lanes2,
        words: hitHere ? [f.word] : focusWay ? ev2.words : null,
        wordTone: hitHere ? 'hit' : ev2 ? ev2.tone : null,
        hit: hitHere || (phase === 'after' && ev2 && ev2.kind === 'complete' && ev2.way === wi),
        focus: focusWay, victim: phase === 'after' && v.miss && v.miss.way === wi,
        dim: phase === 'after' && ev2 && ev2.way !== undefined && ev2.way !== wi
      });
    });
    bus(xs, incoming, cmpSt);
    v.compare.forEach(function (c, wi) { comparator(xs[wi], c, incoming, cmpSt); });
    hitWires(xs);
    var resText, resTone, right = null, left = null, delay = phase === 'compare' ? 0.35 : null;
    if (phase === 'select') { resText = '…'; resTone = 'pending'; right = 'compare valid && tag'; }
    else if (v.hitWay >= 0) {
      resText = 'HIT · way ' + v.hitWay; resTone = 'hit';
      var wordNow = waysShown[v.hitWay].data[f.word];
      right = v.write ? 'store merges into word ' + f.word : 'word ' + f.word + ' = ' + hx(wordNow);
      if (phase === 'after' && ev2 && ev2.kind === 'complete') right = v.write ? 'word ' + f.word + ' now dirty' : 'returns ' + hx(ev2.value);
    } else {
      resText = phase === 'after' ? 'MISS at lookup' : 'MISS'; resTone = 'miss';
      var victim = v.miss ? v.miss.way : preSet.lru;
      left = 'victim way ' + victim;
      if (phase === 'after' && ev2) {
        if (ev2.kind === 'writeback') right = ev2.tone === 'fault' ? 'write-back failed' : 'writing back old words ' + (ev2.words || []).join('–');
        else if (ev2.kind === 'fill') right = ev2.tone === 'fault' ? 'refill failed' : 'refill words ' + (ev2.words || []).join('–') + (ev2.words && ev2.words[0] ? ': tag and V set' : '');
        else if (ev2.kind === 'complete') right = 'completes on refilled way ' + ev2.way;
        else if (ev2.kind === 'fault') { right = 'access fault'; resTone = 'fault'; }
        else right = 'LRU bit picks way ' + victim;
      } else right = 'LRU bit picks way ' + victim;
    }
    result(resText, resTone, left, right, delay);
    return root;
  }

  /* ---------- mount ---------- */

  function mount(holder, options) {
    options = options || {};
    var M = window.PrismCacheModel;
    if (!M) {
      holder.replaceChildren(h('p', { class: 'cx-missing', text: 'The cache model (assets/cache-model.js) did not load, so the local cache explorer is unavailable.' }));
      return { dispose: function () {} };
    }
    var id = 'cx' + (++serial);
    var disposed = false, timer = null, playing = false, runId = 0, abort = null, busy = false;
    var storageKey = 'prism-cache-program';

    /* ---------- session (timeline) ---------- */
    function newSession(mode, env, start, segments) {
      return { mode: mode, env: env, start: start, ops: [], flat: [], segments: segments || [], summary: null, serial: ++serial };
    }
    var session = newSession('model', M.createEnv('soc', []), M.createState(), []);
    var cursor = -1;

    /* View-only phase: between decoding a cacheable address and comparing tags,
       show the set being read. It changes no state and is not part of the model. */
    function withViewPhases(events) {
      var out = [];
      events.forEach(function (e, j) {
        out.push(e);
        var next = events[j + 1];
        if (e.kind === 'decode' && e.cache === 'd' && e.set !== null && e.set !== undefined && next && next.kind === 'probe') {
          out.push({ kind: 'select', view: true, cache: 'd', tone: 'info', title: 'Bits [6:4] = ' + e.set + ': read set ' + e.set + ', both ways',
            text: 'The set index selects one of the 8 sets. Both ways\' valid bits and tags go to two comparators at once, and their data words are read in parallel. Nothing changes in the arrays.',
            source: ['source/core_tiles/base/rtl/caches/dcache.sv: probe_hit (cache[probe_addr.idx].frames[way])'], set: e.set, fields: e.fields, address: e.address, state: e.state, flow: null });
        }
      });
      return out;
    }
    function addOp(op) {
      var index = session.ops.length;
      op.events = withViewPhases(op.events);
      op.index = index; op.first = session.flat.length;
      session.ops.push(op);
      op.events.forEach(function (e, j) { session.flat.push({ op: index, ev: j }); });
      op.last = session.flat.length - 1;
      return op;
    }
    function liveState() { return session.flat.length ? eventAt(session.flat.length - 1).state : session.start; }
    function eventAt(k) { var f = session.flat[k]; return session.ops[f.op].events[f.ev]; }
    function stateAt(k) { return k < 0 ? session.start : eventAt(k).state; }

    function ensureModelSession() {
      if (session.mode === 'model') return false;
      var st = JSON.parse(JSON.stringify(liveState())), mem = {};
      Object.keys(st.mem).forEach(function (k) {
        var a = parseInt(k, 16);
        mem[hex8(a >= 0x8000 ? 0x80000000 + (a - 0x8000) : a)] = st.mem[k];
      });
      st.mem = mem;
      session = newSession('model', M.createEnv('soc', session.segments), st, session.segments);
      cursor = -1;
      return true;
    }

    /* ---------- DOM ---------- */
    var section = h('section', { class: 'cx' + (options.compact ? ' is-compact' : ''), 'aria-labelledby': id + '-title' });
    var head = h('div', { class: 'cx-head' + (options.compact ? ' visually-hidden' : '') }, [
      h('h2', { id: id + '-title', text: 'Local caches in the Base core tile' }),
      options.compact ? null : h('p', { class: 'cx-lede', text: 'Run a load or store, or a program, and watch the address split into tag, set and offset, the tag compare in each way, and the refills and write-backs behind it.' })
    ]);
    var about = h('details', { class: 'cx-about' }, [
      h('summary', { text: 'About these caches' }),
      h('ul', { class: 'cx-facts' }, [
        h('li', {}, [h('strong', { text: 'I-cache' }), ' direct-mapped, 16 lines × 8 bytes (two instructions) = 128 B. Tag [31:7], line [6:3], word [2]. One 8-byte beat refills a line. It caches every fetched address.']),
        h('li', {}, [h('strong', { text: 'D-cache' }), ' 2-way set-associative, 8 sets × 16-byte lines = 256 B, write-back and write-allocate. Tag [31:7], set [6:4], word [3:2], byte [1:0]. A line moves as two 8-byte beats.']),
        h('li', {}, [h('strong', { text: 'Blocking and non-coherent' }), ' One request outstanding per cache. Lines are invalid, valid or dirty.']),
        h('li', {}, [h('strong', { text: 'Cacheable' }), ' Data: only the reserved RAM window 0x8000_0000–0x9FFF_FFFF. Every other data address bypasses the D-cache as one beat. A reserved RAM address with nothing installed is still cacheable; its refill fails.'])
      ]),
      h('p', { class: 'cx-provenance-note' }, [
        h('span', { class: 'cx-badge is-model', text: 'Modeled' }), ' JavaScript cache model written from icache.sv and dcache.sv, with no cycle timing. ',
        h('span', { class: 'cx-badge is-rtl', text: 'Base RTL' }), ' Prism\'s Base tile RTL running in your browser; the model replays it beat by beat and reports any disagreement. ',
        'The "read set" step is a view-only phase: the RTL reads the set and compares tags in the same cycle.'
      ])
    ]);

    /* toolbar: drive tabs, request inputs, maintenance */
    var tabAccess = h('button', { type: 'button', role: 'tab', id: id + '-tab-a', 'aria-controls': id + '-panel-a', 'aria-selected': 'true', class: 'cx-tab', text: 'One access' });
    var tabProgram = h('button', { type: 'button', role: 'tab', id: id + '-tab-p', 'aria-controls': id + '-panel-p', 'aria-selected': 'false', tabindex: '-1', class: 'cx-tab', text: 'Program' });
    var tablist = h('div', { class: 'cx-tabs', role: 'tablist', 'aria-label': 'Drive the caches' }, [tabAccess, tabProgram]);

    function regSelect(idSuffix, value) {
      return h('select', { id: id + idSuffix }, ABI.map(function (n, i) { return h('option', { value: String(i), text: n + ' (x' + i + ')', selected: i === value ? 'selected' : null }); }));
    }
    var asmInput = h('input', { type: 'text', id: id + '-asm', class: 'cx-asm', value: 'lw a0, 0(t0)', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-describedby': id + '-asm-help ' + id + '-asm-error' });
    var opSelect = h('select', { id: id + '-op' }, Object.keys(OPS).map(function (k) { return h('option', { value: k, text: k }); }));
    var regSel = regSelect('-reg', 10), baseSel = regSelect('-base', 5);
    var baseValue = h('input', { type: 'text', id: id + '-basev', class: 'cx-mono', value: '0x80000000', spellcheck: 'false', autocomplete: 'off', inputmode: 'text' });
    var offsetInput = h('input', { type: 'text', id: id + '-off', class: 'cx-mono', value: '0', spellcheck: 'false', autocomplete: 'off' });
    var storeValue = h('input', { type: 'text', id: id + '-val', class: 'cx-mono', value: '0x12345678', spellcheck: 'false', autocomplete: 'off' });
    var regLabel = h('label', { for: regSel.id, text: 'Destination rd' });
    var baseLabel = h('label', { for: baseValue.id, class: 'cx-inline-label', text: 't0 =' });
    var valueLabel = h('label', { for: storeValue.id, class: 'cx-inline-label', text: 'rs2 =' });
    var asmError = h('p', { id: id + '-asm-error', class: 'cx-error', role: 'alert' });
    var effective = h('div', { class: 'cx-effective', 'aria-live': 'polite' });
    var runAccess = h('button', { type: 'button', class: 'cx-primary', text: 'Run access' });
    var presets = h('select', { id: id + '-preset' }, [
      ['', 'Choose an example address…'], ['0x80000000|0', 'RAM, set 0: 0x8000_0000'], ['0x80000000|128', 'Same set, new tag: 0x8000_0080'], ['0x80000000|256', 'Third tag in set 0: 0x8000_0100'],
      ['0x80000000|4', 'Same line, next word: 0x8000_0004'], ['0x80000040|0', 'RAM, set 4: 0x8000_0040'], ['0x80000030|6', 'Set 3, word 1, byte 2: 0x8000_0036'],
      ['0x00000000|4', 'Boot ROM (uncached): 0x0000_0004'], ['0x40020000|0', 'UART register (uncached): 0x4002_0000'], ['0x40010000|8', 'gpio_a register (uncached): 0x4001_0008'],
      ['0x40000000|0', 'sysctrl, reserved only: 0x4000_0000'], ['0x80010000|0', 'RAM window past 64 KiB: 0x8001_0000']
    ].map(function (p) { return h('option', { value: p[0], text: p[1] }); }));
    function field(label, control, extra) { return h('div', { class: 'cx-field' + (extra ? ' ' + extra : '') }, [typeof label === 'string' ? h('label', { for: control.id, text: label }) : label, control]); }
    var moreToggle = h('button', { type: 'button', class: 'cx-more-toggle', 'aria-expanded': 'false', 'aria-controls': id + '-more', text: 'Fields' });
    var moreFields = h('div', { class: 'cx-more', id: id + '-more', hidden: 'hidden', role: 'group', 'aria-label': 'Request fields' }, [
      effective,
      h('div', { class: 'cx-grid' }, [field('Operation', opSelect), field(regLabel, regSel), field('Base register rs1', baseSel), field('Offset (signed 12-bit)', offsetInput), field('Example address', presets)]),
      h('p', { id: id + '-asm-help', class: 'cx-help', text: 'lw rd, offset(rs1) or sw rs2, offset(rs1); also lh, lhu, lb, lbu, sh, sb. One access drives the D-cache directly; run a program to see instruction fetches.' })
    ]);
    var storeWrap = h('span', { class: 'cx-inline' }, [valueLabel, storeValue]);
    var panelAccess = h('div', { role: 'tabpanel', id: id + '-panel-a', 'aria-labelledby': tabAccess.id, class: 'cx-panel cx-request' }, [
      h('label', { for: asmInput.id, class: 'visually-hidden', text: 'RISC-V load or store' }), asmInput,
      h('span', { class: 'cx-inline' }, [baseLabel, baseValue]), storeWrap, runAccess, moreToggle
    ]);

    var exampleSel = h('select', { id: id + '-example', 'aria-label': 'Example program' }, EXAMPLES.map(function (e, i) { return h('option', { value: String(i), text: e.name }); }));
    var loadExample = h('button', { type: 'button', text: 'Load example' });
    var exampleNote = h('p', { class: 'cx-help' });
    var source = h('textarea', { id: id + '-source', class: 'cx-source', rows: '12', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-describedby': id + '-prog-help' });
    var initial = options.initialProgram;
    if (typeof initial !== 'string') { try { initial = window.sessionStorage.getItem(storageKey); } catch (e) { initial = null; } }
    source.value = typeof initial === 'string' && initial.trim() ? initial : EXAMPLES[0].source;
    var limit = h('input', { id: id + '-limit', type: 'number', min: '1', max: '20000', step: '1', value: '4000', inputmode: 'numeric' });
    var runModel = h('button', { type: 'button', class: 'cx-primary', text: 'Run program', title: 'Uses the cache model when supported; otherwise runs the whole program on Base RTL' });
    var runRtl = h('button', { type: 'button', text: 'Run on Base RTL' });
    var progStatus = h('p', { class: 'cx-status', role: 'status', 'aria-live': 'polite' });
    var diagnostics = h('ul', { class: 'cx-diagnostics', 'aria-label': 'Assembly diagnostics' });
    var rtlSummary = h('details', { class: 'cx-summary', hidden: 'hidden' });
    var editorSummary = h('summary', { text: 'Edit assembly' });
    var editor = h('details', { class: 'cx-editor' }, [editorSummary,
      h('div', { class: 'cx-editor-body' }, [
        exampleNote,
        h('label', { for: source.id, class: 'cx-source-label', text: 'RISC-V assembly' }),
        source,
        h('p', { id: id + '-prog-help', class: 'cx-help' }, [
          'Code at 0x0000_0000, data at 0x8000_0000; end with ', h('code', { text: 'halt' }), '. ',
          h('strong', { text: 'Run program' }), ' uses the cache model for ' + M.SUBSET + '. Other instructions, including cycle-counter reads, use the Base RTL automatically. ',
          h('strong', { text: 'Run on Base RTL' }), ' always runs the Base RTL. RTL runs use a flat memory bench with no peripherals; the diagram labels that address map.'
        ]),
        field('RTL cycle limit', limit, 'is-narrow')
      ])
    ]);
    var panelProgram = h('div', { role: 'tabpanel', id: id + '-panel-p', 'aria-labelledby': tabProgram.id, class: 'cx-panel cx-program', hidden: 'hidden' }, [
      exampleSel, loadExample, runModel, runRtl
    ]);
    var programExtra = h('div', { class: 'cx-program-extra', hidden: 'hidden' }, [editor, progStatus, diagnostics, rtlSummary]);

    var flushBtn = h('button', { type: 'button', class: 'cx-maint', title: 'fence.i: clean the D-cache, then invalidate the I-cache', 'aria-label': 'Flush: fence.i, clean D then invalidate I', text: 'fence.i' });
    var cleanBtn = h('button', { type: 'button', class: 'cx-maint', title: 'fence: write back dirty D lines; every line stays valid', 'aria-label': 'Clean D: fence, write back dirty lines', text: 'fence' });
    var resetBtn = h('button', { type: 'button', class: 'cx-maint', title: 'n_rst: clear both caches; dirty data is lost', 'aria-label': 'Cold reset: clear both caches, dirty data is lost', text: 'Reset' });
    var maintHelp = h('details', { class: 'cx-explain' }, [
      h('summary', { id: id + '-mhelp', 'aria-label': 'What the maintenance actions do', title: 'What these do', text: '?' }),
      h('ul', { class: 'cx-popover' }, [
        h('li', {}, [h('strong', { text: 'fence.i (flush)' }), ' cleans the D-cache, then raises icache.invalidate: every I line becomes invalid once any outstanding refill has finished. D lines stay valid.']),
        h('li', {}, [h('strong', { text: 'fence (clean D)' }), ' visits sets 0 to 7 and writes back each dirty way, way 0 first, as two 64-bit beats. Valid bits, tags, data and LRU bits stay.']),
        h('li', {}, [h('strong', { text: 'Reset' }), ' (n_rst, a cold reset) clears valid, dirty and LRU bits in both caches without writing anything back. halt runs the same clean as fence and then stops.'])
      ])
    ]);
    var maintenance = h('div', { class: 'cx-maintenance', role: 'group', 'aria-label': 'Cache maintenance', 'aria-describedby': id + '-mhelp' }, [flushBtn, cleanBtn, resetBtn, maintHelp]);
    var toolbar = h('div', { class: 'cx-control' }, [h('div', { class: 'cx-toolbar' }, [tablist, panelAccess, panelProgram, maintenance]), asmError, moreFields, programExtra]);

    /* player and one-line caption (sticky together) */
    var ICONS = { first: 'M5 4h2v12H5zM16 4v12L8 10z', prev: 'M14 4v12L6 10z', play: 'M6 4v12l10-6z', pause: 'M5 4h3.5v12H5zM11.5 4H15v12h-3.5z', next: 'M6 4v12l8-6z', last: 'M13 4h2v12h-2zM4 4v12l8-6z' };
    function icon(name) { return svg('svg', { viewBox: '0 0 20 20', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' }, [svg('path', { d: ICONS[name], fill: 'currentColor' })]); }
    function iconButton(name, label, title, extra) { var b = h('button', { type: 'button', class: 'cx-icon' + (extra ? ' ' + extra : ''), 'aria-label': label, title: title }); b.appendChild(icon(name)); return b; }
    var btnFirst = iconButton('first', 'Go to the first step', 'First step');
    var btnPrev = iconButton('prev', 'Previous step', 'Previous step (←)');
    var btnPlay = iconButton('play', 'Play', 'Play or pause (space)', 'cx-play');
    btnPlay.setAttribute('aria-pressed', 'false');
    var btnNext = iconButton('next', 'Next step', 'Next step (→)');
    var btnLast = iconButton('last', 'Go to the last step', 'Last step');
    var speed = h('select', { id: id + '-speed', 'aria-label': 'Playback speed' }, SPEEDS.map(function (s) { return h('option', { value: s[0], text: s[1], selected: s[0] === '1' ? 'selected' : null }); }));
    var position = h('span', { class: 'cx-position' });
    var sessionBadge = h('span', { class: 'cx-badge' });
    var narrative = h('div', { class: 'cx-narrative' });
    var player = h('div', { class: 'cx-player', role: 'group', 'aria-label': 'Step through cache events', tabindex: '-1' }, [
      h('div', { class: 'cx-transport' }, [btnFirst, btnPrev, btnPlay, btnNext, btnLast]),
      speed, position, narrative, sessionBadge
    ]);
    var whyPanel = h('div', { id: id + '-why', class: 'cx-why-panel', role: 'region', 'aria-label': 'Step details', hidden: 'hidden' });
    var sticky = h('div', { class: 'cx-sticky' }, [player, whyPanel]);
    var detailsOpen = false;

    /* workspace: lookup diagram + transport strip | cache tables and logs */
    var lkHead = h('div', { class: 'cx-lk-head' });
    var zoomLookup = h('button', { type: 'button', class: 'cx-lk-zoom', 'aria-pressed': 'false', 'aria-label': 'Enlarge the lookup and transport diagrams', text: 'Enlarge' });
    zoomLookup.addEventListener('click', function () {
      var enlarged = lookupCol.classList.toggle('is-enlarged');
      zoomLookup.setAttribute('aria-pressed', String(enlarged));
      zoomLookup.textContent = enlarged ? 'Fit' : 'Enlarge';
      zoomLookup.setAttribute('aria-label', enlarged ? 'Fit diagrams to the available width' : 'Enlarge the lookup and transport diagrams');
      if (enlarged) {
        lkWrap.tabIndex = 0;
        flowWrap.tabIndex = 0;
      }
      else {
        lkWrap.removeAttribute('tabindex');
        flowWrap.removeAttribute('tabindex');
        lkWrap.scrollLeft = 0;
        flowWrap.scrollLeft = 0;
      }
    });
    var lkWrap = h('div', { class: 'cx-lk', role: 'group', 'aria-label': 'Address split and tag lookup' });
    var lkText = h('p', { class: 'visually-hidden cx-lk-sr' });
    var flow = buildFlow();
    var flowWrap = h('div', { class: 'cx-flow' }, [flow.root]);
    var envLabel = h('p', { class: 'cx-env' });
    var infoCard = h('div', { class: 'cx-info', id: id + '-info', role: 'region', 'aria-label': 'Selected block', hidden: 'hidden' });
    var figure = h('figure', { class: 'cx-figure' }, [flowWrap, envLabel, infoCard]);

    var legend = h('div', { class: 'cx-legend-row' });
    var dTable = h('div', { class: 'cx-dcache', role: 'region', 'aria-label': 'D-cache contents', tabindex: '0' });
    var iTable = h('div', { class: 'cx-icache', role: 'region', 'aria-label': 'I-cache contents', tabindex: '0' });
    var memView = h('div', { class: 'cx-memory' });
    var beatView = h('div', { class: 'cx-beats' });
    var tally = h('dl', { class: 'cx-tally' });
    var opLog = h('ol', { class: 'cx-oplog' });
    var announcer = h('p', { class: 'visually-hidden cx-sr', 'aria-live': 'polite' });

    var VIEWS = [['d', 'D-cache'], ['i', 'I-cache'], ['mem', 'Memory'], ['beats', 'Beats'], ['hist', 'History']];
    var viewTabs = {}, viewPanels = {};
    var viewBodies = { d: [dTable], i: [iTable], mem: [memView], beats: [beatView], hist: [tally, opLog] };
    VIEWS.forEach(function (v) {
      viewTabs[v[0]] = h('button', { type: 'button', role: 'tab', id: id + '-vt-' + v[0], 'aria-controls': id + '-vp-' + v[0], 'aria-selected': 'false', tabindex: '-1', class: 'cx-vtab', 'data-view': v[0] }, [v[1], h('span', { class: 'cx-vcount' })]);
      viewPanels[v[0]] = h('div', { role: 'tabpanel', id: id + '-vp-' + v[0], 'aria-labelledby': id + '-vt-' + v[0], class: 'cx-vpanel cx-vpanel-' + v[0], hidden: 'hidden' }, viewBodies[v[0]]);
    });
    var viewList = h('div', { class: 'cx-vtabs', role: 'tablist', 'aria-label': 'Cache contents and logs' }, VIEWS.map(function (v) { return viewTabs[v[0]]; }));
    var stateRow = h('div', { class: 'cx-states' }, [legend]);
    var view = 'd', viewPicked = false;
    var viewCol = h('div', { class: 'cx-viewcol' }, [h('div', { class: 'cx-viewbox' }, [viewList, stateRow].concat(VIEWS.map(function (v) { return viewPanels[v[0]]; })))]);
    var lookupCol = h('div', { class: 'cx-lookupcol' }, [lkHead, lkWrap, lkText, figure]);
    var work = h('div', { class: 'cx-work' }, [lookupCol, viewCol]);
    var stage = h('div', { class: 'cx-stage' }, [sticky, work, announcer]);
    section.appendChild(head); section.appendChild(toolbar); section.appendChild(stage); section.appendChild(about);
    holder.replaceChildren(section);

    function selectView(v, focus, byUser) {
      view = v;
      if (byUser) viewPicked = true;
      VIEWS.forEach(function (x) {
        var on = x[0] === v;
        viewTabs[x[0]].setAttribute('aria-selected', on ? 'true' : 'false');
        viewTabs[x[0]].tabIndex = on ? 0 : -1;
        viewPanels[x[0]].hidden = !on;
      });
      stateRow.hidden = !(v === 'd' || v === 'i');
      if (focus) viewTabs[v].focus();
    }
    VIEWS.forEach(function (x) { viewTabs[x[0]].addEventListener('click', function () { selectView(x[0], false, true); }); });
    viewList.addEventListener('keydown', function (e) {
      var keys = VIEWS.map(function (x) { return x[0]; }), i = keys.indexOf(view);
      var next = e.key === 'ArrowRight' ? keys[(i + 1) % keys.length] : e.key === 'ArrowLeft' ? keys[(i + keys.length - 1) % keys.length] : e.key === 'Home' ? keys[0] : e.key === 'End' ? keys[keys.length - 1] : null;
      if (!next) return;
      e.preventDefault(); e.stopPropagation();
      selectView(next, true, true);
    });
    selectView('d');

    // Local line states only: the RTL caches have no coherence states. The link
    // leads to the separate illustrative model, which is labelled WIP there.
    function renderLegend() {
      var items = [['is-invalid', 'Invalid'], ['is-clean', 'Clean'], ['is-dirty', 'Dirty'], ['is-victim', 'Next victim']];
      legend.replaceChildren(
        h('ul', { class: 'cx-legend', 'aria-label': 'Line states' }, items.map(function (x) { return h('li', {}, [h('span', { class: 'cx-swatch ' + x[0] }), x[1]]); })),
        h('p', { class: 'cx-coh-note' }, ['Non-coherent. ', h('a', { href: '#/architecture/caches/coherent', text: 'Coherence demo (WIP)' })]));
    }
    renderLegend();

    /* ---------- one-access form ---------- */
    function syncFromAsm() {
      var p = parseAccess(asmInput.value);
      if (p.error) { asmError.textContent = p.error; asmInput.setAttribute('aria-invalid', 'true'); updateEffective(); return null; }
      asmError.textContent = ''; asmInput.removeAttribute('aria-invalid');
      opSelect.value = p.op; regSel.value = String(p.reg); baseSel.value = String(p.base); offsetInput.value = String(p.offset);
      updateFormMode(); updateEffective();
      return p;
    }
    function asmFromFields() {
      var off = parseNumber(offsetInput.value);
      asmInput.value = opSelect.value + ' ' + ABI[+regSel.value] + ', ' + (off === null ? offsetInput.value.trim() : off) + '(' + ABI[+baseSel.value] + ')';
      syncFromAsm();
    }
    function updateFormMode() {
      var write = OPS[opSelect.value][0];
      regLabel.textContent = write ? 'Source rs2' : 'Destination rd';
      valueLabel.textContent = ABI[+regSel.value] + ' =';
      storeWrap.hidden = !write;
      storeValue.disabled = !write;
      baseLabel.textContent = ABI[+baseSel.value] + ' =';
      if (+baseSel.value === 0) { baseValue.value = '0'; baseValue.disabled = true; } else baseValue.disabled = false;
    }
    function formRequest() {
      var p = parseAccess(asmInput.value);
      if (p.error) return { error: p.error };
      var base = parseNumber(baseValue.value);
      if (p.base === 0) base = 0;
      if (base === null || base < -2147483648 || base > 0xffffffff) return { error: 'The base address must be a 32-bit number, for example 0x80000000.' };
      var spec = OPS[p.op], data = 0;
      if (spec[0]) {
        data = p.reg === 0 ? 0 : parseNumber(storeValue.value);
        if (data === null || data < -2147483648 || data > 0xffffffff) return { error: 'The store data must be a 32-bit number.' };
      }
      var address = (base + p.offset) >>> 0;
      return { parsed: p, base: base >>> 0, request: { write: spec[0], size: spec[1], address: address, data: data >>> 0, mnemonic: p.op } };
    }
    function updateEffective() {
      var f = formRequest();
      effective.replaceChildren();
      if (f.error) { effective.appendChild(h('span', { class: 'cx-muted', text: f.error })); return; }
      var a = f.request.address, env = session.mode === 'model' ? session.env : M.createEnv('soc', session.segments);
      var c = M.classify(env, a), d = M.splitD(a);
      var align = (f.request.size === 2 && (a & 1)) || (f.request.size === 4 && (a & 3));
      effective.appendChild(h('span', { class: 'cx-eff-addr' }, ['Address ', h('code', { text: hxs(f.base) }), f.parsed.offset < 0 ? ' − ' : ' + ', h('code', { text: String(Math.abs(f.parsed.offset)) }), ' = ', h('strong', { class: 'cx-mono', text: hxs(a) })]));
      var tone = align ? 'is-fault' : c.cacheable ? (c.kind === 'ram' ? 'is-cached' : 'is-fault') : (c.kind === 'device' || c.kind === 'rom' ? 'is-bypass' : 'is-fault');
      var what = align ? 'Misaligned: the hart traps before the cache' :
        c.cacheable ? (c.kind === 'ram' ? 'Cacheable RAM · set ' + d.index + ', tag ' + hx(d.tag) + ', word ' + d.word : 'Cacheable window, but beyond the 64 KiB installed: the refill will fail') :
        c.kind === 'rom' ? 'Boot ROM · uncached' + (f.request.write ? ' (read-only: the write will fail)' : '') :
        c.kind === 'device' ? c.label + (c.register ? ' · ' + c.register : ' · no register at this offset in the published map') + ' · uncached' :
        c.label + ' · uncached, the beat will fail';
      effective.appendChild(h('span', { class: 'cx-chip ' + tone, text: what }));
    }
    function formChanged() { updateEffective(); if (cursor < 0 && !inspect) renderLookup(null, null); }
    asmInput.addEventListener('input', function () { syncFromAsm(); formChanged(); });
    asmInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAccess(); } });
    [opSelect, regSel, baseSel].forEach(function (el) { el.addEventListener('change', function () { updateFormMode(); asmFromFields(); formChanged(); }); });
    offsetInput.addEventListener('input', function () { asmFromFields(); formChanged(); });
    [baseValue, storeValue].forEach(function (el) {
      el.addEventListener('input', formChanged);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAccess(); } });
    });
    presets.addEventListener('change', function () {
      if (!presets.value) return;
      var p = presets.value.split('|');
      baseValue.value = p[0]; if (+baseSel.value === 0) baseSel.value = '5';
      offsetInput.value = p[1];
      updateFormMode(); asmFromFields(); formChanged();
      presets.value = '';
    });
    moreToggle.addEventListener('click', function () {
      var open = moreFields.hidden;
      moreFields.hidden = !open;
      moreToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    runAccess.addEventListener('click', doAccess);

    function encodingOf(text) {
      if (!window.PrismAsm) return null;
      try { var r = window.PrismAsm.assemble(text + '\n', { profile: 'base' }); return r.ok && r.listing.length ? r.listing[0].word : null; } catch (e) { return null; }
    }
    /* A newer user action owns the explorer: cancel any pending RTL run so its
       late completion can neither publish a session nor call onAccess. */
    function supersede(reason) {
      runId++;
      if (abort) { abort.abort(); abort = null; }
      if (busy) {
        setBusy(false);
        if (reason) progStatus.textContent = 'RTL run cancelled: ' + reason;
      }
    }
    function notifyClear() {
      if (typeof options.onAccess !== 'function') return;
      try { options.onAccess(null); } catch (e) { /* the host's callback must not break the explorer */ }
    }
    function doAccess() {
      var f = formRequest();
      if (f.error) { asmError.textContent = f.error; asmInput.focus(); return; }
      stop(); supersede('a single access replaced it.');
      var switched = ensureModelSession();
      var r = M.dataAccess(liveState(), session.env, f.request);
      var p = f.parsed, text = asmInput.value.trim().replace(/\s+/g, ' ');
      var res = r.result, enc = encodingOf(text);
      var summary;
      if (res.fault) summary = res.fault === 'misaligned' ? 'misaligned' : 'access fault';
      else if (f.request.write) summary = res.cacheable ? (res.hit ? 'hit, dirty' : 'miss, allocated dirty') : 'uncached write';
      else summary = (res.cacheable ? (res.hit ? 'hit' : 'miss') : 'uncached') + (res.value !== null && res.value !== undefined ? ' → ' + ABI[p.reg] + ' = ' + hx(signExtend(res.value, p.op)) : ' → ' + ABI[p.reg] + ' = device data');
      var op = addOp({ kind: 'access', provenance: 'model', label: text, summary: summary, encoding: enc, base: f.base, events: r.events, result: res, rd: f.request.write ? null : p.reg });
      if (switched) say('Continuing from the recorded run\'s final cache state, now in the modeled SoC address map.');
      notifyAccess(res, p.op, 'model');
      startOp(op);
    }
    function signExtend(v, op) {
      if (op === 'lb') return (v << 24 >> 24) >>> 0;
      if (op === 'lh') return (v << 16 >> 16) >>> 0;
      return v >>> 0;
    }
    function notifyAccess(res, mnemonic, provenance) {
      if (typeof options.onAccess !== 'function' || !res || res.fault) return;
      try {
        options.onAccess({ op: res.write ? 'sw' : 'lw', mnemonic: mnemonic, size: res.size, address: res.address >>> 0,
          value: res.write ? res.data >>> 0 : (res.value === null || res.value === undefined ? null : res.value >>> 0),
          cacheable: !!res.cacheable, region: res.region || res.kind || null, provenance: provenance });
      } catch (e) { /* the host's callback must not break the explorer */ }
    }

    /* ---------- maintenance ---------- */
    function doMaintenance(kind) {
      stop(); supersede('a maintenance action replaced it.');
      var switched = ensureModelSession();
      var st = liveState(), r, label, summary;
      if (kind === 'flush') { r = M.fenceI(st, session.env); label = 'fence.i (flush)'; summary = r.result.written + ' D line' + (r.result.written === 1 ? '' : 's') + ' written back, ' + r.result.cleared + ' I line' + (r.result.cleared === 1 ? '' : 's') + ' invalidated'; }
      else if (kind === 'clean') { r = M.clean(st, session.env, 'fence'); label = 'fence (clean D)'; summary = r.result.written + ' line' + (r.result.written === 1 ? '' : 's') + ' written back'; }
      else { r = M.reset(st); label = 'cold reset'; summary = r.result.lost ? r.result.lost + ' dirty line' + (r.result.lost === 1 ? '' : 's') + ' discarded' : 'caches cleared'; }
      var op = addOp({ kind: kind, provenance: 'model', label: label, summary: summary, events: r.events, result: r.result });
      if (switched) say('Continuing from the recorded run\'s final cache state, now in the modeled SoC address map.');
      if (kind === 'reset') notifyClear();   // the host's last access no longer describes these caches
      startOp(op);
    }
    flushBtn.addEventListener('click', function () { doMaintenance('flush'); });
    cleanBtn.addEventListener('click', function () { doMaintenance('clean'); });
    resetBtn.addEventListener('click', function () { doMaintenance('reset'); });

    /* ---------- program editor ---------- */
    function persist() {
      try { window.sessionStorage.setItem(storageKey, source.value); } catch (e) { /* storage may be unavailable on file:// */ }
      if (typeof options.onProgram === 'function') { try { options.onProgram(source.value); } catch (e) { /* ignore host errors */ } }
    }
    function updateEditorSummary() {
      var n = source.value.split('\n').filter(function (l) { return l.trim(); }).length;
      editorSummary.textContent = 'Edit assembly · ' + n + ' line' + (n === 1 ? '' : 's');
    }
    var persistTimer = null;
    source.addEventListener('input', function () {
      clearTimeout(persistTimer); persistTimer = setTimeout(persist, 300);
      diagnostics.replaceChildren(); source.removeAttribute('aria-invalid');
      progStatus.textContent = 'Source changed. Run program selects the cache model or Base RTL as needed.';
      updateEditorSummary();
    });
    function showExampleNote() { exampleNote.textContent = EXAMPLES[+exampleSel.value].note; }
    exampleSel.addEventListener('change', showExampleNote);
    loadExample.addEventListener('click', function () {
      source.value = EXAMPLES[+exampleSel.value].source; persist(); updateEditorSummary();
      diagnostics.replaceChildren(); progStatus.textContent = 'Example loaded: ' + EXAMPLES[+exampleSel.value].note;
    });
    function selectLine(line, column) {
      editor.open = true;
      var lines = source.value.split('\n'), start = 0;
      for (var i = 1; i < line && i <= lines.length; i++) start += lines[i - 1].length + 1;
      start += Math.max(0, (column || 1) - 1);
      source.focus(); source.setSelectionRange(start, Math.min(source.value.length, start + Math.max(1, (lines[line - 1] || '').length - (column || 1) + 1)));
    }
    function diagnostic(line, column, message, warning) {
      if (line) {
        message = message.replace(/^Line \d+:\s*/, '');
      }
      var b = h('button', { type: 'button', class: 'link-button', text: (warning ? 'Warning: ' : '') + (line ? 'Line ' + line + (column ? ', column ' + column : '') + ': ' : '') + message });
      if (line) b.addEventListener('click', function () { selectLine(line, column); });
      diagnostics.appendChild(h('li', { class: warning ? 'is-warning' : '' }, [b]));
    }
    function assemble() {
      diagnostics.replaceChildren();
      if (!window.PrismAsm) { progStatus.textContent = 'The assembler (assets/rv-asm.js) is not loaded, so programs cannot run here.'; return null; }
      var r = window.PrismAsm.assemble(source.value, { profile: 'base' });
      source.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
      r.errors.forEach(function (e) { diagnostic(e.line, e.column, e.message, false); });
      r.warnings.forEach(function (e) { diagnostic(e.line, e.column, e.message, true); });
      if (!r.ok) { editor.open = true; progStatus.textContent = 'Assembly failed with ' + r.errors.length + ' error' + (r.errors.length === 1 ? '' : 's') + '. Select one to go to its line.'; return null; }
      var code = r.segments.find(function (s) { return s.base === 0; });
      if (!code || !code.bytes.length) {
        editor.open = true;
        progStatus.textContent = 'The program has no code. Add instructions under .text.';
        return null;
      }
      return r;
    }
    runModel.addEventListener('click', function () {
      stop();
      supersede('a new program run replaced it.');
      persist();
      var a = assemble();
      if (!a) {
        return;
      }
      var r = M.runProgram(a.segments, a.listing, { maxInstructions: 1500, decode: decodeText });
      // The probe is private: an unsupported instruction sends the whole program
      // to the real core before any partial model state or access is published.
      if (r.stop.reason === 'unsupported') {
        var op = r.ops[r.ops.length - 1];
        runRtlProgram(a, { line: r.stop.line, source: stripComment(op.source || op.text) });
        return;
      }
      rtlSummary.hidden = true;
      session = newSession('model', r.env, M.createState(), a.segments);
      notifyClear();   // a new program session starts from reset
      var lastAccess = null;
      r.ops.forEach(function (o) {
        var label = stripComment(o.source) || o.text || hx(o.word);
        var summary = o.access ? (o.access.fault ? 'fault' : o.access.cacheable ? (o.access.hit ? 'D hit' : 'D miss') : 'uncached') : o.fence ? o.fence : o.halt ? 'halt: clean' : '';
        var ifetch = o.events[0];
        if (ifetch && ifetch.kind === 'ifetch' && ifetch.tone === 'miss') summary = (summary ? summary + ', ' : '') + 'I miss';
        if (o.events.length) addOp({ kind: 'instruction', provenance: 'model', label: label, pc: o.pc, line: o.line, summary: summary, events: o.events, result: o.access || null, unsupported: o.unsupported });
        if (o.access && !o.access.fault) lastAccess = { res: o.access, mn: (o.text || '').split(' ')[0] };
      });
      var halted = r.stop.reason === 'halt';
      progStatus.textContent = 'Model run: ' + r.ops.length + ' instruction' + (r.ops.length === 1 ? '' : 's') + '. ' +
        (!halted && r.stop.line ? 'Stopped at line ' + r.stop.line + '; see the diagnostic below.' : r.stop.message);
      if (!halted && r.stop.line) {
        editor.open = true;
        diagnostic(r.stop.line, 1, r.stop.message, false);
      }
      if (lastAccess) notifyAccess(lastAccess.res, lastAccess.mn, 'model');
      startSession();
    });
    function rtlAvailable() {
      return !!(window.PrismSim && window.PrismSim.available && window.PrismSim.available('base') &&
        window.PrismTraceCompiler && window.PrismAsm && typeof Worker === 'function');
    }
    function runRtlProgram(assembled, fallback) {
      stop();
      persist();
      if (!rtlAvailable()) {
        editor.open = true;
        progStatus.textContent = 'This program needs Base RTL, which is unavailable in this build.';
        if (fallback) {
          diagnostic(fallback.line, 1, '“' + fallback.source + '” requires core execution. The cache model cannot execute it; open a build that includes the Base RTL simulator.', true);
        }
        return;
      }
      var max = Number(limit.value);
      if (!Number.isInteger(max) || max < 1 || max > 20000) {
        editor.open = true;
        progStatus.textContent = 'The cycle limit must be a whole number from 1 to 20000.';
        limit.focus();
        return;
      }
      var a = assembled || assemble();
      if (!a) {
        return;
      }
      supersede();
      notifyClear();
      var current = runId, text = source.value;
      abort = typeof AbortController === 'function' ? new AbortController() : null;
      setBusy(true);
      progStatus.textContent = fallback ?
        'Running on Base RTL for “' + fallback.source + '” · flat memory bench, no peripherals…' :
        'Running on the Base tile RTL…';
      runBaseRtl(a.segments, max, abort && abort.signal).then(function (out) {
        if (disposed || current !== runId) return;
        var rows = window.PrismTraceCompiler.parseRows(out.trace || '');
        if (!rows.length) throw new Error((out.log || []).join(' ').slice(0, 300) || 'The simulation produced no cycles.');
        var stopInfo = stopOf(out, rows);
        var rep = M.replayRecording(rows, a.segments, { cacheCsv: out.csv, dumpHex: stopInfo.reason === 'halt' ? out.dump : null, decode: decodeText });
        var listing = {};
        a.listing.forEach(function (l) { if (!(hex8(l.address) in listing)) listing[hex8(l.address)] = l; });
        session = newSession('rtl', rep.env, M.createState(), a.segments);
        abort = null;
        var last = null;
        rep.ops.forEach(function (o) {
          var r = o.recorded, label, summary = '';
          var src = o.pc !== undefined ? listing[hex8(o.pc)] : null;
          if (o.kind === 'ifill') { label = 'I refill ' + hxs(r.address); summary = 'instruction beat'; }
          else if (o.kind === 'data') { label = (src && stripComment(src.source)) || o.text || hx(r.word); summary = o.result.cacheable ? (o.result.hit ? 'D hit' : 'D miss') : 'uncached'; last = { res: o.result, mn: label.split(/\s+/)[0] }; }
          else if (o.kind === 'halt') { label = 'halt: terminal clean'; summary = (o.result.written || 0) + ' written back'; }
          else { label = o.kind; summary = (o.result.written || 0) + ' written back'; }
          addOp({ kind: o.kind, provenance: 'rtl', label: label, line: src ? src.line : null, pc: o.pc, cycle: o.cycle, summary: summary + (o.artifact ? ', bench only' : ''), check: o.check, artifact: !!o.artifact, events: o.events, result: o.result });
        });
        session.summary = { stop: stopInfo, rep: rep, source: text };
        renderSummary();
        var counts = rep.ops.filter(function (o) { return o.kind === 'data'; }).length;
        progStatus.textContent = 'Base RTL run ' + (stopInfo.reason === 'halt' ? 'stopped at halt' : stopInfo.reason === 'max_cycles' ? 'reached the cycle limit' : stopInfo.reason === 'wfi' ? 'reached the cycle limit asleep in WFI' : 'stopped with an error: ' + stopInfo.message) +
          (stopInfo.cycle !== null ? ' at cycle ' + stopInfo.cycle : '') + '. ' + counts + ' data access' + (counts === 1 ? '' : 'es') + ' replayed.' +
          (fallback ? ' Selected automatically for “' + fallback.source + '”.' : '');
        if (last) notifyAccess(last.res, last.mn, 'rtl');
        startSession();
      }).catch(function (err) {
        if (disposed || current !== runId) return;
        progStatus.textContent = err && err.name === 'AbortError' ? 'Run cancelled.' : 'RTL run failed: ' + (err && err.message ? err.message : String(err));
      }).then(function () { if (!disposed && current === runId) setBusy(false); });
    }
    runRtl.addEventListener('click', function () {
      if (!runRtl.disabled) {
        runRtlProgram();
      }
    });
    function setBusy(b) { busy = b; refreshAvailability(); }
    function refreshAvailability() {
      var ok = rtlAvailable();
      runRtl.disabled = busy || !ok;
      runRtl.textContent = busy ? 'Running…' : 'Run on Base RTL';
      runModel.disabled = !window.PrismAsm;
      runRtl.title = ok ? 'Runs on the Base tile RTL compiled to WebAssembly' : 'The Base RTL model is not part of this build';
    }
    function renderSummary() {
      var s = session.summary;
      rtlSummary.replaceChildren();
      if (!s) { rtlSummary.hidden = true; return; }
      var rep = s.rep, data = rep.ops.filter(function (o) { return o.kind === 'data'; });
      var beats = rep.ops.reduce(function (n, o) { return n + (o.recorded && o.recorded.beats ? o.recorded.beats.length : 0); }, 0);
      var fills = rep.ops.filter(function (o) { return o.kind === 'ifill'; }).length;
      var ok = rep.mismatches.length === 0;
      rtlSummary.hidden = false;
      rtlSummary.open = !ok;
      rtlSummary.className = 'cx-summary ' + (ok ? 'is-ok' : 'is-bad');
      rtlSummary.appendChild(h('summary', {}, [h('span', { class: 'cx-pill ' + (ok ? 'is-ok' : 'is-bad'), text: ok ? '✓ Model and RTL agree' : '✗ Model and RTL disagree' }), ' ', h('span', { class: 'cx-muted', text: data.length + ' data accesses, ' + fills + ' I refills compared' })]));
      var ul = h('ul');
      ul.appendChild(h('li', { text: data.length + ' completed data accesses: the direction, address and order of ' + beats + ' D-channel beats, the way each cached access used and every load value ' + (ok ? 'match the recording.' : 'were compared.') }));
      ul.appendChild(h('li', { text: fills + ' I-cache refills recorded' + (ok ? '; the model missed on each of the same lines.' : '.') }));
      if (rep.final.checked) ul.appendChild(h('li', { text: 'Final caches: ' + (rep.final.ok ? 'every valid line\'s words identical to the bench\'s cache dump (' + rep.final.dLines + ' D lines, ' + rep.final.iLines + ' I lines).' : rep.final.problems.join(' ')) }));
      else ul.appendChild(h('li', { text: 'No final cache dump: the bench writes one only when the program reaches halt.' }));
      if (rep.final.memoryChecked) ul.appendChild(h('li', { text: 'Final memory: ' + (rep.final.memoryOk ? 'identical to the bench\'s memory dump.' : 'differs from the bench\'s memory dump.') }));
      rtlSummary.appendChild(ul);
      if (!ok) {
        var bad = h('ul', { class: 'cx-mismatch' });
        rep.mismatches.slice(0, 8).forEach(function (m) { bad.appendChild(h('li', { text: (m.cycle !== null ? 'Cycle ' + m.cycle + ', ' : '') + m.what + ': ' + m.detail })); });
        rtlSummary.appendChild(bad);
      }
      if (rep.notes.length) {
        var notes = h('ul', { class: 'cx-notes' });
        rep.notes.slice(0, 6).forEach(function (n) { notes.appendChild(h('li', { text: 'Cycle ' + n.cycle + ': ' + n.text })); });
        if (rep.notes.length > 6) notes.appendChild(h('li', { text: (rep.notes.length - 6) + ' more like this.' }));
        rtlSummary.appendChild(h('p', { class: 'cx-help', text: 'Tile bench limits:' }));
        rtlSummary.appendChild(notes);
      }
      rtlSummary.appendChild(h('p', { class: 'cx-help', text: 'Not recorded, so not compared: beat data payloads, byte masks, and intermediate metadata such as each LRU-bit update. Cache arrays shown during the replay are reconstructed by the model.' }));
      rtlSummary.appendChild(h('p', { class: 'cx-help', text: 'The bench is Prism\'s Base tile test bench: flat memory with code at 0x0000_0000 and data at 0x8000_0000 (32 KiB each), a fixed one-cycle response delay and no peripherals. The order of instruction refills is the pipeline\'s own, including fetches ahead and down mispredicted paths. Array contents come from the model, checked against the dumps above.' }));
    }

    /* drive tabs */
    function selectTab(which, focus) {
      var a = which === 'a';
      tabAccess.setAttribute('aria-selected', a ? 'true' : 'false'); tabProgram.setAttribute('aria-selected', a ? 'false' : 'true');
      tabAccess.tabIndex = a ? 0 : -1; tabProgram.tabIndex = a ? -1 : 0;
      panelAccess.hidden = !a; panelProgram.hidden = a; programExtra.hidden = a;
      if (!a) { moreFields.hidden = true; moreToggle.setAttribute('aria-expanded', 'false'); }
      if (focus) (a ? tabAccess : tabProgram).focus();
    }
    tabAccess.addEventListener('click', function () { selectTab('a'); });
    tabProgram.addEventListener('click', function () { selectTab('p'); });
    tablist.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) < 0) return;
      e.preventDefault();
      var a = tabAccess.getAttribute('aria-selected') === 'true';
      if (e.key === 'Home') selectTab('a', true); else if (e.key === 'End') selectTab('p', true); else selectTab(a ? 'p' : 'a', true);
    });

    /* ---------- playback ---------- */
    function speedFactor() { return Number(speed.value) || 1; }
    function delayFor(k) {
      var ev = session.flat[k] ? eventAt(k) : null;
      var base = ev && ev.quiet ? 260 : ev && ev.kind === 'ifetch' ? 1500 : 1150;
      return base / speedFactor();
    }
    var pausedVisuals = [];
    function stop() {
      // Freeze CSS animations and packet transitions at their current time, too.
      // Keeping the Animation objects lets Play resume without redrawing the step.
      if (!prefersReducedMotion() && work.getAnimations) {
        pausedVisuals = work.getAnimations({ subtree: true }).filter(function (a) {
          return a.playState === 'running' || a.playState === 'paused';
        });
        pausedVisuals.forEach(function (a) {
          var time = a.currentTime;
          a.pause();
          // Setting hold time also resolves the pending pause before the next frame.
          a.currentTime = time;
        });
      }
      if (timer) clearTimeout(timer);
      timer = null; playing = false; updatePlay();
    }
    function play() {
      if (!session.flat.length) return;
      if (cursor >= session.flat.length - 1) go(session.ops.length ? 0 : -1, false);
      pausedVisuals.forEach(function (a) {
        if (a.effect && a.effect.target && a.effect.target.isConnected && a.playState === 'paused') {
          a.play();
        }
      });
      pausedVisuals = [];
      playing = true; updatePlay(); schedule();
    }
    function schedule() {
      if (timer) clearTimeout(timer);
      if (!playing) return;
      timer = setTimeout(function () {
        if (disposed || !playing) return;
        if (cursor >= session.flat.length - 1) { stop(); announce(); return; }
        go(cursor + 1, false); schedule();
      }, delayFor(cursor));
    }
    function updatePlay() {
      btnPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
      btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      btnPlay.setAttribute('aria-pressed', playing ? 'true' : 'false');
    }
    function startOp(op) {
      if (prefersReducedMotion()) { stop(); go(op.last, true); return; }
      go(op.first, false); playing = true; updatePlay(); schedule();
    }
    function startSession() {
      if (!session.flat.length) { cursor = -1; render(); return; }
      if (prefersReducedMotion()) { stop(); go(0, true); return; }
      go(0, false); playing = true; updatePlay(); schedule();
    }
    var inspect = null;
    function go(k, manual) {
      inspect = null;
      cursor = Math.max(-1, Math.min(session.flat.length - 1, k));
      render();
      if (manual) announce();
    }
    function announce() {
      var ev = cursor >= 0 ? eventAt(cursor) : null;
      announcer.textContent = ev ? 'Step ' + (cursor + 1) + ' of ' + session.flat.length + ': ' + ev.title + '. ' + lkText.textContent : 'Before the first step.';
    }
    btnFirst.addEventListener('click', function () { stop(); go(session.flat.length ? 0 : -1, true); });
    btnPrev.addEventListener('click', function () { stop(); go(cursor - 1, true); });
    btnNext.addEventListener('click', function () { stop(); go(cursor + 1, true); });
    btnLast.addEventListener('click', function () { stop(); go(session.flat.length - 1, true); });
    btnPlay.addEventListener('click', function () { if (playing) { stop(); announce(); } else play(); });
    speed.addEventListener('change', function () { if (playing) schedule(); });
    stage.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.target.closest('input, textarea, select, [role="tab"], summary')) return;
      if (e.key === 'Escape') {
        if (!whyPanel.hidden) { e.preventDefault(); detailsOpen = false; renderNarrative(cursor >= 0 ? eventAt(cursor) : null, currentOp()); narrative.querySelector('.cx-why') && narrative.querySelector('.cx-why').focus(); return; }
        if (selectedPart) { e.preventDefault(); var g = flow.root.querySelector('[data-part="' + selectedPart + '"]'); showInfo(null); if (g) g.focus(); return; }
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(cursor + 1, true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(cursor - 1, true); }
      else if (e.key === ' ' && e.target === player) { e.preventDefault(); btnPlay.click(); }
    });

    /* ---------- rendering ---------- */
    function currentOp() { return cursor >= 0 ? session.ops[session.flat[cursor].op] : null; }
    var lastDrawn = { key: null, cursor: -1 };
    function render() {
      pausedVisuals = [];
      // Rendering replaces some controls; keep keyboard focus on the same logical control.
      var active = document.activeElement;
      var focusKey = active && section.contains(active) ? active.getAttribute('data-focus-key') : null;
      var ev = cursor >= 0 ? eventAt(cursor) : null;
      var st = stateAt(cursor), prev = stateAt(cursor - 1);
      var op = currentOp();
      renderEnvironment();
      renderPlayer(op);
      renderNarrative(ev, op);
      renderFlow(ev);
      renderLookup(ev, op);
      renderD(st, prev, ev);
      renderI(st, prev, ev);
      renderBeats();
      renderMemory(st);
      renderTally(st);
      renderOpLog(op);
      updateEffective();
      followView(ev);
      if (focusKey) {
        var target = section.querySelector('[data-focus-key="' + focusKey + '"]');
        if (target && target !== document.activeElement) target.focus({ preventScroll: true });
      }
    }
    function followView(ev) {
      if (viewPicked || !ev || !ev.cache || (view !== 'd' && view !== 'i')) return;
      if (ev.cache !== view && (ev.kind !== 'reset')) selectView(ev.cache);
    }
    function renderPlayer(op) {
      var n = session.flat.length;
      position.textContent = n ? (cursor + 1) + ' / ' + n : '0 / 0';
      position.title = n ? 'Step ' + (cursor + 1) + ' of ' + n + (op ? ', operation ' + (op.index + 1) + ' of ' + session.ops.length : '') : 'No steps yet';
      btnFirst.disabled = btnPrev.disabled = cursor <= 0;
      btnNext.disabled = btnLast.disabled = cursor >= n - 1;
      btnPlay.disabled = !n;
      sessionBadge.className = 'cx-badge ' + (session.mode === 'rtl' ? 'is-rtl' : 'is-model');
      sessionBadge.textContent = session.mode === 'rtl' ? 'Base RTL' : 'Modeled';
      sessionBadge.title = session.mode === 'rtl' ? 'Hit, miss, ways, beats and load values are from the Base tile RTL; the model fills in array contents and is checked against the bench dumps.' : 'Computed by the JavaScript cache model in the published SoC address map.';
    }
    function renderNarrative(ev, op) {
      narrative.replaceChildren();
      whyPanel.replaceChildren();
      narrative.className = 'cx-narrative tone-' + (ev ? ev.tone || 'info' : 'info');
      if (!ev) {
        whyPanel.hidden = true;
        narrative.appendChild(h('p', { class: 'cx-narrative-line' }, [h('span', { class: 'cx-narrative-title', text: 'Caches empty: every line invalid. Run an access or a program.' })]));
        return;
      }
      var last = ev === op.events[op.events.length - 1];
      var bad = op.check && !op.check.ok;
      var toggle = h('button', { type: 'button', class: 'cx-why', 'data-focus-key': 'why', 'aria-expanded': detailsOpen ? 'true' : 'false', 'aria-controls': whyPanel.id, text: 'Details' });
      toggle.addEventListener('click', function () { detailsOpen = !detailsOpen; renderNarrative(eventAt(cursor), currentOp()); narrative.querySelector('.cx-why').focus(); });
      var alias = op.artifact && ev.beat ? M.benchAlias(ev.beat.address) : null;
      narrative.appendChild(h('p', { class: 'cx-narrative-line' }, [
        h('code', { class: 'cx-narrative-op', text: op.label }),
        h('span', { class: 'cx-narrative-title', text: ev.title }),
        op.artifact ? h('span', { class: 'cx-pill is-warn', text: 'bench only: reaches flat memory at ' + hxs(M.benchAlias(op.result && op.result.address !== undefined ? op.result.address : (ev.address || 0))) }) : null,
        op.check && last ? h('span', { class: 'cx-pill ' + (bad ? 'is-bad' : 'is-ok'), text: bad ? '✗ differs from RTL' : '✓ matches RTL' }) : null,
        toggle
      ]));
      whyPanel.hidden = !detailsOpen;
      whyPanel.appendChild(h('p', { class: 'cx-narrative-text', text: ev.text }));
      var meta = [];
      if (op.encoding !== null && op.encoding !== undefined) meta.push('encoding ' + hx(op.encoding));
      if (op.line) meta.push('source line ' + op.line);
      if (op.cycle !== undefined) meta.push('recorded at cycle ' + op.cycle);
      if (op.provenance === 'rtl') meta.push('array contents reconstructed by the model from the recording');
      if (ev.view) meta.push('view-only phase: no state change');
      var vals = h('dl', { class: 'cx-values' });
      function val(k, v) { vals.appendChild(h('div', {}, [h('dt', { text: k }), h('dd', { class: 'cx-mono', text: v })])); }
      if (ev.beat) {
        val('Beat', (ev.beat.channel === 'i' ? 'I ' : 'D ') + ev.beat.dir + ' ' + hxs(ev.beat.address));
        if (alias !== null) val('Bench alias', hxs(alias));
        val('Byte mask', '0x' + ('0' + ev.beat.mask.toString(16)).slice(-2));
        if (ev.beat.data) { val('Lanes [7:4] (word +4)', hx(ev.beat.data[1])); val('Lanes [3:0] (word +0)', hx(ev.beat.data[0])); }
        val('Result', ev.beat.ok ? (ev.beat.device ? 'device response (not modeled)' : 'completed') : 'error');
      }
      if (ev.kind === 'complete' && ev.value !== undefined && ev.value !== null && op.rd !== null && op.rd !== undefined) val(ABI[op.rd] + ' ←', hx(signExtend(ev.value, (op.label || '').split(' ')[0])));
      if (ev.lru) val('LRU bit', ev.lru.before + ' → ' + ev.lru.after);
      if (vals.childNodes.length) whyPanel.appendChild(vals);
      if (meta.length) whyPanel.appendChild(h('p', { class: 'cx-muted cx-small', text: meta.join(' · ') }));
      if (ev.source && ev.source.length) whyPanel.appendChild(h('p', { class: 'cx-source-refs' }, ['RTL: '].concat(ev.source.map(function (x, i) { return h('code', { text: x + (i < ev.source.length - 1 ? ';' : '') }); }).reduce(function (a, c) { a.push(c, ' '); return a; }, []))));
      if (op.check && last) {
        var c = h('ul', { class: 'cx-check' });
        op.check.items.forEach(function (it) { c.appendChild(h('li', { class: it.ok ? 'is-ok' : 'is-bad' }, [h('span', { 'aria-hidden': 'true', text: it.ok ? '✓ ' : '✗ ' }), h('strong', { text: (it.ok ? 'Matches RTL: ' : 'Differs from RTL: ') + it.what + '. ' }), it.detail])); });
        whyPanel.appendChild(c);
        whyPanel.appendChild(h('p', { class: 'cx-muted cx-small', text: 'The recording gives beat direction, address and order, the way used and load data; it does not record beat payloads or byte masks.' }));
      }
    }

    var INFO = {
      core: ['Base core', 'IF asks the I-cache for the word at the PC. MEM holds a load or store until the D-cache answers with hit or access_fault. The pipeline itself is on the core tab.', 'source/core_tiles/base/rtl/pipeline/datapath.sv'],
      icache: ['I-cache', 'Direct-mapped, 16 lines of 8 bytes. Tag [31:7], line [6:3], word [2]. A miss sends one 8-byte read, which installs data, tag and valid together; a failed read never becomes valid. It caches every fetch address. fence.i clears every valid bit.', 'source/core_tiles/base/rtl/caches/icache.sv'],
      dcache: ['D-cache', '8 sets × 2 ways × 16 bytes, write-back and write-allocate. EX compares both ways\' tags. A miss replaces the way named by the set\'s LRU bit: two write-back beats if it is dirty, then two refill beats. A store marks its line dirty without writing memory. Addresses outside the RAM window leave as one uncached beat and allocate nothing.', 'source/core_tiles/base/rtl/caches/dcache.sv'],
      fabric: ['Memory fabric', 'cache_fabric_if has separate 64-bit instruction and data channels, one beat outstanding on each, with no IDs and no coherence. The direct fabric serves the data channel first.', 'source/contracts/interfaces/cache_fabric_if.vh'],
      route: ['Address routing', 'Decodes each beat\'s address: RAM, boot ROM, or the system bus to the peripherals. A reserved address with nothing installed completes with an error.', 'source/soc/packages/memory_map_pkg.vh'],
      ram: ['RAM', '64 KiB installed at 0x8000_0000. The whole reserved window 0x8000_0000–0x9FFF_FFFF is cacheable; a refill past the installed 64 KiB fails.', 'source/soc/packages/memory_map_pkg.vh (is_cacheable)'],
      rom: ['Boot ROM', '4 KiB at 0x0000_0000 (64 KiB reserved). Data loads from it are uncached and writes fail. The I-cache does cache instruction fetches from it.', 'source/soc/packages/memory_map_pkg.vh'],
      sys: ['Peripherals', 'MMIO aperture 0x4000_0000–0x4FFF_FFFF, always uncached: one masked beat per access, so device side effects happen exactly once. The system bus tab follows these beats to the device and shows interrupts.', 'source/core_tiles/base/rtl/caches/dcache.sv (capture_io)']
    };
    var BENCH_INFO = {
      route: ['Bench memory agent', 'The Base tile bench has no address router. Its memory agent answers every beat after a fixed delay, aliasing data addresses into its flat 64 KiB: bits [14:0], plus 0x8000 when bit 31 is set.', 'qa/core-diagrams/tracer_patch.py (bench address alias)'],
      ram: ['Bench data memory', '32 KiB of flat memory for addresses with bit 31 set, seen at 0x8000_0000–0x8000_7FFF. Higher RAM-window addresses alias onto it instead of failing as they would in a SoC.', 'source/core_tiles/base/tb/pipeline/verification_env.sv'],
      rom: ['Bench code memory', '32 KiB of flat memory at 0x0000_0000 holding the program. Uncached data accesses to any address with bit 31 clear, MMIO included, alias into it.', 'source/core_tiles/base/tb/pipeline/verification_env.sv'],
      sys: ['No peripherals', 'The tile bench has no system bus and no devices. A beat addressed to the MMIO aperture reads or writes the flat code memory at its alias instead; the diagram shows that alias.', 'qa/core-diagrams/tracer_patch.py']
    };
    var SOC_NODES = { ram: ['RAM', '64 KiB · 0x8000_0000'], rom: ['Boot ROM', '4 KiB · 0x0000_0000'], sys: ['Peripherals', 'MMIO · system bus'], route: ['Route', ''] };
    var BENCH_NODES = { ram: ['Bench data', '32 KiB flat'], rom: ['Bench code', '32 KiB flat'], sys: ['No peripherals', 'not in the bench'], route: ['Bench', ''] };
    function bench() { return session.env && session.env.kind === 'bench'; }
    function infoFor(part) { return (bench() && BENCH_INFO[part]) || INFO[part]; }
    var shownEnv = null;
    function renderEnvironment() {
      var kind = bench() ? 'bench' : 'soc';
      if (kind === shownEnv) return;
      shownEnv = kind;
      var nodes = kind === 'bench' ? BENCH_NODES : SOC_NODES;
      Object.keys(nodes).forEach(function (part) {
        var g = flow.root.querySelector('[data-part="' + part + '"]'), t = g.querySelectorAll('text');
        t[0].textContent = nodes[part][0]; if (t[1]) t[1].textContent = nodes[part][1];
        g.classList.toggle('is-absent', kind === 'bench' && part === 'sys');
        g.setAttribute('aria-label', nodes[part][0] + ': show details');
      });
      envLabel.replaceChildren(kind === 'bench'
        ? h('span', { title: 'Flat memory: 32 KiB code at 0x0000_0000 and 32 KiB data at 0x8000_0000, no peripherals. Other addresses alias into it.' }, [h('span', { class: 'cx-badge is-rtl', text: 'RTL tile bench' }), ' flat 32 KiB code @0x0000_0000 + 32 KiB data @0x8000_0000, no peripherals'])
        : h('span', { title: 'Select a block in the strip for what it does in the RTL.' }, [h('span', { class: 'cx-badge is-model', text: 'SoC address map' }), ' RAM 64 KiB @0x8000_0000 · ROM 4 KiB @0x0000_0000 · MMIO 0x4000_0000–0x4FFF_FFFF']));
      if (selectedPart) showInfo(selectedPart, true);
    }
    var selectedPart = null;
    function showInfo(part, keep) {
      selectedPart = part;
      Array.prototype.forEach.call(flow.root.querySelectorAll('.cx-node'), function (n) {
        var on = n.getAttribute('data-part') === part;
        n.classList.toggle('is-selected', on);
        n.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
      infoCard.replaceChildren();
      if (!part) { infoCard.hidden = true; return; }
      var i = infoFor(part);
      var close = h('button', { type: 'button', class: 'cx-info-close', 'aria-label': 'Close ' + i[0] + ' details', text: '×' });
      close.addEventListener('click', function () { var g = flow.root.querySelector('[data-part="' + part + '"]'); showInfo(null); if (g) g.focus(); });
      infoCard.appendChild(h('div', { class: 'cx-info-head' }, [h('h3', { text: i[0] }), close]));
      infoCard.appendChild(h('p', { text: i[1] }));
      infoCard.appendChild(h('p', { class: 'cx-source-refs' }, [bench() && BENCH_INFO[part] ? 'Source: ' : 'RTL: ', h('code', { text: i[2] })]));
      infoCard.hidden = false;
      if (!keep && infoCard.scrollIntoView) {
        var r = infoCard.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) infoCard.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    }
    Array.prototype.forEach.call(flow.root.querySelectorAll('.cx-node'), function (n) {
      var part = n.getAttribute('data-part');
      n.setAttribute('tabindex', '0'); n.setAttribute('role', 'button'); n.setAttribute('aria-label', INFO[part][0] + ': show details');
      n.setAttribute('aria-controls', infoCard.id); n.setAttribute('aria-expanded', 'false');
      n.addEventListener('click', function () { showInfo(selectedPart === part ? null : part); });
      n.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showInfo(selectedPart === part ? null : part); } });
    });
    flow.root.setAttribute('aria-label', 'Cache data path: core, I-cache and D-cache, memory fabric, and the memory or devices behind it');
    function targetOf(address) {
      var c = M.classify(session.env, address);
      if (bench()) return c.bench >= 0x8000 ? 'ram' : 'rom';   // the bench aliases every address into flat memory
      if (c.kind === 'ram' || c.kind === 'ram-hole') return 'ram';
      if (c.kind === 'rom' || c.kind === 'rom-hole') return 'rom';
      return 'sys';
    }
    function renderFlow(ev) {
      var root = flow.root, token = flow.token;
      Array.prototype.forEach.call(root.querySelectorAll('.is-active, .is-fault-path'), function (n) { n.classList.remove('is-active'); n.classList.remove('is-fault-path'); });
      if (!ev || !ev.flow) {
        token.setAttribute('data-hidden', 'true');
        if (ev && ev.cache) { var n = root.querySelector('[data-part="' + (ev.cache === 'i' ? 'icache' : 'dcache') + '"]'); if (n) n.classList.add('is-active'); }
        return;
      }
      var side = ev.flow.indexOf('i') >= 0 && ev.cache === 'i' ? 'i' : 'd';
      var fault = ev.beat ? !ev.beat.ok : ev.tone === 'fault';
      var outward = /^core-|-fabric$/.test(ev.flow);         // core -> cache, cache -> fabric
      var toFabric = /fabric/.test(ev.flow);
      var main = toFabric ? side + '-fabric' : 'core-' + side;
      var edges = [main], parts = ['core', side === 'i' ? 'icache' : 'dcache'];
      if (toFabric) {
        var addr = ev.beat ? ev.beat.address : ev.address;
        var target = addr === undefined ? null : targetOf(addr);
        edges.push('fabric-route'); parts.push('fabric', 'route');
        if (target) { edges.push('route-' + target); parts.push(target); }
      }
      edges.forEach(function (name) { var e = root.querySelector('[data-edge="' + name + '"]'); if (e) e.classList.add(fault ? 'is-fault-path' : 'is-active'); });
      parts.forEach(function (name) { var e = root.querySelector('[data-part="' + name + '"]'); if (e) e.classList.add('is-active'); });
      var seg = FLOW[main], from = outward ? seg[0] : seg[1], to = outward ? seg[1] : seg[0];
      var label = ev.beat ? (ev.beat.dir === 'read' ? 'R ' : 'W ') + hxs(ev.beat.address) + (bench() && M.classify(session.env, ev.beat.address).benchArtifact ? ' → ' + hxs(M.benchAlias(ev.beat.address)) : '')
        : ev.value !== undefined && ev.value !== null ? hx(ev.value)
        : fault ? 'error' : ev.kind === 'complete' ? 'done' : hxs(ev.address || 0);
      token.querySelector('text').textContent = label;
      var tw = Math.max(74, label.length * 6.9 + 16);
      token.querySelector('rect').setAttribute('width', tw); token.querySelector('rect').setAttribute('x', -tw / 2);
      token.setAttribute('class', 'cx-token' + (fault ? ' is-fault' : ''));
      token.removeAttribute('data-hidden');
      // Keep the label inside the strip: centre it on the active segment, clamped.
      var at = function (p) { var x = Math.max(tw / 2 + 2, Math.min(FLOW_W - tw / 2 - 2, p[0])); return 'translate(' + x + 'px,' + (p[1] - 14) + 'px)'; };
      token.style.transition = 'none';
      if (prefersReducedMotion() || !playing) { token.style.transform = at([(from[0] + to[0]) / 2, to[1]]); return; }
      token.style.transform = at(from);
      token.getBoundingClientRect();   // commit the start point so the move animates
      token.style.transition = 'transform ' + Math.round(Math.max(150, delayFor(cursor) * 0.6)) + 'ms ease-in-out';
      token.style.transform = at(to);
    }

    /* ---------- lookup diagram ---------- */
    function previewView() {
      var f = formRequest(), st = stateAt(cursor);
      if (f.error) return { mode: 'empty', address: null, st: st };
      var a = f.request.address, env = session.mode === 'model' ? session.env : M.createEnv('soc', session.segments);
      var c = M.classify(env, a);
      var align = (f.request.size === 2 && (a & 1)) || (f.request.size === 4 && (a & 3));
      return { mode: 'preview', address: a, fields: M.splitD(a), cacheable: c.cacheable && !align, st: st, note: align ? 'Misaligned: the hart will trap before the D-cache' : 'is_cacheable = 0 · ' + c.label + ': this access will bypass the D-cache' };
    }
    function renderLookup(ev, op) {
      var v = inspect ? lookupModel(M, null, null, inspect, stateAt(cursor)) : ev ? lookupModel(M, ev, op, null, ev.state) : previewView();
      var key = session.serial + ':' + cursor + ':' + (inspect ? inspect.cache + inspect.index : '');
      var forward = !inspect && cursor >= 0 && lastDrawn.key !== key && (cursor === lastDrawn.cursor + 1 || (op && cursor === op.first) || lastDrawn.session !== session.serial);
      var animate = forward && !prefersReducedMotion();
      lastDrawn = { key: key, cursor: cursor, session: session.serial };
      var svgEl = drawLookup(v, { M: M, animate: animate, dur: Math.min(1100, delayFor(cursor) * (v.mode === 'i' ? 0.9 : 0.7)), decode: decodeText });
      svgEl.setAttribute('aria-labelledby', lkText.id || (lkText.id = id + '-lk-sr'));
      lkWrap.replaceChildren(svgEl);
      lkWrap.className = 'cx-lk' + (animate ? ' is-animating' : '');
      renderLookupHead(v, ev, op);
      lkText.textContent = describeLookup(v);
    }
    function regionChip(v) {
      if (v.mode === 'i' || (v.mode === 'maint' && v.cache === 'i')) return h('span', { class: 'cx-chip is-cached', text: 'I-cache · caches every fetch address' });
      if (v.mode === 'bypass') return h('span', { class: 'cx-chip is-bypass', text: 'Not cacheable · bypass' });
      if (v.mode === 'misaligned') return h('span', { class: 'cx-chip is-fault', text: 'Misaligned' });
      if (v.mode === 'd') return h('span', { class: 'cx-chip is-cached', text: 'D-cache · RAM window, cacheable' });
      if (v.mode === 'preview') return h('span', { class: 'cx-chip ' + (v.cacheable ? 'is-cached' : 'is-bypass'), text: 'Not run yet' });
      return null;
    }
    function renderLookupHead(v, ev, op) {
      lkHead.replaceChildren();
      var addr = v.address !== undefined && v.address !== null ? v.address : null;
      if (v.phase === 'inspect') {
        var back = h('button', { type: 'button', class: 'cx-link', 'data-focus-key': 'inspect-back', text: 'Back to the step' });
        back.addEventListener('click', function () { setInspect(null); });
        lkHead.appendChild(h('span', { class: 'cx-lk-label', text: 'Inspecting ' + (v.mode === 'i' ? 'I-cache line ' : 'D-cache set ') + v.index }));
        lkHead.appendChild(back);
        lkHead.appendChild(zoomLookup);
        return;
      }
      var label = v.mode === 'i' ? 'Fetch' : v.mode === 'maint' ? 'Maintenance' : v.mode === 'preview' || v.mode === 'empty' ? 'Next access' : 'Data address';
      lkHead.appendChild(h('span', { class: 'cx-lk-label', text: label }));
      if (addr !== null) lkHead.appendChild(h('strong', { class: 'cx-mono cx-lk-addr', text: hxs(addr) }));
      var chip = regionChip(v);
      if (chip) lkHead.appendChild(chip);
      lkHead.appendChild(zoomLookup);
    }
    function describeLookup(v) {
      if (!v) return '';
      if (v.phase === 'inspect') return 'Inspecting ' + (v.mode === 'i' ? 'line ' : 'set ') + v.index + '.';
      if (v.mode === 'bypass') return 'Address ' + hxs(v.address) + ' is not cacheable: no set is read and no tag is compared. One masked beat.';
      if (v.mode === 'misaligned') return 'Misaligned address ' + hxs(v.address) + ': no cache access.';
      if (v.mode === 'preview' || v.mode === 'empty' || v.mode === 'maint') return '';
      var f = v.fields, parts = 'Tag ' + tagHex(f.tag) + ', ' + (v.mode === 'i' ? 'line ' : 'set ') + f.index + ', word ' + f.word + ', byte ' + f.byte + '; block offset ' + (f.address & (v.mode === 'i' ? 7 : 15)) + '.';
      if (v.mode === 'i') {
        if (v.retained) return parts + ' Retained fault: no lookup.';
        var c = v.compare;
        return parts + ' Line tag ' + tagHex(c.tag) + (c.valid ? ' valid' : ' invalid') + ': ' + (c.match ? 'hit.' : 'miss.');
      }
      if (v.phase === 'split') return parts;
      var words = v.compare.map(function (c, wi) { return 'way ' + wi + ' tag ' + tagHex(c.tag) + (c.valid ? '' : ' (invalid)') + (v.phase === 'select' ? '' : c.match ? ' matches' : ' no match'); });
      return parts + ' ' + words.join('; ') + (v.phase === 'select' ? '.' : '. ' + (v.hitWay >= 0 ? 'Hit in way ' + v.hitWay + '.' : 'Miss.'));
    }
    function setInspect(next) {
      inspect = next;
      if (next) stop();
      render();
    }

    /* ---------- tables ---------- */
    function stateLabel(s) { return s === 'invalid' ? 'Invalid' : s === 'dirty' ? 'Dirty' : 'Clean'; }
    function inspectButton(cache, index, label) {
      var on = !!(inspect && inspect.cache === cache && inspect.index === index);
      var b = h('button', { type: 'button', class: 'cx-setbtn', 'data-focus-key': cache + 'set-' + index, 'aria-pressed': on ? 'true' : 'false', title: 'Show ' + label + ' in the lookup diagram', 'aria-label': 'Inspect ' + label }, [h('span', { class: 'cx-setnum', text: String(index) })]);
      b.addEventListener('click', function () { setInspect(on ? null : { cache: cache, index: index }); });
      return b;
    }
    function renderD(st, prev, ev) {
      dTable.replaceChildren();
      var table = h('table', { class: 'cx-table cx-dtable' });
      table.appendChild(h('caption', { class: 'visually-hidden', text: 'D-cache: for each set, the replacement bit and both ways with state, tag and four data words. Select a set to show it in the lookup diagram.' }));
      table.appendChild(h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: 'Set' }), h('th', { scope: 'col', text: 'Way 0' }), h('th', { scope: 'col', text: 'Way 1' })])]));
      var body = h('tbody');
      st.d.sets.forEach(function (set, si) {
        var probed = ev && ev.cache === 'd' && ev.set === si;
        var inspected = !!(inspect && inspect.cache === 'd' && inspect.index === si);
        var tr = h('tr', { class: (probed ? 'is-probed' : '') + (inspected ? ' is-inspected' : '') + (probed || inspected ? ' is-expanded' : '') });
        tr.appendChild(h('th', { scope: 'row', class: 'cx-setcell' }, [inspectButton('d', si, 'D-cache set ' + si), h('span', { class: 'cx-lru', title: 'Replacement bit: the way the next miss in this set replaces', text: 'LRU ' + set.lru })]));
        set.ways.forEach(function (w, wi) {
          var p = prev.d.sets[si].ways[wi], s = lineState(w);
          var cls = ['cx-way', 'is-' + s];
          if (set.lru === wi && w.valid) cls.push('is-next-victim');
          if (probed && ev.compare) cls.push(ev.compare[wi].match ? 'is-match' : 'is-nomatch');
          if (probed && ev.way === wi && !ev.compare && !(ev.victim && ev.victim.way === wi)) cls.push('is-focus');
          if (probed && ev.victim && ev.victim.way === wi) cls.push('is-victim');
          if (JSON.stringify(w) !== JSON.stringify(p)) cls.push('is-changed');
          var line = M.dLineAddress(w.tag, si);
          var meta = h('div', { class: 'cx-way-meta' }, [
            h('span', { class: 'cx-state', text: stateLabel(s) }),
            h('span', { class: 'cx-tag cx-mono', title: 'Tag [31:7]', text: w.valid || w.tag ? tagHex(w.tag) : '—' }),
            w.valid ? h('span', { class: 'cx-line cx-mono', text: hxs(line) }) : null,
          ]);
          var empty = !w.valid && !w.tag && w.data.every(function (d) { return !d; });
          if (empty) meta.appendChild(h('span', { class: 'cx-empty', text: 'empty since reset' }));
          var words = empty ? null : h('div', { class: 'cx-dwords' }, w.data.map(function (d, k) {
            var active = probed && ev.way === wi && ev.words && ev.words.indexOf(k) >= 0;
            var changed = d !== p.data[k];
            return h('span', { 'data-w': 'w' + k, class: 'cx-word cx-mono' + (active ? ' is-active' : '') + (changed ? ' is-changed' : '') + (!w.valid ? ' is-stale' : ''), title: 'Word ' + k + (w.valid ? ' at ' + hxs(line + 4 * k) : '') }, [h('span', { class: 'cx-wv', text: hex8(d) })]);
          }));
          tr.appendChild(h('td', { class: cls.join(' '), title: empty ? null : 'Way ' + wi + ': ' + w.data.map(hex8).join(' ') }, [meta, words]));
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      dTable.appendChild(table);
      var valid = 0, dirty = 0;
      st.d.sets.forEach(function (s) { s.ways.forEach(function (w) { if (w.valid) valid++; if (w.valid && w.dirty) dirty++; }); });
      viewTabs.d.querySelector('.cx-vcount').textContent = String(valid);
      viewTabs.d.title = valid + ' of 16 D lines valid, ' + dirty + ' dirty';
    }
    function renderI(st, prev, ev) {
      iTable.replaceChildren();
      var pc = ev && ev.cache === 'i' ? ev.pc : null;
      var table = h('table', { class: 'cx-table cx-itable' });
      table.appendChild(h('colgroup', {}, [h('col', { class: 'cx-icol-index' }), h('col', { class: 'cx-icol-meta' }), h('col'), h('col')]));
      table.appendChild(h('caption', { class: 'visually-hidden', text: 'I-cache: for each line, valid bit, line address and the two instructions it holds. Select a line to show it in the lookup diagram.' }));
      table.appendChild(h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: 'Line' }), h('th', { scope: 'col', text: 'State, address' }), h('th', { scope: 'col', text: 'Word 0' }), h('th', { scope: 'col', text: 'Word 1' })])]));
      var body = h('tbody');
      st.i.lines.forEach(function (l, li) {
        var focus = ev && ev.cache === 'i' && ev.line === li;
        var changed = JSON.stringify(l) !== JSON.stringify(prev.i.lines[li]);
        var addr = M.iLineAddress(l.tag, li);
        var tr = h('tr', { class: (focus ? 'is-probed ' : '') + (l.valid ? 'is-clean' : 'is-invalid') + (changed ? ' is-changed' : '') + (inspect && inspect.cache === 'i' && inspect.index === li ? ' is-inspected' : '') });
        tr.appendChild(h('th', { scope: 'row' }, [inspectButton('i', li, 'I-cache line ' + li)]));
        tr.appendChild(h('td', { class: 'cx-imeta' }, [h('span', { class: 'cx-state', text: l.valid ? 'Valid' : 'Invalid' }), ' ', h('span', { class: 'cx-mono cx-tag', text: l.valid || l.tag ? hxs(addr) : '—' })]));
        l.data.forEach(function (d, k) {
          var active = focus && pc !== null && ((pc >>> 2) & 1) === k && ev.kind === 'ifetch';
          var shown = l.valid || l.tag || d;
          tr.appendChild(h('td', { title: shown ? hex8(d) + ' · ' + decodeText(d, addr + 4 * k) : null, class: 'cx-iword' + (active ? ' is-active' : '') + (!l.valid ? ' is-stale' : '') }, shown ? [h('span', { class: 'cx-mono cx-ihex', text: hex8(d) }), ' ', h('span', { class: 'cx-dis', text: decodeText(d, addr + 4 * k) })] : [h('span', { class: 'cx-muted', text: '—' })]));
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      iTable.appendChild(table);
      var valid = st.i.lines.filter(function (l) { return l.valid; }).length;
      viewTabs.i.querySelector('.cx-vcount').textContent = String(valid);
      viewTabs.i.title = valid + ' of 16 I lines valid';
      if (!valid) iTable.insertBefore(h('p', { class: 'cx-inote', text: session.flat.length && st.i.lines.some(function (l) { return l.tag || l.data[0] || l.data[1]; }) ? 'Every line is invalid. Old tags and instructions stay in the array but cannot hit.' : 'Empty: run a program to fill it. Single accesses do not fetch.' }), table);
    }
    function beatsUpTo(k) {
      var out = [];
      for (var i = 0; i <= k; i++) { var e = eventAt(i); if (e.beat) out.push({ n: out.length + 1, beat: e.beat, current: i === k }); }
      return out;
    }
    function renderBeats() {
      beatView.replaceChildren();
      var list = cursor >= 0 ? beatsUpTo(cursor) : [];
      viewTabs.beats.querySelector('.cx-vcount').textContent = list.length ? String(list.length) : '';
      if (!list.length) { beatView.appendChild(h('p', { class: 'cx-muted cx-pad', text: 'No beats yet. Hits and the controller\'s internal steps send nothing to the fabric.' })); return; }
      var shown = list.slice(-12);
      var table = h('table', { class: 'cx-table cx-beattable' }, [
        h('thead', {}, [h('tr', {}, ['#', 'Ch', 'Beat', 'Mask', 'Purpose'].map(function (t) { return h('th', { scope: 'col', text: t }); }))])
      ]);
      var body = h('tbody');
      shown.forEach(function (b) {
        var purpose = { 'fill-low': 'refill low', 'fill-high': 'refill high', 'writeback-low': 'write-back low', 'writeback-high': 'write-back high', 'clean-low': 'clean low', 'clean-high': 'clean high', 'uncached': 'uncached', 'ifill': 'I refill' }[b.beat.purpose] || b.beat.purpose;
        body.appendChild(h('tr', { class: (b.current ? 'is-current ' : '') + (b.beat.ok ? '' : 'is-error') }, [
          h('td', { class: 'cx-mono', text: String(b.n) }), h('td', { text: b.beat.channel === 'i' ? 'I' : 'D' }),
          h('td', { class: 'cx-mono', text: (b.beat.dir === 'read' ? 'R ' : 'W ') + hxs(b.beat.address) }),
          h('td', { class: 'cx-mono', text: '0x' + ('0' + b.beat.mask.toString(16)).slice(-2) }),
          h('td', { text: purpose + (b.beat.ok ? '' : ' · error') })
        ]));
      });
      table.appendChild(body);
      if (list.length > shown.length) beatView.appendChild(h('p', { class: 'cx-muted cx-pad', text: 'Last 12 of ' + list.length + ' beats.' }));
      beatView.appendChild(table);
    }
    function touchedLines(k) {
      var lines = [];
      function add(a) { a = (a & ~15) >>> 0; var i = lines.indexOf(a); if (i >= 0) lines.splice(i, 1); lines.push(a); }
      for (var i = 0; i <= k; i++) {
        var e = eventAt(i);
        var a = e.beat && e.beat.channel === 'd' ? e.beat.address : e.kind === 'decode' ? e.address : null;
        if (a === null) continue;
        var kind = M.classify(session.env, a).kind;
        if (kind === 'ram' || kind === 'rom') add(a);
      }
      return lines.slice(-8).reverse();
    }
    function renderMemory(st) {
      memView.replaceChildren();
      var lines = cursor >= 0 ? touchedLines(cursor) : [];
      if (!lines.length) { memView.appendChild(h('p', { class: 'cx-muted cx-pad', text: 'Lines appear here when the D-cache refills, writes back or bypasses to them.' })); return; }
      var table = h('table', { class: 'cx-table cx-memtable' }, [h('caption', { class: 'visually-hidden', text: 'Memory contents of recently used lines, compared with the D-cache.' }),
        h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: 'Line' }), h('th', { scope: 'col', text: 'Words 0–3 in memory' })])])]);
      var body = h('tbody');
      lines.forEach(function (a) {
        var d = M.splitD(a), cached = null;
        st.d.sets[d.index].ways.forEach(function (w) { if (w.valid && w.tag === d.tag) cached = w; });
        var cells = [0, 1, 2, 3].map(function (k) {
          var mv = M.readWord(st, session.env, a + 4 * k);
          var stale = cached && cached.dirty && cached.data[k] !== mv;
          return h('span', { 'data-w': 'w' + k, class: 'cx-word cx-mono' + (stale ? ' is-stale-mem' : ''), title: stale ? 'Stale: the D-cache holds ' + hx(cached.data[k]) : '' }, [h('span', { class: 'cx-wv', text: hex8(mv) })]);
        });
        var note = cached ? (cached.dirty ? 'cached, dirty' : 'cached, clean') : 'not cached';
        body.appendChild(h('tr', {}, [h('th', { scope: 'row' }, [h('span', { class: 'cx-mono', text: hxs(a) }), h('span', { class: 'cx-memnote', text: note })]), h('td', {}, [h('div', { class: 'cx-words' }, cells)])]));
      });
      table.appendChild(body);
      memView.appendChild(table);
      if (session.mode === 'rtl') memView.appendChild(h('p', { class: 'cx-muted cx-pad', text: 'Tile bench memory (data aliases into 32 KiB).' }));
      memView.appendChild(h('p', { class: 'cx-help cx-pad', text: 'Struck values are stale: a dirty line in the D-cache is newer. Memory catches up only on write-back.' }));
    }
    function renderTally(st) {
      var t = st.tally;
      tally.replaceChildren();
      [['D hits', t.dHit], ['D misses', t.dMiss], ['Uncached', t.uncached], ['Refill beats', t.fill], ['Write-back beats', t.writeback], ['I hits', t.iHit], ['I misses', t.iMiss], ['Faults', t.fault]].forEach(function (p) {
        tally.appendChild(h('div', {}, [h('dt', { text: p[0] }), h('dd', { class: 'cx-mono', text: String(p[1]) })]));
      });
    }
    function renderOpLog(op) {
      opLog.replaceChildren();
      viewTabs.hist.querySelector('.cx-vcount').textContent = session.ops.length ? String(session.ops.length) : '';
      if (!session.ops.length) { opLog.appendChild(h('li', { class: 'cx-muted', text: 'None yet.' })); return; }
      var current = op ? op.index : -1;
      var from = Math.max(0, Math.min(current < 0 ? 0 : current - 30, session.ops.length - 60)), to = Math.min(session.ops.length, from + 60);
      if (from > 0) opLog.appendChild(h('li', { class: 'cx-muted', text: from + ' earlier operations' }));
      for (var i = from; i < to; i++) (function (o) {
        var bad = o.check && !o.check.ok;
        var b = h('button', { type: 'button', 'data-focus-key': 'op-' + o.index, class: 'cx-opbtn' + (o.index === current ? ' is-current' : '') + (bad ? ' is-bad' : ''), 'aria-current': o.index === current ? 'true' : null }, [
          h('span', { class: 'cx-opnum cx-mono', text: String(o.index + 1) }),
          h('code', { class: 'cx-oplabel', text: o.label }),
          h('span', { class: 'cx-opsum', text: (o.cycle !== undefined ? 'c' + o.cycle + ' · ' : '') + (o.summary || '') + (bad ? ' · differs' : '') })
        ]);
        b.addEventListener('click', function () { stop(); go(o.first, true); });
        opLog.appendChild(h('li', {}, [b]));
      })(session.ops[i]);
      if (to < session.ops.length) opLog.appendChild(h('li', { class: 'cx-muted', text: (session.ops.length - to) + ' later operations' }));
      var cur = opLog.querySelector('.is-current'), box = viewPanels.hist;
      if (cur && !box.hidden && box.scrollHeight > box.clientHeight) {
        var top = cur.offsetTop;
        if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = Math.max(0, top - 60);
      }
    }
    function say(text) { announcer.textContent = text; }

    showExampleNote();
    updateEditorSummary();
    showInfo(null);
    syncFromAsm();
    refreshAvailability();
    render();

    return {
      dispose: function () {
        stop(); supersede();
        disposed = true;
        clearTimeout(persistTimer);
      },
      // For tests and hosts: a JSON copy of the current session. state is the live
      // (final) state, not the step on display. steps include view-only phases.
      snapshot: function () {
        return JSON.parse(JSON.stringify({ mode: session.mode, cursor: cursor, steps: session.flat.length, ops: session.ops.map(function (o) { return { label: o.label, kind: o.kind, provenance: o.provenance, summary: o.summary, check: o.check || null }; }), state: liveState() }));
      }
    };
  }

  window.PrismCacheExplorer = { mount: mount, examples: EXAMPLES };
})();
