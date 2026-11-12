/* Local cache model for the Base core tile (owner: cache explorer).
 *
 * A transaction-level model of Prism's Base tile caches, written from
 *   source/core_tiles/base/rtl/caches/icache.sv
 *   source/core_tiles/base/rtl/caches/dcache.sv
 *   source/core_tiles/base/rtl/interfaces/{icache_if,dcache_if}.vh
 *   source/contracts/interfaces/cache_fabric_if.vh
 *   source/soc/packages/memory_map_pkg.vh
 * It is not the RTL. It reproduces the caches' architectural decisions (tag
 * compare, LRU victim, write-back/write-allocate, beat order, uncached bypass,
 * clean/invalidate) as a list of events, without cycle timing. Every function
 * is pure: states and events are plain JSON-serializable objects.
 *
 * Two memory environments back the model:
 *   'soc'   the published address map (window.PRISM_REFERENCE.memory or the
 *           pinned fallback below): installed ROM/RAM, capacity holes return
 *           errors, MMIO beats go to a device whose response is not modeled.
 *   'bench' the Base tile bench's flat 64 KiB memory, aliased exactly as
 *           qa/core-diagrams/tracer_patch.py does, so a recorded RTL run can
 *           be replayed and compared beat for beat (replayRecording).
 *
 *   PrismCacheModel.createState()
 *   PrismCacheModel.createEnv(kind, segments, options)
 *   PrismCacheModel.dataAccess(state, env, request)  -> { state, events, result }
 *   PrismCacheModel.instructionFetch(state, env, pc) -> { state, events, result }
 *   PrismCacheModel.clean(state, env, reason)        -> { state, events, result }
 *   PrismCacheModel.invalidateInstruction(state)     -> { state, events, result }
 *   PrismCacheModel.reset(state)                     -> { state, events, result }
 *   PrismCacheModel.runProgram(segments, listing, options)  model interpreter
 *   PrismCacheModel.extractRecording(rows)            Base tracer rows -> operations
 *   PrismCacheModel.replayRecording(rows, segments, extra) -> checked operations
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrismCacheModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RTL = {
    icache: 'source/core_tiles/base/rtl/caches/icache.sv',
    dcache: 'source/core_tiles/base/rtl/caches/dcache.sv',
    dif: 'source/core_tiles/base/rtl/interfaces/dcache_if.vh',
    iif: 'source/core_tiles/base/rtl/interfaces/icache_if.vh',
    fabric: 'source/contracts/interfaces/cache_fabric_if.vh',
    map: 'source/soc/packages/memory_map_pkg.vh',
    datapath: 'source/core_tiles/base/rtl/pipeline/datapath.sv'
  };

  /* core_uarch_pkg.vh: ITAG/IIDX/IBYT = 25/4/3; DTAG/DIDX/DBLK/DBYT = 25/3/2/2, two ways. */
  var GEOMETRY = {
    i: { lines: 16, lineBytes: 8, words: 2, bytes: 128, tag: [31, 7], index: [6, 3], word: [2, 2], byte: [1, 0] },
    d: { sets: 8, ways: 2, lineBytes: 16, words: 4, bytes: 256, tag: [31, 7], index: [6, 4], word: [3, 2], byte: [1, 0] }
  };

  /* Pinned published map (content/base reference, prism:configs/memory.toml).
     Used only when window.PRISM_REFERENCE is absent (Node tests). */
  var FALLBACK_MAP = {
    storage: [
      { name: 'rom', base: 0x00000000, bytes: 4096, reserved_bytes: 65536 },
      { name: 'ram', base: 0x80000000, bytes: 65536, reserved_bytes: 536870912 }
    ],
    aperture: { base: 0x40000000, bytes: 0x10000000 },
    regions: [
      { id: 'sysctrl', base: 0x40000000, bytes: 4096 }, { id: 'timer', base: 0x40001000, bytes: 4096 },
      { id: 'irq', base: 0x40002000, bytes: 4096 }, { id: 'gpio_a', base: 0x40010000, bytes: 65536 },
      { id: 'uart', base: 0x40020000, bytes: 65536 }, { id: 'spi', base: 0x40030000, bytes: 65536 },
      { id: 'i2c', base: 0x40040000, bytes: 65536 }, { id: 'gpio_b', base: 0x40070000, bytes: 4096 }
    ]
  };
  /* The architecture tabs' teaching composition: every peripheral with RTL.
     sysctrl and i2c are reserved regions without hardware. */
  var TEACHING_DEVICES = ['timer', 'irq', 'gpio_a', 'uart', 'spi', 'gpio_b'];

  function u32(n) { return n >>> 0; }
  function hex8(n) { return ('0000000' + (n >>> 0).toString(16)).slice(-8); }
  function hx(n) { return '0x' + hex8(n); }
  function bits(n, hi, lo) { return u32(n) / Math.pow(2, lo) % Math.pow(2, hi - lo + 1) >>> 0; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function splitD(address) {
    address = u32(address);
    return { address: address, tag: address >>> 7, index: (address >>> 4) & 7, word: (address >>> 2) & 3, byte: address & 3, line: u32(address & ~15) };
  }
  function splitI(address) {
    address = u32(address);
    return { address: address, tag: address >>> 7, index: (address >>> 3) & 15, word: (address >>> 2) & 1, byte: address & 3, line: u32(address & ~7) };
  }
  function dLineAddress(tag, set) { return u32((tag << 7) | (set << 4)); }
  function iLineAddress(tag, line) { return u32((tag << 7) | (line << 3)); }

  /* ---------- state ---------- */

  function createState() {
    var sets = [], lines = [];
    for (var s = 0; s < 8; s++) {
      sets.push({ lru: 0, ways: [0, 1].map(function () { return { valid: 0, dirty: 0, tag: 0, data: [0, 0, 0, 0] }; }) });
    }
    for (var l = 0; l < 16; l++) lines.push({ valid: 0, tag: 0, data: [0, 0] });
    return {
      d: { sets: sets },
      i: { lines: lines, fault: null },
      mem: {},          // written memory words: { 'xxxxxxxx' (aligned byte address): value }
      tally: { dHit: 0, dMiss: 0, uncached: 0, writeback: 0, fill: 0, iHit: 0, iMiss: 0, fault: 0 }
    };
  }

  /* ---------- memory environments ---------- */

  function mapOf(options) {
    var ref = options && options.map;
    if (!ref && typeof window !== 'undefined' && window.PRISM_REFERENCE && window.PRISM_REFERENCE.memory) ref = window.PRISM_REFERENCE.memory;
    return ref || FALLBACK_MAP;
  }

  function imageWords(segments) {
    var words = {};
    (segments || []).forEach(function (seg) {
      var base = u32(seg.base), bytes = seg.bytes || [];
      for (var i = 0; i < bytes.length; i++) {
        var a = u32(base + i), w = hex8(a & ~3);
        words[w] = u32((words[w] || 0) | (bytes[i] << (8 * (a & 3))));
      }
    });
    return words;
  }

  /* kind: 'soc' | 'bench'. segments: assembler output [{ base, bytes }]. */
  function createEnv(kind, segments, options) {
    options = options || {};
    var m = mapOf(options), storage = {};
    (m.storage || []).forEach(function (s) { storage[s.name] = s; });
    var installed = options.devices || TEACHING_DEVICES;
    var image = imageWords(segments);
    if (kind === 'bench') {
      var aliased = {};
      Object.keys(image).forEach(function (k) { aliased[hex8(benchAlias(num(k)))] = image[k]; });
      image = aliased;
    }
    return {
      kind: kind === 'bench' ? 'bench' : 'soc',
      image: image,
      rom: storage.rom || FALLBACK_MAP.storage[0],
      ram: storage.ram || FALLBACK_MAP.storage[1],
      aperture: m.aperture || FALLBACK_MAP.aperture,
      regions: (m.regions || FALLBACK_MAP.regions).map(function (r) { return { id: r.id, base: u32(r.base), bytes: r.bytes, installed: installed.indexOf(r.id) >= 0, registers: (r.registers || []).map(function (x) { return { name: x.name, address: u32(x.address) }; }) }; })
    };
  }

  function inRange(address, base, bytes) { return u32(address - base) < bytes; }

  /* The bench aliases data addresses into its flat 64 KiB (tracer_patch.py MASK). */
  function benchAlias(address) { return u32((address & 0x7fff) | ((address >>> 31) ? 0x8000 : 0)); }

  /* Classify for the data side. cacheable is exactly memory_map_pkg::is_cacheable:
     the whole reserved RAM window, not just installed capacity. */
  function classify(env, address) {
    address = u32(address);
    var ram = env.ram, rom = env.rom, ap = env.aperture;
    var c = { address: address, cacheable: inRange(address, ram.base, ram.reserved_bytes) };
    if (c.cacheable) {
      c.kind = inRange(address, ram.base, ram.bytes) ? 'ram' : 'ram-hole';
      c.label = c.kind === 'ram' ? 'RAM' : 'RAM window beyond installed capacity';
    } else if (inRange(address, rom.base, rom.reserved_bytes)) {
      c.kind = inRange(address, rom.base, rom.bytes) ? 'rom' : 'rom-hole';
      c.label = c.kind === 'rom' ? 'Boot ROM' : 'ROM window beyond installed capacity';
    } else if (inRange(address, ap.base, ap.bytes)) {
      var region = null;
      env.regions.forEach(function (r) { if (inRange(address, r.base, r.bytes)) region = r; });
      c.kind = region ? (region.installed ? 'device' : 'reserved') : 'mmio-gap';
      c.region = region ? region.id : null;
      if (region) {
        var reg = null;
        region.registers.forEach(function (x) { if (u32(address - x.address) < 4) reg = x.name; });
        c.register = reg;
      }
      c.label = region ? (region.installed ? 'MMIO ' + region.id : 'MMIO ' + region.id + ' (reserved, no hardware)') : 'MMIO aperture, no reserved region';
    } else {
      c.kind = 'unmapped';
      c.label = 'Outside every reserved region';
    }
    if (env.kind === 'bench') {
      c.bench = benchAlias(address);
      var benchMemory = (address >>> 31) ? inRange(address, 0x80000000, 0x8000) : address < 0x8000;
      c.benchArtifact = !benchMemory || !(c.kind === 'ram' || c.kind === 'rom' || c.kind === 'rom-hole');
    }
    return c;
  }

  function memKey(env, address) { return hex8((env.kind === 'bench' ? benchAlias(address) : u32(address)) & ~3); }
  function readWord(state, env, address) {
    var k = memKey(env, address);
    if (Object.prototype.hasOwnProperty.call(state.mem, k)) return state.mem[k];
    return env.image[k] || 0;
  }
  function writeBytes(state, env, address, word, byteMask) {
    var k = memKey(env, address), old = readWord(state, env, address), out = old;
    for (var b = 0; b < 4; b++) if (byteMask & (1 << b)) out = u32((out & ~(0xff << (8 * b))) | (word & (0xff << (8 * b))));
    state.mem[k] = u32(out);
  }

  /* One fabric data beat. Returns { ok, data: [lo, hi], device } */
  function fabricRead(state, env, beatAddress, side) {
    var c = classify(env, beatAddress);
    if (env.kind === 'bench') return { ok: true, data: [readWord(state, env, beatAddress), readWord(state, env, beatAddress + 4)] };
    if (c.kind === 'ram' || c.kind === 'rom') return { ok: true, data: [readWord(state, env, beatAddress), readWord(state, env, beatAddress + 4)] };
    if (c.kind === 'device' && side === 'd') return { ok: true, data: null, device: c.region };
    return { ok: false, data: null, reason: errorReason(c, 'read') };
  }
  function fabricWrite(state, env, beatAddress, data, mask) {
    var c = classify(env, beatAddress);
    var ok = env.kind === 'bench' || c.kind === 'ram' || c.kind === 'device';
    if (!ok) return { ok: false, reason: errorReason(c, 'write') };
    if (c.kind === 'device' && env.kind !== 'bench') return { ok: true, device: c.region };
    if (mask & 0x0f) writeBytes(state, env, beatAddress, data[0], mask & 0xf);
    if (mask & 0xf0) writeBytes(state, env, beatAddress + 4, data[1], mask >>> 4);
    return { ok: true };
  }
  function errorReason(c, dir) {
    if (c.kind === 'rom' && dir === 'write') return 'Boot ROM is read-only: a write beat completes with an error.';
    if (c.kind === 'ram-hole' || c.kind === 'rom-hole') return 'The address is reserved but beyond installed capacity: the system router completes the beat with an error.';
    if (c.kind === 'reserved') return 'The ' + c.region + ' region is reserved but has no hardware in this composition: with no external port, the router completes the beat with an error.';
    if (c.kind === 'device') return 'Instruction fetch from a peripheral is not modeled.';
    return 'No target decodes this address: the beat completes with an error.';
  }

  /* ---------- helpers for events ---------- */

  function sizeOf(n) { return n === 1 ? 'byte' : n === 2 ? 'halfword' : 'word'; }
  function laneMask(size, offset) { return ({ 1: 0x01, 2: 0x03, 4: 0x0f })[size] << offset & 0xff; }
  function wordMask(size, byte) { return u32(({ 1: 0xff, 2: 0xffff, 4: 0xffffffff })[size] * Math.pow(2, 8 * byte)); }
  /* dcache.sv merge_store */
  function mergeStore(old, data, size, byte) {
    var m = size === 4 ? 0xffffffff : wordMask(size, byte);
    return u32((old & ~m) | (u32(data * Math.pow(2, 8 * byte)) & m));
  }
  /* Low-packed, zero-extended cache read data (dcache.sv cpu_response). */
  function extract(word, size, byte) {
    if (size === 4) return u32(word);
    return u32(word >>> (8 * byte)) & (size === 1 ? 0xff : 0xffff);
  }

  function Recorder(state) {
    this.state = state; this.events = [];
  }
  Recorder.prototype.push = function (ev) { ev.state = clone(this.state); this.events.push(ev); return ev; };

  function lineView(way) { return { valid: way.valid, dirty: way.dirty, tag: way.tag }; }

  /* ---------- D-cache ---------- */

  /* request: { write, size: 1|2|4, address, data (low-packed store payload), mnemonic? } */
  function dataAccess(state0, env, request) {
    var state = clone(state0), r = new Recorder(state);
    var write = !!request.write, size = request.size || 4, address = u32(request.address), data = u32(request.data || 0);
    var f = splitD(address), c = classify(env, address);
    var mn = request.mnemonic || (write ? ({ 1: 'sb', 2: 'sh', 4: 'sw' })[size] : ({ 1: 'lbu', 2: 'lhu', 4: 'lw' })[size]);
    var result = { write: write, size: size, address: address, data: data, cacheable: c.cacheable, kind: c.kind, region: c.region || null };

    if ((size === 2 && (address & 1)) || (size === 4 && (address & 3))) {
      r.push({ kind: 'misaligned', tone: 'fault', title: 'Misaligned ' + sizeOf(size) + ' access',
        text: 'The hart checks natural alignment before the D-cache sees an access, so ' + hx(address) + ' raises a misaligned exception in the core and no cache state changes.',
        source: [RTL.dif + ': the hart owns natural alignment', RTL.dcache + ': Misaligned D-cache access assertion'], address: address });
      result.fault = 'misaligned';
      return { state: state, events: r.events, result: result };
    }

    r.push({ kind: 'decode', cache: 'd', tone: 'info', title: mn + ' ' + hx(address),
      text: c.cacheable
        ? 'is_cacheable(' + hx(address) + ') is true: the address is inside the reserved RAM window, so the D-cache handles it. Tag ' + hx(f.tag) + ', set ' + f.index + ', word ' + f.word + ', byte ' + f.byte + '.'
        : 'is_cacheable(' + hx(address) + ') is false (' + c.label + '): the access bypasses the cache arrays and leaves as one uncached beat.',
      source: [RTL.map + ': is_cacheable'], address: address, fields: f, region: c, set: c.cacheable ? f.index : null, write: write, size: size, data: write ? data : null,
      flow: 'core-d' });

    if (!c.cacheable) return uncached(state, r, env, request, f, c, mn, result);

    var set = state.d.sets[f.index];
    var compare = set.ways.map(function (w, i) { return { way: i, valid: w.valid, tag: w.tag, match: !!(w.valid && w.tag === f.tag) }; });
    var hitWay = compare[0].match ? 0 : compare[1].match ? 1 : -1;
    r.push({ kind: 'probe', cache: 'd', tone: hitWay >= 0 ? 'hit' : 'miss', title: hitWay >= 0 ? 'Tag match in way ' + hitWay : 'No way matches: miss',
      text: 'In EX the probe reads set ' + f.index + ' and compares both ways\' tags with ' + hx(f.tag) + ' (valid && tag equal). ' +
        (hitWay >= 0 ? 'Way ' + hitWay + ' matches. probe_accept captures the result with the instruction; MEM does not compare tags again.' : 'Neither valid way holds this tag. MEM holds the access while the controller handles the miss.'),
      source: [RTL.dcache + ': lookup (probe_hit), probe_registers'], set: f.index, compare: compare, address: address, fields: f });

    var way = hitWay;
    if (hitWay < 0) {
      state.tally.dMiss++;
      var victim = set.lru, v = set.ways[victim];
      var victimLine = dLineAddress(v.tag, f.index);
      r.push({ kind: 'miss', cache: 'd', tone: 'miss', title: 'Miss: replace way ' + victim + ' (LRU bit = ' + victim + ')',
        text: 'capture_miss saves the address' + (write ? ', store payload and size' : ' and size') + '. The set\'s replacement bit chooses way ' + victim +
          ' as the victim; the RTL does not prefer an invalid way. ' +
          (!v.valid ? 'Way ' + victim + ' is invalid, so nothing is lost.' : v.dirty ? 'Way ' + victim + ' holds dirty line ' + hx(victimLine) + ': it must be written back first.' : 'Way ' + victim + ' holds clean line ' + hx(victimLine) + ': it is overwritten without a write-back.'),
        source: [RTL.dcache + ': capture_miss, controller DCACHE_IDLE'], set: f.index, way: victim, victim: { way: victim, line: v.valid ? victimLine : null, valid: v.valid, dirty: v.dirty }, address: address });

      if (v.valid && v.dirty) {
        var wbOk = true;
        for (var half = 0; half < 2 && wbOk; half++) {
          var wa = u32(victimLine + 8 * half), wd = [v.data[2 * half], v.data[2 * half + 1]];
          var w = fabricWrite(state, env, wa, wd, 0xff);
          state.tally.writeback += 1;
          if (!w.ok) {
            v.valid = 0; v.dirty = 0; wbOk = false;
            r.push({ kind: 'writeback', cache: 'd', tone: 'fault', title: 'Write-back ' + (half ? 'high' : 'low') + ' beat failed',
              text: w.reason + ' The RTL drops the line (valid and dirty cleared), pulses writeback_failed for the hart\'s error record and continues with the refill.',
              source: [RTL.dcache + ': failed_writeback'], set: f.index, way: victim, beat: { channel: 'd', dir: 'write', address: wa, data: wd, mask: 0xff, ok: false, purpose: 'writeback-' + (half ? 'high' : 'low') }, flow: 'd-fabric' });
          } else {
            if (half === 1) v.dirty = 0;
            r.push({ kind: 'writeback', cache: 'd', tone: 'dirty', title: 'Write-back ' + (half ? 'high' : 'low') + ' beat: ' + hx(wa),
              text: 'DCACHE_WB_' + (half ? 'HIGH' : 'LOW') + ' writes words ' + (2 * half) + '–' + (2 * half + 1) + ' of the victim (' + hx(wd[0]) + ', ' + hx(wd[1]) + ') as one 64-bit beat with mask 0xff. ' +
                (half ? 'Completing the second beat clears the dirty bit; memory now holds the line.' : 'The dirty bit stays set until the high beat completes.'),
              source: [RTL.dcache + ': build_memory_request DCACHE_WB_' + (half ? 'HIGH' : 'LOW')], set: f.index, way: victim, words: half ? [2, 3] : [0, 1],
              beat: { channel: 'd', dir: 'write', address: wa, data: wd, mask: 0xff, ok: true, purpose: 'writeback-' + (half ? 'high' : 'low') }, flow: 'd-fabric' });
          }
        }
      }

      for (var h = 0; h < 2; h++) {
        var fa = u32(f.line + 8 * h), rd = fabricRead(state, env, fa, 'd');
        state.tally.fill += 1;
        if (!rd.ok) {
          v.valid = 0;
          state.tally.fault++;
          r.push({ kind: 'fill', cache: 'd', tone: 'fault', title: 'Refill ' + (h ? 'high' : 'low') + ' beat failed',
            text: rd.reason + ' failed_fill returns the controller to IDLE and clears way ' + victim + '\'s valid bit' + (h ? ' (its low words were already replaced)' : '') + '. cache_error then completes the held access with access_fault: the hart traps instead of retiring it. The LRU bit is unchanged.',
            source: [RTL.dcache + ': failed_fill, cache_error'], set: f.index, way: victim,
            beat: { channel: 'd', dir: 'read', address: fa, data: null, mask: 0xff, ok: false, purpose: 'fill-' + (h ? 'high' : 'low') }, flow: 'd-fabric' });
          result.fault = 'access';
          result.hit = false;
          r.push({ kind: 'fault', cache: 'd', tone: 'fault', title: 'Access fault: ' + mn + ' does not retire',
            text: 'No line is installed for ' + hx(f.line) + '. The trap handler sees a ' + (write ? 'store' : 'load') + ' access fault.',
            source: [RTL.dif + ': access_fault'], set: f.index, way: victim, address: address });
          return { state: state, events: r.events, result: result };
        }
        var merged = null;
        for (var k = 0; k < 2; k++) {
          var word = rd.data[k], idx = 2 * h + k;
          if (write && f.word === idx) {
            merged = { word: idx, before: word, after: mergeStore(word, data, size, f.byte) };
            word = merged.after;
          }
          v.data[idx] = word;
        }
        if (h === 1) { v.tag = f.tag; v.valid = 1; v.dirty = write ? 1 : 0; }
        r.push({ kind: 'fill', cache: 'd', tone: h ? 'fill' : 'fill', title: 'Refill ' + (h ? 'high' : 'low') + ' beat: ' + hx(fa),
          text: 'DCACHE_FILL_' + (h ? 'HIGH' : 'LOW') + ' reads ' + hx(rd.data[0]) + ', ' + hx(rd.data[1]) + ' into words ' + (2 * h) + '–' + (2 * h + 1) + ' of way ' + victim + '. ' +
            (merged ? 'The saved store merges into word ' + merged.word + ': ' + hx(merged.before) + ' → ' + hx(merged.after) + '. ' : '') +
            (h ? 'The high beat installs tag ' + hx(f.tag) + ' with valid = 1 and dirty = ' + (write ? '1 (store miss)' : '0') + '.' : 'Tag and valid still describe the old line until the high beat; EX is held, so nothing can probe it meanwhile.'),
          source: [RTL.dcache + ': format_refill, metadata (selected_fill && beat_high)'], set: f.index, way: victim, words: h ? [2, 3] : [0, 1], merged: merged,
          beat: { channel: 'd', dir: 'read', address: fa, data: rd.data, mask: 0xff, ok: true, purpose: 'fill-' + (h ? 'high' : 'low') }, flow: 'fabric-d' });
      }
      way = victim;
      result.hit = false;
    } else {
      state.tally.dHit++;
      result.hit = true;
    }

    // The held MEM access completes as a hit on the selected way (after a fill the
    // probe register is forced to the victim way); a hit updates the LRU bit.
    var line = set.ways[way], old = line.data[f.word];
    var lruBefore = set.lru;
    set.lru = way ? 0 : 1;
    result.way = way; result.set = f.index;
    if (write) {
      line.data[f.word] = mergeStore(old, data, size, f.byte);
      line.dirty = 1;
      result.before = old; result.after = line.data[f.word];
      r.push({ kind: 'complete', cache: 'd', tone: 'dirty', title: (result.hit ? 'Store hit' : 'Store completes') + ': way ' + way + ' word ' + f.word + ' is dirty',
        text: (result.hit ? 'The store merges into the cached word: ' : 'The held store completes as a hit on the installed line: ') + hx(old) + ' → ' + hx(line.data[f.word]) + ' (' + sizeOf(size) + ' at byte ' + f.byte + '). ' +
          'The dirty bit is set and memory is not written now: write-back happens on eviction or on a clean. ' + lruText(lruBefore, set.lru, way),
        source: [RTL.dcache + ': store_hit, merge_store, replacement_bit'], set: f.index, way: way, words: [f.word], lru: { before: lruBefore, after: set.lru }, address: address, flow: 'd-core' });
    } else {
      var value = extract(old, size, f.byte);
      result.value = value;
      r.push({ kind: 'complete', cache: 'd', tone: 'hit', title: (result.hit ? 'Load hit' : 'Load completes') + ': ' + hx(value),
        text: (result.hit ? 'The cached word ' : 'The held load completes as a hit on the installed line; word ') + hx(old) + (size < 4 ? ' is shifted by byte ' + f.byte + ' and zero-extended to ' + hx(value) + ' (the hart applies sign extension).' : ' returns to the hart.') + ' ' + lruText(lruBefore, set.lru, way),
        source: [RTL.dcache + ': cpu_response, replacement_bit'], set: f.index, way: way, words: [f.word], lru: { before: lruBefore, after: set.lru }, value: value, address: address, flow: 'd-core' });
    }
    return { state: state, events: r.events, result: result };
  }

  function lruText(before, after, way) {
    return 'The access used way ' + way + ', so the replacement bit points at way ' + after + (before === after ? ' (unchanged).' : ' (was ' + before + ').');
  }

  function uncached(state, r, env, request, f, c, mn, result) {
    var write = !!request.write, size = request.size || 4, address = f.address, data = u32(request.data || 0);
    var beatAddress = u32(address & ~7), offset = address & 7, mask = laneMask(size, offset);
    var lanes = [0, 0];
    if (write) {
      var shifted = data * Math.pow(2, 8 * offset);   // {32'b0, data} << 8*address[2:0]
      lanes = [u32(shifted % 4294967296), u32(Math.floor(shifted / 4294967296))];
    }
    state.tally.uncached++;
    var resp = write ? fabricWrite(state, env, beatAddress, lanes, mask) : fabricRead(state, env, beatAddress, 'd');
    var beat = { channel: 'd', dir: write ? 'write' : 'read', address: beatAddress, mask: mask, data: write ? lanes : (resp.data || null), ok: resp.ok, purpose: 'uncached', device: resp.device || null };
    r.push({ kind: 'uncached', cache: 'd', tone: resp.ok ? 'bypass' : 'fault', title: 'Uncached ' + (write ? 'write' : 'read') + ' beat: ' + hx(beatAddress) + ', mask ' + '0x' + ('0' + mask.toString(16)).slice(-2),
      text: 'capture_io registers one beat: the 8-byte-aligned address ' + hx(beatAddress) + ' with byte mask 0x' + ('0' + mask.toString(16)).slice(-2) + ' (lanes ' + offset + '–' + (offset + size - 1) + ')' +
        (write ? ' and the payload shifted into those lanes.' : '.') + ' No tag, set, way or LRU bit is read or changed.' +
        (resp.device ? ' The memory fabric forwards it to the system bus; the ' + resp.device + ' device produces the response (the system bus tab follows that path).' : ''),
      source: [RTL.dcache + ': capture_io, io_mask, build_memory_request', RTL.fabric + ': byte masks'], beat: beat, address: address, region: c, flow: 'd-fabric' });
    if (!resp.ok) {
      state.tally.fault++;
      result.fault = 'access';
      r.push({ kind: 'fault', cache: 'd', tone: 'fault', title: 'Access fault: ' + mn + ' does not retire',
        text: resp.reason + ' io_error makes the single io_complete pulse an access_fault: the hart traps. Nothing was allocated.',
        source: [RTL.dcache + ': io_complete, io_error'], address: address, flow: 'fabric-d' });
      return { state: state, events: r.events, result: result };
    }
    if (write) {
      r.push({ kind: 'complete', cache: 'd', tone: 'bypass', title: 'Uncached store completes once',
        text: 'The beat completes; io_complete pulses for one cycle so the held MEM access cannot issue the same device side effect twice. Neither cache changes.',
        source: [RTL.dcache + ': io_pending, io_complete'], address: address, flow: 'fabric-d' });
    } else {
      var value = resp.data ? extract(offset < 4 ? resp.data[0] : resp.data[1], size, offset & 3) : null;
      result.value = value;
      r.push({ kind: 'complete', cache: 'd', tone: 'bypass', title: 'Uncached load completes once' + (value !== null ? ': ' + hx(value) : ''),
        text: (value !== null ? 'The response is shifted right by ' + offset + ' bytes and saved in io_read_data: ' + hx(value) + '.' : 'io_read_data holds the device\'s response; this view does not model device registers.') +
          ' io_complete pulses once; the line is not allocated, so the next access to ' + hx(address) + ' is uncached again.',
        source: [RTL.dcache + ': io_shifted, io_read_data, io_complete'], value: value, address: address, flow: 'fabric-d' });
    }
    result.hit = null;
    return { state: state, events: r.events, result: result };
  }

  /* ---------- maintenance ---------- */

  /* reason: 'fence' | 'fence.i' | 'halt'. Writes back dirty ways; valid lines stay valid. */
  function clean(state0, env, reason) {
    var state = clone(state0), r = new Recorder(state), written = 0, dropped = 0;
    reason = reason || 'fence';
    r.push({ kind: 'clean-start', cache: 'd', tone: 'info', title: reason === 'halt' ? 'Terminal halt: clean the D-cache' : 'dcache.clean: scan for dirty lines',
      text: (reason === 'halt' ? 'The hart holds halt; the D-cache runs the same scan as clean and then keeps flushed asserted. ' : 'The fence in MEM holds dcache.clean. ') +
        'DCACHE_FLUSH visits sets 0 to 7 and writes back each dirty way, way 0 first. Valid lines stay valid: Prism has no D-cache invalidate.',
      source: [RTL.dcache + ': controller DCACHE_FLUSH', RTL.datapath + ': fence FSM'], flow: null });
    for (var s = 0; s < 8; s++) {
      var set = state.d.sets[s];
      while (set.ways[0].dirty || set.ways[1].dirty) {
        var way = set.ways[0].dirty ? 0 : 1, v = set.ways[way], line = dLineAddress(v.tag, s);
        for (var half = 0; half < 2; half++) {
          var wa = u32(line + 8 * half), wd = [v.data[2 * half], v.data[2 * half + 1]];
          var w = fabricWrite(state, env, wa, wd, 0xff);
          state.tally.writeback++;
          if (!w.ok) {
            v.valid = 0; v.dirty = 0; dropped++;
            r.push({ kind: 'writeback', cache: 'd', tone: 'fault', title: 'Clean write-back failed: line dropped', text: w.reason + ' The line is dropped and the scan continues.',
              source: [RTL.dcache + ': failed_writeback'], set: s, way: way, beat: { channel: 'd', dir: 'write', address: wa, data: wd, mask: 0xff, ok: false, purpose: 'clean-' + (half ? 'high' : 'low') }, flow: 'd-fabric' });
            break;
          }
          if (half === 1) { v.dirty = 0; written++; }
          r.push({ kind: 'writeback', cache: 'd', tone: 'dirty', title: 'Set ' + s + ' way ' + way + ': write-back ' + (half ? 'high' : 'low') + ' beat ' + hx(wa),
            text: 'Words ' + (2 * half) + '–' + (2 * half + 1) + ' (' + hx(wd[0]) + ', ' + hx(wd[1]) + ') go to memory.' + (half ? ' The line is now clean and still valid.' : ''),
            source: [RTL.dcache + ': DCACHE_WB_' + (half ? 'HIGH' : 'LOW') + ' while flushing'], set: s, way: way, words: half ? [2, 3] : [0, 1],
            beat: { channel: 'd', dir: 'write', address: wa, data: wd, mask: 0xff, ok: true, purpose: 'clean-' + (half ? 'high' : 'low') }, flow: 'd-fabric' });
        }
      }
    }
    r.push({ kind: 'clean-done', cache: 'd', title: (reason === 'halt' ? 'flushed: ' : 'clean_done: ') + written + ' line' + (written === 1 ? '' : 's') + ' written back' + (dropped ? ', ' + dropped + ' dropped' : ''), tone: dropped ? 'fault' : 'info',
      text: (dropped ? dropped + ' dirty line' + (dropped === 1 ? ' was' : 's were') + ' dropped after a write-back error: valid and dirty were cleared and writeback_failed reported each line address. Memory keeps whichever beats it accepted. ' : '') +
        (written ? 'Memory now matches every remaining valid line. ' : dropped ? '' : 'No line was dirty, so no beat was needed. ') +
        'Other valid bits, tags, data and LRU bits are unchanged.' +
        (reason === 'halt' ? ' The core is stopped.' : ''),
      source: [RTL.dcache + ': DCACHE_CLEAN', RTL.dif + ': clean preserves valid lines'], flow: null });
    return { state: state, events: r.events, result: { written: written, dropped: dropped } };
  }

  function invalidateInstruction(state0) {
    var state = clone(state0), r = new Recorder(state), cleared = 0;
    state.i.lines.forEach(function (l) { if (l.valid) cleared++; l.valid = 0; });
    state.i.fault = null;
    r.push({ kind: 'invalidate', cache: 'i', tone: 'info', title: 'icache.invalidate: ' + cleared + ' line' + (cleared === 1 ? '' : 's') + ' invalidated',
      text: 'After clean_done, fence.i raises icache.invalidate. Once any outstanding refill has drained, every valid bit (and any retained fetch fault) is cleared in one edge and invalidate_done is acknowledged. Tags and data stay in the array but can no longer hit. Instructions are refetched from memory, where the clean has just placed any stored code.',
      source: [RTL.icache + ': ICACHE_READY invalidate', RTL.datapath + ': FENCE_INVALIDATE'], flow: null });
    return { state: state, events: r.events, result: { cleared: cleared } };
  }

  function fenceI(state0, env) {
    var a = clean(state0, env, 'fence.i'), b = invalidateInstruction(a.state);
    return { state: b.state, events: a.events.concat(b.events), result: { written: a.result.written, cleared: b.result.cleared } };
  }

  function reset(state0) {
    var fresh = createState(), state = clone(state0);
    var lost = 0;
    state.d.sets.forEach(function (s) { s.ways.forEach(function (w) { if (w.valid && w.dirty) lost++; }); });
    // n_rst clears contents and metadata; memory outside the tile is untouched.
    state.d = fresh.d; state.i = fresh.i;
    var r = new Recorder(state);
    r.push({ kind: 'reset', tone: lost ? 'fault' : 'info', title: 'n_rst: both caches cleared',
      text: 'Asynchronous reset clears every valid, dirty and LRU bit and the data arrays in both caches and cancels requests. ' +
        (lost ? lost + ' dirty line' + (lost === 1 ? ' was' : 's were') + ' discarded without a write-back: memory keeps its older values.' : 'No line was dirty, so no data was lost.'),
      source: [RTL.dcache + ': n_rst discards valid and dirty contents', RTL.icache + ': n_rst'], flow: null });
    return { state: state, events: r.events, result: { lost: lost } };
  }

  /* ---------- I-cache ---------- */

  function instructionFetch(state0, env, pc) {
    var state = clone(state0), r = new Recorder(state);
    var f = splitI(pc), line = state.i.lines[f.index];
    // icache.sv fault_matches: a retained failed refill for this 8-byte line answers
    // access_fault again, without a lookup or another fabric beat.
    if (state.i.fault !== null && state.i.fault === f.line) {
      state.tally.fault++;
      r.push({ kind: 'ifetch', cache: 'i', tone: 'fault', title: 'Fetch ' + hx(pc) + ': retained fetch fault',
        text: 'The last refill of line ' + hx(f.line) + ' failed. The I-cache keeps that fault and answers access_fault again without another request. Fetching a different line, invalidation or reset releases it.',
        source: [RTL.icache + ': fault_valid, fault_matches'], line: f.index, pc: u32(pc), fields: f, flow: null });
      return { state: state, events: r.events, result: { pc: u32(pc), line: f.index, hit: false, fault: true, retained: true } };
    }
    // An enabled lookup of another line releases a retained fault, even when it hits.
    var released = state.i.fault !== null;
    state.i.fault = null;
    var hit = !!(line.valid && line.tag === f.tag);
    var result = { pc: u32(pc), line: f.index, hit: hit, released: released };
    if (hit) {
      state.tally.iHit++;
      result.word = line.data[f.word];
      r.push({ kind: 'ifetch', cache: 'i', tone: 'hit', title: 'Fetch ' + hx(pc) + ': I-cache hit', quiet: true,
        text: 'Line ' + f.index + ' is valid with tag ' + hx(f.tag) + '; address bit 2 selects word ' + f.word + ' (' + hx(line.data[f.word]) + ').',
        source: [RTL.icache + ': hit, read_data'], line: f.index, words: [f.word], pc: u32(pc), fields: f, flow: null });
      return { state: state, events: r.events, result: result };
    }
    state.tally.iMiss++;
    var rd = fabricRead(state, env, f.line, 'i');
    var beat = { channel: 'i', dir: 'read', address: f.line, data: rd.ok ? rd.data : null, mask: 0xff, ok: rd.ok, purpose: 'ifill' };
    r.push({ kind: 'ifetch', cache: 'i', tone: 'miss', title: 'Fetch ' + hx(pc) + ': I-cache miss',
      text: 'Line ' + f.index + (line.valid ? ' holds tag ' + hx(line.tag) + ', not ' + hx(f.tag) : ' is invalid') + '. The I-cache saves the aligned address ' + hx(f.line) +
        ' and requests one 8-byte beat on the instruction channel. The I-cache does not consult is_cacheable: it caches any fetched address.',
      source: [RTL.icache + ': ICACHE_READY miss capture'], line: f.index, pc: u32(pc), fields: f, flow: 'core-i' });
    if (!rd.ok) {
      state.i.fault = f.line;
      result.fault = true;
      r.push({ kind: 'ifill', cache: 'i', tone: 'fault', title: 'Refill failed: no line installed', beat: beat,
        text: rd.reason + ' A failed refill never becomes valid; the fault is held for this line until another line is looked up, an invalidation or reset.',
        source: [RTL.icache + ': ICACHE_FILL instruction_error'], line: f.index, pc: u32(pc), flow: 'i-fabric' });
      return { state: state, events: r.events, result: result };
    }
    line.data = rd.data.slice(); line.tag = f.tag; line.valid = 1; state.i.fault = null;
    result.word = line.data[f.word];
    r.push({ kind: 'ifill', cache: 'i', tone: 'fill', title: 'Instruction beat ' + hx(f.line) + ' installs line ' + f.index, beat: beat,
      text: 'One successful 64-bit beat writes both instructions (' + hx(rd.data[0]) + ', ' + hx(rd.data[1]) + '), tag ' + hx(f.tag) + ' and valid = 1 in the same edge. The fetch then hits.',
      source: [RTL.icache + ': ICACHE_FILL'], line: f.index, words: [0, 1], pc: u32(pc), flow: 'fabric-i' });
    return { state: state, events: r.events, result: result };
  }

  /* ---------- program interpreter (model mode) ---------- */

  function sx(v, b) { var m = Math.pow(2, b); v = ((v % m) + m) % m; return v >= m / 2 ? v - m : v; }
  var LD = { 0: ['lb', 1, true], 1: ['lh', 2, true], 2: ['lw', 4, false], 4: ['lbu', 1, false], 5: ['lhu', 2, false] };
  var ST = { 0: ['sb', 1], 1: ['sh', 2], 2: ['sw', 4] };
  var SUBSET = 'RV32I loads and stores, integer ALU instructions, branches, jal/jalr, lui/auipc, fence, fence.i and halt';

  /* Executes one decoded instruction; returns { next, memory?, fence?, halt?, error? } */
  function execute(word, pc, regs, cpu) {
    var op = word & 0x7f, rd = (word >>> 7) & 31, f3 = (word >>> 12) & 7, rs1 = (word >>> 15) & 31, rs2 = (word >>> 20) & 31, f7 = word >>> 25;
    var a = regs[rs1], b = regs[rs2], next = u32(pc + 4);
    function setRd(v) { if (rd) regs[rd] = u32(v); }
    if (op === 0x37) { setRd(word & 0xfffff000); return { next: next }; }
    if (op === 0x17) { setRd(pc + (word & 0xfffff000)); return { next: next }; }
    if (op === 0x6f) {
      var j = sx(((word >>> 31) << 20) | (((word >>> 12) & 0xff) << 12) | (((word >>> 20) & 1) << 11) | (((word >>> 21) & 0x3ff) << 1), 21);
      var jt = u32(pc + j);
      if (jt & 3) return { misaligned: jt, mnemonic: 'jal' };   // trap before rd is written
      setRd(next); return { next: jt };
    }
    if (op === 0x67 && f3 === 0) {
      var t = u32((a + sx(word >>> 20, 12)) & ~1);              // JALR clears bit 0 first
      if (t & 3) return { misaligned: t, mnemonic: 'jalr' };
      setRd(next); return { next: t };
    }
    if (op === 0x63) {
      var bi = sx(((word >>> 31) << 12) | (((word >>> 7) & 1) << 11) | (((word >>> 25) & 0x3f) << 5) | (((word >>> 8) & 0xf) << 1), 13);
      var sa = a | 0, sb = b | 0, take;
      if (f3 === 0) take = a === b; else if (f3 === 1) take = a !== b; else if (f3 === 4) take = sa < sb; else if (f3 === 5) take = sa >= sb;
      else if (f3 === 6) take = a < b; else if (f3 === 7) take = a >= b; else return { error: 'unknown branch' };
      if (take && (u32(pc + bi) & 3)) return { misaligned: u32(pc + bi), mnemonic: 'branch' };   // an untaken branch never traps
      return { next: take ? u32(pc + bi) : next };
    }
    if (op === 0x03 && LD[f3]) return { next: next, memory: { write: false, size: LD[f3][1], signed: LD[f3][2], mnemonic: LD[f3][0], address: u32(a + sx(word >>> 20, 12)), rd: rd } };
    if (op === 0x23 && ST[f3]) {
      var si = sx(((word >>> 25) << 5) | ((word >>> 7) & 31), 12);
      return { next: next, memory: { write: true, size: ST[f3][1], mnemonic: ST[f3][0], address: u32(a + si), data: ST[f3][1] === 4 ? b : b & (ST[f3][1] === 1 ? 0xff : 0xffff) } };
    }
    if (op === 0x13) {
      var imm = sx(word >>> 20, 12), sh = rs2;
      if (f3 === 0) setRd(a + imm); else if (f3 === 2) setRd((a | 0) < imm ? 1 : 0); else if (f3 === 3) setRd(a < u32(imm) ? 1 : 0);
      else if (f3 === 4) setRd(a ^ imm); else if (f3 === 6) setRd(a | imm); else if (f3 === 7) setRd(a & imm);
      else if (f3 === 1 && f7 === 0) setRd(a << sh); else if (f3 === 5 && f7 === 0) setRd(a >>> sh); else if (f3 === 5 && f7 === 0x20) setRd((a | 0) >> sh);
      else return { error: 'unsupported shift encoding' };
      return { next: next };
    }
    if (op === 0x33 && (f7 === 0 || f7 === 0x20)) {
      var k = f3 + ',' + f7;
      var r = ({ '0,0': a + b, '0,32': a - b, '1,0': a << (b & 31), '2,0': (a | 0) < (b | 0) ? 1 : 0, '3,0': a < b ? 1 : 0, '4,0': a ^ b, '5,0': a >>> (b & 31), '5,32': (a | 0) >> (b & 31), '6,0': a | b, '7,0': a & b })[k];
      if (r === undefined) return { error: 'unsupported register-register encoding' };
      setRd(r); return { next: next };
    }
    if (op === 0x0f && (f3 === 0 || f3 === 1)) return { next: next, fence: f3 === 1 ? 'fence.i' : 'fence' };
    // Prism's halt macro: csrrwi zero, mie, 0 then wfi with interrupts masked.
    if (word === 0x30405073) { cpu.mie = 0; return { next: next }; }
    if (word === 0x10500073 && cpu.mie === 0) return { next: pc, halt: true };
    return { error: 'outside the cache model\'s subset' };
  }

  /* Runs an assembled program through the model in program order.
     segments: assembler output. listing: [{ address, line, source }].
     options: { maxInstructions, env, decode(word, pc) -> text, onAccess } */
  function runProgram(segments, listing, options) {
    options = options || {};
    var env = options.env || createEnv('soc', segments, options);
    var state = options.state ? clone(options.state) : createState();
    var regs = new Array(32).fill(0), unknown = {}, cpu = { mie: 1 };
    var lines = {};
    (listing || []).forEach(function (l) { if (!(hex8(l.address) in lines)) lines[hex8(l.address)] = l; });
    var ops = [], pc = 0, max = options.maxInstructions || 1500, stop = null;
    // ROM must hold the code (the published map installs 4 KiB).
    for (var n = 0; n < max; n++) {
      if (pc & 3) { stop = { reason: 'fault', pc: pc, message: 'PC ' + hx(pc) + ' is not 4-byte aligned: the hart takes an instruction-address-misaligned trap (cause 0). The model stops.' }; break; }
      var src = lines[hex8(pc)] || null;
      var fetch = instructionFetch(state, env, pc);
      state = fetch.state;
      var op = { kind: 'instruction', pc: pc, line: src ? src.line : null, source: src ? src.source.trim() : null, events: fetch.events };
      ops.push(op);
      if (fetch.result.fault) { stop = { reason: 'fault', pc: pc, message: 'Instruction fetch at ' + hx(pc) + ' failed: the model stopped.' }; break; }
      var word = fetch.result.word;
      op.word = word;
      op.text = options.decode ? options.decode(word, pc) : '0x' + hex8(word);
      var x = execute(word, pc, regs, cpu);
      if (x.misaligned !== undefined) {
        op.fault = 'misaligned-target';
        op.events.push({ kind: 'fault', tone: 'fault', title: 'Misaligned ' + x.mnemonic + ' target ' + hx(x.misaligned),
          text: 'The target is not 4-byte aligned and Base has no compressed instructions, so the hart takes an instruction-address-misaligned trap (cause 0) before the jump commits; rd is not written.',
          source: [RTL.datapath + ': misaligned taken target'], state: clone(state), flow: null });
        stop = { reason: 'fault', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + '"' + (op.source || op.text) + '" at ' + hx(pc) + ' targets ' + hx(x.misaligned) + ', which is not 4-byte aligned: instruction-address-misaligned trap (cause 0). The model stops here (trap handlers are not modeled).' };
        break;
      }
      if (x.error) {
        stop = { reason: 'unsupported', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + '"' + (op.source || op.text) + '" at ' + hx(pc) + ' is ' + x.error + ' (' + SUBSET + '). Nothing was executed for it. Run the program on the Base RTL instead.' };
        op.unsupported = true;
        break;
      }
      if (x.memory) {
        var m = x.memory;
        var base = (word >>> 15) & 31;
        if (unknown[base]) { stop = { reason: 'unknown', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + 'the base register holds a device value this view does not model, so the address is unknown.' }; break; }
        if (m.write && unknown[(word >>> 20) & 31]) { stop = { reason: 'unknown', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + 'the store data is a device value this view does not model.' }; break; }
        var acc = dataAccess(state, env, m);
        state = acc.state;
        op.events = op.events.concat(acc.events);
        op.access = acc.result;
        if (acc.result.fault) { stop = { reason: 'fault', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + 'the ' + m.mnemonic + ' at ' + hx(m.address) + ' faulted, so the hart would trap. The model stops here (trap handlers are not modeled).' }; break; }
        if (!m.write && m.rd) {
          if (acc.result.value === null || acc.result.value === undefined) { unknown[m.rd] = true; regs[m.rd] = 0; }
          else { delete unknown[m.rd]; regs[m.rd] = m.signed ? u32(sx(acc.result.value, 8 * m.size)) : acc.result.value; }
        }
        if (options.onAccess) options.onAccess(acc.result);
      } else {
        var rdn = (word >>> 7) & 31, opc = word & 0x7f;
        if (rdn && [0x37, 0x17, 0x6f, 0x67, 0x13, 0x33].indexOf(opc) >= 0) {
          var srcs = [(word >>> 15) & 31];
          if (opc === 0x33) srcs.push((word >>> 20) & 31);
          if (opc === 0x37 || opc === 0x6f || opc === 0x17) srcs = [];
          if (srcs.some(function (s) { return unknown[s]; })) unknown[rdn] = true; else delete unknown[rdn];
        }
        if (opc === 0x67 && unknown[(word >>> 15) & 31]) { stop = { reason: 'unknown', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + 'the jump target is a device value this view does not model.' }; break; }
        if (opc === 0x63 && (unknown[(word >>> 15) & 31] || unknown[(word >>> 20) & 31])) { stop = { reason: 'unknown', pc: pc, line: op.line, message: (op.line ? 'Line ' + op.line + ': ' : '') + 'the branch compares a device value this view does not model.' }; break; }
      }
      if (x.fence) {
        var mt = x.fence === 'fence.i' ? fenceI(state, env) : clean(state, env, 'fence');
        state = mt.state; op.events = op.events.concat(mt.events); op.fence = x.fence;
      }
      if (x.halt) {
        var hc = clean(state, env, 'halt');
        state = hc.state; op.events = op.events.concat(hc.events); op.halt = true;
        stop = { reason: 'halt', pc: pc, line: op.line, message: 'Stopped at halt; the D-cache was cleaned and its lines remain valid.' };
        break;
      }
      pc = x.next;
    }
    if (!stop) stop = { reason: 'limit', pc: pc, message: 'Stopped after ' + max + ' instructions (the model\'s limit). Add halt to end the program.' };
    return { ops: ops, state: state, regs: regs, unknown: Object.keys(unknown).map(Number), stop: stop, env: env };
  }

  /* ---------- recorded RTL runs ---------- */

  function num(h) { return parseInt(h, 16) >>> 0; }
  var LOAD_SIZE = { 0: 1, 1: 2, 2: 4, 4: 1, 5: 2 }, STORE_SIZE = { 0: 1, 1: 2, 2: 4 };

  /* Base tracer rows (qa/core-diagrams/tracer_patch.py) -> ordered operations:
     I-cache refills, completed D accesses, fences and the terminal clean, each
     with the fabric beats the RTL completed for it. */
  function extractRecording(rows) {
    var ops = [], pending = [], flushSeen = false, lastBoundary = -1;
    rows.forEach(function (t, i) {
      if (t.bir && !t.biw) ops.push({ kind: 'ifill', cycle: t.c, address: num(t.bia) });
      if ((t.bdr || t.bdw) && !t.bdwt) pending.push({ dir: t.bdr ? 'read' : 'write', address: num(t.bda), state: t.dst, cycle: t.c });
      if (t.dst === 5) flushSeen = true;
      var enc = num(t.mem[2]);
      if ((t.dre || t.dwe) && t.dhit && t.memfire) {
        var f3 = (enc >>> 12) & 7, write = !!t.dwe;
        ops.push({ kind: 'data', cycle: t.c, pc: num(t.mem[1]), word: enc, write: write, size: write ? STORE_SIZE[f3] : LOAD_SIZE[f3], signed: !write && f3 < 2,
          address: num(t.dad), wdata: num(t.dwd), rdata: num(t.drd), way: t.phit === 2 ? 1 : t.phit === 1 ? 0 : null, beats: pending.splice(0) });
        flushSeen = false; lastBoundary = i;
      } else if (t.mem[0] && (enc & 0x7f) === 0x0f && t.memfire) {
        ops.push({ kind: ((enc >>> 12) & 7) === 1 ? 'fence.i' : 'fence', cycle: t.c, pc: num(t.mem[1]), word: enc, beats: pending.splice(0) });
        flushSeen = false; lastBoundary = i;
      }
    });
    var end = rows.length ? rows[rows.length - 1].c : 0;
    if (flushSeen) ops.push({ kind: 'halt', cycle: end, beats: pending.splice(0) });
    else if (pending.length) ops.push({ kind: 'incomplete', cycle: end, beats: pending.splice(0) });
    return ops;
  }

  function parseCacheDump(csv) {
    var d = [], i = [];
    String(csv || '').split('\n').slice(1).forEach(function (l) {
      var p = l.trim().split(','); if (p.length < 5) return;
      var e = { set: +p[1], way: +p[2], address: num(p[3]), data: num(p[4]) };
      (p[0] === 'D' ? d : i).push(e);
    });
    return { d: d, i: i };
  }

  function beatsOf(events) {
    var out = [];
    events.forEach(function (e) { if (e.beat && e.beat.channel === 'd') out.push({ dir: e.beat.dir, address: e.beat.address }); });
    return out;
  }
  function sameBeats(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].dir !== b[i].dir || a[i].address !== b[i].address) return false;
    return true;
  }
  function beatText(list) { return list.length ? list.map(function (b) { return (b.dir === 'read' ? 'R ' : 'W ') + hx(b.address); }).join(', ') : 'none'; }

  /* Replays a recorded Base RTL run through the model ('bench' environment) and
     checks each operation. extra: { cacheCsv, dumpHex, decode } */
  function replayRecording(rows, segments, extra) {
    extra = extra || {};
    var env = createEnv('bench', segments), state = createState(), ops = [], mismatches = [], notes = [];
    var rec = extractRecording(rows);
    rec.forEach(function (r) {
      var op = { kind: r.kind, cycle: r.cycle, recorded: r, events: [], check: { ok: true, items: [] } };
      function check(ok, what, detail) { op.check.items.push({ ok: ok, what: what, detail: detail }); if (!ok) { op.check.ok = false; mismatches.push({ cycle: r.cycle, what: what, detail: detail }); } }
      var x;
      if (r.kind === 'incomplete') {
        notes.push({ cycle: r.cycle, text: 'The recording ended while a data access was still in progress (' + beatText(r.beats) + '); it is not replayed.' });
        return;
      }
      if (r.kind === 'ifill') {
        var before = state.i.lines[(r.address >>> 3) & 15];
        var already = before.valid && before.tag === (r.address >>> 7);
        x = instructionFetch(state, env, r.address);
        check(!already, 'I-cache miss', already ? 'The model already held line ' + hx(r.address) + '; the RTL refilled it.' : 'The model also misses line ' + hx(r.address) + '.');
        op.pc = r.address;
      } else if (r.kind === 'data') {
        op.pc = r.pc; op.word = r.word; op.text = extra.decode ? extra.decode(r.word, r.pc) : null;
        x = dataAccess(state, env, { write: r.write, size: r.size, address: r.address, data: r.wdata });
        var cls = classify(env, r.address);
        if (cls.benchArtifact) {
          op.artifact = true;
          notes.push({ cycle: r.cycle, text: hx(r.address) + ' (' + cls.label + ') reached the tile bench\'s flat memory at ' + hx(cls.bench) + '. The bench has no peripherals or capacity holes; in a SoC this access would go to the system bus.' });
        }
        var predicted = beatsOf(x.events);
        check(sameBeats(predicted, r.beats), 'fabric beats', 'RTL: ' + beatText(r.beats) + '. Model: ' + beatText(predicted) + '.');
        if (x.result.cacheable) check(x.result.way === r.way, 'way', 'RTL completed in way ' + r.way + '; model used way ' + x.result.way + '.');
        if (!r.write) check(x.result.value === r.rdata, 'load data', 'RTL returned ' + hx(r.rdata) + '; model returned ' + (x.result.value === null ? 'nothing' : hx(x.result.value)) + '.');
      } else {
        op.pc = r.pc;
        x = r.kind === 'fence.i' ? fenceI(state, env) : clean(state, env, r.kind === 'halt' ? 'halt' : 'fence');
        var pb = beatsOf(x.events);
        check(sameBeats(pb, r.beats), 'write-back beats', 'RTL: ' + beatText(r.beats) + '. Model: ' + beatText(pb) + '.');
      }
      state = x.state; op.events = x.events; op.result = x.result;
      ops.push(op);
    });
    var final = { checked: false };
    if (extra.cacheCsv) {
      var dump = parseCacheDump(extra.cacheCsv), problems = [];
      var modelD = [], modelI = [];
      state.d.sets.forEach(function (s, si) { s.ways.forEach(function (w, wi) { if (w.valid) for (var k = 0; k < 4; k++) modelD.push({ set: si, way: wi, address: benchAlias(dLineAddress(w.tag, si) + 4 * k), data: w.data[k] }); }); });
      state.i.lines.forEach(function (l, li) { if (l.valid) for (var k = 0; k < 2; k++) modelI.push({ set: li, way: 0, address: u32(iLineAddress(l.tag, li) + 4 * k), data: l.data[k] }); });
      function cmp(name, a, b) {
        var key = function (e) { return e.set + '/' + e.way + '/' + hex8(e.address) + '/' + hex8(e.data); };
        var A = a.map(key).sort().join(';'), B = b.map(key).sort().join(';');
        if (A !== B) problems.push(name + ' contents differ (RTL ' + a.length / (name === 'D' ? 4 : 2) + ' valid lines, model ' + b.length / (name === 'D' ? 4 : 2) + ').');
      }
      cmp('D', dump.d, modelD); cmp('I', dump.i, modelI);
      final = { checked: true, ok: problems.length === 0, problems: problems, dLines: dump.d.length / 4, iLines: dump.i.length / 2 };
      problems.forEach(function (p) { mismatches.push({ cycle: null, what: 'final caches', detail: p }); });
    }
    if (extra.dumpHex) {
      var words = String(extra.dumpHex).trim().split('\n'), bad = 0, first = null;
      for (var w = 0; w < words.length; w++) {
        var a = w < 0x2000 ? w * 4 : 0x80000000 + (w - 0x2000) * 4;
        var mv = readWord(state, env, u32(a)), rv = num(words[w]);
        if (mv !== rv) { bad++; if (first === null) first = hx(a) + ': RTL ' + hx(rv) + ', model ' + hx(mv); }
      }
      final.memoryChecked = true; final.memoryOk = bad === 0;
      if (bad) mismatches.push({ cycle: null, what: 'final memory', detail: bad + ' words differ; first ' + first });
    }
    return { ops: ops, state: state, mismatches: mismatches, notes: notes, final: final, env: env };
  }

  return {
    RTL: RTL, GEOMETRY: GEOMETRY, FALLBACK_MAP: FALLBACK_MAP, TEACHING_DEVICES: TEACHING_DEVICES, SUBSET: SUBSET,
    hex8: hex8, hx: hx, bits: bits, splitD: splitD, splitI: splitI, dLineAddress: dLineAddress, iLineAddress: iLineAddress,
    createState: createState, createEnv: createEnv, classify: classify, readWord: readWord, benchAlias: benchAlias,
    dataAccess: dataAccess, instructionFetch: instructionFetch, clean: clean, invalidateInstruction: invalidateInstruction, fenceI: fenceI, reset: reset,
    mergeStore: mergeStore, execute: execute, runProgram: runProgram,
    extractRecording: extractRecording, replayRecording: replayRecording, parseCacheDump: parseCacheDump
  };
});
