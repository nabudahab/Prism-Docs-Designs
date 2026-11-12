/* Illustrative coherence model for the "Coherent · WIP" cache view.
 *
 * A teaching model of MESI on one serialized snooping bus. It is not Prism RTL,
 * not a description of a planned Prism protocol and not an interface contract:
 * Prism's caches and cache_fabric_if are non-coherent. Nothing here is shared
 * with cache-model.js.
 *
 * Demo geometry: 16-bit values in four-byte address slots; the upper two bytes
 * are not modeled. Each 16-byte line has 4 slots. There are 4 memory lines
 * (slot addresses 0x00-0x3C) and 2 direct-mapped sets per cache (line L in L % 2).
 * Between 1 and 4 caches.
 *
 * Every operation is a pure function: it takes a state and returns
 * { state, events, value? }. Transactions are atomic and run one at a time; an
 * event is one step of that serialized story, not a cycle, and carries a deep
 * snapshot of the whole system after it ("after").
 *
 * Invariants kept after every event (see check()):
 *   - a line held in M or E has no other valid copy (single writer);
 *   - every S or E copy equals memory;
 *   - the current value of a word is the M copy if one exists, else memory, and
 *     it equals the value of the last store to that word;
 *   - dirty data leaves a cache only as a write-back or a transfer to a cache
 *     that becomes its owner; nothing is dropped silently.
 *
 * Event fields: type, label (short traffic label), text (one-sentence caption),
 * paths (node-name lists such as ['c0', 'bus', 'mem']; node names are 'p<k>'
 * for core k, 'c<k>' for cache k, 'mem' and 'bus'), cache, line, set, data
 * (the line delivered by a data transfer), word (the word a core reads or
 * writes), changed ([{ node, set }] or
 * [{ node: 'mem', line }]) and after.
 */
