/* Interactive core datapath diagrams: SVG engine, stepper and charts.
   Models (geometry plus RTL notes) live in model-*.js and register through
   PrismCoreDiagrams.define(). Cycle data comes from window.PRISM_CORE_TRACES,
   recorded from Prism's RTL tile benches. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var models = {};
  var mounted = new WeakMap();
  var zoomSettings = {};
  var flowSetting;   // signal-flow animation: shared by every diagram on the page

  function unmount(container) {
    var handle = mounted.get(container);
    if (handle) { handle.dispose(); mounted.delete(container); }
  }

  function s(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (attrs[k] !== undefined && attrs[k] !== null) el.setAttribute(k, String(attrs[k]));
    });
    if (parent) parent.appendChild(el);
    return el;
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function setKids(el) {
    el.replaceChildren();
    for (var i = 1; i < arguments.length; i++) add(el, arguments[i]);
  }
  function add(el, kid) {
    if (kid === undefined || kid === null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(el, k); }); return; }
    el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  // Text with `code` spans.
  function rich(text) {
    return String(text).split('`').map(function (part, i) { return i % 2 ? h('code', { text: part }) : part; });
  }

  /* ---------- shapes ---------- */
  // Corner points of the slanted shapes; rectangles return null.
  function outline(b) {
    var x = b.x, y = b.y, w = b.w, H = b.h;
    if (b.kind === 'mux') {
      var d = Math.min(w * 0.9, H * 0.22);
      if (b.dir === 'down') return [[x, y], [x + w, y], [x + w - d, y + H], [x + d, y + H]];
      return [[x, y], [x + w, y + d], [x + w, y + H - d], [x, y + H]];
    }
    if (b.kind === 'alu' || b.kind === 'add') {
      return [[x, y], [x + w, y + H * 0.28], [x + w, y + H * 0.72], [x, y + H], [x, y + H * 0.6], [x + w * 0.22, y + H / 2], [x, y + H * 0.4]];
    }
    return null;
  }
  function shape(b, g) {
    var o = outline(b);
    if (o) return s('polygon', { class: 'shape', points: o.map(function (p) { return p[0] + ' ' + p[1]; }).join(' ') }, g);
    var r = b.kind === 'bar' || b.kind === 'reg' ? 2 : 6;
    return s('rect', { class: 'shape', x: b.x, y: b.y, width: b.w, height: b.h, rx: r }, g);
  }

  /* ---------- nets ----------
     How a model's wires connect, and which parts of them a frame lights. A
     wire that starts on another wire is fed by it, so lighting the wire also
     lights the feeding wire from its source up to the tap, and no further.
     Nothing here touches the page; the tests run it on every recorded cycle. */
  var NEAR = 0.75;   // two points this close are the same point
  var GATE = 24;     // delay through a block, as a length of wire

  function round(v) { return Math.round(v * 10) / 10; }
  function measure(pts) {
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return cum;
  }
  // Distance along wire w at which point p lies on it, or -1.
  function arcAt(w, p) {
    for (var i = 1; i < w.pts.length; i++) {
      var a = w.pts[i - 1], b = w.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L = w.cum[i] - w.cum[i - 1];
      if (!L) continue;
      var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L);
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= NEAR) return w.cum[i - 1] + Math.max(0, Math.min(1, t)) * L;
    }
    return -1;
  }
  function pointAt(w, at) {
    for (var i = 1; i < w.pts.length; i++) {
      if (at <= w.cum[i] || i === w.pts.length - 1) {
        var L = w.cum[i] - w.cum[i - 1], t = L ? Math.max(0, Math.min(1, (at - w.cum[i - 1]) / L)) : 0;
        return [round(w.pts[i - 1][0] + t * (w.pts[i][0] - w.pts[i - 1][0])), round(w.pts[i - 1][1] + t * (w.pts[i][1] - w.pts[i - 1][1]))];
      }
    }
    return w.pts[0];
  }
  // The points of wire w between two distances along it.
  function slice(w, a, b) {
    var out = [pointAt(w, a)];
    for (var i = 1; i < w.pts.length - 1; i++) if (w.cum[i] > a + 1e-6 && w.cum[i] < b - 1e-6) out.push(w.pts[i]);
    out.push(pointAt(w, b));
    return out;
  }
  // The smallest block whose box contains p.
  function blockAt(model, p) {
    var best = null;
    Object.keys(model.blocks).forEach(function (id) {
      var b = model.blocks[id];
      if (p[0] < b.x - 1.5 || p[0] > b.x + b.w + 1.5 || p[1] < b.y - 1.5 || p[1] > b.y + b.h + 1.5) return;
      if (!best || b.w * b.h < model.blocks[best].w * model.blocks[best].h) best = id;
    });
    return best;
  }
  // Move the end of a wire onto the slanted edge it points at.
  function snap(pts, i, b) {
    var o = outline(b);
    if (!o) return;
    var p = pts[i], q = pts[i ? i - 1 : 1], dx = p[0] - q[0], dy = p[1] - q[1], L = Math.hypot(dx, dy), best = null;
    if (!L) return;
    for (var k = 0; k < o.length; k++) {
      var a = o[k], c = o[(k + 1) % o.length], ex = c[0] - a[0], ey = c[1] - a[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      var t = ((a[0] - q[0]) * ey - (a[1] - q[1]) * ex) / den, u = ((a[0] - q[0]) * dy - (a[1] - q[1]) * dx) / den;
      if (u < -1e-6 || u > 1 + 1e-6 || t < 0.02 || t > 1 + 14 / L) continue;
      if (best === null || t < best) best = t;
    }
    if (best !== null) pts[i] = [round(q[0] + dx * best), round(q[1] + dy * best)];
  }

  function buildNet(model) {
    var ids = Object.keys(model.wires), wires = {};
    ids.forEach(function (id) {
      var m = model.wires[id], pts = m.pts.map(function (p) { return [p[0], p[1]]; });
      var src = blockAt(model, pts[0]), dst = blockAt(model, pts[pts.length - 1]);
      if (src) snap(pts, 0, model.blocks[src]);
      if (dst) snap(pts, pts.length - 1, model.blocks[dst]);
      var cum = measure(pts);
      // parent/tap: the wire this one starts on, and where. origin: where the
      // signal enters this wire (not its first point when it is fed part-way).
      wires[id] = { id: id, pts: pts, cum: cum, len: cum[cum.length - 1], arrow: m.arrow !== false, cls: m.cls || '', latch: !!m.latch, src: src, dst: dst, parent: null, tap: 0, origin: 0 };
    });
    function each(test) { ids.forEach(function (id) { var w = wires[id]; if (!w.src && !w.parent) ids.some(function (other) { return other !== id && test(w, wires[other]); }); }); }
    // A wire that starts part-way along another, or where another ends.
    each(function (w, p) {
      var at = arcAt(p, w.pts[0]);
      if (at <= NEAR) return false;
      w.parent = p.id; w.tap = at; return true;
    });
    // A trunk with no start of its own is fed where another wire ends on it.
    each(function (w, f) {
      if (f.dst || f.parent === w.id) return false;
      var at = arcAt(w, f.pts[f.pts.length - 1]);
      if (at < 0) return false;
      w.parent = f.id; w.tap = f.len; w.origin = at; return true;
    });
    // Wires that leave such a trunk at its first point.
    each(function (w, p) {
      if (p.origin <= NEAR || p.parent === w.id || arcAt(p, w.pts[0]) < 0) return false;
      w.parent = p.id; w.tap = arcAt(p, w.pts[0]); return true;
    });
    var dots = [];
    ids.forEach(function (id) {
      (model.wires[id].dots || []).forEach(function (p) {
        var through = [];
        ids.forEach(function (other) { var at = arcAt(wires[other], p); if (at >= 0) through.push({ id: other, at: at }); });
        dots.push({ x: p[0], y: p[1], owner: id, through: through });
      });
    });
    return { model: model, ids: ids, wires: wires, dots: dots };
  }

  // The lit parts of a frame. `on` is frame.wires; `shown(id)` is false for
  // wires on a hidden layer. Returns pieces of wire in the direction the signal
  // travels, each with the distance the signal has covered when it gets there.
  function light(net, on, shown) {
    var W = net.wires, claims = {}, live = {};
    net.ids.forEach(function (id) { if (on[id] && (!shown || shown(id))) live[id] = on[id]; });
    function claim(id, a, b, f, by) {
      claims[id] = claims[id] || [];
      if (b - a > 1e-6) claims[id].push({ a: a, b: b, color: f.color || '', hot: !!f.hot, tone: W[by].cls });
    }
    Object.keys(live).forEach(function (id) {
      var w = W[id], f = live[id];
      if (w.arrow) claim(id, 0, w.len, f, id);
      // What feeds it, up to a block or a wire that is lit in its own right.
      for (var hops = 0; w.parent && hops < 64; hops++) {
        var p = W[w.parent], own = live[p.id];
        if ((shown && !shown(p.id)) || (own && p.arrow)) break;
        claim(p.id, Math.min(p.origin, w.tap), Math.max(p.origin, w.tap), own || f, own ? p.id : id);
        if (own) break;
        w = p;
      }
    });
    // A lit wire without an arrowhead is a trunk: it lights as far as the
    // wires that leave it, or whole when none of them is in use.
    Object.keys(live).forEach(function (id) { if (!W[id].arrow && !claims[id]) claim(id, 0, W[id].len, live[id], id); });

    var pieces = [], byWire = {};
    Object.keys(claims).forEach(function (id) {
      var w = W[id], list = claims[id], cuts = [], last = null;
      list.forEach(function (c) { cuts.push(c.a, c.b); });
      if (w.origin > NEAR) cuts.push(w.origin);
      cuts.sort(function (x, y) { return x - y; });
      for (var i = 1; i < cuts.length; i++) {
        var a = cuts[i - 1], b = cuts[i], mid = (a + b) / 2, best = null;
        if (b - a < 1e-6) continue;
        list.forEach(function (c) { if (c.a <= mid && mid <= c.b && (!best || (c.hot && !best.hot))) best = c; });
        if (!best) { last = null; continue; }
        var back = b <= w.origin + 1e-6;
        if (last && last.b === a && last.back === back && last.color === best.color && last.hot === best.hot && last.tone === best.tone) { last.b = b; continue; }
        last = { id: id, a: a, b: b, back: back, color: best.color, hot: best.hot, tone: best.tone };
        pieces.push(last);
        (byWire[id] = byWire[id] || []).push(last);
      }
    });

    // When the signal reaches each wire: registers and pipeline bars start the
    // cycle, and a block passes it on after its last lit input arrives. A wire
    // marked `latch` in the model is stored at the clock edge (a register
    // write), so nothing leaving its block waits for it.
    var into = {}, starts = {}, busy = {};
    function passive(id) { var k = net.model.blocks[id].kind; return k === 'bar' || k === 'reg'; }
    Object.keys(byWire).forEach(function (id) {
      var w = W[id];
      if (w.dst && !w.latch && byWire[id].some(function (p) { return p.b >= w.len - NEAR; })) (into[w.dst] = into[w.dst] || []).push(id);
    });
    function start(id) {
      if (starts[id] !== undefined) return starts[id];
      if (busy[id]) return 0;
      busy[id] = true;
      var w = W[id], t = 0;
      if (w.parent) t = start(w.parent) + Math.abs(w.tap - W[w.parent].origin);
      else if (w.src && !passive(w.src)) (into[w.src] || []).forEach(function (v) { t = Math.max(t, start(v) + W[v].len - W[v].origin + GATE); });
      busy[id] = false;
      return (starts[id] = t);
    }
    var span = 0;
    pieces.forEach(function (p) {
      var w = W[p.id];
      p.pts = slice(w, p.a, p.b);
      if (p.back) p.pts.reverse();
      p.len = p.b - p.a;
      p.at = start(p.id) + (p.back ? w.origin - p.b : p.a - w.origin);
      p.head = w.arrow && !p.back && p.b >= w.len - NEAR;
      span = Math.max(span, p.at + p.len);
    });

    var dots = [];
    net.dots.forEach(function (d) {
      if (shown && !shown(d.owner)) return;
      var best = null;
      d.through.forEach(function (th) {
        (byWire[th.id] || []).forEach(function (p) { if (th.at >= p.a - NEAR && th.at <= p.b + NEAR && (!best || (p.hot && !best.hot))) best = p; });
      });
      if (best) dots.push({ x: d.x, y: d.y, color: best.color, hot: best.hot, tone: best.tone });
    });
    return { pieces: pieces, dots: dots, byWire: byWire, span: span };
  }

  /* ---------- diagram ---------- */
  // Arrowhead length and half-width, and how far the line stops short of the
  // tip so that its square end stays inside the head.
  var HEAD = { rest: [7, 3.6, 4], bus: [8.5, 4.6, 5], lit: [8.5, 4.6, 5], ctl: [8, 4.3, 5], hot: [9.5, 5.2, 6], litbus: [10, 5.6, 6.5] };
  function headKind(cls, lit, hot) {
    if (!lit) return cls === 'bus' ? 'bus' : 'rest';
    return hot ? 'hot' : cls === 'bus' ? 'litbus' : cls === 'ctl' ? 'ctl' : 'lit';
  }
  function pathData(pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' '); }
  // Line and arrowhead for a run of points.
  function strand(pts, head, g) {
    var n = pts.length, line = pts;
    if (head) {
      var p = pts[n - 2], q = pts[n - 1], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      var size = HEAD[head], back = Math.min(size[2], Math.max(0, L - 0.5));
      line = pts.slice(0, n - 1).concat([[round(q[0] - ux * back), round(q[1] - uy * back)]]);
      var bx = q[0] - ux * size[0], by = q[1] - uy * size[0];
      s('path', { class: 'ln', d: pathData(line) }, g);
      s('polygon', { class: 'ah', points: [q[0], q[1], round(bx - uy * size[1]), round(by + ux * size[1]), round(bx + uy * size[1]), round(by - ux * size[1])].join(' ') }, g);
    } else s('path', { class: 'ln', d: pathData(line) }, g);
    return line;
  }
  var TONE = { ctl: 'var(--ctl-line)', trap: 'var(--trap-line)' };
  function tint(piece) { return piece.color || TONE[piece.tone] || 'var(--ink)'; }

  function Diagram(model, onPick) {
    var self = this;
    this.model = model;
    this.net = buildNet(model);
    var svg = s('svg', { viewBox: '0 ' + (model.y0 || 0) + ' ' + model.w + ' ' + model.h, role: 'img' });
    s('title', { text: model.title }, svg);
    s('desc', { text: model.desc }, svg);
    this.svg = svg;
    // Wires at rest, then their lit parts, then the hovered and selected wire:
    // a lit wire is never cut by an idle one that crosses it.
    var gRegion = s('g', {}, svg), gWire = s('g', {}, svg), gLit = s('g', { class: 'lit-layer' }, svg), gFocus = s('g', {}, svg),
      gBlock = s('g', {}, svg), gLabel = s('g', {}, svg), gTag = s('g', {}, svg);
    this.gTag = gTag; this.gLit = gLit;
    this.gSel = s('g', {}, gFocus); this.gHover = s('g', {}, gFocus);
    this.wires = {}; this.blocks = {}; this.labels = {};
    this.picked = null; this.pulses = []; this.lit = null;

    (model.regions || []).forEach(function (r) {
      var g = s('g', { class: 'region' + (r.layer ? ' L-' + r.layer : '') }, gRegion);
      if (r.w) s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10 }, g);
      if (r.label) s('text', { x: r.lx || r.x + 10, y: r.ly || r.y + 18, text: r.label, class: r.cls || '' }, g);
    });
    (model.heads || []).forEach(function (t) {
      s('text', { x: t[0], y: t[1], text: t[2], class: 'stage-head', 'text-anchor': 'middle' }, gRegion);
    });
    (model.contracts || []).forEach(function (c) {
      var g = s('g', { class: c.layer ? 'L-' + c.layer : '' }, gRegion);
      s('line', { class: 'contract-line', x1: c.x1, y1: c.y, x2: c.x2, y2: c.y }, g);
      var chip = s('g', { class: 'contract-chip blk', 'data-id': c.id, role: 'button', tabindex: 0, 'aria-label': c.label + ' contract' }, g);
      var tw = c.label.length * 7.6 + 18;
      s('rect', { x: c.cx - tw / 2, y: c.y - 11, width: tw, height: 22, rx: 11 }, chip);
      s('text', { x: c.cx, y: c.y + 1, text: c.label }, chip);
      chip.addEventListener('click', function () { onPick('contract', c.id); });
      chip.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick('contract', c.id); } });
      self.blocks[c.id] = chip;
    });

    Object.keys(model.wires).forEach(function (id) {
      var w = model.wires[id], n = self.net.wires[id];
      var g = s('g', { class: 'wire' + (w.cls ? ' ' + w.cls : '') + (w.layer ? ' L-' + w.layer : ''), 'data-id': id }, gWire);
      self.draw(id, g);
      s('path', { class: 'hit', d: pathData(n.pts) }, g);
      g.addEventListener('click', function (e) { e.stopPropagation(); onPick('wire', id); });
      g.addEventListener('pointerenter', function () { self.gHover.replaceChildren(self.copy(id)); });
      g.addEventListener('pointerleave', function () { self.gHover.replaceChildren(); });
      s('title', { text: (w.name || id) }, g);
      self.wires[id] = g;
      (w.lab || []).forEach(function (l) {
        var t = s('text', { class: 'wl' + (w.cls === 'ctl' ? ' ctl' : '') + (w.layer ? ' L-' + w.layer : ''), x: l[0], y: l[1], text: l[2], 'text-anchor': l[3] || 'start' }, gLabel);
        (self.labels[id] = self.labels[id] || []).push(t);
      });
    });

    Object.keys(model.blocks).forEach(function (id) {
      var b = model.blocks[id];
      var g = s('g', { class: 'blk k-' + (b.kind || 'box') + (b.layer ? ' L-' + b.layer : ''), 'data-id': id, role: 'button', tabindex: 0, 'aria-label': (b.info && b.info.title) || b.label || id }, gBlock);
      shape(b, g);
      if (b.kind === 'reg' && b.clk !== false) {
        var cx = b.x + b.w / 2, by = b.y + b.h;
        s('polyline', { class: 'clk', points: [cx - 6, by, cx, by - 7, cx + 6, by].join(' ') }, g);
      }
      var cx2 = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (b.vertical) {
        s('text', { class: 't', x: cx2, y: cy, text: b.label, transform: 'rotate(-90 ' + cx2 + ' ' + cy + ')' }, g);
      } else if (b.label) {
        var lines = b.sub ? [cy - 8, cy + 9] : [cy, null];
        s('text', { class: 't', x: cx2 + (b.tx || 0), y: lines[0] + (b.ty || 0), text: b.label }, g);
        if (b.sub) String(b.sub).split('\n').forEach(function (line, i) {
          s('text', { class: 's', x: cx2 + (b.tx || 0), y: lines[1] + (b.ty || 0) + i * 12, text: line }, g);
        });
      }
      (b.pins || []).forEach(function (p) { s('text', { class: 'pin', x: p[0], y: p[1], text: p[2], 'text-anchor': p[3] || 'start' }, g); });
      g.addEventListener('click', function () { onPick('block', id); });
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick('block', id); } });
      self.blocks[id] = g;
    });
  }
  // A wire at rest: line, arrowhead and junction dots.
  Diagram.prototype.draw = function (id, g) {
    var w = this.model.wires[id], n = this.net.wires[id];
    strand(n.pts, n.arrow ? headKind(w.cls, false) : null, g);
    (w.dots || []).forEach(function (p) { s('circle', { class: 'dot', cx: p[0], cy: p[1], r: 2.8 }, g); });
  };
  // A copy drawn over the lit wires, for the hovered and the selected wire.
  Diagram.prototype.copy = function (id) {
    var w = this.model.wires[id], g = s('g', { class: 'wire focus' + (w.cls ? ' ' + w.cls : '') });
    this.draw(id, g);
    return g;
  };
  Diagram.prototype.shown = function (id) { return !this.wires[id].classList.contains('layer-off'); };
  Diagram.prototype.setLayers = function (layers) {
    var svg = this.svg;
    (this.model.layers || []).forEach(function (L) {
      svg.querySelectorAll('.L-' + L.key).forEach(function (el) { el.classList.toggle('layer-off', !layers[L.key]); });
    });
    if (this.picked) this.select(this.picked.kind, this.picked.id);
  };
  Diagram.prototype.select = function (kind, id) {
    this.picked = { kind: kind, id: id };
    this.svg.querySelectorAll('.sel').forEach(function (el) { el.classList.remove('sel'); });
    this.gSel.replaceChildren();
    if (kind === 'wire') { if (this.wires[id] && this.shown(id)) this.gSel.appendChild(this.copy(id)); }
    else if (this.blocks[id]) this.blocks[id].classList.add('sel');
  };
  // flow: { span: milliseconds } runs one pulse along the lit wires, in the
  // order the signals settle; omit it to change the picture without motion.
  Diagram.prototype.apply = function (frame, showValues, flow) {
    var self = this;
    var lit = this.lit = light(this.net, frame.wires, function (id) { return self.shown(id); });
    this.pulses.forEach(function (a) { a.cancel(); });
    this.pulses = [];
    this.gLit.replaceChildren();
    // Hot paths go on top of the others; junction dots on top of both.
    lit.pieces.slice().sort(function (a, b) { return (a.hot ? 1 : 0) - (b.hot ? 1 : 0); }).forEach(function (p) {
      var cls = self.model.wires[p.id].cls || '';
      var g = s('g', { class: 'lit' + (cls ? ' ' + cls : '') + (p.hot ? ' hot' : ''), style: 'color:' + tint(p) }, self.gLit);
      var line = strand(p.pts, p.head ? headKind(cls, true, p.hot) : null, g);
      // Dashes keep the phase of the wire at rest underneath.
      if (cls === 'ctl') g.firstChild.style.strokeDashoffset = String(p.back ? ((5 - p.b) % 8 + 8) % 8 : p.a % 8);
      if (flow) self.pulse(p, line, g, flow.span, lit.span);
    });
    lit.dots.forEach(function (d) {
      s('circle', { class: 'dot' + (d.hot ? ' hot' : ''), cx: d.x, cy: d.y, r: d.hot ? 3.9 : 3.5, style: 'color:' + tint(d) }, self.gLit);
    });
    Object.keys(this.model.blocks).forEach(function (id) {
      var g = self.blocks[id], f = frame.blocks[id] || {};
      g.classList.toggle('on', !!f.on);
      g.classList.toggle('wait', !!f.wait);
      var old = g.querySelector('.badge');
      if (old) old.remove();
      if (f.badge) {
        // Above the block and centred, unless the model moves it (badgeX is
        // the centre, badgeY the top) clear of a wire that enters there.
        var b = self.model.blocks[id];
        var bw = f.badge.length * 6.4 + 12, bx = (b.badgeX !== undefined ? b.badgeX : b.x + b.w / 2) - bw / 2, by = (b.badgeY !== undefined ? b.badgeY : b.y - 18);
        var bg = s('g', { class: 'badge' }, g);
        s('rect', { x: bx, y: by, width: bw, height: 16, rx: 8 }, bg);
        s('text', { x: bx + bw / 2, y: by + 8.5, text: f.badge }, bg);
      }
    });
    this.gTag.replaceChildren();
    (frame.tokens || []).forEach(function (t) {
      var g = s('g', { class: t.bubble ? 'bubble' : 'token' }, self.gTag);
      var tw = Math.max(t.minw || 0, t.text.length * 6.7 + 14);
      var x = t.anchor === 'start' ? t.x : t.x - tw / 2;
      s('rect', { x: x, y: t.y - 10, width: tw, height: 20, rx: 10, style: t.bubble ? '' : 'fill:' + t.color }, g);
      s('text', { x: x + tw / 2, y: t.y + 1, text: t.text }, g);
      if (t.strike) s('line', { x1: x + 6, y1: t.y, x2: x + tw - 6, y2: t.y, stroke: '#fff', 'stroke-width': 1.5 }, g);
    });
    if (showValues) {
      // A value shows wherever any part of its wire is lit. vt is [x, y] for a
      // centred tag; a third entry, 'start' or 'end', pins that edge instead,
      // so a long value grows away from the block beside it.
      Object.keys(frame.values || {}).forEach(function (id) {
        var w = self.model.wires[id], parts = lit.byWire[id];
        if (!w || !w.vt || !parts) return;
        var text = frame.values[id];
        var g = s('g', { class: 'vtag', style: 'color:' + tint(parts[0]) }, self.gTag);
        var tw = text.length * 6.1 + 10, x = w.vt[2] === 'start' ? w.vt[0] : w.vt[2] === 'end' ? w.vt[0] - tw : w.vt[0] - tw / 2;
        s('rect', { x: x, y: w.vt[1] - 8, width: tw, height: 16, rx: 3 }, g);
        s('text', { x: x + tw / 2, y: w.vt[1] + 0.5, text: text }, g);
      });
    }
    return lit;
  };
  // One bead that runs the length of a lit piece. Distance is compressed
  // (square root) so that near wires are not over in a blink and far ones
  // still finish within the span.
  Diagram.prototype.pulse = function (piece, line, g, span, reach) {
    var path = s('path', { class: 'pulse', d: pathData(line) }, g);
    if (!path.animate) { path.remove(); return; }
    var scale = Math.max(reach, (this.model.w + this.model.h) / 2);
    function when(d) { return span * Math.sqrt(Math.min(1, d / scale)); }
    var len = path.getTotalLength ? path.getTotalLength() : piece.len, dash = Math.min(9, Math.max(3, len * 0.4));
    var from = when(piece.at), to = Math.max(from + 70, when(piece.at + piece.len));
    path.style.strokeDasharray = dash + ' ' + (len + dash + 8);
    this.pulses.push(path.animate([{ strokeDashoffset: dash + 2 }, { strokeDashoffset: -(len + 2) }], { delay: from, duration: to - from, fill: 'both', easing: 'linear' }));
  };

  /* ---------- page widget ---------- */
  function mount(container, key, opts) {
    opts = opts || {};
    unmount(container);
    var M = models[key];
    var T = window.PRISM_CORE_TRACES || {};
    if (!M || !(opts.custom || window.PRISM_CORE_TRACES)) { container.textContent = 'Diagram data is missing.'; return; }
    // opts.custom = { key, label, trace }: a trace compiled in the browser
    // (core-trace-compiler.js). `key` is the model configuration it ran on.
    // Configurations without a recording in this build are left out.
    var variants = M.variants.filter(function (v) { return T[v.trace]; });
    if (!variants.length) variants = M.variants;
    if (opts.custom) {
      T = Object.assign({}, T, { __custom: opts.custom.trace });
      variants = [{ key: opts.custom.key, label: opts.custom.label || 'Your program', trace: '__custom' }];
    }
    var variant = variants.filter(function (v) { return v.key === opts.variant; })[0] || variants[0];
    var trace = T[variant.trace];
    var cycle = opts.cycle !== undefined ? opts.cycle : (opts.custom ? 0 : (M.startCycle || 0)), timer = null;
    var layers = {};
    (M.layers || []).forEach(function (L) { layers[L.key] = L.on !== false; });
    (opts.layers || []).forEach(function (k) { layers[k] = true; });
    var showValues = true;
    var picked = null;
    // Signal flow: on unless the reader turned it off, or asks for reduced motion.
    var FLOW_KEY = 'prism-core-diagram-flow';
    if (flowSetting === undefined) {
      try { flowSetting = window.localStorage.getItem(FLOW_KEY); } catch (error) { /* storage is optional */ }
      flowSetting = flowSetting === 'on' ? true : flowSetting === 'off' ? false : null;
    }
    var showFlow = flowSetting !== null && flowSetting !== undefined ? flowSetting : !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var drawn = null;

    var root = h('section', { class: 'cd live', 'aria-label': M.title });
    var detailBody = h('div', { tabindex: -1, 'aria-live': 'polite' });
    var detail = h('div', { class: 'cd-detail' }, detailBody);
    var selBar = h('p', { class: 'cd-selbar', hidden: true });
    var diagram = new Diagram(M, pick);
    var now = h('div', { class: 'cd-now', 'aria-live': 'polite' });
    var slider = h('input', { type: 'range', min: 0, max: trace.cycles.length - 1, value: cycle, 'aria-label': 'Cycle' });
    var counter = h('span', { class: 'cd-cycle' });
    function counterText(t, i) { return 'cycle ' + t.cycles[i].c + ' (' + t.cycles[0].c + '–' + t.cycles[t.cycles.length - 1].c + ')'; }
    // Reserve the widest text any configuration can show (monospace, so ch is
    // exact); a counter that grows would re-wrap the toolbar.
    counter.style.width = Math.max.apply(null, variants.map(function (v) {
      var t = T[v.trace]; return t ? counterText(t, t.cycles.length - 1).length : 0;
    })) + 'ch';
    var playBtn = h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Play', text: '▶' });
    var chart = h('div', { class: 'cd-chart' });

    function stop() { if (timer) { clearInterval(timer); timer = null; } playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Play'); }
    function go(c) { cycle = Math.max(0, Math.min(trace.cycles.length - 1, c)); render(); }
    function step(dir) { stop(); go(cycle + dir); }
    function jumpEvent(dir) {
      stop();
      for (var c = cycle + dir; c >= 0 && c < trace.cycles.length; c += dir) {
        if (M.isEvent(trace, c)) { go(c); return; }
      }
    }
    playBtn.addEventListener('click', function () {
      if (timer) { stop(); return; }
      if (cycle >= trace.cycles.length - 1) cycle = 0;
      playBtn.textContent = '❚❚'; playBtn.setAttribute('aria-label', 'Pause');
      // Stop when the run ends or the widget has been replaced (for example by a new run).
      timer = setInterval(function () { if (cycle >= trace.cycles.length - 1 || !root.isConnected) stop(); else go(cycle + 1); }, Number(speed.value));
    });
    slider.addEventListener('input', function () { stop(); go(Number(slider.value)); });
    var speed = h('select', { 'aria-label': 'Speed' },
      h('option', { value: 1100, text: 'Slow' }), h('option', { value: 650, text: 'Normal', selected: true }), h('option', { value: 300, text: 'Fast' }));
    speed.addEventListener('change', function () { if (timer) { stop(); playBtn.click(); } });

    // Generic per-configuration geometry text: block sub-labels (variantSub)
    // and contract chips limited to some configurations (contract.variants).
    function applyVariant() {
      Object.keys(M.blocks).forEach(function (id) {
        var b = M.blocks[id], g = diagram.blocks[id];
        if (!b.variantSub || !g) return;
        var sub = b.variantSub[variant.key] !== undefined ? b.variantSub[variant.key] : b.sub;
        var lines = g.querySelectorAll('text.s');
        String(sub || '').split('\n').forEach(function (line, i) { if (lines[i]) lines[i].textContent = line; });
      });
      (M.contracts || []).forEach(function (c) {
        var chip = diagram.blocks[c.id];
        if (c.variants && chip && chip.parentNode) chip.parentNode.style.display = c.variants.indexOf(variant.key) >= 0 ? '' : 'none';
      });
      if (M.onVariant) M.onVariant(diagram, variant);
    }
    var variantGroup = variants.length > 1 ? h('div', { class: 'cd-group', role: 'group', 'aria-label': 'Configuration' },
      h('span', { class: 'cd-group-label', text: 'Configuration' }),
      variants.map(function (v) {
        var b = h('button', { type: 'button', 'aria-pressed': String(v === variant), text: v.label });
        b.addEventListener('click', function () {
          stop(); variant = v; trace = T[v.trace];
          variantGroup.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          slider.max = trace.cycles.length - 1;
          applyVariant();
          setupLabels(); buildChart(); go(Math.min(cycle, trace.cycles.length - 1));
        });
        return b;
      })) : null;

    // Label jumps. opts.symbols maps label -> address (from the assembler). A
    // visit is an instruction at that address that retired or trapped; it is
    // marked at its first cycle in the chart. The same run can then be read from
    // any point, for example the first and second pass of a loop.
    var labels = [], label = null;
    // Without opts.symbols (the recorded demos), labels come from assembling
    // the trace's own source when the assembler is on the page.
    function programSymbols() {
      if (!trace.program || !window.PrismAsm) return {};
      try {
        var r = window.PrismAsm.assemble(trace.program, { profile: key === 'singlecycle' ? 'singlecycle' : key });
        return r.ok ? r.symbols : {};
      } catch (e) { return {}; }
    }
    function findLabels() {
      var syms = opts.symbols || programSymbols(), byPc = {};
      trace.dyn.forEach(function (d) {
        // Count instructions that executed: not discarded, not left in flight at the end.
        if ((d.fate !== 'retired' && d.fate !== 'trap') || d.pc === undefined || d.pc === null) return;
        var keys = Object.keys(d.cells).map(Number);
        if (!keys.length) return;
        (byPc[d.pc] = byPc[d.pc] || []).push(Math.min.apply(null, keys) - trace.cycles[0].c);
      });
      return Object.keys(syms).filter(function (n) { return byPc[syms[n]]; })
        .sort(function (a, b) { return syms[a] - syms[b] || (a < b ? -1 : 1); })
        .map(function (n) {
          var at = byPc[syms[n]].filter(function (i) { return i >= 0 && i < trace.cycles.length; }).sort(function (a, b) { return a - b; });
          return { name: n, at: at.filter(function (i, k) { return at.indexOf(i) === k; }) };
        }).filter(function (L) { return L.at.length; });
    }
    var labelSel = h('select', { 'aria-label': 'Label' });
    var labelPrev = h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Previous visit to the label', title: 'Previous visit', text: '◀' });
    var labelNext = h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Next visit to the label', title: 'Next visit', text: '▶' });
    var labelPos = h('span', { class: 'cd-label-pos' });
    var labelGroup = h('div', { class: 'cd-group', role: 'group', 'aria-label': 'Jump to a label' },
      h('span', { class: 'cd-group-label', text: 'Label' }), labelSel, labelPrev, labelNext, labelPos);
    function setupLabels() {
      labels = findLabels();
      var keep = label && labels.filter(function (L) { return L.name === label.name; })[0];
      label = keep || labels[0] || null;
      setKids(labelSel, labels.map(function (L) {
        return h('option', { value: L.name, selected: L === label, text: L.name + ' (' + L.at.length + '×)' });
      }));
      labelGroup.hidden = !labels.length;
      var widest = 0;
      labels.forEach(function (L) { widest = Math.max(widest, String(L.at.length).length); });
      labelPos.style.width = (2 * widest + 4) + 'ch';
    }
    function visitIndex(i) { return label ? label.at.indexOf(i) : -1; }
    function jumpLabel(dir) {
      if (!label) return;
      stop();
      var at = label.at, target = null;
      if (dir > 0) { for (var k = 0; k < at.length; k++) if (at[k] > cycle) { target = at[k]; break; } }
      else { for (var j = at.length - 1; j >= 0; j--) if (at[j] < cycle) { target = at[j]; break; } }
      if (target !== null) go(target);
    }
    function updateLabel() {
      if (!label) return;
      var k = visitIndex(cycle);
      labelPos.textContent = k >= 0 ? (k + 1) + ' of ' + label.at.length : '';
      labelPrev.disabled = !(label.at[0] < cycle);
      labelNext.disabled = !(label.at[label.at.length - 1] > cycle);
      headCells.forEach(function (th, col) { th.classList.toggle('mark', label.at.indexOf(win.lo + col) >= 0); });
    }
    labelSel.addEventListener('change', function () {
      label = labels.filter(function (L) { return L.name === labelSel.value; })[0] || null;
      if (!label) return;
      stop();
      // The first visit at or after the current cycle, else the last one.
      var next = label.at.filter(function (i) { return i >= cycle; })[0];
      go(next !== undefined ? next : label.at[label.at.length - 1]);
    });
    labelPrev.addEventListener('click', function () { jumpLabel(-1); });
    labelNext.addEventListener('click', function () { jumpLabel(1); });
    setupLabels();

    var layerGroup = h('div', { class: 'cd-group cd-layers', role: 'group', 'aria-label': 'Layers' },
      h('span', { class: 'cd-group-label', text: 'Show' }),
      (M.layers || []).map(function (L) {
        var cb = h('input', { type: 'checkbox', checked: layers[L.key] });
        cb.addEventListener('change', function () { layers[L.key] = cb.checked; diagram.setLayers(layers); render(); });
        return h('label', null, cb, L.label);
      }),
      (function () {
        var cb = h('input', { type: 'checkbox', checked: true });
        cb.addEventListener('change', function () { showValues = cb.checked; render(); });
        return h('label', null, cb, 'values');
      })(),
      (function () {
        var cb = h('input', { type: 'checkbox', checked: showFlow });
        cb.addEventListener('change', function () {
          showFlow = flowSetting = cb.checked;
          try { window.localStorage.setItem(FLOW_KEY, showFlow ? 'on' : 'off'); } catch (error) { /* storage is optional */ }
          drawn = null; render();
        });
        return h('label', { title: 'Each cycle, a pulse runs along the lit wires from the registers through the logic' }, cb, 'signal flow');
      })());

    var figure = h('div', { class: 'cd-figure' }, diagram.svg);
    var storageKey = 'prism-core-diagram-zoom-' + key;
    var savedZoom = zoomSettings[key];
    if (savedZoom === undefined) {
      try { savedZoom = window.localStorage.getItem(storageKey); } catch (error) { /* storage is optional */ }
    }
    var zoom = savedZoom && savedZoom !== 'fit' && Number(savedZoom) >= 10 && Number(savedZoom) <= 200 ? Number(savedZoom) : null;
    if (opts.fit !== undefined) zoom = opts.fit ? null : 100;
    var zoomSlider = h('input', { type: 'range', min: 10, max: 200, step: 1, value: 100,
      'aria-label': M.title + ' zoom', 'aria-valuetext': 'Fit to width' });
    var zoomValue = h('span', { class: 'cd-zoom-value', 'aria-hidden': 'true', text: 'Fit' });
    var zoomBtn = h('button', { type: 'button', 'aria-pressed': 'false', title: 'Fit the whole diagram to the page width', text: 'Fit to width' });
    var actualBtn = h('button', { type: 'button', text: '100%', title: 'Show the diagram at its original size' });
    function updateScale() {
      var width = diagram.svg.getBoundingClientRect().width;
      if (!width && zoom === null) return;
      var percent = zoom === null ? Math.round(100 * width / M.w) : zoom;
      zoomSlider.value = Math.max(10, Math.min(200, percent));
      zoomSlider.setAttribute('aria-valuetext', percent + '%' + (zoom === null ? ' (fit to width)' : ''));
      zoomValue.textContent = percent + '%';
      var horizontal = figure.scrollWidth > figure.clientWidth + 1;
      figure.classList.toggle('pannable', horizontal || figure.scrollHeight > figure.clientHeight + 1);
      stageGroup.hidden = !horizontal;
    }
    function setZoom(value, remember) {
      // Preserve the point at the centre while the reader adjusts the slider.
      var oldWidth = diagram.svg.getBoundingClientRect().width || M.w;
      var inset = Math.max(0, (figure.clientWidth - oldWidth) / 2);
      var x = (figure.scrollLeft + figure.clientWidth / 2 - inset) / oldWidth;
      var y = (figure.scrollTop + figure.clientHeight / 2) / oldWidth;
      zoom = value;
      figure.classList.toggle('zoom', zoom !== null);
      figure.style.setProperty('--diagram-w', zoom === null ? '100%' : (M.w * zoom / 100) + 'px');
      zoomBtn.setAttribute('aria-pressed', String(zoom === null));
      actualBtn.setAttribute('aria-pressed', String(zoom === 100));
      if (remember) {
        zoomSettings[key] = zoom === null ? 'fit' : zoom;
        try { window.localStorage.setItem(storageKey, String(zoomSettings[key])); } catch (error) { /* storage is optional */ }
      }
      var width = diagram.svg.getBoundingClientRect().width;
      figure.scrollLeft = zoom === null ? 0 : x * width - figure.clientWidth / 2;
      figure.scrollTop = zoom === null ? 0 : y * width - figure.clientHeight / 2;
      updateScale();
    }
    zoomSlider.addEventListener('input', function () { setZoom(Number(zoomSlider.value), true); });
    zoomBtn.addEventListener('click', function () { setZoom(null, true); });
    actualBtn.addEventListener('click', function () { setZoom(100, true); });
    var zoomGroup = h('div', { class: 'cd-group cd-zoom', role: 'group', 'aria-label': 'Diagram scale' },
      h('label', { class: 'cd-zoom-label' }, 'Zoom', zoomSlider, zoomValue),
      h('div', { class: 'cd-group' }, zoomBtn, actualBtn));
    function scrollToPoint(x, y) {
      var scale = diagram.svg.getBoundingClientRect().width / M.w;
      var smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      figure.scrollTo({ left: Math.max(0, x * scale - figure.clientWidth / 2),
        top: y === undefined ? figure.scrollTop : Math.max(0, (y - (M.y0 || 0)) * scale - figure.clientHeight / 2),
        behavior: smooth ? 'smooth' : 'auto' });
    }
    function reveal(kind, id) {
      var o = kind === 'wire' ? M.wires[id] : M.blocks[id];
      if (!o) return;
      var x = o.pts ? (o.pts[0][0] + o.pts[o.pts.length - 1][0]) / 2 : o.x + o.w / 2;
      var y = o.pts ? (o.pts[0][1] + o.pts[o.pts.length - 1][1]) / 2 : o.y + o.h / 2;
      scrollToPoint(x, y);
    }
    var stageGroup = h('div', { class: 'cd-group', role: 'group', 'aria-label': 'Scroll to stage' }, h('span', { class: 'cd-group-label', text: 'Go to' }),
      (M.stages || []).map(function (st) { return h('button', { type: 'button', text: st[0], onclick: function () { scrollToPoint(st[1]); } }); }));
    // Drag to pan in either direction; touch scrolling remains native.
    var releasePan;
    (function () {
      var down = null;
      figure.addEventListener('pointerdown', function (e) { if (e.button === 0 && e.pointerType === 'mouse' && figure.classList.contains('pannable')) down = { x: e.clientX, y: e.clientY, left: figure.scrollLeft, top: figure.scrollTop, moved: false, id: e.pointerId }; });
      figure.addEventListener('pointermove', function (e) { if (!down) return; if (!(e.buttons & 1)) { down = null; return; } var dx = e.clientX - down.x, dy = e.clientY - down.y; if (Math.hypot(dx, dy) > 4) { if (!down.moved) { try { figure.setPointerCapture(down.id); } catch (err) { /* already released */ } } down.moved = true; figure.scrollLeft = down.left - dx; figure.scrollTop = down.top - dy; } });
      function release() { setTimeout(function () { down = null; }, 0); }
      figure.addEventListener('pointerup', release);
      figure.addEventListener('pointercancel', release);
      figure.addEventListener('lostpointercapture', release);
      window.addEventListener('pointerup', release);
      window.addEventListener('blur', release);
      releasePan = function () { down = null; window.removeEventListener('pointerup', release); window.removeEventListener('blur', release); };
      figure.addEventListener('click', function (e) { if (down && down.moved) { e.stopPropagation(); e.preventDefault(); } }, true);
    })();
    var toolbar = h('div', { class: 'cd-toolbar' },
      variantGroup,
      h('div', { class: 'cd-group cd-cycles', role: 'group', 'aria-label': 'Cycle controls' },
        h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Previous event', title: 'Previous event', text: '⏮', onclick: function () { jumpEvent(-1); } }),
        h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Previous cycle', title: 'Previous cycle', text: '◀', onclick: function () { step(-1); } }),
        playBtn,
        h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Next cycle', title: 'Next cycle', text: '▶|', onclick: function () { step(1); } }),
        h('button', { type: 'button', class: 'cd-icon', 'aria-label': 'Next event', title: 'Next event', text: '⏭', onclick: function () { jumpEvent(1); } }),
        slider, counter, speed),
      labelGroup, layerGroup, zoomGroup, stageGroup);

    figure.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    });
    figure.tabIndex = 0;
    figure.setAttribute('aria-label', M.title + '. Use the left and right arrow keys to step cycles.');
    root.append(toolbar, now, selBar, figure, h('div', { class: 'cd-foot' }, chart, detail));
    container.appendChild(root);
    var resizeObserver = window.ResizeObserver ? new window.ResizeObserver(updateScale) : null;
    if (resizeObserver) resizeObserver.observe(figure);
    else window.addEventListener('resize', updateScale);
    var layoutFrame = window.requestAnimationFrame(updateScale);

    var inspect = h('label', { class: 'cd-inspect' }, 'Inspect ', (function () {
      var sel = h('select', { 'aria-label': 'Inspect a block or signal' }, h('option', { value: '', text: 'choose a block or signal…' }));
      var gb = h('optgroup', { label: 'Blocks' }), gw = h('optgroup', { label: 'Signals' });
      Object.keys(M.blocks).forEach(function (id) { var b = M.blocks[id]; if (b.info) gb.appendChild(h('option', { value: 'block:' + id, text: b.info.title || b.label || id })); });
      Object.keys(M.contractInfo || {}).forEach(function (id) { gb.appendChild(h('option', { value: 'contract:' + id, text: id })); });
      Object.keys(M.wires).sort(function (a, b) { return (M.wires[a].name || a).localeCompare(M.wires[b].name || b); }).forEach(function (id) { gw.appendChild(h('option', { value: 'wire:' + id, text: M.wires[id].name || id })); });
      sel.append(gb, gw);
      sel.addEventListener('change', function () { if (!sel.value) return; var p = sel.value.split(':'); pick(p[0], p[1], true); });
      return sel;
    })());
    detail.appendChild(inspect);
    function pick(kind, id, keepFocus) {
      picked = { kind: kind, id: id };
      diagram.select(kind, id);
      showDetail();
      var sel = inspect.querySelector('select'); sel.value = kind + ':' + id;

      if (figure.classList.contains('pannable')) reveal(kind, id);
    }
    function showDetail() {
      if (!picked) {
        setKids(detailBody, h('h3', { text: 'Details' }), h('p', { text: M.detailHint || 'Select a block or wire for its role and RTL source.' }));
        return;
      }
      var src = picked.kind === 'wire' ? M.wires[picked.id] : (M.blocks[picked.id] || (M.contractInfo || {})[picked.id]);
      // variantInfo: per-configuration text for the same block or wire.
      var info = (src && ((src.variantInfo && src.variantInfo[variant.key]) || src.info)) || {};
      var kindText = picked.kind === 'wire' ? (src.cls === 'ctl' ? 'Control signal' : src.cls === 'trap' ? 'Trap and CSR signal' : 'Datapath signal') : (info.kind || 'Block');
      var valueNow = null;
      if (picked.kind === 'wire') {
        var f = M.frame(trace, cycle, variant), active = diagram.lit && diagram.lit.byWire[picked.id];
        if (active && f.values && f.values[picked.id]) valueNow = f.values[picked.id];
        else if (active) valueNow = 'active this cycle';
        else valueNow = 'not used this cycle';
      }
      setKids(detailBody,
        h('h3', { text: 'Details' }),
        h('div', { class: 'kind', text: kindText }),
        h('h4', { text: info.title || src.name || picked.id }),
        valueNow ? h('p', { class: 'now-val', text: 'Cycle ' + trace.cycles[cycle].c + ': ' + valueNow }) : null,
        (info.text ? [].concat(info.text) : []).map(function (t) { return h('p', null, rich(t)); }),
        info.src ? h('p', { class: 'src' }, 'RTL: ', [].concat(info.src).map(function (p, i) { return [i ? ', ' : '', h('code', { text: p })]; })) : null);
      var first = info.text ? String([].concat(info.text)[0]).split(/(?<=\.)\s/)[0] : '';
      setKids(selBar, h('strong', { text: (info.title || src.name || picked.id) + (valueNow && valueNow.indexOf('0x') === 0 ? ' = ' + valueNow : '') }), first ? [' · ', rich(first)] : null, ' ',
        h('a', { href: '#', text: 'Details', onclick: function (e) { e.preventDefault(); detail.scrollIntoView({ block: 'nearest' }); detailBody.focus({ preventScroll: true }); } }));
      selBar.hidden = false;
    }

    // Occupancy chart. Long runs (user programs up to 20000 cycles) draw only a
    // window of cycles around the current one, and only the instructions active
    // in it; the window moves when the cursor nears an edge.
    var FULL = 400, SPAN = 160, EDGE = 20;
    var chartData = null, spans = [], win = { lo: 0, hi: -1 };
    var gridCells = [], headCells = [], rowEls = {}, firstRow = null;
    function buildChart() {
      chartData = M.chart(trace, variant);
      spans = chartData.rows.map(function (row) {
        var keys = Object.keys(row.cells).map(Number);
        return keys.length ? [Math.min.apply(null, keys), Math.max.apply(null, keys)] : [Infinity, -Infinity];
      });
      win = { lo: 0, hi: -1 };
      drawWindow(cycle);
    }
    function drawWindow(center) {
      var n = trace.cycles.length, lo = 0, hi = n - 1;
      if (n > FULL) { lo = Math.max(0, Math.min(n - SPAN, center - SPAN / 2)); hi = Math.min(n - 1, lo + SPAN - 1); }
      win = { lo: lo, hi: hi };
      var cLo = trace.cycles[lo].c, cHi = trace.cycles[hi].c;
      gridCells = []; headCells = []; rowEls = {}; firstRow = null; lastNow = -1;
      var thead = h('tr', null, h('th', { class: 'ins', text: chartData.corner }));
      for (var c = lo; c <= hi; c++) {
        (function (c) {
          var th = h('th', { class: label && label.at.indexOf(c) >= 0 ? 'mark' : null, title: label && label.at.indexOf(c) >= 0 ? label.name : null, text: String(trace.cycles[c].c), onclick: function () { stop(); go(c); } });
          headCells.push(th); thead.appendChild(th);
        })(c);
      }
      var body = h('tbody');
      chartData.rows.forEach(function (row, index) {
        if (spans[index][1] < cLo || spans[index][0] > cHi) return;
        var tr = h('tr', { class: row.cls || '' }, h('th', { class: 'ins', tabindex: 0, title: 'Go to this instruction', onclick: function () { stop(); go(row.jump - trace.cycles[0].c); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stop(); go(row.jump - trace.cycles[0].c); } } }, h('span', { class: 'pc', text: row.pc }), row.text));
        rowEls[index] = tr;
        if (!firstRow) firstRow = tr;
        var cells = [];
        for (var c = lo; c <= hi; c++) {
          (function (c) {
            var cell = row.cells[trace.cycles[c].c];
            var td = h('td', { class: cell ? 'c ' + (cell.cls || '') : '', style: cell ? 'background:' + cell.color + ';--cell:' + cell.color : null, text: cell ? cell.text : '', title: cell && cell.title, onclick: function () { stop(); go(c); } });
            cells.push(td); tr.appendChild(td);
          })(c);
        }
        gridCells.push(cells);
        body.appendChild(tr);
      });
      var windowed = hi - lo + 1 < n;
      setKids(chart, h('h3', { text: chartData.title }), h('p', { class: 'hint', text: chartData.hint + (windowed ? ' Showing cycles ' + cLo + '–' + cHi + ' of ' + trace.cycles[0].c + '–' + trace.cycles[n - 1].c + '; the window follows the current cycle.' : '') }),
        h('div', { class: 'cd-grid-wrap' }, h('table', { class: 'cd-grid' }, h('thead', null, thead), body)),
        h('div', { class: 'cd-legend' }, chartData.legend.map(function (l) { return h('span', { class: l[0], style: l[2] ? '--sw:' + l[2] : null, text: l[1] }); })));
      chart.wrap = chart.querySelector('.cd-grid-wrap');
    }
    var lastNow = -1;
    function markChart() {
      var n = trace.cycles.length;
      if (n > FULL && (cycle < win.lo + (win.lo > 0 ? EDGE : 0) || cycle > win.hi - (win.hi < n - 1 ? EDGE : 0))) drawWindow(cycle);
      var col = cycle - win.lo;
      if (lastNow >= 0) {
        if (headCells[lastNow]) headCells[lastNow].classList.remove('now');
        gridCells.forEach(function (cells) { if (cells[lastNow]) cells[lastNow].classList.remove('now'); });
      }
      lastNow = col;
      if (headCells[col]) headCells[col].classList.add('now');
      gridCells.forEach(function (cells) { if (cells[col]) cells[col].classList.add('now'); });
      var cur = M.currentRows ? M.currentRows(trace, cycle) : [];
      Object.keys(rowEls).forEach(function (i) { rowEls[i].classList.toggle('cur', cur.indexOf(Number(i)) >= 0); });
      var wrap = chart.wrap, th = headCells[col];
      if (wrap && th && wrap.clientWidth) {
        // Positions relative to the scroll box (offsetLeft/Top are relative to a page ancestor).
        var box = wrap.getBoundingClientRect(), stickyW = firstRow ? firstRow.firstChild.offsetWidth : 0;
        var x = th.getBoundingClientRect().left - box.left + wrap.scrollLeft;
        wrap.scrollLeft = Math.max(0, x - stickyW - (wrap.clientWidth - stickyW) / 2);
        var curRow = cur.length ? rowEls[cur[0]] : null;
        if (curRow) {
          var y = curRow.getBoundingClientRect().top - box.top + wrap.scrollTop;
          if (y < wrap.scrollTop + 24 || y > wrap.scrollTop + wrap.clientHeight - 40) wrap.scrollTop = Math.max(0, y - 60);
        }
      }
    }

    function render() {
      var f = M.frame(trace, cycle, variant);
      // The pulse runs once per cycle shown, and fits inside a playback step.
      var view = variant.key + ' ' + cycle, moved = view !== drawn;
      drawn = view;
      diagram.apply(f, showValues, showFlow && moved ? { span: timer ? Math.min(620, Number(speed.value) * 0.8) : 620 } : null);
      slider.value = cycle;
      counter.textContent = counterText(trace, cycle);
      setKids(now, M.narrate(trace, cycle, variant).map(function (line, i) {
        return h('p', { class: i === 0 ? 'cd-now-head' : '' }, line.map(function (part) {
          if (typeof part === 'string') return rich(part);
          return h('span', { class: 'cd-chip', style: 'background:' + part.color, text: part.text });
        }));
      }));
      markChart();
      updateLabel();
      if (picked && picked.kind === 'wire') showDetail();
    }

    setZoom(zoom, false);
    diagram.setLayers(layers);
    applyVariant();
    buildChart();
    showDetail();
    render();
    var handle = { go: go, dispose: function () {
      stop();
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', updateScale);
      window.cancelAnimationFrame(layoutFrame);
      releasePan();
      root.remove();
    } };
    mounted.set(container, handle);
    return handle;
  }

  window.PrismCoreDiagrams = {
    define: function (key, model) { models[key] = model; },
    has: function (key) { return !!models[key]; },
    mount: mount,
    unmount: unmount,
    net: { build: buildNet, light: light },
    util: { s: s, h: h }
  };
})();
