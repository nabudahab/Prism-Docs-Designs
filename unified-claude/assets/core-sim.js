/* Runs a program on Prism's RTL in the browser (owner: Claude).
 *
 * Each core's tile bench is compiled by Verilator to C++ and by Emscripten to
 * WebAssembly (scripts/sim_build.py; pinned under content/sim/, shipped as
 * assets/sim/<core>.js). This file loads a model on first use, runs it in a
 * Worker when the browser allows one (the page stays responsive and a run can
 * be cancelled), and compiles the per-cycle rows with PrismTraceCompiler.
 *
 *   PrismSim.available(core)                 core: base | singlecycle | singlecycle_cached | hazard3 | hazard3_ahb
 *   PrismSim.run(core, image, { maxCycles, signal }) -> Promise<view>
 *     image: { segments: [{ base, bytes }], source? }
 *     view:  { cycles, dyn, program, stop: { reason, cycle, message }, log }
 *     reason: halt | wfi | max_cycles | error
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core-trace-compiler.js'));
  else root.PrismSim = factory(root.PrismTraceCompiler);
})(typeof self !== 'undefined' ? self : this, function (Compiler) {
  'use strict';

  var CORES = ['base', 'singlecycle', 'singlecycle_cached', 'hazard3', 'hazard3_ahb'];
  var WORDS = 16384;                 // the bench's flat memory: 64 KiB
  var CODE = { base: 0x00000000, size: 0x8000, index: 0 };
  var DATA = { base: 0x80000000, size: 0x8000, index: 0x2000 };
  var LATENCY = 1;
  var MAX_CYCLES = 20000;
  var isNode = typeof window === 'undefined' && typeof process === 'object' && !!(process.versions && process.versions.node);

  function manifest() {
    return (typeof window !== 'undefined' && window.PRISM_SIM_MODELS) || null;
  }

  function available(core) {
    if (CORES.indexOf(core) < 0) return false;
    if (isNode) return true;
    var m = manifest();
    return !!(m && m.cores && m.cores[core]);
  }

  /* Program image: the bench's $readmemh file, one 32-bit word per line. */
  function imageHex(image) {
    var words = new Uint32Array(WORDS);
    (image.segments || []).forEach(function (seg) {
      var bytes = seg.bytes || new Uint8Array(0), base = seg.base >>> 0;
      var region = base >= DATA.base && base < DATA.base + DATA.size ? DATA : (base < CODE.base + CODE.size ? CODE : null);
      if (!region || base - region.base + bytes.length > region.size) {
        throw new Error('Segment at 0x' + base.toString(16) + ' (' + bytes.length + ' bytes) is outside code 0x00000000-0x00007fff and data RAM 0x80000000-0x80007fff');
      }
      for (var i = 0; i < bytes.length; i++) {
        var offset = base - region.base + i;
        var w = region.index + (offset >>> 2);
        words[w] = (words[w] | (bytes[i] << (8 * (offset & 3)))) >>> 0;
      }
    });
    var lines = new Array(WORDS);
    for (var i = 0; i < WORDS; i++) lines[i] = ('0000000' + words[i].toString(16)).slice(-8);
    return lines.join('\n') + '\n';
  }

  /* Runs inside the Worker (stringified) and in-process; keep it self-contained. */
  function execute(factory, hex, args) {
    var log = [];
    var push = function (s) { log.push(String(s)); };
    return factory({ print: push, printErr: push, noInitialRun: true }).then(function (M) {
      M.FS.writeFile('/image.hex', hex);
      var exit = 0;
      try { M.callMain(['+IMAGE=/image.hex', '+PRISM_TRACE=/trace.jsonl', '+TRACE=/dev/null', '+DUMP=/dump.hex', '+CACHE_DUMP=/caches.csv'].concat(args)); }
      catch (e) {
        if (e && e.name === 'ExitStatus') exit = e.status;
        else { push(String(e && e.message || e)); exit = -1; }
      }
      var trace = '';
      try { trace = M.FS.readFile('/trace.jsonl', { encoding: 'utf8' }); } catch (e) { /* no rows */ }
      return { log: log, trace: trace, exit: exit };
    });
  }

  function stopOf(core, rows, out) {
    var text = out.log.join('\n');
    var last = rows.length ? rows[rows.length - 1] : null;
    var cycle = last ? last.c : -1; // the RTL's cycle number, as the diagram shows it
    if (/RTL completed:|PASS singlecycle program|PASS hazard3 program:/.test(text)) return { reason: 'halt', cycle: cycle };
    if (/RTL timeout|Singlecycle program timed out|Hazard3 program timed out/.test(text)) {
      var asleep = !!(last && last.sleep); // WFI sleep state recorded from the RTL
      return { reason: asleep ? 'wfi' : 'max_cycles', cycle: cycle };
    }
    var fatal = text.split('\n').filter(function (l) { return /%Error|%Fatal|Assertion|Aborted|RuntimeError/.test(l); });
    return { reason: 'error', cycle: cycle, message: (fatal[0] || text.split('\n').filter(Boolean).pop() || 'The simulation stopped without a result (exit ' + out.exit + ').').replace(/^\[\d+\]\s*/, '') };
  }

  var loading = {};
  function loadModel(core) {
    var name = 'PrismSim_' + core;
    if (isNode) return Promise.resolve(require('../../content/sim/' + core + '.js'));
    if (window[name]) return Promise.resolve(window[name]);
    if (loading[core]) return loading[core];
    loading[core] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/sim/' + core + '.js';
      s.charset = 'utf-8';
      s.onload = function () { window[name] ? resolve(window[name]) : reject(new Error('The ' + core + ' model did not load')); };
      s.onerror = function () { delete loading[core]; reject(new Error('Could not load assets/sim/' + core + '.js')); };
      document.head.appendChild(s);
    });
    return loading[core];
  }

  // The model's factory closes over one variable (_scriptName) from its
  // wrapper; the embedded WebAssembly needs no fetch, so a Worker can run the
  // factory's own source. Blob workers also work from file:// pages.
  function workerRun(factory, hex, args, signal) {
    var body = 'var _scriptName = "";\nvar factory = ' + factory.toString() + ';\nvar execute = ' + execute.toString() + ';\n' +
      'self.onmessage = function (e) { execute(factory, e.data.hex, e.data.args).then(function (r) { self.postMessage(r); }, function (err) { self.postMessage({ log: [String(err && err.message || err)], trace: "", exit: -1 }); }); };\n';
    var url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
    var worker;
    try { worker = new Worker(url); } catch (e) { URL.revokeObjectURL(url); return null; }
    return new Promise(function (resolve, reject) {
      function onAbort() { done(); reject(abortError()); }
      // Every exit path stops the worker, frees the URL and drops the listener.
      function done() {
        worker.terminate(); URL.revokeObjectURL(url);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      worker.onmessage = function (e) { done(); resolve(e.data); };
      worker.onerror = function (e) { done(); if (e.preventDefault) e.preventDefault(); reject(new Error(e.message || 'The simulation worker failed')); };
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal) signal.addEventListener('abort', onAbort);
      worker.postMessage({ hex: hex, args: args });
    });
  }
  function abortError() { var e = new Error('Run cancelled'); e.name = 'AbortError'; return e; }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }

  function run(core, image, options) {
    options = options || {};
    return new Promise(function (resolve) {
      if (!available(core)) throw new Error('No WebAssembly model for ' + core + ' in this build');
      var max = Math.floor(options.maxCycles || 2000);
      if (!(max >= 1 && max <= MAX_CYCLES)) throw new Error('Cycle limit must be 1 to ' + MAX_CYCLES);
      checkAbort(options.signal);
      resolve({ hex: imageHex(image), max: max });
    }).then(function (p) {
      // +FINISH_ON_WFI: the RTL treats a WFI with mie == 0 as terminal (Prism's `halt` macro).
      var args = ['+FINISH_ON_WFI', '+LATENCY=' + LATENCY, '+MAX_CYCLES=' + p.max];
      return loadModel(core).then(function (factory) {
        checkAbort(options.signal);
        var pending = !isNode && typeof Worker === 'function' && typeof Blob === 'function' && options.worker !== false ? workerRun(factory, p.hex, args, options.signal) : null;
        if (pending) return pending;
        // In-page fallback: runs to completion once started (no Worker to stop),
        // so cancellation is honoured before and after it.
        // In Node the Emscripten runtime records the bench's exit status on
        // process.exitCode; a timed-out run must not fail the host process.
        var code = isNode ? process.exitCode : undefined;
        return execute(factory, p.hex, args).then(function (r) { if (isNode) process.exitCode = code; checkAbort(options.signal); return r; });
      });
    }).then(function (out) {
      var rows = Compiler.parseRows(out.trace || '');
      var stop = stopOf(core, rows, out);
      if (!rows.length) {
        var err = new Error(stop.message || 'The simulation produced no cycles');
        err.log = out.log;
        throw err;
      }
      var view = Compiler.compile(core, rows, image.source || '');
      view.stop = stop;
      view.log = out.log;
      return view;
    });
  }

  return { available: available, run: run, imageHex: imageHex, layout: { code: CODE, data: DATA, latency: LATENCY, maxCycles: MAX_CYCLES } };
});