(function (root) {
  'use strict';

  var WORDS = 4;
  var LINES = 4;
  var SETS = 2;
  var MAX_CACHES = 4;
  var WORD_MASK = 0xffff;

  function hex(value, digits) {
    var text = (value >>> 0).toString(16);
    while (text.length < digits) {
      text = '0' + text;
    }
    return text;
  }
  function addrText(address) {
    return '0x' + hex(address, 2);
  }
  function wordText(value) {
    return '0x' + hex(value, 4);
  }
  function lineOf(address) {
    return (address >> 4) & (LINES - 1);
  }
  function wordOf(address) {
    return (address >> 2) & (WORDS - 1);
  }
  function setOf(line) {
    return line % SETS;
  }
  function lineAddress(line) {
    return line * WORDS * 4;
  }
  /* Initial memory: line L word w holds 0xA0Lw, so a value names where it came from. */
  function initialWord(line, word) {
    return 0xa000 | (line << 4) | word;
  }

  function emptyCache(id) {
    var sets = [];
    for (var s = 0; s < SETS; s++) {
      sets.push({ state: 'I', line: null, data: [0, 0, 0, 0] });
    }
    return { id: id, sets: sets };
  }
  function create(count) {
    var n = count === undefined ? 2 : count;
    if (!(n >= 1 && n <= MAX_CACHES)) {
      throw new RangeError('Cache count must be 1 to ' + MAX_CACHES);
    }
    var mem = [];
    for (var l = 0; l < LINES; l++) {
      mem.push([initialWord(l, 0), initialWord(l, 1), initialWord(l, 2), initialWord(l, 3)]);
    }
    var caches = [];
    for (var k = 0; k < n; k++) {
      caches.push(emptyCache(k));
    }
    return { caches: caches, mem: mem };
  }
  function clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function findCache(state, id) {
    for (var i = 0; i < state.caches.length; i++) {
      if (state.caches[i].id === id) {
        return state.caches[i];
      }
    }
    return null;
  }
  function holders(state, line) {
    var out = [];
    state.caches.forEach(function (cache) {
      var entry = cache.sets[setOf(line)];
      if (entry.state !== 'I' && entry.line === line) {
        out.push({ cache: cache, entry: entry });
      }
    });
    return out;
  }
  function validAddress(address) {
    return typeof address === 'number' && address >= 0 && address < LINES * WORDS * 4 && address % 4 === 0;
  }

  /* Collects events for one operation; each event snapshots the state after it. */
  function recorder(state) {
    var events = [];
    return {
      events: events,
      add: function (event) {
        event.after = clone(state);
        if (!event.paths) {
          event.paths = [];
        }
        if (!event.changed) {
          event.changed = [];
        }
        events.push(event);
        return event;
      }
    };
  }
  function cname(id) {
    return 'Cache ' + id;
  }
  function node(id) {
    return 'c' + id;
  }

  /* Makes room in the requester's set for `line`. A clean copy is dropped; a
     dirty one is written back first, so its data reaches memory. */
  function evictFor(state, cache, line, rec) {
    var set = setOf(line);
    var entry = cache.sets[set];
    if (entry.state === 'I' || entry.line === line) {
      return;
    }
    var old = entry.line;
    if (entry.state === 'M') {
      var data = entry.data.slice();
      state.mem[old] = data.slice();
      entry.state = 'I';
      rec.add({ type: 'writeback', label: 'WB L' + old, cache: cache.id, line: old, set: set, data: data,
        paths: [[node(cache.id), 'bus', 'mem']],
        changed: [{ node: node(cache.id), set: set }, { node: 'mem', line: old }],
        text: cname(cache.id) + ' needs set ' + set + ' for L' + line + ': it writes dirty L' + old + ' back to memory (M → I).' });
      return;
    }
    var was = entry.state;
    entry.state = 'I';
    rec.add({ type: 'drop', label: 'drop L' + old, cache: cache.id, line: old, set: set,
      changed: [{ node: node(cache.id), set: set }],
      text: cname(cache.id) + ' needs set ' + set + ' for L' + line + ': it drops clean L' + old + ' without bus traffic (' + was + ' → I).' });
  }

  function broadcast(state, requester, extraMem) {
    var paths = [];
    state.caches.forEach(function (cache) {
      if (cache.id !== requester) {
        paths.push([node(requester), 'bus', node(cache.id)]);
      }
    });
    if (extraMem) {
      paths.push([node(requester), 'bus', 'mem']);
    }
    return paths;
  }

  function load(input, id, address) {
    var state = clone(input);
    var cache = findCache(state, id);
    if (!cache) {
      throw new RangeError('No cache ' + id);
    }
    if (!validAddress(address)) {
      throw new RangeError('Address must be a word address 0x00-0x3C');
    }
    var line = lineOf(address), word = wordOf(address), set = setOf(line);
    var rec = recorder(state);
    var entry = cache.sets[set];
    rec.add({ type: 'request', label: 'LD ' + addrText(address), cache: id, line: line, set: set, word: word,
      paths: [['p' + id, node(id)]],
      text: 'Core ' + id + ' loads ' + addrText(address) + ' (L' + line + ' word ' + word + ').' });
    if (entry.state !== 'I' && entry.line === line) {
      var hitValue = entry.data[word];
      rec.add({ type: 'respond', label: wordText(hitValue), cache: id, line: line, set: set, word: word, value: hitValue,
        paths: [[node(id), 'p' + id]],
        text: 'Hit in ' + entry.state + ': ' + cname(id) + ' returns ' + wordText(hitValue) + ' with no bus traffic.' });
      return { state: state, events: rec.events, value: hitValue };
    }
    evictFor(state, cache, line, rec);
    var peers = holders(state, line);
    rec.add({ type: 'busrd', label: 'BusRd L' + line, cache: id, line: line, set: set,
      paths: broadcast(state, id, true),
      text: cname(id) + ' misses and broadcasts a read for L' + line + '. Every other cache snoops it.' });
    var owner = null;
    peers.forEach(function (p) {
      if (p.entry.state === 'M') {
        owner = p;
      }
    });
    var data;
    if (owner) {
      // The owner intervenes: one bus transfer carries the line to the
      // requester and to memory, so memory is clean again and both share it.
      data = owner.entry.data.slice();
      owner.entry.state = 'S';
      state.mem[line] = data.slice();
      entry.state = 'S';
      entry.line = line;
      entry.data = data.slice();
      rec.add({ type: 'flush', label: 'data L' + line, cache: id, from: owner.cache.id, line: line, set: set, data: data,
        paths: [[node(owner.cache.id), 'bus', node(id)], [node(owner.cache.id), 'bus', 'mem']],
        changed: [{ node: node(owner.cache.id), set: set }, { node: node(id), set: set }, { node: 'mem', line: line }],
        text: cname(owner.cache.id) + ' holds L' + line + ' modified: it supplies the line to ' + cname(id) + ' and memory, then both hold it in S.' });
    }
    else {
      if (peers.length) {
        var downgraded = [];
        peers.forEach(function (p) {
          if (p.entry.state === 'E') {
            p.entry.state = 'S';
            downgraded.push(p.cache.id);
          }
        });
        rec.add({ type: 'shared', label: 'shared', cache: id, line: line, set: set,
          paths: peers.map(function (p) { return [node(p.cache.id), 'bus', node(id)]; }),
          changed: downgraded.map(function (k) { return { node: node(k), set: set }; }),
          text: peers.map(function (p) { return cname(p.cache.id); }).join(', ') + (peers.length > 1 ? ' hold' : ' holds') + ' a clean copy and signal "shared"' + (downgraded.length ? ' (E → S)' : '') + '.' });
      }
      data = state.mem[line].slice();
      entry.state = peers.length ? 'S' : 'E';
      entry.line = line;
      entry.data = data.slice();
      rec.add({ type: 'memdata', label: 'data L' + line, cache: id, line: line, set: set, data: data,
        paths: [['mem', 'bus', node(id)]],
        changed: [{ node: node(id), set: set }],
        text: 'Memory supplies L' + line + '. ' + cname(id) + ' installs it in ' + entry.state + (peers.length ? ' because another cache shares it.' : ': no other cache has it.') });
    }
    var value = entry.data[word];
    rec.add({ type: 'respond', label: wordText(value), cache: id, line: line, set: set, word: word, value: value,
      paths: [[node(id), 'p' + id]],
      text: cname(id) + ' returns ' + wordText(value) + ' to core ' + id + '.' });
    return { state: state, events: rec.events, value: value };
  }

  function store(input, id, address, value) {
    var state = clone(input);
    var cache = findCache(state, id);
    if (!cache) {
      throw new RangeError('No cache ' + id);
    }
    if (!validAddress(address)) {
      throw new RangeError('Address must be a word address 0x00-0x3C');
    }
    if (!(typeof value === 'number' && value >= 0 && value <= WORD_MASK && Math.floor(value) === value)) {
      throw new RangeError('Value must be 0x0000-0xFFFF');
    }
    var line = lineOf(address), word = wordOf(address), set = setOf(line);
    var rec = recorder(state);
    var entry = cache.sets[set];
    rec.add({ type: 'request', label: 'ST ' + addrText(address) + '=' + hex(value, 4), cache: id, line: line, set: set, word: word,
      paths: [['p' + id, node(id)]],
      text: 'Core ' + id + ' stores ' + wordText(value) + ' to ' + addrText(address) + ' (L' + line + ' word ' + word + ').' });
    var hit = entry.state !== 'I' && entry.line === line;
    var how;
    if (hit && entry.state === 'M') {
      how = 'Hit in M: the line is already owned and dirty, so the store needs no bus traffic.';
    }
    else if (hit && entry.state === 'E') {
      how = 'Hit in E: no other copy exists, so the store upgrades to M silently.';
    }
    else if (hit) {
      // S: ownership first. Every sharer invalidates and acknowledges before the write.
      var sharers = holders(state, line).filter(function (p) { return p.cache.id !== id; });
      rec.add({ type: 'busupgr', label: 'Upgr L' + line, cache: id, line: line, set: set,
        paths: broadcast(state, id, false),
        text: cname(id) + ' holds L' + line + ' shared, so it broadcasts an ownership request (upgrade).' });
      sharers.forEach(function (p) {
        p.entry.state = 'I';
        rec.add({ type: 'ack', label: 'inv ack', cache: id, from: p.cache.id, line: line, set: set,
          paths: [[node(p.cache.id), 'bus', node(id)]],
          changed: [{ node: node(p.cache.id), set: set }],
          text: cname(p.cache.id) + ' invalidates its copy of L' + line + ' (S → I) and acknowledges.' });
      });
      how = sharers.length ? 'All copies are invalid: ' + cname(id) + ' owns L' + line + ' (S → M) and writes.' : 'No other copy answered: ' + cname(id) + ' owns L' + line + ' (S → M) and writes.';
    }
    else {
      evictFor(state, cache, line, rec);
      var peers = holders(state, line);
      rec.add({ type: 'busrdx', label: 'RdX L' + line, cache: id, line: line, set: set,
        paths: broadcast(state, id, true),
        text: cname(id) + ' misses and broadcasts a read-for-ownership for L' + line + '.' });
      var owner = null;
      peers.forEach(function (p) {
        if (p.entry.state === 'M') {
          owner = p;
        }
      });
      if (owner) {
        // Ownership moves with the dirty line; memory stays stale under the new owner.
        var moved = owner.entry.data.slice();
        owner.entry.state = 'I';
        entry.state = 'M';
        entry.line = line;
        entry.data = moved.slice();
        rec.add({ type: 'transfer', label: 'data L' + line, cache: id, from: owner.cache.id, line: line, set: set, data: moved,
          paths: [[node(owner.cache.id), 'bus', node(id)]],
          changed: [{ node: node(owner.cache.id), set: set }, { node: node(id), set: set }],
          text: cname(owner.cache.id) + ' passes its modified L' + line + ' to ' + cname(id) + ' and invalidates (M → I). Memory stays stale.' });
      }
      else {
        peers.forEach(function (p) {
          var was = p.entry.state;
          p.entry.state = 'I';
          rec.add({ type: 'ack', label: 'inv ack', cache: id, from: p.cache.id, line: line, set: set,
            paths: [[node(p.cache.id), 'bus', node(id)]],
            changed: [{ node: node(p.cache.id), set: set }],
            text: cname(p.cache.id) + ' invalidates its copy of L' + line + ' (' + was + ' → I) and acknowledges.' });
        });
        var data = state.mem[line].slice();
        entry.state = 'M';
        entry.line = line;
        entry.data = data.slice();
        rec.add({ type: 'memdata', label: 'data L' + line, cache: id, line: line, set: set, data: data,
          paths: [['mem', 'bus', node(id)]],
          changed: [{ node: node(id), set: set }],
          text: 'Memory supplies L' + line + '. ' + cname(id) + ' now owns it (M) before writing.' });
      }
      how = cname(id) + ' writes word ' + word + ' of its owned line. Memory is now stale for L' + line + '.';
    }
    entry.state = 'M';
    entry.data[word] = value;
    rec.add({ type: 'write', label: wordText(value), cache: id, line: line, set: set, word: word, value: value,
      changed: [{ node: node(id), set: set }],
      text: how });
    return { state: state, events: rec.events };
  }

  function addCache(input) {
    var state = clone(input);
    if (state.caches.length >= MAX_CACHES) {
      throw new RangeError('At most ' + MAX_CACHES + ' caches');
    }
    var id = 0;
    while (findCache(state, id)) {
      id++;
    }
    state.caches.push(emptyCache(id));
    state.caches.sort(function (a, b) { return a.id - b.id; });
    var rec = recorder(state);
    rec.add({ type: 'add', label: 'add', cache: id, changed: [{ node: node(id), set: 0 }, { node: node(id), set: 1 }],
      text: cname(id) + ' joins the bus with every line invalid.' });
    return { state: state, events: rec.events, id: id };
  }

  /* Removes a cache. Its dirty lines are written back first; clean ones need nothing. */
  function removeCache(input, id) {
    var state = clone(input);
    var cache = findCache(state, id);
    if (!cache) {
      throw new RangeError('No cache ' + id);
    }
    if (state.caches.length <= 1) {
      throw new RangeError('Keep at least one cache');
    }
    var rec = recorder(state);
    cache.sets.forEach(function (entry, set) {
      if (entry.state === 'M') {
        var data = entry.data.slice();
        state.mem[entry.line] = data.slice();
        entry.state = 'I';
        rec.add({ type: 'writeback', label: 'WB L' + entry.line, cache: id, line: entry.line, set: set, data: data,
          paths: [[node(id), 'bus', 'mem']],
          changed: [{ node: node(id), set: set }, { node: 'mem', line: entry.line }],
          text: cname(id) + ' is leaving: it writes dirty L' + entry.line + ' back to memory first.' });
      }
    });
    state.caches = state.caches.filter(function (c) { return c.id !== id; });
    rec.add({ type: 'remove', label: 'remove', cache: id,
      text: cname(id) + ' leaves the bus. ' + (rec.events.length ? 'Its dirty data is safe in memory.' : 'It held no dirty data.') });
    return { state: state, events: rec.events };
  }

  /* Explicit reset: discards every cache and restores initial memory. */
  function reset(input, count) {
    var n = count === undefined ? (input ? input.caches.length : 2) : count;
    var state = create(n);
    var rec = recorder(state);
    rec.add({ type: 'reset', label: 'reset',
      text: 'Reset: ' + n + (n === 1 ? ' empty cache' : ' empty caches') + ' and initial memory. Earlier cache contents, dirty or not, are discarded.' });
    return { state: state, events: rec.events };
  }

  /* The value a load would see: the M copy when one exists, else memory. */
  function currentValue(state, address) {
    var line = lineOf(address), word = wordOf(address);
    var owner = holders(state, line).filter(function (p) { return p.entry.state === 'M'; })[0];
    return owner ? owner.entry.data[word] : state.mem[line][word];
  }
  function currentLine(state, line) {
    var owner = holders(state, line).filter(function (p) { return p.entry.state === 'M'; })[0];
    return (owner ? owner.entry.data : state.mem[line]).slice();
  }
  function ownerOf(state, line) {
    var owner = holders(state, line).filter(function (p) { return p.entry.state === 'M'; })[0];
    return owner ? owner.cache.id : null;
  }

  /* Structural and coherence invariants; returns a list of violations. */
  function check(state) {
    var errors = [];
    if (!(state.caches.length >= 1 && state.caches.length <= MAX_CACHES)) {
      errors.push('cache count ' + state.caches.length);
    }
    var seen = {};
    state.caches.forEach(function (cache, i) {
      if (seen[cache.id]) {
        errors.push('duplicate cache ' + cache.id);
      }
      seen[cache.id] = true;
      if (i && state.caches[i - 1].id > cache.id) {
        errors.push('caches out of order');
      }
      cache.sets.forEach(function (entry, set) {
        if ('MESI'.indexOf(entry.state) < 0 || entry.state.length !== 1) {
          errors.push('cache ' + cache.id + ' set ' + set + ' bad state ' + entry.state);
        }
        if (entry.state !== 'I' && setOf(entry.line) !== set) {
          errors.push('cache ' + cache.id + ' holds L' + entry.line + ' in set ' + set);
        }
      });
    });
    for (var line = 0; line < LINES; line++) {
      var hs = holders(state, line);
      var exclusive = hs.filter(function (p) { return p.entry.state === 'M' || p.entry.state === 'E'; });
      if (exclusive.length && hs.length > 1) {
        errors.push('L' + line + ' has ' + exclusive[0].entry.state + ' in cache ' + exclusive[0].cache.id + ' and ' + (hs.length - 1) + ' other copies');
      }
      hs.forEach(function (p) {
        if (p.entry.state !== 'M' && p.entry.data.join() !== state.mem[line].join()) {
          errors.push('L' + line + ' in cache ' + p.cache.id + ' is ' + p.entry.state + ' but differs from memory');
        }
      });
    }
    return errors;
  }

  var api = {
    WORDS: WORDS, LINES: LINES, SETS: SETS, MAX_CACHES: MAX_CACHES, WORD_MASK: WORD_MASK,
    create: create, clone: clone, load: load, store: store, addCache: addCache, removeCache: removeCache, reset: reset,
    check: check, currentValue: currentValue, currentLine: currentLine, ownerOf: ownerOf,
    lineOf: lineOf, wordOf: wordOf, setOf: setOf, lineAddress: lineAddress, initialWord: initialWord,
    addrText: addrText, wordText: wordText, hex: hex
  };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  else {
    root.PrismCoherenceModel = api;
  }
})(typeof window !== 'undefined' ? window : this);
