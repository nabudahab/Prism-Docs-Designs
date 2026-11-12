/* Coherent caches (WIP): an interactive view of the illustrative MESI model in
 * cache-coherence-model.js.
 *
 *   window.PrismCoherentCaches.mount(holder) -> { dispose, snapshot, check }
 *
 * The whole view is labelled WIP. It is a teaching model on one serialized
 * snooping bus, separate from the RTL-backed cache explorer: it shares no state
 * with it, sends nothing to the host and is not Prism hardware or a planned
 * interface.
 *
 * Playback: every operation yields a list of events, each with a snapshot. A
 * step first draws the transaction's paths over the state before the event
 * while tokens travel (requestAnimationFrame, driven by an elapsed-time counter
 * that only advances while playing), then shows the snapshot after it. Pause
 * stops the counter, so tokens hold their positions. With reduced motion there
 * is no travel or autoplay: the reader steps through static snapshots.
 * Each new operation, reset or topology change bumps a generation counter;
 * frames from an older generation do nothing.
 */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var TRAVEL_MS = 900;
  var DWELL_MS = 600;
  var NARROW_PX = 560;
  var MEDIUM_PX = 900;
  var TYPE_CLASS = {
    request: 'is-core', respond: 'is-core', write: 'is-core',
    busrd: 'is-req', busrdx: 'is-req', busupgr: 'is-req', shared: 'is-req',
    memdata: 'is-data', flush: 'is-data', transfer: 'is-data',
    ack: 'is-inv', writeback: 'is-wb', drop: 'is-core', add: 'is-core', remove: 'is-core', reset: 'is-core'
  };
  var STATE_NAME = { M: 'Modified', E: 'Exclusive', S: 'Shared', I: 'Invalid' };
  var serial = 0;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) {
        return;
      }
      if (k === 'text') {
        el.textContent = v;
      }
      else {
        el.setAttribute(k, v);
      }
    });
    (children || []).forEach(function (c) {
      if (c !== null && c !== undefined) {
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    });
    return el;
  }
  function sv(tag, attrs, parent) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') {
        el.textContent = attrs[k];
      }
      else if (attrs[k] !== null && attrs[k] !== undefined) {
        el.setAttribute(k, attrs[k]);
      }
    });
    if (parent) {
      parent.appendChild(el);
    }
    return el;
  }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------- geometry ---------- */

  /* Places cores, caches, the bus and memory. Wide: caches in one row above a
     horizontal bus. Medium: two caches above and two below the bus, memory at
     its right end. Narrow: one column with a vertical bus on the right. */
  function layout(ids, mode) {
    var g = { mode: mode, cores: {}, caches: {}, coreLink: {}, port: {}, busAt: {} };
    var CW = 176, CH = 96;
    if (mode === 'medium') {
      g.W = 608;
      ids.forEach(function (id, i) {
        var x = 8 + (i % 2) * (CW + 14), cx = x + CW / 2;
        if (i < 2) {
          g.cores[id] = { x: cx - 38, y: 6, w: 76, h: 22 };
          g.caches[id] = { x: x, y: 44, w: CW, h: CH };
          g.coreLink[id] = [[cx, 28], [cx, 44]];
          g.port['c' + id] = [cx, 140];
        }
        else {
          g.caches[id] = { x: x, y: 200, w: CW, h: CH };
          g.cores[id] = { x: cx - 38, y: 312, w: 76, h: 22 };
          g.coreLink[id] = [[cx, 312], [cx, 296]];
          g.port['c' + id] = [cx, 200];
        }
        g.busAt['c' + id] = [cx, 170];
      });
      g.mem = { x: 396, y: 110, w: 206, h: 120, cols: 1 };
      g.port.mem = [396, 170];
      g.busAt.mem = [384, 170];
      g.bus = { x: 28, y: 166, w: 360, h: 8 };
      g.busLabel = { x: 28, y: 189, anchor: 'start', text: 'Snooping bus · one transaction at a time' };
      g.H = ids.length > 2 ? 340 : 264;
      g.wip = { x: 396, y: 250 };
      return g;
    }
    if (mode === 'wide') {
      g.W = 760;
      var total = ids.length * CW + (ids.length - 1) * 14;
      var x0 = (g.W - total) / 2;
      ids.forEach(function (id, i) {
        var x = x0 + i * (CW + 14), cx = x + CW / 2;
        g.cores[id] = { x: cx - 38, y: 8, w: 76, h: 22 };
        g.caches[id] = { x: x, y: 44, w: CW, h: CH };
        g.coreLink[id] = [[cx, 30], [cx, 44]];
        g.port['c' + id] = [cx, 140];
        g.busAt['c' + id] = [cx, 176];
      });
      g.mem = { x: (g.W - 448) / 2, y: 206, w: 448, h: 72, cols: 2 };
      g.port.mem = [g.W / 2, 206];
      g.busAt.mem = [g.W / 2, 176];
      var left = Math.min(x0 + 24, g.mem.x), right = Math.max(x0 + total - 24, g.mem.x + g.mem.w);
      g.bus = { x: left, y: 172, w: right - left, h: 8 };
      g.busLabel = { x: left, y: 197, anchor: 'start', text: 'Snooping bus · one transaction at a time' };
      g.H = 284;
      g.wip = { x: 6, y: 279 };
      return g;
    }
    g.W = 272;
    ids.forEach(function (id, i) {
      var top = 6 + i * 146, cx = 8 + CW / 2;
      g.cores[id] = { x: cx - 38, y: top, w: 76, h: 22 };
      g.caches[id] = { x: 8, y: top + 38, w: CW, h: CH };
      g.coreLink[id] = [[cx, top + 22], [cx, top + 38]];
      g.port['c' + id] = [8 + CW, top + 38 + 48];
      g.busAt['c' + id] = [226, top + 38 + 48];
    });
    var memY = 6 + ids.length * 146 + 10;
    g.mem = { x: 8, y: memY, w: 206, h: 120, cols: 1 };
    g.port.mem = [214, memY + 60];
    g.busAt.mem = [226, memY + 60];
    var firstY = g.busAt['c' + ids[0]][1];
    g.bus = { x: 222, y: firstY - 12, w: 8, h: memY + 72 - firstY };
    g.busLabel = { x: 226, y: firstY - 17, anchor: 'middle', text: 'bus' };
    g.H = memY + 120 + 18;
    g.wip = { x: 8, y: g.H - 5 };
    return g;
  }

  /* Polyline for one event path, or null when a node is not drawn. */
  function pathPoints(g, names) {
    var a = names[0], b = names[names.length - 1];
    if (names.length === 2 && /^p\d$/.test(a) && b === 'c' + a.slice(1)) {
      return g.coreLink[+a.slice(1)] ? g.coreLink[+a.slice(1)].slice() : null;
    }
    if (names.length === 2 && /^p\d$/.test(b) && a === 'c' + b.slice(1)) {
      return g.coreLink[+b.slice(1)] ? g.coreLink[+b.slice(1)].slice().reverse() : null;
    }
    if (!g.port[a] || !g.port[b]) {
      return null;
    }
    return [g.port[a], g.busAt[a], g.busAt[b], g.port[b]];
  }
  function measure(points) {
    var lens = [0];
    for (var i = 1; i < points.length; i++) {
      lens.push(lens[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    }
    return lens;
  }
  function pointAt(points, lens, d) {
    for (var i = 1; i < points.length; i++) {
      if (d <= lens[i] || i === points.length - 1) {
        var span = lens[i] - lens[i - 1] || 1, t = Math.max(0, Math.min(1, (d - lens[i - 1]) / span));
        return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      }
    }
    return points[points.length - 1];
  }

  /* ---------- mount ---------- */

  function mount(holder) {
    var M = window.PrismCoherenceModel;
    if (!M) {
      holder.replaceChildren(h('p', { class: 'notice', role: 'status', text: 'Coherent caches · WIP: the illustrative model (assets/cache-coherence-model.js) is missing from this build.' }));
      return { dispose: function () {} };
    }
    var id = 'coh' + (++serial);
    var committed = M.create(2);
    var selected = 0;
    var run = null;
    var playing = false;
    var raf = 0;
    var last = 0;
    var gen = 0;
    var disposed = false;
    var mode = 'wide';
    var tokens = [];
    var observer = null;
    var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    /* banner */
    var banner = h('p', { class: 'coh-banner' }, [
      h('span', { class: 'coh-wip', text: 'WIP' }),
      h('span', {}, [h('strong', { text: 'Illustrative coherence model.' }),
        ' MESI on one serialized snooping bus, for teaching. Prism’s supplied caches and ',
        h('code', { text: 'cache_fabric_if' }), ' are non-coherent.'])
    ]);

    /* controls */
    var cacheSel = h('select', { id: id + '-cache', class: 'coh-select' });
    var addrSel = h('select', { id: id + '-addr', class: 'coh-select coh-mono' });
    for (var a = 0; a < M.LINES * M.WORDS * 4; a += 4) {
      addrSel.appendChild(h('option', { value: String(a), text: M.addrText(a) + ' · L' + M.lineOf(a) + ' w' + M.wordOf(a), selected: a === 0x24 ? 'selected' : null }));
    }
    var valueIn = h('input', { id: id + '-value', type: 'text', class: 'coh-mono coh-value', value: '0x1111', inputmode: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': id + '-err' });
    var loadBtn = h('button', { type: 'button', class: 'coh-primary', text: 'Load' });
    var storeBtn = h('button', { type: 'button', class: 'coh-primary', text: 'Store' });
    var addBtn = h('button', { type: 'button', text: 'Add cache' });
    var removeBtn = h('button', { type: 'button', text: 'Remove' });
    var exampleBtn = h('button', { type: 'button', title: 'Resets to two caches, then: read, share, write, read the latest value', text: 'Run example' });
    var resetBtn = h('button', { type: 'button', title: 'Empty every cache and restore initial memory. Cache contents, dirty or not, are discarded.', text: 'Reset' });
    var error = h('p', { id: id + '-err', class: 'coh-error', role: 'alert' });
    function labelled(text, control) {
      return h('label', { class: 'coh-field', for: control.id }, [h('span', { text: text }), control]);
    }
    var toolbar = h('div', { class: 'coh-toolbar', role: 'group', 'aria-label': 'Cache operations' }, [
      h('div', { class: 'coh-ops' }, [labelled('Cache', cacheSel), labelled('Address', addrSel), labelled('Value (hex)', valueIn), h('div', { class: 'coh-act' }, [loadBtn, storeBtn])]),
      h('div', { class: 'coh-topo' }, [addBtn, removeBtn, exampleBtn, resetBtn])
    ]);

    /* figure and player */
    var figure = h('div', { class: 'coh-figure' });
    var prevBtn = h('button', { type: 'button', class: 'coh-icon', 'aria-label': 'Previous step', title: 'Previous step', text: '‹ Step' });
    var playBtn = h('button', { type: 'button', class: 'coh-icon coh-play', 'aria-label': 'Play', 'aria-pressed': 'false', text: '▶' });
    var nextBtn = h('button', { type: 'button', class: 'coh-icon', 'aria-label': 'Next step', title: 'Next step', text: 'Step ›' });
    var position = h('span', { class: 'coh-pos coh-mono' });
    var opTitle = h('strong', { class: 'coh-op' });
    var caption = h('span', { class: 'coh-text' });
    var live = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
    var queued = h('p', { class: 'coh-queued', role: 'status', hidden: 'hidden' });
    var player = h('div', { class: 'coh-player', role: 'group', 'aria-label': 'Step through the transaction' }, [
      h('div', { class: 'coh-transport' }, [prevBtn, playBtn, nextBtn]), position, h('p', { class: 'coh-caption' }, [opTitle, ' ', caption])
    ]);
    var legend = h('ul', { class: 'coh-legend', 'aria-label': 'Line states' }, [
      ['M', 'Modified: dirty, only copy'], ['E', 'Exclusive: clean, only copy'], ['S', 'Shared: clean, maybe copies'], ['I', 'Invalid']
    ].map(function (x) {
      return h('li', {}, [h('span', { class: 'coh-chip is-' + x[0], text: x[0] }), x[1]]);
    }).concat([h('li', {}, [h('span', { class: 'coh-chip is-stale', text: 'stale' }), 'memory behind an M copy'])]));
    var about = h('details', { class: 'coh-about' }, [
      h('summary', { text: 'What this model shows and leaves out' }),
      h('ul', {}, [
        h('li', { text: 'Write-back, write-allocate caches kept coherent by invalidation (MESI). Every cache snoops every bus request.' }),
        h('li', { text: 'One transaction at a time, in order, with no timing, overlap or arbitration.' }),
        h('li', { text: 'An M owner answers a read by sending the line to the reader and memory; both end in S. A store to an S line first invalidates every other copy and waits for each acknowledgement.' }),
        h('li', { text: 'Evicting or removing a cache writes dirty lines back first. Reset is the only action that discards data.' }),
        h('li', { text: 'Demo geometry: 16-bit values in four-byte address slots; the upper two bytes are not modeled. Four slots per 16-byte line, 4 memory lines, 2 direct-mapped sets per cache.' })
      ])
    ]);
    var root = h('div', { class: 'coh', 'data-wip': 'true' }, [banner, toolbar, error, queued, figure, player, legend, about, live]);
    holder.replaceChildren(root);

    /* ---------- controls ---------- */
    function syncControls() {
      var ids = committed.caches.map(function (c) { return c.id; });
      if (ids.indexOf(selected) < 0) {
        selected = ids[0];
      }
      cacheSel.replaceChildren.apply(cacheSel, ids.map(function (k) {
        return h('option', { value: String(k), text: 'Cache ' + k, selected: k === selected ? 'selected' : null });
      }));
      cacheSel.value = String(selected);
      addBtn.disabled = ids.length >= M.MAX_CACHES;
      removeBtn.disabled = ids.length <= 1;
      removeBtn.textContent = 'Remove cache ' + selected;
      syncPlayer();
    }
    function syncPlayer() {
      var n = run ? run.events.length : 0;
      var reduced = reducedMotion();
      prevBtn.disabled = !run || run.cursor <= 0;
      nextBtn.disabled = !run || (run.cursor >= n - 1 && run.phase !== 'travel');
      playBtn.disabled = !run || (reduced && !playing);
      playBtn.title = reduced ? 'Motion is reduced: use the step buttons' : '';
      var atEnd = run && run.cursor >= n - 1 && run.phase !== 'travel';
      playBtn.textContent = playing ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', playing ? 'Pause' : atEnd ? 'Replay' : 'Play');
      playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      position.textContent = run ? (run.cursor + 1) + ' / ' + n : '';
      queued.hidden = !run || run.pendingAt === undefined || run.cursor >= run.pendingAt;
      queued.textContent = queued.hidden ? '' : 'Queued: ' + run.pendingLabel + '. Continue the recorded steps to reach this operation.';
      if (!run) {
        opTitle.textContent = 'Ready.';
        caption.textContent = 'Pick a cache, then load or store. Run example shows a share, an invalidation and a read of the latest value.';
        return;
      }
      var ev = run.events[run.cursor];
      opTitle.textContent = ev.op + (run.phase === 'travel' ? ' …' : '');
      caption.textContent = ev.text;
    }
    function selectCache(k, focusDiagram) {
      selected = k;
      error.textContent = '';
      syncControls();
      render();
      if (focusDiagram) {
        var el = figure.querySelector('[data-cache="' + k + '"]');
        if (el) {
          el.focus();
        }
      }
    }
    function parseValue() {
      var text = valueIn.value.trim();
      var m = /^(0x)?([0-9a-f]{1,4})$/i.exec(text);
      if (!m) {
        return null;
      }
      return parseInt(m[2], 16);
    }

    /* ---------- runs ---------- */
    function tag(events, op) {
      events.forEach(function (e) {
        e.op = op;
      });
      return events;
    }
    function startRun(before, result, replaceHistory) {
      var previous = run;
      var retain = !replaceHistory && previous &&
        (previous.cursor < previous.events.length - 1 || previous.phase === 'travel');
      gen++;
      stopFrames();
      committed = result.state;
      // Operations use the committed state, but their communication stays in
      // order when the reader is still watching or inspecting earlier events.
      run = retain ? {
        before: previous.before,
        events: previous.events.concat(result.events),
        cursor: previous.cursor,
        phase: previous.phase,
        elapsed: previous.elapsed,
        pendingAt: previous.events.length,
        pendingLabel: result.events[0].op
      } : { before: before, events: result.events, cursor: 0, phase: 'travel', elapsed: 0 };
      if (!run.events[run.cursor].paths.length || reducedMotion()) {
        run.phase = 'shown';
      }
      playing = !reducedMotion();
      error.textContent = '';
      syncControls();
      render();
      if (run.phase === 'shown') {
        announce();
      }
      if (playing) {
        kick();
      }
    }
    function doLoad() {
      var before = committed;
      var address = +addrSel.value;
      var r = M.load(before, selected, address);
      tag(r.events, 'Load · cache ' + selected + ' · ' + M.addrText(address));
      startRun(before, r);
    }
    function doStore() {
      var value = parseValue();
      if (value === null) {
        error.textContent = 'Enter a hex value from 0x0000 to 0xFFFF (16-bit demo values).';
        valueIn.setAttribute('aria-invalid', 'true');
        valueIn.focus();
        return;
      }
      valueIn.removeAttribute('aria-invalid');
      var before = committed;
      var address = +addrSel.value;
      var r = M.store(before, selected, address, value);
      tag(r.events, 'Store · cache ' + selected + ' · ' + M.addrText(address) + ' = ' + M.wordText(value));
      startRun(before, r);
    }
    function doAdd() {
      var before = committed;
      var r = M.addCache(before);
      tag(r.events, 'Add cache ' + r.id);
      selected = r.id;
      startRun(before, r);
    }
    function doRemove() {
      var before = committed;
      var k = selected;
      var r = M.removeCache(before, k);
      tag(r.events, 'Remove cache ' + k);
      startRun(before, r);
    }
    function doReset() {
      var before = committed;
      var r = M.reset(before, before.caches.length);
      tag(r.events, 'Reset');
      startRun(before, r, true);
    }
    /* Read, share, write with invalidation, then read the latest value. */
    function doExample() {
      var before = committed;
      var events = [];
      var st = M.reset(before, 2);
      events = events.concat(tag(st.events, 'Example 0/4 · reset to two caches'));
      var steps = [
        ['load', 0, 0x24, null, 'Example 1/4 · cache 0 reads 0x24'],
        ['load', 1, 0x24, null, 'Example 2/4 · cache 1 reads 0x24'],
        ['store', 1, 0x24, 0x1111, 'Example 3/4 · cache 1 writes 0x24'],
        ['load', 0, 0x24, null, 'Example 4/4 · cache 0 reads 0x24 again']
      ];
      var state = st.state;
      steps.forEach(function (s) {
        var r = s[0] === 'load' ? M.load(state, s[1], s[2]) : M.store(state, s[1], s[2], s[3]);
        events = events.concat(tag(r.events, s[4]));
        state = r.state;
      });
      selected = 0;
      addrSel.value = String(0x24);
      startRun(before, { state: state, events: events }, true);
    }
    loadBtn.addEventListener('click', doLoad);
    storeBtn.addEventListener('click', doStore);
    addBtn.addEventListener('click', doAdd);
    removeBtn.addEventListener('click', doRemove);
    resetBtn.addEventListener('click', doReset);
    exampleBtn.addEventListener('click', doExample);
    cacheSel.addEventListener('change', function () {
      selectCache(+cacheSel.value, false);
    });
    valueIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        doStore();
      }
    });
    valueIn.addEventListener('input', function () {
      valueIn.removeAttribute('aria-invalid');
      error.textContent = '';
    });

    /* ---------- player ---------- */
    function stopFrames() {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = 0;
    }
    function kick() {
      stopFrames();
      last = performance.now();
      var mine = gen;
      raf = requestAnimationFrame(function step(now) {
        raf = 0;
        if (disposed || !playing || mine !== gen || !run) {
          return;
        }
        if (reducedMotion()) {
          motionChanged();
          return;
        }
        var dt = Math.max(0, Math.min(64, now - last));
        last = now;
        run.elapsed += dt;
        if (run.phase === 'travel') {
          var t = Math.min(1, run.elapsed / TRAVEL_MS);
          placeTokens(t);
          if (t >= 1) {
            run.phase = 'shown';
            run.elapsed = 0;
            render();
            syncPlayer();
            announce();
          }
        }
        else if (run.elapsed >= DWELL_MS) {
          if (run.cursor < run.events.length - 1) {
            run.cursor++;
            run.elapsed = 0;
            run.phase = run.events[run.cursor].paths.length ? 'travel' : 'shown';
            render();
            syncPlayer();
            if (run.phase === 'shown') {
              announce();
            }
          }
          else {
            playing = false;
            syncPlayer();
            return;
          }
        }
        raf = requestAnimationFrame(step);
      });
    }
    function pause() {
      playing = false;
      stopFrames();
      syncPlayer();
    }
    function showStep(k) {
      pause();
      run.cursor = Math.max(0, Math.min(run.events.length - 1, k));
      run.phase = 'shown';
      run.elapsed = 0;
      render();
      syncPlayer();
      announce();
    }
    prevBtn.addEventListener('click', function () {
      if (run) {
        showStep(run.cursor - 1);
      }
    });
    nextBtn.addEventListener('click', function () {
      if (!run) {
        return;
      }
      if (run.phase === 'travel') {
        showStep(run.cursor);
      }
      else {
        showStep(run.cursor + 1);
      }
    });
    playBtn.addEventListener('click', function () {
      if (playing) {
        pause();
        return;
      }
      if (!run || reducedMotion()) {
        return;
      }
      if (run.cursor >= run.events.length - 1 && run.phase !== 'travel') {
        run.cursor = 0;
        run.elapsed = 0;
        run.phase = run.events[0].paths.length ? 'travel' : 'shown';
        render();
      }
      playing = true;
      syncPlayer();
      kick();
    });
    function motionChanged() {
      if (disposed) {
        return;
      }
      if (reducedMotion() && run) {
        showStep(run.cursor);
      }
      else {
        syncPlayer();
      }
    }
    if (motionQuery) {
      motionQuery.addEventListener('change', motionChanged);
    }
    function announce() {
      if (run) {
        var ev = run.events[run.cursor];
        live.textContent = ev.op + ': ' + ev.text;
      }
    }

    /* ---------- drawing ---------- */
    function shownState() {
      if (!run) {
        return committed;
      }
      if (run.phase === 'travel') {
        return run.cursor > 0 ? run.events[run.cursor - 1].after : run.before;
      }
      return run.events[run.cursor].after;
    }
    function render() {
      var focusId = document.activeElement && document.activeElement.getAttribute && figure.contains(document.activeElement) ? document.activeElement.getAttribute('data-cache') : null;
      var state = shownState();
      var ev = run ? run.events[run.cursor] : null;
      var ids = state.caches.map(function (c) { return c.id; });
      var g = layout(ids, mode);
      var svgEl = sv('svg', { viewBox: '0 0 ' + g.W + ' ' + g.H, class: 'coh-svg is-' + mode, 'data-layout': mode, role: 'group', 'aria-label': 'Cores, caches, snooping bus and memory of the illustrative model' });
      var defs = sv('defs', {}, svgEl);
      ['is-core', 'is-req', 'is-data', 'is-inv', 'is-wb'].forEach(function (cls) {
        var mk = sv('marker', { id: id + '-arrow-' + cls, viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' }, defs);
        sv('path', { d: 'M0,0 L8,4 L0,8 z', class: 'coh-arrowhead ' + cls }, mk);
      });
      var changed = {};
      if (ev && run.phase !== 'travel') {
        ev.changed.forEach(function (c) {
          changed[c.node === 'mem' ? 'mem' + c.line : c.node + ':' + c.set] = true;
        });
      }

      /* wires */
      ids.forEach(function (k) {
        var l = g.coreLink[k];
        sv('path', { d: 'M' + l[0][0] + ',' + l[0][1] + ' L' + l[1][0] + ',' + l[1][1], class: 'coh-wire' }, svgEl);
        var p = g.port['c' + k], b = g.busAt['c' + k];
        sv('path', { d: 'M' + p[0] + ',' + p[1] + ' L' + b[0] + ',' + b[1], class: 'coh-wire' }, svgEl);
      });
      sv('path', { d: 'M' + g.port.mem[0] + ',' + g.port.mem[1] + ' L' + g.busAt.mem[0] + ',' + g.busAt.mem[1], class: 'coh-wire' }, svgEl);
      sv('rect', { x: g.bus.x, y: g.bus.y, width: g.bus.w, height: g.bus.h, rx: 3, class: 'coh-bus' }, svgEl);
      sv('text', { x: g.busLabel.x, y: g.busLabel.y, 'text-anchor': g.busLabel.anchor, class: 'coh-small', text: g.busLabel.text }, svgEl);

      /* cores and caches */
      state.caches.forEach(function (cache) {
        var k = cache.id, c = g.cores[k], r = g.caches[k];
        var active = ev && ev.cache === k;
        var core = sv('g', { class: 'coh-core' + (active && run.phase !== 'travel' && /^(request|respond)$/.test(ev.type) ? ' is-active' : '') }, svgEl);
        sv('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 5 }, core);
        sv('text', { x: c.x + c.w / 2, y: c.y + 15, 'text-anchor': 'middle', class: 'coh-core-title', text: 'Core ' + k }, core);
        var selectable = committed.caches.some(function (c) {
          return c.id === k;
        });
        var isSel = selectable && k === selected;
        var summary = cache.sets.map(function (e, s) {
          return 'set ' + s + ' ' + (e.state === 'I' ? 'invalid' : 'L' + e.line + ' ' + STATE_NAME[e.state]);
        }).join(', ');
        var card = sv('g', { class: 'coh-cache' + (isSel ? ' is-selected' : '') + (active ? ' is-active' : '') + (selectable ? '' : ' is-historical'),
          'data-cache': String(k), tabindex: selectable ? '0' : null, role: selectable ? 'button' : 'group',
          'aria-pressed': selectable ? String(isSel) : null,
          'aria-label': 'Cache ' + k + ': ' + summary + (selectable ? (isSel ? '. Selected' : '. Select') : '. Recorded cache; removed from current topology.') }, svgEl);
        sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, class: 'coh-card' }, card);
        sv('text', { x: r.x + 8, y: r.y + 16, class: 'coh-cache-title', text: 'Cache ' + k }, card);
        if (isSel) {
          sv('text', { x: r.x + r.w - 8, y: r.y + 16, 'text-anchor': 'end', class: 'coh-small coh-selected-label', text: 'selected' }, card);
        }
        else if (!selectable) {
          sv('text', { x: r.x + r.w - 8, y: r.y + 16, 'text-anchor': 'end', class: 'coh-small', text: 'history' }, card);
        }
        cache.sets.forEach(function (e, s) {
          var ry = r.y + 24 + s * 34;
          var row = sv('g', { class: 'coh-row is-' + e.state + (changed['c' + k + ':' + s] ? ' is-changed' : '') }, card);
          sv('rect', { x: r.x + 4, y: ry, width: r.w - 8, height: 30, rx: 5, class: 'coh-rowbg' }, row);
          sv('rect', { x: r.x + 8, y: ry + 4, width: 22, height: 22, rx: 4, class: 'coh-badge' }, row);
          sv('text', { x: r.x + 19, y: ry + 20, 'text-anchor': 'middle', class: 'coh-badge-text', text: e.state }, row);
          sv('text', { x: r.x + 36, y: ry + 11, class: 'coh-tiny', text: 'set ' + s }, row);
          sv('text', { x: r.x + 36, y: ry + 25, class: 'coh-line', text: e.state === 'I' ? '—' : 'L' + e.line }, row);
          for (var w = 0; w < M.WORDS; w++) {
            var wx = r.x + 64 + w * 27;
            var hot = ev && run.phase !== 'travel' && ev.cache === k && ev.set === s && ev.word === w && /^(write|respond)$/.test(ev.type);
            var cell = sv('g', { class: 'coh-word' + (hot ? ' is-hot' : '') }, row);
            sv('rect', { x: wx, y: ry + 5, width: 26, height: 20, rx: 3 }, cell);
            if (e.state !== 'I') {
              sv('text', { x: wx + 13, y: ry + 19, 'text-anchor': 'middle', class: 'coh-wordtext', text: M.hex(e.data[w], 4) }, cell);
            }
          }
        });
        if (selectable) {
          card.addEventListener('click', function () {
            selectCache(k, false);
          });
          card.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectCache(k, true);
            }
          });
        }
      });

      /* memory */
      var mem = sv('g', { class: 'coh-mem', role: 'img', 'aria-label': memorySummary(state) }, svgEl);
      sv('rect', { x: g.mem.x, y: g.mem.y, width: g.mem.w, height: g.mem.h, rx: 8, class: 'coh-card' }, mem);
      sv('text', { x: g.mem.x + 8, y: g.mem.y + 14, class: 'coh-cache-title', text: 'Memory' }, mem);
      sv('text', { x: g.mem.x + g.mem.w - 8, y: g.mem.y + 14, 'text-anchor': 'end', class: 'coh-tiny', text: 'Ln covers 0xn0–0xnC' }, mem);
      for (var l = 0; l < M.LINES; l++) {
        var col = g.mem.cols === 2 ? l % 2 : 0, rowN = g.mem.cols === 2 ? l >> 1 : l;
        var cw = g.mem.cols === 2 ? 214 : 198;
        var mx = g.mem.x + 6 + col * (cw + 4), my = g.mem.y + 20 + rowN * 24;
        var owner = M.ownerOf(state, l);
        var ml = sv('g', { class: 'coh-memline' + (owner !== null ? ' is-stale' : '') + (changed['mem' + l] ? ' is-changed' : '') }, mem);
        sv('rect', { x: mx, y: my, width: cw, height: 22, rx: 4, class: 'coh-rowbg' }, ml);
        sv('text', { x: mx + 4, y: my + 15, class: 'coh-line', text: 'L' + l }, ml);
        var cur = owner !== null ? M.currentLine(state, l) : null;
        for (var mw = 0; mw < M.WORDS; mw++) {
          var x = mx + 22 + mw * 34;
          var old = cur && cur[mw] !== state.mem[l][mw];
          var wg = sv('g', { class: 'coh-word' + (old ? ' is-old' : '') }, ml);
          sv('rect', { x: x, y: my + 2, width: 32, height: 18, rx: 3 }, wg);
          sv('text', { x: x + 16, y: my + 15, 'text-anchor': 'middle', class: 'coh-wordtext', text: M.hex(state.mem[l][mw], 4) }, wg);
        }
        if (owner !== null) {
          sv('text', { x: mx + 22 + 4 * 34 + 2, y: my + 15, class: 'coh-stale', text: g.mem.cols === 1 ? 'stale' : 'stale · C' + owner }, ml);
        }
      }
      sv('text', { x: g.wip.x, y: g.wip.y, class: 'coh-wipmark', text: 'WIP · illustrative model' }, svgEl);

      /* active transaction: paths with arrows and labelled tokens */
      tokens = [];
      if (ev) {
        var cls = TYPE_CLASS[ev.type] || 'is-core';
        var pathsLayer = sv('g', { class: 'coh-paths' }, svgEl);
        var tokensLayer = sv('g', { class: 'coh-tokens' }, svgEl);
        ev.paths.forEach(function (names) {
          var pts = pathPoints(g, names);
          if (!pts) {
            return;
          }
          var d = 'M' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' L');
          sv('path', { d: d, class: 'coh-flow ' + cls + (run.phase === 'travel' ? ' is-moving' : ''), 'marker-end': 'url(#' + id + '-arrow-' + cls + ')' }, pathsLayer);
          var lens = measure(pts), total = lens[lens.length - 1];
          var coreLink = names.length === 2;
          // Bus paths stop at the bus beside the destination; core-link labels stop
          // halfway down the short link, beside it, clear of both boxes.
          var end = coreLink ? total / 2 : lens[lens.length - 2];
          var tw = ev.label.length * 6 + 12;
          var tok = sv('g', { class: 'coh-token ' + cls }, tokensLayer);
          sv('rect', { x: -tw / 2, y: -8, width: tw, height: 16, rx: 8 }, tok);
          sv('text', { x: 0, y: 3.5, 'text-anchor': 'middle', text: ev.label }, tok);
          tokens.push({ el: tok, pts: pts, lens: lens, end: end, dx: coreLink ? tw / 2 + 6 : 0, W: g.W, tw: tw });
        });
      }
      figure.replaceChildren(svgEl);
      placeTokens(run && run.phase === 'travel' ? Math.min(1, run.elapsed / TRAVEL_MS) : 1);
      if (focusId !== null) {
        var back = figure.querySelector('[data-cache="' + focusId + '"]');
        if (back && back.getAttribute('tabindex') === '0') {
          back.focus();
        }
        else {
          cacheSel.focus();
        }
      }
    }
    function placeTokens(t) {
      tokens.forEach(function (tk) {
        var p = pointAt(tk.pts, tk.lens, tk.end * t);
        var x = Math.max(tk.tw / 2 + 2, Math.min(tk.W - tk.tw / 2 - 2, p[0] + tk.dx));
        tk.el.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + p[1].toFixed(1) + ')');
      });
    }
    function memorySummary(state) {
      var parts = [];
      for (var l = 0; l < M.LINES; l++) {
        var owner = M.ownerOf(state, l);
        parts.push('L' + l + ' ' + state.mem[l].map(function (v) { return M.hex(v, 4); }).join(' ') + (owner !== null ? ' (stale; cache ' + owner + ' holds it modified)' : ''));
      }
      return 'Memory: ' + parts.join('; ');
    }

    /* The container width picks the layout, so text stays readable. */
    function modeFor() {
      var w = root.getBoundingClientRect().width;
      if (w > 0 && w < NARROW_PX) {
        return 'narrow';
      }
      if (w > 0 && w < MEDIUM_PX) {
        return 'medium';
      }
      return 'wide';
    }
    function fitLayout() {
      var next = modeFor();
      if (next !== mode) {
        mode = next;
        render();
      }
    }
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(function () {
        if (!disposed) {
          fitLayout();
        }
      });
      observer.observe(root);
    }
    mode = modeFor();
    syncControls();
    render();

    return {
      dispose: function () {
        disposed = true;
        playing = false;
        gen++;
        stopFrames();
        if (motionQuery) {
          motionQuery.removeEventListener('change', motionChanged);
        }
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      },
      snapshot: function () {
        return {
          state: M.clone(committed),
          selected: selected,
          layout: mode,
          playing: playing,
          disposed: disposed,
          frame: !!raf,
          run: run ? { cursor: run.cursor, phase: run.phase, elapsed: run.elapsed, count: run.events.length, types: run.events.map(function (e) { return e.type; }) } : null
        };
      },
      check: function () {
        return M.check(committed);
      }
    };
  }

  window.PrismCoherentCaches = { mount: mount };
})();
