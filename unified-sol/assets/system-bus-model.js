/* System bus, asynchronous peripherals and interrupt return: a state model of
   one representative teaching composition assembled from Prism RTL.

   The composition is not a shipped SoC configuration. It is the Base core
   tile, the direct fabric, system_bus, ASYNC_PERIPHERALS=1 (mmio_cdc plus the
   two-flop interrupt synchronizers in system.sv), timer, IRQ controller,
   two GPIO banks, UART and SPI. PWM is not installed in this teaching model.
   Other standard devices are omitted from this teaching composition; their
   references do not imply simulated behavior here. Reserved regions, storage sizes and interrupt bits are read from the
   pinned address map (PRISM_REFERENCE.memory); manifest facts below are
   transcribed from source/soc/peripherals/*.toml and checked against a Prism
   checkout by qa/bus-diagrams/check-model.cjs.

   Modelled register effects follow device RTL for 32-bit lw/sw accesses; SPI
   excludes QSPI segments and models only the COMPLETE interrupt bit.
   Time is a count of peripheral_clk edges that advances only where this model
   counts it (CDC request edges, device waits, input events and the time
   buttons). CPU-domain steps are ordered but carry no cycle numbers: the two
   clocks are unrelated.

   run(state, action) never mutates its input. It returns steps, each with a
   full snapshot of the state after that step, so a view can step backwards.
   Works in browsers (window.PrismSystemBusModel) and in Node (module.exports). */
(function (root) {
  'use strict';

  var PER = 'source/soc/peripherals/rtl/';
  var BUS = 'source/soc/buses/rtl/';

  // Modelled windows, manifest alignment and RTL top. SPI models its 28-byte
  // classic subset; the canonical component has a 60-byte window with segments.
  var COMPONENTS = {
    timer: { top: 'timer', bytes: 16, align: 8, irq: 'timer', software: 'prism_timer_registers_v1', rtl: PER + 'timer.sv' },
    irq: { top: 'irq_controller', bytes: 384, align: 512, irq: 'controller', software: 'prism_irq_registers_v1', rtl: PER + 'irq_controller.sv' },
    gpio: { top: 'gpio', bytes: 40, align: 64, irq: 'external', software: 'prism_gpio_registers_v1', rtl: PER + 'gpio.sv' },
    uart: { top: 'uart', bytes: 24, align: 32, irq: 'external', software: 'prism_uart_registers_v1', rtl: PER + 'uart.sv' },
    spi: { top: 'spi', bytes: 28, sourceBytes: 60, align: 64, irq: 'external', software: 'prism_spi_registers_v1', rtl: PER + 'spi.sv' }
  };

  // The representative composition, in its devices[] order.
  var INSTANCES = [
    { name: 'timer0', component: 'timer', region: 'timer', irq: 'timer' },
    { name: 'irq0', component: 'irq', region: 'irq', irq: null },
    { name: 'gpio_a', component: 'gpio', region: 'gpio_a', irq: 'gpio_a', bank: 'a', pins: 'gpio_in, gpio_out, gpio_oe' },
    { name: 'uart0', component: 'uart', region: 'uart', irq: 'uart', pins: 'uart_rx, uart_tx' },
    { name: 'spi0', component: 'spi', region: 'spi', irq: 'spi', pins: 'spi_miso, spi_mosi, spi_sck, spi_cs_n' },
    { name: 'gpio_b', component: 'gpio', region: 'gpio_b', irq: 'gpio_b', bank: 'b', pins: 'gpio_b_in, gpio_b_out, gpio_b_oe' }
  ];

  // Base D-cache geometry (source/core_tiles/base/rtl/caches/dcache.sv):
  // 8 sets x 2 ways x 16-byte lines, write-back, write-allocate, one LRU bit.
  var DSETS = 8;

  // Machine trap causes (source/contracts/packages/trap_causes_pkg.vh).
  var CAUSE = {
    external: 0x8000000B, timer: 0x80000007,
    loadMisaligned: 4, storeMisaligned: 6, loadFault: 5, storeFault: 7
  };
  var CAUSE_NAME = {};
  CAUSE_NAME[CAUSE.external] = 'machine external interrupt';
  CAUSE_NAME[CAUSE.timer] = 'machine timer interrupt';
  CAUSE_NAME[CAUSE.loadMisaligned] = 'load address misaligned';
  CAUSE_NAME[CAUSE.storeMisaligned] = 'store address misaligned';
  CAUSE_NAME[CAUSE.loadFault] = 'load access fault';
  CAUSE_NAME[CAUSE.storeFault] = 'store access fault';

  var MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);
  var PRESET_TIMER_GAP = 1000000; // far beyond a UART or SPI frame, so only the timer click reaches it
  var B32 = BigInt(32), BFF = BigInt(0xFFFFFFFF);

  /* ---------- formatting ---------- */
  function hex32(n) {
    var v = (n >>> 0).toString(16).toUpperCase();
    while (v.length < 8) v = '0' + v;
    return '0x' + v.slice(0, 4) + '_' + v.slice(4);
  }
  function hex64(b) {
    var v = BigInt.asUintN(64, b).toString(16).toUpperCase();
    while (v.length < 16) v = '0' + v;
    return '0x' + v.slice(0, 4) + '_' + v.slice(4, 8) + '_' + v.slice(8, 12) + '_' + v.slice(12);
  }
  function hex8(n) { var v = (n & 0xFF).toString(16).toUpperCase(); return '0x' + (v.length < 2 ? '0' + v : v); }
  function hexShort(n) { return '0x' + (n >>> 0).toString(16).toUpperCase(); }
  function size(bytes) {
    if (bytes >= 1048576 && bytes % 1048576 === 0) return (bytes / 1048576) + ' MiB';
    if (bytes >= 1024 && bytes % 1024 === 0) return (bytes / 1024) + ' KiB';
    return bytes + ' B';
  }
  function bits(n, width) { var s = (n >>> 0).toString(2); while (s.length < width) s = '0' + s; return s; }
  function maskText(mask) { return hex8(mask) + ' (' + (mask & 0xF0 ? 'upper word, bytes 4–7' : 'lower word, bytes 0–3') + ')'; }

  /* ---------- deep copy (handles BigInt) ---------- */
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = clone(v[k]);
    return out;
  }

  /* ---------- layout from the pinned address map ---------- */
  function create(memory) {
    if (!memory || !memory.regions || !memory.storage || !memory.aperture) throw new Error('Address map data is missing');
    function region(id) { return memory.regions.filter(function (r) { return r.id === id; })[0] || null; }
    function storage(name) { return memory.storage.filter(function (s) { return s.name === name; })[0] || null; }
    var ram = storage('ram'), rom = storage('rom');
    if (!ram || !rom) throw new Error('Address map has no RAM or ROM storage');
    var bitOf = {};
    (memory.interrupts || []).forEach(function (i) { bitOf[i.name] = i.bit; });
    var devices = INSTANCES.map(function (inst, index) {
      var r = region(inst.region);
      if (!r) throw new Error('Address map has no region ' + inst.region);
      var comp = COMPONENTS[inst.component];
      var bit = inst.irq && inst.irq !== 'timer' ? bitOf[inst.irq] : null;
      if (inst.irq && inst.irq !== 'timer' && typeof bit !== 'number') throw new Error('Address map has no interrupt ' + inst.irq);
      return { name: inst.name, index: index, component: inst.component, comp: comp, region: r, base: r.base >>> 0, bytes: comp.bytes,
        irq: inst.irq, bit: bit, id: bit === null ? null : bit + 1, bank: inst.bank || null, pins: inst.pins || null };
    });
    var sources = devices.filter(function (d) { return d.bit !== null; }).sort(function (a, b) { return a.bit - b.bit; });
    var present = sources.reduce(function (m, d) { return (m | (1 << d.bit)) >>> 0; }, 0);
    var byName = {};
    devices.forEach(function (d) { byName[d.name] = d; });
    var installedRegions = {};
    devices.forEach(function (d) { installedRegions[d.region.id] = d; });
    var L = {
      ram: { base: ram.base >>> 0, bytes: ram.bytes, reserved: ram.reserved_bytes, last: ram.last >>> 0 },
      rom: { base: rom.base >>> 0, bytes: rom.bytes, reserved: rom.reserved_bytes, last: rom.last >>> 0 },
      mmio: { base: memory.aperture.base >>> 0, bytes: memory.aperture.bytes, last: (memory.aperture.base + memory.aperture.bytes - 1) >>> 0 },
      regions: memory.regions.slice().sort(function (a, b) { return a.base - b.base; }),
      devices: devices, byName: byName, sources: sources, present: present, installedRegions: installedRegions
    };
    return makeSoc(L);
  }

  function makeSoc(L) {
    var gpioOf = { a: L.byName.gpio_a, b: L.byName.gpio_b };

    /* ---------- reset state ---------- */
    function initial() {
      var prio = []; for (var i = 0; i < 32; i++) prio.push(1);
      function gpio() { return { pins: 0, meta: 0, sync: 0, prev: 0, out: 0, oe: 0, ie: 0, pend: 0, rise: 0, fall: 0 }; }
      var sets = [];
      for (var s = 0; s < DSETS; s++) sets.push({ lru: 0, ways: [0, 1].map(function () { return { valid: false, dirty: false, tag: 0, data: [0, 0, 0, 0] }; }) });
      return {
        time: 0,
        ram: {},
        dcache: sets,
        cdc: { state: 'IDLE', req: 0, ack: 0, reqSync: 0, ackSync: 0, active: 0 },
        gpio: { a: gpio(), b: gpio() },
        uart: { divider: 868, ie: 0, txBusy: false, txCount: 0, txBits: 0, txByte: 0, txDone: false, rxByte: 0, rxValid: false, overrun: false, frameError: false, sent: [] },
        spi: { divider: 2, busy: false, counter: 0, sck: 0, bitsLeft: 0, frame: 0, frameBitsActive: 8, received: 0, rxValid: false, csHold: false, ie: false, frameBits: 8, miso: 0xA5 },
        timer: { mtime: BigInt(0), mtimecmp: BigInt(0) },
        irq: { enable: 0, inService: 0, prio: prio },
        cpu: { mstatusMIE: false, mstatusMPIE: false, MEIE: false, MTIE: false, extSync: [0, 0], timSync: [0, 0], MEIP: false, MTIP: false,
          context: 'main', mcause: null, mepc: null, mtval: null, last: null, claimed: 0 }
      };
    }
    // Reset values with every level already through its synchronizer: after
    // reset MTIME = MTIMECMP = 0, so timer_irq is high and mip.MTIP reads 1.
    // Teaching preset: the state firmware setup would leave. Each enable below
    // is a real register value; the page shows them and can return to reset.
    function preset() {
      var st = initial();
      ['a', 'b'].forEach(function (k) { var g = st.gpio[k]; g.rise = 1; g.fall = 1; g.ie = 1; });
      st.uart.ie = 1;
      st.spi.ie = true;
      st.irq.enable = L.present;
      st.timer.mtimecmp = BigInt(PRESET_TIMER_GAP);
      st.cpu.MEIE = true; st.cpu.MTIE = true; st.cpu.mstatusMIE = true;
      var lv = levels(st);
      st.cpu.extSync = lv.ext ? [1, 1] : [0, 0]; st.cpu.MEIP = lv.ext;
      st.cpu.timSync = lv.tim ? [1, 1] : [0, 0]; st.cpu.MTIP = lv.tim;
      return st;
    }
    function settledInitial() {
      var st = initial(), lv = levels(st);
      st.cpu.extSync = lv.ext ? [1, 1] : [0, 0]; st.cpu.MEIP = lv.ext;
      st.cpu.timSync = lv.tim ? [1, 1] : [0, 0]; st.cpu.MTIP = lv.tim;
      return st;
    }

    /* ---------- combinational levels (peripheral_clk domain) ---------- */
    function gpioIrq(g) { return (g.pend & g.ie & 0xFF) !== 0; }
    function uartPending(u) { return (u.frameError ? 8 : 0) | (u.overrun ? 4 : 0) | (u.txDone ? 2 : 0) | (u.rxValid ? 1 : 0); }
    function uartIrq(u) { return (uartPending(u) & u.ie) !== 0; }
    function spiIrq(p) { return p.ie && p.rxValid; }
    function timerIrq(st) { return st.timer.mtime >= st.timer.mtimecmp; }
    function deviceIrq(st, d) {
      if (d.component === 'gpio') return gpioIrq(st.gpio[d.bank]);
      if (d.component === 'uart') return uartIrq(st.uart);
      if (d.component === 'spi') return spiIrq(st.spi);
      if (d.component === 'timer') return timerIrq(st);
      return false;
    }
    // irq_sources vector: each routed device level at its address-map bit.
    function sourceLevels(st) {
      var v = 0;
      L.sources.forEach(function (d) { if (deviceIrq(st, d)) v |= 1 << d.bit; });
      return v >>> 0;
    }
    function irqView(st) {
      var pending = (sourceLevels(st) & L.present) >>> 0;
      var active = (pending & st.irq.enable & ~st.irq.inService) >>> 0;
      // Descending iteration lets lower IDs win priority ties (irq_controller.sv).
      var winner = 0, best = 0;
      for (var s = 31; s >= 0; s--) {
        if ((active >>> s) & 1 && (winner === 0 || st.irq.prio[s] >= best)) { winner = s + 1; best = st.irq.prio[s]; }
      }
      return { pending: pending, active: active, winner: winner, irq: active !== 0 };
    }
    function levels(st) { return { ext: irqView(st).irq, tim: timerIrq(st) }; }
    function eligible(st) {
      var c = st.cpu;
      return c.mstatusMIE && ((c.MEIE && c.MEIP) || (c.MTIE && c.MTIP));
    }

    /* ---------- address classification ---------- */
    function regionAt(a) {
      for (var i = 0; i < L.regions.length; i++) {
        var r = L.regions[i];
        if (a >= r.base && a <= (r.last >>> 0)) return r;
      }
      return null;
    }
    function registerAt(dev, a) {
      var off = a - dev.base, regs = dev.region.registers || [];
      for (var i = 0; i < regs.length; i++) if (regs[i].offset === off) return regs[i];
      return null;
    }
    function beatOf(ea, op, value) {
      var beat = (ea & ~7) >>> 0, upper = (ea & 4) !== 0, mask = upper ? 0xF0 : 0x0F;
      var data = op === 'sw' ? (BigInt(value >>> 0) << BigInt(8 * (ea & 7))) & MASK64 : BigInt(0);
      return { address: beat, mask: mask, upper: upper, data: data, write: op === 'sw', decode: (beat + (upper ? 4 : 0)) >>> 0 };
    }
    function classify(ea) {
      ea = ea >>> 0;
      var out = { address: ea, cacheable: false };
      if (((ea - L.ram.base) >>> 0) <= ((L.ram.last - L.ram.base) >>> 0)) {
        out.cacheable = true;
        out.target = ((ea - L.ram.base) >>> 0) < L.ram.bytes ? 'ram' : 'ram-hole';
        return out;
      }
      if (((ea - L.rom.base) >>> 0) <= ((L.rom.last - L.rom.base) >>> 0)) {
        out.target = ((ea - L.rom.base) >>> 0) < L.rom.bytes ? 'rom' : 'rom-hole';
        return out;
      }
      if (ea >= L.mmio.base && ea <= L.mmio.last) {
        out.target = 'mmio';
        var decode = ((ea & ~7) + ((ea & 4) ? 4 : 0)) >>> 0;
        out.region = regionAt(ea);
        out.device = null;
        L.devices.forEach(function (d) { if (decode >= d.base && decode < d.base + d.bytes) out.device = d; });
        if (out.device) out.register = registerAt(out.device, (ea & ~3) >>> 0);
        return out;
      }
      out.target = 'unmapped';
      return out;
    }
    function describe(ea) {
      var c = classify(ea);
      if (c.target === 'ram') return 'RAM, installed (cacheable)';
      if (c.target === 'ram-hole') return 'RAM reservation beyond the ' + size(L.ram.bytes) + ' installed: no storage';
      if (c.target === 'rom') return 'Boot ROM, installed';
      if (c.target === 'rom-hole') return 'Boot ROM reservation beyond the ' + size(L.rom.bytes) + ' installed: no storage';
      if (c.target === 'unmapped') return 'Outside RAM, ROM and the peripheral aperture';
      if (c.device) return c.device.name + (c.register ? ' ' + c.register.name.toUpperCase() : ' (no register at this offset)');
      if (c.region && L.installedRegions[c.region.id]) return c.region.id + ' reservation, outside ' + L.installedRegions[c.region.id].name + '’s ' + L.installedRegions[c.region.id].bytes + '-byte window';
      if (c.region) return c.region.id + ' reservation: not simulated in this composition';
      return 'Peripheral aperture, between reservations';
    }

    /* ---------- device register logic (mirrors each RTL file) ---------- */
    function lanesOf(beat) {
      var upper = (beat.mask & 0xF0) !== 0;
      var lanes = upper ? beat.mask >> 4 : beat.mask & 0xF;
      return { upper: upper, lanes: lanes, valid: lanes !== 0 && !(upper && (beat.mask & 0xF)),
        word: Number(upper ? (beat.data >> B32) & BFF : beat.data & BFF) >>> 0 };
    }
    function place(upper, word) { return upper ? (BigInt(word >>> 0) << B32) : BigInt(word >>> 0); }

    // Each returns { error, wait (peripheral clocks with ready low), read (BigInt), effects: [text], apply(st) }.
    var DEVICE = {
      gpio: function (st, d, beat) {
        var g = st.gpio[d.bank], x = lanesOf(beat);
        var index = (((beat.address >>> 3) & 7) << 1) | (x.upper ? 1 : 0);
        var selected = (beat.address >>> 6) === (d.base >>> 6) && (beat.address & 7) === 0 && index <= 9;
        var error = !selected || !x.valid || (beat.write && index === 0);
        var names = ['INPUT', 'OUTPUT', 'OUTPUT_ENABLE', 'SET', 'CLEAR', 'TOGGLE', 'IRQ_ENABLE', 'IRQ_PENDING', 'IRQ_RISE', 'IRQ_FALL'];
        var r = { error: error, wait: 0, effects: [], reg: names[index] || null };
        var value = [g.sync, g.out, g.oe, g.out, g.out, g.out, g.ie, g.pend, g.rise, g.fall][index];
        r.read = error ? BigInt(0) : place(x.upper, value === undefined ? g.out : value);
        if (error) { r.effects.push(beat.write && index === 0 ? 'INPUT is read-only: the write completes with error and changes nothing.' : 'No register: error, no effect.'); return r; }
        if (!beat.write) { r.effects.push(names[index] + ' reads ' + hex8(value) + '.'); return r; }
        var w = x.word & 0xFF;
        if (!(x.lanes & 1)) { r.effects.push('Byte 0 is not enabled: no register changes.'); return r; }
        switch (index) {
          case 1: g.out = w; r.effects.push('OUTPUT ← ' + hex8(w) + '; ' + d.name + ' drives gpio_out = ' + hex8(w) + '.'); break;
          case 2: g.oe = w; r.effects.push('OUTPUT_ENABLE ← ' + hex8(w) + ' (gpio_oe).'); break;
          case 3: g.out = (g.out | w) & 0xFF; r.effects.push('SET: OUTPUT becomes ' + hex8(g.out) + '.'); break;
          case 4: g.out = g.out & ~w & 0xFF; r.effects.push('CLEAR: OUTPUT becomes ' + hex8(g.out) + '.'); break;
          case 5: g.out = (g.out ^ w) & 0xFF; r.effects.push('TOGGLE: OUTPUT becomes ' + hex8(g.out) + '.'); break;
          case 6: g.ie = w; r.effects.push('IRQ_ENABLE ← ' + hex8(w) + '. It masks the irq output only; pending edges stay recorded.'); break;
          case 7: g.pend = g.pend & ~w & 0xFF; r.effects.push('IRQ_PENDING write-one-to-clear: pending becomes ' + hex8(g.pend) + '.'); break;
          case 8: g.rise = w; r.effects.push('IRQ_RISE ← ' + hex8(w) + ' (applies to edges after this one).'); break;
          case 9: g.fall = w; r.effects.push('IRQ_FALL ← ' + hex8(w) + '.'); break;
        }
        if (index >= 1 && index <= 5) r.effects.push('Outputs never feed gpio_in or the edge detector, so this store raises no interrupt.');
        return r;
      },
      uart: function (st, d, beat) {
        var u = st.uart, x = lanesOf(beat);
        var index = (((beat.address >>> 3) & 3) << 1) | (x.upper ? 1 : 0);
        var legal = x.valid && (beat.address & 7) === 0 && index < 6;
        var names = ['TX', 'RX', 'STATUS', 'DIVIDER', 'IRQ_ENABLE', 'IRQ_PENDING'];
        var r = { error: !legal, wait: 0, effects: [], reg: names[index] || null, read: BigInt(0) };
        if (!legal) { r.effects.push('Illegal access: error, no effect.'); return r; }
        if (beat.write && index === 0 && (x.lanes & 1) && u.txBusy) {
          r.wait = uartLeft(u);
          r.effects.push('A frame is still being sent, so ready stays low for ' + r.wait + ' peripheral clocks until its stop bit ends (at the current DIVIDER).');
        }
        r.apply = function (s) {
          var v = s.uart, read = 0;
          if (index === 1) read = v.rxByte;
          else if (index === 2) read = (v.frameError ? 8 : 0) | (v.overrun ? 4 : 0) | (v.rxValid ? 2 : 0) | (v.txBusy ? 0 : 1);
          else if (index === 3) read = v.divider >>> 0;
          else if (index === 4) read = v.ie;
          else if (index === 5) read = uartPending(v);
          r.read = place(x.upper, read);
          if (!beat.write) {
            r.effects.push(names[index] + ' reads ' + hexShort(read) + '.');
            if (index === 1 && (x.lanes & 1)) {
              if (v.rxValid) r.effects.push('Reading RX consumes the byte: RX_VALID ← 0, which also lowers IRQ_PENDING.RX_VALID.');
              v.rxValid = false;
            }
            return;
          }
          var w = x.word;
          switch (index) {
            case 0:
              if (x.lanes & 1) {
                // tx_count <= divider - 1 on this completion edge; the edge tick that follows takes it from divider.
                v.txByte = w & 0xFF; v.txBusy = true; v.txDone = false; v.txBits = 10; v.txCount = v.divider;
                r.effects.push('TX ← ' + hex8(w) + ': start bit, 8 data bits and stop bit go out on uart_tx, about ' + (10 * v.divider) + ' peripheral clocks (10 × DIVIDER). IRQ_PENDING.TX_COMPLETE ← 0.');
              }
              break;
            case 1: r.effects.push('RX is read-only: the write is ignored (no error).'); break;
            case 2:
              if (x.lanes & 1) {
                if (w & 4) v.overrun = false;
                if (w & 8) v.frameError = false;
                r.effects.push('STATUS write-one-to-clear: OVERRUN ' + (v.overrun ? 1 : 0) + ', FRAME_ERROR ' + (v.frameError ? 1 : 0) + '.');
              }
              break;
            case 3: {
              var upd = v.divider >>> 0;
              for (var b = 0; b < 4; b++) if ((x.lanes >> b) & 1) upd = ((upd & ~(0xFF << (8 * b))) | (w & (0xFF << (8 * b)))) >>> 0;
              var nd = upd < 8 ? 8 : upd;
              // Stored at the completion edge; a bit reload on that same edge still uses the old value.
              r.late = function (s2) { s2.uart.divider = nd; };
              r.effects.push('DIVIDER ← ' + nd + ' peripheral clocks per bit' + (upd < 8 ? ' (values below 8 are stored as 8)' : '') + '. A frame in progress keeps its current bit countdown; later bits reload from the new value.');
              break;
            }
            case 4: if (x.lanes & 1) { v.ie = w & 0xF; r.effects.push('IRQ_ENABLE ← ' + bits(v.ie, 4) + ' (FRAME_ERROR, OVERRUN, TX_COMPLETE, RX_VALID).'); } break;
            case 5:
              if (x.lanes & 1) {
                if (w & 2) v.txDone = false;
                if (w & 4) v.overrun = false;
                if (w & 8) v.frameError = false;
                r.effects.push('IRQ_PENDING write-one-to-clear: now ' + bits(uartPending(v), 4) + '.' + (w & 1 ? ' Bit 0 (RX_VALID) is not cleared by writing: read RX to clear it.' : ''));
              }
              break;
          }
        };
        return r;
      },
      spi: function (st, d, beat) {
        var x = lanesOf(beat);
        var index = (((beat.address >>> 3) & 3) << 1) | (x.upper ? 1 : 0);
        var valid = x.valid && (beat.address & 7) === 0 && index < 7;
        var names = ['DATA', 'STATUS', 'DIVIDER', 'CS_HOLD', 'IRQ_ENABLE', 'IRQ_PENDING', 'CONFIG'];
        var r = { error: !valid, wait: 0, effects: [], reg: names[index] || null, read: BigInt(0) };
        if (!valid) { r.effects.push('Illegal access: error, no effect.'); return r; }
        if (index === 0 && st.spi.busy) {
          r.wait = spiLeft(st.spi);
          r.effects.push('A frame is in progress, so DATA holds ready low for ' + r.wait + ' peripheral clocks until it finishes (at the current DIVIDER).');
        }
        r.apply = function (s) {
          var p = s.spi, read = 0;
          read = [p.received, (p.rxValid ? 2 : 0) | (p.busy ? 1 : 0), p.divider >>> 0, p.csHold ? 1 : 0, p.ie ? 1 : 0, p.rxValid ? 1 : 0, p.frameBits][index];
          r.read = place(x.upper, read);
          if (!beat.write) {
            r.effects.push(names[index] + ' reads ' + hexShort(read) + '.');
            if (index === 0 && (x.lanes & 1)) {
              if (p.rxValid) r.effects.push('Reading DATA byte 0 consumes the completion: RX_VALID (= IRQ_PENDING.COMPLETE) ← 0.');
              p.rxValid = false;
            }
            return;
          }
          var w = x.word;
          switch (index) {
            case 0:
              if (x.lanes & 1) {
                var payload = ((x.lanes & 2 ? (w >>> 8) & 3 : 0) << 8) | (w & 0xFF);
                p.frame = payload; p.frameBitsActive = p.frameBits; p.busy = true; p.rxValid = false;
                // counter <= divider - 1 on this completion edge (the following edge tick takes it from divider).
                p.bitsLeft = p.frameBits; p.sck = 0; p.counter = p.divider;
                r.effects.push('DATA ← ' + hexShort(payload) + ': a ' + p.frameBits + '-bit mode-0 frame starts, MSB first, ' + (2 * p.frameBits * p.divider) + ' peripheral clocks at the current DIVIDER (2 × bits × DIVIDER). RX_VALID ← 0; cs_n goes low.');
              }
              break;
            case 1: r.effects.push('STATUS is read-only: the write is ignored (no error).'); break;
            case 2: {
              var upd = p.divider >>> 0;
              for (var b = 0; b < 4; b++) if ((x.lanes >> b) & 1) upd = ((upd & ~(0xFF << (8 * b))) | (w & (0xFF << (8 * b)))) >>> 0;
              var nd2 = upd === 0 ? 1 : upd;
              r.late = function (s2) { s2.spi.divider = nd2; };
              r.effects.push('DIVIDER ← ' + nd2 + ' peripheral clocks per SCK half-period. A frame in progress keeps its current countdown; later half-periods reload from the new value.');
              break;
            }
            case 3: if (x.lanes & 1) { p.csHold = !!(w & 1); r.effects.push('CS_HOLD.ENABLE ← ' + (w & 1) + '.'); } break;
            case 4: if (x.lanes & 1) { p.ie = !!(w & 1); r.effects.push('IRQ_ENABLE.COMPLETE ← ' + (w & 1) + '.'); } break;
            case 5: if ((x.lanes & 1) && (w & 1)) { p.rxValid = false; r.effects.push('IRQ_PENDING write-one-to-clear: COMPLETE (RX_VALID) ← 0.'); } else r.effects.push('No bit 0 written: nothing changes.'); break;
            case 6:
              if ((x.lanes & 1) && [8, 9, 10].indexOf(w & 0xF) >= 0) { p.frameBits = w & 0xF; r.effects.push('CONFIG.FRAME_BITS ← ' + p.frameBits + ' for the next frame.'); }
              else r.effects.push('Unsupported frame length: CONFIG keeps ' + p.frameBits + '.');
              break;
          }
        };
        return r;
      },
      timer: function (st, d, beat) {
        var selT = beat.address === d.base, selC = beat.address === ((d.base + 8) >>> 0);
        var error = (beat.address & 7) !== 0 || !(selT || selC) || beat.mask === 0;
        var r = { error: error, wait: 0, effects: [], reg: selT ? 'MTIME' : selC ? 'MTIMECMP' : null, read: BigInt(0) };
        if (error) { r.effects.push('Not MTIME or MTIMECMP: error, no write.'); return r; }
        r.apply = function (s) {
          var t = s.timer, cur = selT ? t.mtime : t.mtimecmp;
          r.read = cur;
          if (!beat.write) { r.effects.push((selT ? 'MTIME' : 'MTIMECMP') + ' drives the whole beat: ' + hex64(cur) + '. The core keeps the ' + (beat.mask & 0xF0 ? 'upper' : 'lower') + ' word.'); return; }
          var next = cur;
          for (var lane = 0; lane < 8; lane++) {
            if ((beat.mask >> lane) & 1) {
              var sh = BigInt(8 * lane), m = BigInt(0xFF) << sh;
              next = (next & ~m & MASK64) | (beat.data & m);
            }
          }
          if (selT) { t.mtime = next; r.effects.push('MTIME bytes ' + (beat.mask & 0xF0 ? '4–7' : '0–3') + ' replaced: ' + hex64(next) + '. This edge does not increment it.'); }
          else { t.mtimecmp = next; r.effects.push('MTIMECMP becomes ' + hex64(next) + '. timer_irq is the level MTIME ≥ MTIMECMP, so it changes as soon as this value lands.'); }
          r.skipTick = selT;
        };
        return r;
      },
      irq: function (st, d, beat) {
        var x = lanesOf(beat);
        var index = (((beat.address >>> 3) & 63) << 1) | (x.upper ? 1 : 0);
        var prioAccess = index >= 64 && index < 96;
        var selected = (beat.address >>> 9) === (d.base >>> 9) && (beat.address & 7) === 0 && (index < 7 || prioAccess);
        var v = irqView(st);
        var w = x.word;
        var completeBad = index === 6 && (x.lanes !== 0xF || (beat.write && (w === 0 || w > 32 || !((st.irq.inService >>> ((w - 1) & 31)) & 1))));
        var error = !selected || !x.valid || (beat.write && [0, 2, 5].indexOf(index) >= 0) || completeBad;
        var names = ['PENDING', 'ENABLE', 'ACTIVE', 'ENABLE_SET', 'ENABLE_CLEAR', 'PRESENT', 'CURRENT_IRQ'];
        var r = { error: error, wait: 0, effects: [], reg: prioAccess ? 'PRIORITY_' + (index - 64) : names[index] || null, read: BigInt(0) };
        if (error) {
          if (!selected) r.effects.push('No register at this offset (the window holds 0x00–0x1B and 0x100–0x17F): error, no effect.');
          else if (beat.write && [0, 2, 5].indexOf(index) >= 0) r.effects.push(names[index] + ' is read-only: error, no effect.');
          else if (completeBad) r.effects.push('CURRENT_IRQ completion needs a full word holding an ID that is in service. ID ' + w + ' is not: error, nothing changes.');
          else r.effects.push('Illegal lane mask: error, no effect.');
          return r;
        }
        r.apply = function (s) {
          var q = s.irq, read;
          if (index === 0) read = v.pending;
          else if (index === 2) read = v.active;
          else if (index === 5) read = L.present;
          else if (index === 6) read = v.winner;
          else read = prioAccess ? q.prio[index - 64] : q.enable;
          r.read = place(x.upper, read);
          if (!beat.write) {
            if (index === 6) {
              if (v.winner) {
                q.inService = (q.inService | (1 << (v.winner - 1))) >>> 0;
                r.effects.push('CURRENT_IRQ returns ID ' + v.winner + ' (source ' + (v.winner - 1) + ', ' + srcName(v.winner - 1) + ') and marks it in service. ACTIVE now excludes it.');
                r.effects.push('The claim does not touch the device: its irq level stays as it is until software clears the cause there.');
                r.claimed = v.winner;
              } else { r.claimed = 0; r.effects.push('CURRENT_IRQ returns 0: no ACTIVE source. Nothing is claimed.'); }
            } else r.effects.push((prioAccess ? 'PRIORITY_' + (index - 64) : names[index]) + ' reads ' + hexShort(read) + '.');
            return;
          }
          switch (index) {
            case 1: q.enable = (w & L.present) >>> 0; r.effects.push('ENABLE ← ' + bits(q.enable, 4) + ' (installed sources only).'); break;
            case 3: q.enable = (q.enable | (w & L.present)) >>> 0; r.effects.push('ENABLE_SET: ENABLE becomes ' + bits(q.enable, 4) + '.'); break;
            case 4: q.enable = (q.enable & ~w) >>> 0; r.effects.push('ENABLE_CLEAR: ENABLE becomes ' + bits(q.enable, 4) + '.'); break;
            case 6:
              q.inService = (q.inService & ~(1 << ((w - 1) & 31))) >>> 0;
              r.effects.push('Completion: ID ' + w + ' leaves service. Only the in-service bit clears; if ' + srcName(w - 1) + ' still drives its level, the source is ACTIVE again.');
              r.completed = w;
              break;
            default:
              if (prioAccess && (x.lanes & 1)) { q.prio[index - 64] = w & 0xF; r.effects.push('PRIORITY_' + (index - 64) + ' ← ' + (w & 0xF) + '. Higher wins; ties go to the lower source.'); }
          }
        };
        return r;
      }
    };
    function srcName(bit) {
      for (var i = 0; i < L.sources.length; i++) if (L.sources[i].bit === bit) return L.sources[i].name;
      return 'source ' + bit;
    }

    /* ---------- time ---------- */
    // Advance peripheral time by n clocks, firing device events in order.
    // Edges until the frame ends, reloading later bits/half-periods from the
    // current DIVIDER exactly as uart.sv and spi.sv do.
    function uartLeft(u) { return u.txBusy ? u.txCount + 1 + (u.txBits - 1) * u.divider : 0; }
    function spiLeft(p) { return p.busy ? p.counter + 1 + ((p.sck ? 2 * p.bitsLeft - 1 : 2 * p.bitsLeft) - 1) * p.divider : 0; }
    function uartTick(u, n) {
      while (n > 0 && u.txBusy) {
        if (n <= u.txCount) { u.txCount -= n; return; }
        n -= u.txCount + 1;
        u.txCount = u.divider - 1;
        if (u.txBits === 1) { u.txBusy = false; u.txDone = true; u.sent.push(u.txByte); }
        u.txBits -= 1;
      }
    }
    function spiTick(p, n) {
      while (n > 0 && p.busy) {
        if (n <= p.counter) { p.counter -= n; return; }
        n -= p.counter + 1;
        p.counter = p.divider - 1;
        if (!p.sck) { p.sck = 1; continue; }
        if (p.bitsLeft === 1) { p.busy = false; p.sck = 0; p.received = p.miso & ((1 << p.frameBitsActive) - 1); p.rxValid = true; return; }
        p.sck = 0; p.bitsLeft -= 1;
      }
    }
    function nextEvent(st) {
      var list = [];
      if (st.uart.txBusy) list.push({ kind: 'uart-tx', at: uartLeft(st.uart) });
      if (st.spi.busy) list.push({ kind: 'spi', at: spiLeft(st.spi) });
      if (st.timer.mtime < st.timer.mtimecmp) {
        var gap = st.timer.mtimecmp - st.timer.mtime;
        if (gap <= BigInt(1e12)) list.push({ kind: 'timer', at: Number(gap) });
      }
      list.sort(function (a, b) { return a.at - b.at; });
      return list[0] || null;
    }
    function tick(st, n, holdMtime) {
      if (n <= 0) return;
      st.time += n;
      if (!holdMtime) st.timer.mtime = (st.timer.mtime + BigInt(n)) & MASK64;
      uartTick(st.uart, n);
      spiTick(st.spi, n);
    }
    // Events fire in time order. Each one settles the CPU side before time
    // moves on (illustrative schedule: the CPU clock is fast enough to sample
    // and, when free, accept an interrupt between separate peripheral events),
    // so splitting an interval into parts never changes the result.
    function advance(ctx, n) {
      var st = ctx.st, remaining = n;
      while (remaining > 0) {
        var ev = nextEvent(st);
        if (!ev || ev.at > remaining) { tick(st, remaining); remaining = 0; break; }
        var was = { uart: st.uart.txBusy, spi: st.spi.busy, timer: timerIrq(st) };
        tick(st, ev.at);
        remaining -= ev.at;
        if (was.uart && !st.uart.txBusy) fire(ctx, 'uart-tx');
        if (was.spi && !st.spi.busy) fire(ctx, 'spi');
        if (!was.timer && timerIrq(st)) fire(ctx, 'timer');
      }
    }
    function fire(ctx, kind) {
      var st = ctx.st;
      if (kind === 'uart-tx') {
        ctx.step({ group: 'event-uart-tx', title: 'uart0: the stop bit of ' + hex8(st.uart.txByte) + ' ends', kind: 'event', parts: ['dev_uart0'],
          text: ['The transmitter idles: STATUS.TX_READY ← 1 and IRQ_PENDING.TX_COMPLETE ← 1. The flag is recorded whether or not IRQ_ENABLE.TX_COMPLETE is set; the enable only masks the irq output.'] });
        ctx.levelChange(); settle(ctx);
      } else if (kind === 'spi') {
        var p = st.spi;
        ctx.step({ group: 'event-spi', title: 'spi0: the ' + p.frameBitsActive + '-bit frame finishes', kind: 'event', parts: ['dev_spi0'],
          text: ['Sent ' + hexShort(p.frame) + ' on MOSI; sampled ' + hexShort(p.received) + ' from MISO (this page’s stand-in for the attached device). BUSY ← 0, RX_VALID ← 1 (= IRQ_PENDING.COMPLETE), even if IRQ_ENABLE.COMPLETE is 0.'] });
        ctx.levelChange(); settle(ctx);
      } else if (kind === 'timer') {
        ctx.step({ group: 'event-timer', title: 'timer0: MTIME reaches MTIMECMP', kind: 'event', parts: ['dev_timer0'],
          text: ['MTIME = ' + hex64(st.timer.mtime) + ' ≥ MTIMECMP = ' + hex64(st.timer.mtimecmp) + ', so the combinational compare raises timer_irq. It stays high until software moves MTIMECMP above MTIME.'] });
        ctx.levelChange(); settle(ctx);
      }
    }

    /* ---------- story context ---------- */
    function context(start) {
      var ctx = { st: clone(start), steps: [], txn: null, pendingLevels: false };
      ctx.step = function (s) {
        s.state = clone(ctx.st);
        s.txn = ctx.txn ? clone(ctx.txn) : null;
        s.parts = s.parts || [];
        s.flows = s.flows || [];
        s.text = s.text || [];
        ctx.steps.push(s);
        return s;
      };
      // Show the peripheral-domain chain from a device level to the wires at
      // the domain boundary. CPU-side flops settle afterwards (settle()).
      ctx.lastLevels = { ext: irqView(ctx.st).irq, tim: timerIrq(ctx.st), src: sourceLevels(ctx.st), active: irqView(ctx.st).active };
      ctx.levelChange = function () {
        var st = ctx.st, now = irqView(st), src = sourceLevels(st), tim = timerIrq(st), before = ctx.lastLevels;
        var flows = [], parts = [], text = [], hops = [];
        L.sources.forEach(function (d) {
          var was = (before.src >>> d.bit) & 1, is = (src >>> d.bit) & 1;
          if (was !== is) {
            flows.push({ wire: 'w_irq_' + d.name, dir: 'irq', label: String(is) });
            parts.push('dev_' + d.name);
            text.push(d.name + ' irq ' + was + ' → ' + is + ': ' + levelReason(st, d) + ' It drives irq_sources[' + d.bit + '].');
            hops.push(d.name + ' irq = ' + is + ' → irq0 source ' + d.bit);
          }
        });
        if (now.active !== before.active || now.irq !== before.ext || flows.length) {
          parts.push('dev_irq0');
          text.push('irq0: PENDING ' + bits(now.pending, 4) + ' & ENABLE ' + bits(st.irq.enable, 4) + ' & ~in-service ' + bits(st.irq.inService, 4) + ' = ACTIVE ' + bits(now.active, 4) + '. Its irq output (any ACTIVE bit) is ' + (now.irq ? 1 : 0) + '.');
        }
        if (now.irq !== before.ext) {
          flows.push({ wire: 'w_ext_irq', dir: 'irq', label: now.irq ? '1' : '0' });
          text.push('peripheral_external_irq ' + (before.ext ? 1 : 0) + ' → ' + (now.irq ? 1 : 0) + ' reaches the CPU-side synchronizer.');
          hops.push('peripheral_external_irq = ' + (now.irq ? 1 : 0));
        } else if (now.active !== before.active || flows.length) {
          hops.push('irq0 ACTIVE ' + bits(now.active, 4) + (now.irq ? ', output stays 1' : ', output stays 0'));
        }
        if (tim !== before.tim) {
          parts.push('dev_timer0');
          flows.push({ wire: 'w_tim_irq', dir: 'irq', label: tim ? '1' : '0' });
          text.push('peripheral_timer_irq ' + (before.tim ? 1 : 0) + ' → ' + (tim ? 1 : 0) + ' (MTIME ' + (tim ? '≥' : '<') + ' MTIMECMP). It bypasses irq0.');
          hops.push('peripheral_timer_irq = ' + (tim ? 1 : 0) + ' (bypasses irq0)');
        }
        ctx.lastLevels = { ext: now.irq, tim: tim, src: src, active: now.active };
        if (!text.length) return false;
        ctx.step({ group: 'irq-periph', title: hops.join(' → ') || 'Interrupt levels change', kind: 'irq', parts: parts, flows: flows, text: text });
        ctx.pendingLevels = true;
        return true;
      };
      return ctx;
    }
    function levelReason(st, d) {
      if (d.component === 'gpio') { var g = st.gpio[d.bank]; return 'IRQ_PENDING ' + hex8(g.pend) + ' & IRQ_ENABLE ' + hex8(g.ie) + ' = ' + hex8(g.pend & g.ie) + '.'; }
      if (d.component === 'uart') return 'IRQ_PENDING ' + bits(uartPending(st.uart), 4) + ' & IRQ_ENABLE ' + bits(st.uart.ie, 4) + '.';
      if (d.component === 'spi') return 'IRQ_ENABLE.COMPLETE ' + (st.spi.ie ? 1 : 0) + ' & RX_VALID ' + (st.spi.rxValid ? 1 : 0) + '.';
      return '';
    }

    // CPU side: two clk flops per level, then csr_file samples mip on the
    // falling edge; trap entry follows when MIE && (mie & mip).
    function settle(ctx) {
      var st = ctx.st, c = st.cpu, guard = 0;
      while (guard++ < 8) {
        var lv = levels(st);
        var e0 = lv.ext ? 1 : 0, t0 = lv.tim ? 1 : 0;
        if (c.extSync[0] !== e0 || c.timSync[0] !== t0) {
          var flowsA = [], textA = [], partsA = [];
          if (c.extSync[0] !== e0) { flowsA.push({ wire: 'w_ext_irq', dir: 'irq', label: String(e0) }); partsA.push('sync_ext'); textA.push('external_sync[0] ← ' + e0 + ' (first flop; may go metastable and settle).'); }
          if (c.timSync[0] !== t0) { flowsA.push({ wire: 'w_tim_irq', dir: 'irq', label: String(t0) }); partsA.push('sync_tim'); textA.push('timer_sync[0] ← ' + t0 + '.'); }
          var e1 = c.extSync[0], t1 = c.timSync[0];
          if (c.extSync[1] !== e1) { textA.push('external_sync[1] ← ' + e1 + ': core external_irq = ' + e1 + '.'); flowsA.push({ wire: 'w_ext_core', dir: 'irq', label: String(e1) }); partsA.push('csr'); }
          if (c.timSync[1] !== t1) { textA.push('timer_sync[1] ← ' + t1 + ': core timer_irq = ' + t1 + '.'); flowsA.push({ wire: 'w_tim_core', dir: 'irq', label: String(t1) }); partsA.push('csr'); }
          c.extSync = [e0, e1]; c.timSync = [t0, t1];
          ctx.step({ group: 'irq-sync', title: 'clk edge 1: first synchronizer flop' + (partsA.indexOf('sync_ext') >= 0 && partsA.indexOf('sync_tim') >= 0 ? 's' : '') + ' ← ' + [partsA.indexOf('sync_ext') >= 0 ? 'external ' + e0 : null, partsA.indexOf('sync_tim') >= 0 ? 'timer ' + t0 : null].filter(Boolean).join(', '), kind: 'irq', parts: partsA, flows: flowsA, text: textA });
          continue;
        }
        if (c.extSync[1] !== c.extSync[0] || c.timSync[1] !== c.timSync[0]) {
          var flowsB = [], textB = [], partsB = [];
          if (c.extSync[1] !== c.extSync[0]) { flowsB.push({ wire: 'w_ext_core', dir: 'irq', label: String(c.extSync[0]) }); partsB.push('sync_ext', 'csr'); textB.push('external_sync[1] ← ' + c.extSync[0] + ': core external_irq = ' + c.extSync[0] + '.'); }
          if (c.timSync[1] !== c.timSync[0]) { flowsB.push({ wire: 'w_tim_core', dir: 'irq', label: String(c.timSync[0]) }); partsB.push('sync_tim', 'csr'); textB.push('timer_sync[1] ← ' + c.timSync[0] + ': core timer_irq = ' + c.timSync[0] + '.'); }
          c.extSync = [c.extSync[0], c.extSync[0]]; c.timSync = [c.timSync[0], c.timSync[0]];
          ctx.step({ group: 'irq-sync', title: 'clk edge 2: ' + [partsB.indexOf('sync_ext') >= 0 ? 'core external_irq = ' + c.extSync[0] : null, partsB.indexOf('sync_tim') >= 0 ? 'core timer_irq = ' + c.timSync[0] : null].filter(Boolean).join(', '), kind: 'irq', parts: partsB, flows: flowsB, text: textB });
          continue;
        }
        var meip = c.extSync[1] === 1, mtip = c.timSync[1] === 1;
        if (c.MEIP !== meip || c.MTIP !== mtip) {
          var textC = [];
          if (c.MEIP !== meip) textC.push('mip.MEIP ← ' + (meip ? 1 : 0) + '.');
          if (c.MTIP !== mtip) textC.push('mip.MTIP ← ' + (mtip ? 1 : 0) + '.');
          c.MEIP = meip; c.MTIP = mtip;
          var mipTitle = 'Falling clk edge: ' + [textC.length > 0 && textC[0].indexOf('MEIP') >= 0 ? 'mip.MEIP = ' + (meip ? 1 : 0) : null, textC.join(' ').indexOf('MTIP') >= 0 ? 'mip.MTIP = ' + (mtip ? 1 : 0) : null].filter(Boolean).join(', ') + (eligible(st) ? ' → eligible' : '');
          textC.push('csr_file samples the levels on the falling clk edge, whatever the enables are. Software writes to mip cannot clear them; only the source can.');
          textC.push(eligibilityText(st));
          ctx.step({ group: 'irq-mip', title: mipTitle, kind: 'cpu', parts: ['csr'], text: textC });
          continue;
        }
        break;
      }
      if (eligible(st) && ctx.inAccess) {
        // The synchronizers and mip keep sampling, but Base takes the trap only
        // after the blocking access in MEM completes; access() rechecks then.
        if (!ctx.deferNoted) ctx.step({ group: 'irq-mip', title: 'Eligible, but the core waits for the access in MEM to complete', kind: 'cpu', parts: ['csr', 'core'],
          text: ['IF/ID/EX hold while older MEM/WB work drains. When the access completes, the core rechecks the enables and levels before taking a trap.'] });
        ctx.deferNoted = true;
        ctx.pendingLevels = true;
        return;
      }
      if (eligible(st)) trapEntry(ctx, null);
      ctx.pendingLevels = false;
    }
    function eligibilityText(st) {
      var c = st.cpu;
      var ext = c.MEIE && c.MEIP, tim = c.MTIE && c.MTIP;
      var base = 'mie & mip = {MEIE·MEIP ' + (ext ? 1 : 0) + ', MTIE·MTIP ' + (tim ? 1 : 0) + '}; mstatus.MIE = ' + (c.mstatusMIE ? 1 : 0) + '.';
      if (eligible(st)) return base + ' The interrupt is eligible.';
      if ((ext || tim) && !c.mstatusMIE) return base + ' Pending and enabled, but MIE = 0 blocks trap entry' + (c.context === 'handler' ? ' (it was cleared on handler entry).' : '.');
      if (c.MEIP || c.MTIP) return base + ' Pending in mip but masked in mie: no trap.';
      return base + ' Nothing is pending.';
    }
    function trapEntry(ctx, fault) {
      var st = ctx.st, c = st.cpu, cause, mtval;
      if (fault && ctx.txn) c.last = ctx.txn.outcome || CAUSE_NAME[fault.cause];
      if (fault) { cause = fault.cause; mtval = fault.mtval; }
      else { cause = c.MEIE && c.MEIP ? CAUSE.external : CAUSE.timer; mtval = 0; }
      if (!fault) {
        ctx.step({ group: 'trap', title: 'Core accepts the interrupt after older MEM/WB work drains', kind: 'cpu', parts: ['csr', 'core'],
          text: ['csr_file reports interrupt_pending. Base holds IF/ID/EX and lets older MEM/WB work drain (a blocking access in MEM finishes first), then registers the trap request on a rising clk edge.',
            'Priority among enabled pending levels: write-back error, external (MEIP), software, timer (MTIP). Here: ' + CAUSE_NAME[cause] + '.'] });
      }
      c.mstatusMPIE = c.mstatusMIE; c.mstatusMIE = false;
      c.mcause = cause; c.mtval = mtval; c.mepc = fault ? 'the faulting ' + fault.instr : 'the oldest unexecuted instruction';
      c.context = 'handler';
      ctx.step({ group: 'trap', title: (fault ? 'Exception: ' : 'Trap: ') + 'mcause ' + hex32(cause) + ', MIE ← 0, PC ← mtvec', kind: 'cpu', parts: ['csr', 'core'], flows: [{ wire: 'w_trap', dir: 'req', label: 'mtvec' }],
        text: ['Falling clk edge: mepc ← PC of ' + c.mepc + '; mcause ← ' + hex32(cause) + ' (' + CAUSE_NAME[cause] + '); mtval ← ' + hex32(mtval) + '; mstatus.MPIE ← ' + (c.mstatusMPIE ? 1 : 0) + '; MIE ← 0.',
          'Next rising edge: younger work is squashed and fetch restarts at mtvec (direct mode; firmware sets the handler address).',
          fault ? 'A real handler would fix or skip the faulting instruction before mret.' : 'Nothing has acknowledged the interrupt: the level is still high in mip. With MIE = 0 the core does not take it again; the handler claims and clears it.'] });
    }

    /* ---------- actions ---------- */
    function instrText(a) {
      var off = a.offset | 0;
      return a.op === 'lw' ? 'lw a0, ' + off + '(t0)' : 'sw t1, ' + off + '(t0)';
    }

    // One lw/sw from MEM to completion.
    function access(ctx, a) {
      var st = ctx.st, ea = ((a.base >>> 0) + (a.offset | 0)) >>> 0, op = a.op, value = a.value >>> 0;
      var instr = instrText(a);
      var cls = classify(ea);
      var txn = ctx.txn = { instr: instr, op: op, base: a.base >>> 0, offset: a.offset | 0, value: op === 'sw' ? value : null, ea: ea,
        target: describe(ea), path: null, beats: [], result: null, rd: null, outcome: null };
      ctx.step({ group: 'core', title: instr + ': effective address ' + hex32(ea), kind: 'bus', parts: ['core'],
        text: ['EX adds t0 = ' + hex32(a.base) + ' and the offset ' + (a.offset | 0) + '. ' + (op === 'sw' ? 't1 = ' + hex32(value) + ' is the store data. ' : '') + 'Target: ' + txn.target + '.'] });
      if (ea & 3) {
        txn.path = 'none'; txn.outcome = (op === 'lw' ? 'Load' : 'Store') + ' address misaligned';
        ctx.step({ group: 'core', title: 'Misaligned word address: exception in EX', kind: 'cpu', parts: ['core'],
          text: ['A word access needs an address that is a multiple of 4. Base raises ' + (op === 'lw' ? 'load' : 'store') + ' address misaligned in EX; no request reaches the cache or the bus.'] });
        trapEntry(ctx, { cause: op === 'lw' ? CAUSE.loadMisaligned : CAUSE.storeMisaligned, mtval: ea, instr: instr });
        return;
      }
      if (cls.cacheable) cachedAccess(ctx, a, ea, cls);
      else uncachedAccess(ctx, a, ea, cls);
      ctx.inAccess = false;
      if (ctx.pendingLevels || levelsMoved(st) || eligible(st)) settle(ctx);
      ctx.deferNoted = false;
    }
    function levelsMoved(st) {
      var lv = levels(st), c = st.cpu;
      return (lv.ext ? 1 : 0) !== c.extSync[1] || (lv.tim ? 1 : 0) !== c.timSync[1] || c.MEIP !== (c.extSync[1] === 1) || c.MTIP !== (c.timSync[1] === 1);
    }

    function lineAddr(tag, idx) { return ((tag << 7) | (idx << 4)) >>> 0; }
    function ramWord(st, a) { return st.ram[a >>> 0] >>> 0 || 0; }
    function cachedAccess(ctx, a, ea, cls) {
      var st = ctx.st, txn = ctx.txn, op = a.op;
      var idx = (ea >>> 4) & 7, tag = ea >>> 7, word = (ea >>> 2) & 3, set = st.dcache[idx];
      var hitWay = -1;
      set.ways.forEach(function (w, i) { if (w.valid && w.tag === tag) hitWay = i; });
      txn.path = 'cache';
      if (hitWay >= 0) {
        var line = set.ways[hitWay];
        if (op === 'lw') { txn.rd = line.data[word]; }
        else { line.data[word] = a.value >>> 0; line.dirty = true; }
        set.lru = 1 - hitWay;
        txn.cache = 'hit'; txn.result = 'ACCESS'; txn.outcome = op === 'lw' ? 'a0 ← ' + hex32(txn.rd) + ' from the D-cache' : 'Stored in the D-cache line; RAM is not written until that line is written back';
        st.cpu.last = txn.outcome;
        ctx.step({ group: 'cache', title: 'D-cache hit: no fabric transaction', kind: 'bus', parts: ['caches', 'lane_line', 'core'], flows: [{ wire: 'w_core_cache', dir: 'req', label: op.toUpperCase() + ' ' + hex32(ea) }],
          text: ['RAM addresses are cacheable. The line holding ' + hex32(ea) + ' is resident (set ' + idx + ', way ' + hitWay + '), so the access completes inside the tile and system_bus sees nothing.',
            op === 'lw' ? 'a0 ← ' + hex32(txn.rd) + '.' : 'The word is written into the line and the line is marked dirty. RAM keeps its old value until the line is evicted or flushed.',
            'The Caches tab models hits, misses and replacement in detail.'] });
        return;
      }
      var victim = set.lru, v = set.ways[victim];
      txn.cache = 'miss';
      ctx.step({ group: 'cache', title: 'D-cache miss: the line must come from RAM', kind: 'bus', parts: ['caches', 'lane_line', 'core'], flows: [{ wire: 'w_core_cache', dir: 'req', label: op.toUpperCase() + ' ' + hex32(ea) }],
        text: ['RAM addresses are cacheable, so the D-cache allocates a 16-byte line for both loads and stores (write-back, write-allocate). Set ' + idx + ' replaces way ' + victim + ' (its LRU way)' +
          (v.valid ? ', which holds ' + hex32(lineAddr(v.tag, idx)) + (v.dirty ? ' and is dirty, so it is written back first.' : ' (clean, dropped without a write).') : ', which is empty.'),
          'Line beats always enable all eight bytes (mask 0xFF), unlike an uncached word.'] });
      if (v.valid && v.dirty) {
        var victimBase = lineAddr(v.tag, idx);
        for (var half = 0; half < 2; half++) {
          var wa = (victimBase + half * 8) >>> 0;
          var d64 = (BigInt(v.data[half * 2 + 1] >>> 0) << B32) | BigInt(v.data[half * 2] >>> 0);
          txn.beats.push({ kind: half ? 'WB_HIGH' : 'WB_LOW', write: true, address: wa, mask: 0xFF, data: d64, response: 'ACCESS' });
          memoryBeat(ctx, { write: true, address: wa, mask: 0xFF, data: d64, label: half ? 'WB_HIGH' : 'WB_LOW' });
          st.ram[wa] = v.data[half * 2]; st.ram[(wa + 4) >>> 0] = v.data[half * 2 + 1];
        }
        v.dirty = false;
      }
      var base = lineAddr(tag, idx), filled = [];
      for (var h = 0; h < 2; h++) {
        var fa = (base + h * 8) >>> 0;
        var ok = classify(fa).target === 'ram';
        var data = ok ? (BigInt(ramWord(st, fa + 4)) << B32) | BigInt(ramWord(st, fa)) : null;
        txn.beats.push({ kind: h ? 'FILL_HIGH' : 'FILL_LOW', write: false, address: fa, mask: 0xFF, data: data, response: ok ? 'ACCESS' : 'ERROR' });
        memoryBeat(ctx, { write: false, address: fa, mask: 0xFF, data: data, label: h ? 'FILL_HIGH' : 'FILL_LOW', hole: !ok });
        if (!ok) {
          v.valid = false;
          txn.result = 'ERROR';
          txn.outcome = (op === 'lw' ? 'Load' : 'Store') + ' access fault: the refill hit a hole in the RAM reservation';
          ctx.step({ group: 'rsp-core', title: 'Refill error: the D-cache reports an access fault', kind: 'bus', parts: ['caches', 'core'], flows: [{ wire: 'w_core_cache', dir: 'rsp', label: 'fault' }],
            text: ['The way being refilled is invalidated (its low words may already be replaced). MEM turns cache_error into a ' + (op === 'lw' ? 'load' : 'store') + ' access fault with mtval = ' + hex32(ea) + '.',
              'Holes do not alias installed RAM: system_bus checks installed capacity before subtracting the base.'] });
          trapEntry(ctx, { cause: op === 'lw' ? CAUSE.loadFault : CAUSE.storeFault, mtval: ea, instr: txn.instr });
          return;
        }
        filled.push(ramWord(st, fa), ramWord(st, fa + 4));
      }
      v.valid = true; v.tag = tag; v.data = filled; v.dirty = false;
      if (op === 'sw') { v.data[word] = a.value >>> 0; v.dirty = true; }
      else txn.rd = v.data[word];
      set.lru = 1 - victim;
      txn.result = 'ACCESS';
      txn.outcome = op === 'lw' ? 'a0 ← ' + hex32(txn.rd) : 'Stored in the refilled line (dirty); RAM still holds ' + hex32(ramWord(st, ea)) + ' at ' + hex32(ea);
      st.cpu.last = txn.outcome;
      ctx.step({ group: 'rsp-core', title: 'Line installed; the ' + (op === 'lw' ? 'load' : 'store') + ' completes in the cache', kind: 'bus', parts: ['caches', 'lane_line', 'core'], flows: [{ wire: 'w_core_cache', dir: 'rsp', label: op === 'lw' ? hex32(txn.rd) : 'done' }],
        text: [op === 'lw' ? 'a0 ← ' + hex32(txn.rd) + ' (word ' + word + ' of the line).' : 'The store merges into the refilled line, which becomes dirty. The new value reaches RAM only when this line is written back; a later uncached reader of RAM would not see it.'] });
    }
    // One fabric beat to RAM (line traffic).
    function memoryBeat(ctx, b) {
      var st = ctx.st;
      var lbl = (b.write ? 'W ' : 'R ') + hex32(b.address);
      ctx.step({ group: 'beat-' + b.label, title: b.label + ': ' + (b.write ? 'write' : 'read') + ' beat ' + hex32(b.address) + ', mask 0xFF', kind: 'bus',
        parts: ['caches', 'lane_line', 'fabric', 'system_bus'], flows: [{ wire: 'w_cfi', dir: 'req', label: lbl }, { wire: 'w_sbi', dir: 'req', label: lbl }],
        text: ['cache_fabric_if data_' + (b.write ? 'write' : 'read') + ' at ' + hex32(b.address) + (b.write ? ' with ' + hex64(b.data) : '') + '. The direct fabric gives data priority over instruction fetch and passes the beat to system_bus unchanged.'] });
      if (b.hole) {
        ctx.step({ group: 'beat-' + b.label, title: 'system_bus: no installed RAM at ' + hex32(b.address) + ' → ERROR', kind: 'bus', tone: 'error',
          parts: ['system_bus', 'fabric', 'caches'], flows: [{ wire: 'w_sbi', dir: 'rsp', label: 'ERROR' }, { wire: 'w_cfi', dir: 'rsp', label: 'error' }],
          text: ['address_decode: the address is in the ' + size(L.ram.reserved) + ' RAM reservation but past the ' + size(L.ram.bytes) + ' installed, so ram_selected is 0. No target is enabled and system_bus answers ERROR in the same cycle.'] });
        return;
      }
      ctx.step({ group: 'beat-' + b.label, title: 'RAM ' + (b.write ? 'stores' : 'returns') + ' the beat (physical ' + hex32(b.address - L.ram.base) + ')', kind: 'bus',
        parts: ['system_bus', 'ram', 'fabric', 'caches'], flows: [{ wire: 'w_ram', dir: 'req', label: hexShort(b.address - L.ram.base) }, { wire: 'w_ram', dir: 'rsp', label: 'ACCESS' }, { wire: 'w_sbi', dir: 'rsp', label: 'ACCESS' }, { wire: 'w_cfi', dir: 'rsp', label: b.write ? 'done' : 'data' }],
        text: ['system_bus selects RAM (installed capacity checked first), subtracts the base and drives physical_ramif. RAM answers ACCESS after its latency (RAM_LAT, default 1)' + (b.write ? '.' : ' with ' + hex64(b.data) + '.'),
          'data_wait drops on that edge; the D-cache takes the next beat.'] });
    }

    function uncachedAccess(ctx, a, ea, cls) {
      var st = ctx.st, txn = ctx.txn, op = a.op;
      var beat = beatOf(ea, op, a.value);
      txn.path = cls.target === 'mmio' ? 'mmio' : cls.target === 'rom' || cls.target === 'rom-hole' ? 'rom' : 'none';
      txn.beats.push({ kind: 'uncached', write: beat.write, address: beat.address, mask: beat.mask, data: beat.write ? beat.data : null, response: null });
      var lbl = (beat.write ? 'W ' : 'R ') + hex32(beat.address) + ' ' + hex8(beat.mask);
      ctx.step({ group: 'req-tile', title: 'Not cacheable: one uncached beat', kind: 'bus', parts: ['core', 'caches', 'lane_io'], flows: [{ wire: 'w_core_cache', dir: 'req', label: op.toUpperCase() + ' ' + hex32(ea) }],
        text: ['Only the RAM window is cacheable, so the D-cache skips line allocation and registers a single beat: address ' + hex32(beat.address) + ' (aligned down to 8 bytes), byte_enable ' + maskText(beat.mask) +
          (beat.write ? ', write_data ' + hex64(beat.data) + ' (t1 shifted into its lanes)' : '') + '.',
          'It issues the beat once and holds it until completion, so a device side effect cannot repeat.'] });
      ctx.step({ group: 'req-tile', title: 'Fabric: data beat onto system_bus_if', kind: 'bus', parts: ['caches', 'lane_io', 'fabric', 'system_bus'], flows: [{ wire: 'w_cfi', dir: 'req', label: lbl }, { wire: 'w_sbi', dir: 'req', label: lbl }],
        text: ['The direct fabric passes the data channel straight through (memREN/memWEN, memaddr, memmask) and marks it as a data access, not a fetch.'] });
      var result;
      if (cls.target === 'rom' && op === 'lw') {
        ctx.step({ group: 'target', title: 'system_bus selects the boot ROM', kind: 'bus', parts: ['system_bus', 'rom'], flows: [{ wire: 'w_rom', dir: 'req', label: 'R ' + hexShort(beat.address - L.rom.base) }],
          text: ['The address is inside the ' + size(L.rom.bytes) + ' installed of the ' + size(L.rom.reserved) + ' ROM reservation, and this is a read: romif.ramREN = 1 at offset ' + hexShort(beat.address - L.rom.base) + '.'] });
        result = { error: false, read: null };
        ctx.step({ group: 'target', title: 'ROM answers ACCESS', kind: 'bus', parts: ['rom', 'system_bus'], flows: [{ wire: 'w_rom', dir: 'rsp', label: 'ACCESS' }],
          text: ['The ROM registers the read address and answers ACCESS on the next cycle with the beat from the boot image. This page does not model the image, so the value is not shown.'] });
      } else if (cls.target === 'rom') {
        result = { error: true };
        ctx.step({ group: 'target', title: 'system_bus: ROM writes are rejected → ERROR', kind: 'bus', tone: 'error', parts: ['system_bus', 'rom'],
          text: ['rom_read requires a read; romif.ramWEN is tied to 0. With no target enabled for the write, system_bus answers ERROR immediately. The ROM never sees it.'] });
      } else if (cls.target === 'rom-hole') {
        result = { error: true };
        ctx.step({ group: 'target', title: 'system_bus: no installed ROM at ' + hex32(ea) + ' → ERROR', kind: 'bus', tone: 'error', parts: ['system_bus'],
          text: ['The address is in the ' + size(L.rom.reserved) + ' ROM reservation but past the ' + size(L.rom.bytes) + ' installed. rom_selected checks capacity, so the hole does not alias the image: ERROR.'] });
      } else if (cls.target === 'unmapped') {
        result = { error: true };
        ctx.step({ group: 'target', title: 'system_bus: no target → ERROR', kind: 'bus', tone: 'error', parts: ['system_bus'],
          text: ['The address is outside RAM, ROM and the peripheral aperture ' + hex32(L.mmio.base) + '–' + hex32(L.mmio.last) + '. system_bus answers ERROR without enabling any target.'] });
      } else {
        result = mmioAccess(ctx, beat, cls);
      }
      // Response back to the core.
      txn.beats[0].response = result.error ? 'ERROR' : 'ACCESS';
      txn.result = result.error ? 'ERROR' : 'ACCESS';
      if (result.error) {
        txn.outcome = (op === 'lw' ? 'Load' : 'Store') + ' access fault (mcause ' + (op === 'lw' ? 5 : 7) + ', mtval ' + hex32(ea) + ')';
        ctx.step({ group: 'rsp-core', title: 'ERROR returns: ' + (op === 'lw' ? 'load' : 'store') + ' access fault', kind: 'bus', tone: 'error', parts: ['system_bus', 'fabric', 'caches', 'lane_io', 'core'],
          flows: [{ wire: 'w_sbi', dir: 'rsp', label: 'ERROR' }, { wire: 'w_cfi', dir: 'rsp', label: 'error' }, { wire: 'w_core_cache', dir: 'rsp', label: 'fault' }],
          text: ['ERROR completes the beat; data_error reaches the D-cache, which completes the held access with access_fault. MEM records a ' + (op === 'lw' ? 'load' : 'store') + ' access fault with mtval = ' + hex32(ea) + '.'] });
        trapEntry(ctx, { cause: op === 'lw' ? CAUSE.loadFault : CAUSE.storeFault, mtval: ea, instr: txn.instr });
        return;
      }
      var text;
      if (op === 'lw') {
        if (result.read === null) { txn.rd = null; txn.outcome = 'a0 ← word ' + (ea & 4 ? 1 : 0) + ' of the ROM beat (boot image contents)'; text = 'The D-cache shifts the beat by ' + (8 * (ea & 7)) + ' bits and keeps 32: a0 ← the boot-image word at ' + hex32(ea) + '.'; }
        else {
          var word = Number((result.read >> BigInt(8 * (ea & 7))) & BFF) >>> 0;
          txn.rd = word; txn.rdata = result.read;
          txn.outcome = 'a0 ← ' + hex32(word);
          text = 'read_data ' + hex64(result.read) + ' is shifted right by ' + (8 * (ea & 7)) + ' bits; the low word is the result: a0 ← ' + hex32(word) + '.';
        }
      } else {
        txn.outcome = 'Store completed at the device; no data returns';
        text = 'A store completion carries no data. The device acted on it at its own completion edge, before this response arrived.';
      }
      st.cpu.last = txn.outcome;
      ctx.step({ group: 'rsp-core', title: 'ACCESS returns to the core', kind: 'bus', parts: ['system_bus', 'fabric', 'caches', 'lane_io', 'core'],
        flows: [{ wire: 'w_sbi', dir: 'rsp', label: 'ACCESS' }, { wire: 'w_cfi', dir: 'rsp', label: op === 'lw' && txn.rd !== null ? hex32(txn.rd) : 'done' }, { wire: 'w_core_cache', dir: 'rsp', label: op === 'lw' ? 'a0' : 'done' }],
        text: ['system_bus reports ACCESS; the fabric drops data_wait for that edge and the D-cache captures the response (io_complete), then hands it to MEM.', text] });
    }

    function mmioAccess(ctx, beat, cls) {
      var st = ctx.st, cdc = st.cdc;
      ctx.inAccess = true;
      var lbl = (beat.write ? 'W ' : 'R ') + hex32(beat.address) + ' ' + hex8(beat.mask);
      ctx.step({ group: 'req-bus', title: 'system_bus: peripheral aperture → mmio.valid', kind: 'bus', parts: ['system_bus', 'cdc'], flows: [{ wire: 'w_mmio_cpu', dir: 'req', label: lbl }],
        text: ['The address is inside ' + hex32(L.mmio.base) + '–' + hex32(L.mmio.last) + ', aligned, a data access, with exactly one enable. system_bus raises mmio.valid for every such address, including addresses with no device; the peripheral decoder sorts those out.',
          'Until mmio.ready, system_bus answers BUSY. The fabric and the core wait: there is one blocking request and no ID.'] });
      cdc.state = 'WAIT_ACK'; cdc.req = cdc.req ^ 1;
      ctx.step({ group: 'cdc-req', title: 'mmio_cdc (clk): capture the request, flip request_toggle', kind: 'bus', parts: ['cdc'],
        text: ['IDLE captures {write, address, write_data, byte_enable} into request_payload, flips request_toggle to ' + cdc.req + ' and moves to WAIT_ACK. The host keeps holding the request.'] });
      advance(ctx, 2);
      cdc.reqSync = cdc.req;
      ctx.step({ group: 'cdc-req', title: 'Two peripheral_clk edges synchronize request_toggle', kind: 'bus', parts: ['cdc'],
        text: ['request_meta then request_sync take the new toggle. Only the toggle is synchronized; the payload bundle has been stable since capture and is sampled as a unit.'] });
      advance(ctx, 1);
      cdc.active = 1;
      ctx.step({ group: 'cdc-req', title: 'mmio_cdc (peripheral_clk): request_sync ≠ acknowledge_toggle → valid', kind: 'bus', parts: ['cdc', 'decoder'], flows: [{ wire: 'w_mmio_per', dir: 'req', label: lbl }],
        text: ['On the next peripheral_clk edge the bridge copies the payload to destination_request and raises peripheral.valid, holding it until valid && ready.'] });
      var dev = cls.device;
      var decodeAddr = beat.decode;
      if (!dev) {
        var why = cls.region ? (L.installedRegions[cls.region.id] ? 'It is in the ' + cls.region.id + ' reservation but outside ' + L.installedRegions[cls.region.id].name + '’s ' + L.installedRegions[cls.region.id].bytes + '-byte register window.' : 'The ' + cls.region.id + ' reservation is not simulated in this teaching composition.') : 'No reservation covers it.';
        ctx.step({ group: 'device', title: 'mmio_decode_bus: no window → ready = 1, error = 1', kind: 'bus', tone: 'error', parts: ['decoder', 'dev_none'], flows: [{ wire: 'w_dev_none', dir: 'req', label: hexShort(decodeAddr) }],
          text: ['Decode address ' + hex32(decodeAddr) + ' (the aligned beat' + (beat.upper ? ' + 4 for the upper lanes' : '') + ') matches no device window. ' + why,
            'With ENABLE_EXTERNAL = 0 in this composition, the decoder itself completes the beat at once with error and zero data.'] });
        advance(ctx, 1);
        return finishCdc(ctx, { error: true, read: BigInt(0) });
      }
      var regName = cls.register ? cls.register.name.toUpperCase() : hexShort(decodeAddr - dev.base);
      ctx.step({ group: 'device', title: 'mmio_decode_bus selects devices[' + dev.index + '] = ' + dev.name, kind: 'bus', parts: ['decoder', 'dev_' + dev.name], flows: [{ wire: 'w_dev_' + dev.name, dir: 'req', label: (beat.write ? 'W ' : 'R ') + regName }],
        text: ['Decode address ' + hex32(decodeAddr) + ' (the aligned beat' + (beat.upper ? ' + 4, because upper lanes are enabled' : '') + ') falls in [' + hex32(dev.base) + ', ' + hex32(dev.base + dev.bytes) + '). Only that port sees valid; every request field passes unchanged, and the device checks the lanes.'] });
      var r = DEVICE[dev.component](st, dev, beat);
      if (r.wait > 0) {
        ctx.step({ group: 'device', title: dev.name + ' holds ready low', kind: 'bus', parts: ['dev_' + dev.name], text: r.effects.slice() });
        r.effects = [];
        advance(ctx, r.wait);
      }
      // Completion edge: register reads see pre-edge values; the edge's own
      // counter/compare update follows (an accepted MTIME write suppresses it).
      if (r.apply) r.apply(st);
      if (r.skipTick) tick(st, 1, true); else advance(ctx, 1);
      if (r.late) r.late(st);
      ctx.txn.reg = r.reg;
      if (r.claimed !== undefined) { ctx.txn.claimed = r.claimed; st.cpu.claimed = r.claimed; }
      if (r.completed) { ctx.txn.completed = r.completed; if (st.cpu.claimed === r.completed) st.cpu.claimed = 0; }
      var word = Number((r.read >> BigInt(beat.upper ? 32 : 0)) & BFF) >>> 0;
      if (!beat.write && !r.error && ctx.txn.beats[0]) ctx.txn.beats[0].data = r.read;
      var effectText = r.effects.length ? r.effects : ['Completes.'];
      ctx.step({ group: 'device', title: dev.name + (r.reg ? ' ' + r.reg : '') + (r.error ? ': completes with error' : beat.write ? ': store takes effect' : ': read data returns'), kind: 'bus', tone: r.error ? 'error' : null,
        parts: ['dev_' + dev.name, 'decoder'], flows: [{ wire: 'w_dev_' + dev.name, dir: 'rsp', label: r.error ? 'error' : beat.write ? 'done' : hexShort(word) }],
        text: ['Completion is the peripheral_clk edge with valid && ready. ' + (r.error ? 'error is set, so no register changes.' : 'The register operation happens on that edge, once.')].concat(effectText) });
      ctx.levelChange(); settle(ctx);
      return finishCdc(ctx, { error: r.error, read: r.read, word: beat.write || r.error ? null : word });
    }
    function finishCdc(ctx, resp) {
      var st = ctx.st, cdc = st.cdc;
      cdc.active = 0; cdc.ack = cdc.reqSync;
      ctx.step({ group: 'cdc-rsp', title: 'mmio_cdc captures {error, read_data}, flips acknowledge_toggle', kind: 'bus', parts: ['cdc', 'decoder'], flows: [{ wire: 'w_mmio_per', dir: 'rsp', label: resp.error ? 'error' : resp.word !== null && resp.word !== undefined ? hexShort(resp.word) : 'done' }],
        text: ['On the same completion edge the bridge stores the response bundle (error = ' + (resp.error ? 1 : 0) + (resp.error ? '' : ', read_data = ' + hex64(resp.read)) + '), sets acknowledge_toggle = ' + cdc.ack + ' and drops peripheral.valid.'] });
      cdc.ackSync = cdc.ack;
      ctx.step({ group: 'cdc-rsp', title: 'Two clk edges synchronize acknowledge_toggle', kind: 'bus', parts: ['cdc'],
        text: ['acknowledge_meta then acknowledge_sync take the toggle in the CPU clock domain. The response bundle has been stable since its capture.'] });
      cdc.state = 'REPLY';
      ctx.step({ group: 'cdc-rsp', title: 'WAIT_ACK → REPLY: cpu.ready for one clk edge', kind: 'bus', parts: ['cdc', 'system_bus'], flows: [{ wire: 'w_mmio_cpu', dir: 'rsp', label: resp.error ? 'ERROR' : resp.word !== null && resp.word !== undefined ? hexShort(resp.word) : 'ACCESS' }],
        text: ['acknowledge_sync equals request_toggle, so the bridge copies the response to source_response and enters REPLY: cpu.ready = 1, cpu.error = ' + (resp.error ? 1 : 0) + '. system_bus turns that into ' + (resp.error ? 'ERROR' : 'ACCESS') + '. Next edge: back to IDLE.'] });
      cdc.state = 'IDLE';
      return resp;
    }

    function gpioEvent(ctx, a) {
      var st = ctx.st, g = st.gpio[a.bank], dev = gpioOf[a.bank], bit = 1 << a.pin;
      var level = a.level ? 1 : 0;
      if (((g.pins >> a.pin) & 1) === level) return;
      g.pins = level ? (g.pins | bit) : (g.pins & ~bit);
      ctx.txn = null;
      ctx.step({ group: 'event-gpio', title: dev.name + ' pin ' + a.pin + ' ' + (level ? 'rises' : 'falls') + ' (asynchronous input)', kind: 'event', parts: ['dev_' + dev.name],
        text: ['gpio_in[' + a.pin + '] ← ' + level + '. The pin is asynchronous to every clock; gpio.sv synchronizes each bit in its bus clock (peripheral_clk here).'] });
      advance(ctx, 2);
      g.meta = g.pins; g.sync = g.pins;
      ctx.step({ group: 'event-gpio', title: 'Two peripheral_clk edges: input_meta, input_sync', kind: 'event', parts: ['dev_' + dev.name],
        text: ['INPUT now reads ' + hex8(g.sync) + '. previous_input still holds ' + hex8(g.prev) + ', so the edge detector sees a ' + (level ? 'rising' : 'falling') + ' edge on bit ' + a.pin + '.'] });
      var edges = ((g.sync & ~g.prev) & g.rise) | ((~g.sync & g.prev) & g.fall);
      edges &= 0xFF;
      advance(ctx, 1);
      g.prev = g.sync;
      g.pend = (g.pend | edges) & 0xFF;
      var sel = level ? g.rise : g.fall;
      ctx.step({ group: 'event-gpio', title: edges ? 'Edge recorded: IRQ_PENDING bit ' + a.pin + ' ← 1' : 'Edge not selected: nothing recorded', kind: 'event', parts: ['dev_' + dev.name],
        text: [edges ? 'IRQ_' + (level ? 'RISE' : 'FALL') + ' = ' + hex8(sel) + ' selects this edge, so IRQ_PENDING becomes ' + hex8(g.pend) + '. New edges are recorded even while IRQ_ENABLE masks them; the bit stays set until software writes one to clear it.' :
          'IRQ_' + (level ? 'RISE' : 'FALL') + ' = ' + hex8(sel) + ' does not select bit ' + a.pin + ', so IRQ_PENDING stays ' + hex8(g.pend) + '. INPUT still changed.'] });
      ctx.levelChange();
      settle(ctx);
    }

    function uartRx(ctx, a) {
      var st = ctx.st, u = st.uart, byte = a.byte & 0xFF;
      ctx.txn = null;
      ctx.step({ group: 'event-uart', title: 'uart_rx: a start bit arrives', kind: 'event', parts: ['dev_uart0'],
        text: ['The line falls. uart.sv synchronizes rx through two flops, waits half a bit (DIVIDER / 2) to confirm the start bit, then samples eight data bits LSB first at bit centres.'] });
      advance(ctx, Math.floor(9.5 * u.divider));
      var held = u.rxValid;
      if (held) u.overrun = true; else { u.rxByte = byte; u.rxValid = true; }
      if (a.frameError) u.frameError = true;
      ctx.step({ group: 'event-uart', title: held ? 'Stop bit: RX still holds an unread byte → OVERRUN' : 'Stop bit: RX ← ' + hex8(byte) + ', RX_VALID ← 1', kind: 'event', parts: ['dev_uart0'],
        text: [held ? 'There is no FIFO: the unread byte ' + hex8(u.rxByte) + ' is kept, ' + hex8(byte) + ' is dropped and OVERRUN ← 1.' : 'About 9.5 bit times (' + Math.floor(9.5 * u.divider) + ' peripheral clocks at DIVIDER ' + u.divider + ') after the start edge, the stop-bit sample delivers the byte.',
          a.frameError ? 'The stop bit sampled low: FRAME_ERROR ← 1 (the byte is still delivered).' : 'RX_VALID is a level: it stays 1 until software reads RX.'] });
      ctx.levelChange();
      settle(ctx);
    }

    function timeAction(ctx, a) {
      var st = ctx.st;
      ctx.txn = null;
      var n = a.cycles;
      if (a.until === 'event') {
        var ev = nextEvent(st);
        if (!ev) {
          ctx.step({ group: 'time', title: 'No device event is scheduled', kind: 'time', parts: [], text: ['No UART frame or SPI frame is in progress, and MTIME is already ≥ MTIMECMP (or the compare is too far away to wait for here).'] });
          return;
        }
        n = ev.at;
      }
      var from = st.timer.mtime;
      advance(ctx, n);
      ctx.step({ group: 'time', title: n + ' peripheral clocks pass', kind: 'time', parts: ['dev_timer0'],
        text: ['MTIME ' + hex64(from) + ' → ' + hex64(st.timer.mtime) + '. In hardware MTIME counts every peripheral_clk edge; this page moves it only when you ask, during the CDC edges and device waits it counts, and during input events.'] });
      settle(ctx);
    }

    function csrAction(ctx, a) {
      var st = ctx.st, c = st.cpu;
      ctx.txn = null;
      var map = { 'mstatus.MIE': ['mstatusMIE', 'csrsi mstatus, 8', 'csrci mstatus, 8'], 'mie.MEIE': ['MEIE', 'csrs mie, t2 (t2 = 0x800)', 'csrc mie, t2 (t2 = 0x800)'], 'mie.MTIE': ['MTIE', 'csrs mie, t2 (t2 = 0x80)', 'csrc mie, t2 (t2 = 0x80)'] };
      var m = map[a.field];
      c[m[0]] = !!a.value;
      ctx.step({ group: 'csr', title: (a.value ? m[1] : m[2]) + ': ' + a.field + ' ← ' + (a.value ? 1 : 0), kind: 'cpu', parts: ['csr', 'core'],
        text: ['A CSR instruction, not a bus access: the write lands in csr_file on a falling clk edge when it reaches WB.', eligibilityText(st)] });
      settle(ctx);
    }

    function mretAction(ctx) {
      var st = ctx.st, c = st.cpu;
      ctx.txn = null;
      var was = c.context;
      c.mstatusMIE = c.mstatusMPIE; c.mstatusMPIE = true;
      c.context = 'main';
      ctx.step({ group: 'mret', title: 'mret: MIE ← MPIE (' + (c.mstatusMIE ? 1 : 0) + '), MPIE ← 1, PC ← mepc', kind: 'cpu', parts: ['csr', 'core'], flows: [{ wire: 'w_trap', dir: 'req', label: 'mepc' }],
        text: [(was === 'handler' ? 'The handler returns to ' + c.mepc + '. ' : 'mret outside a handler still applies the same CSR transformation. ') + 'Nothing here touches irq0 or any device.', eligibilityText(st) +
          (eligible(st) ? ' A level that is still asserted traps again immediately.' : '')] });
      settle(ctx);
    }

    function noteAction(ctx, a) {
      ctx.txn = null;
      ctx.step({ group: 'note-' + ctx.steps.length, title: a.title, kind: 'note', parts: a.parts || [], text: a.text || [] });
    }
    function spiMiso(ctx, a) { ctx.st.spi.miso = a.value & 0x3FF; }

    function run(state, action) {
      var ctx = context(state);
      if (action.type === 'access') access(ctx, action);
      else if (action.type === 'gpio') gpioEvent(ctx, action);
      else if (action.type === 'uart-rx') uartRx(ctx, action);
      else if (action.type === 'time') timeAction(ctx, action);
      else if (action.type === 'csr') csrAction(ctx, action);
      else if (action.type === 'mret') mretAction(ctx);
      else if (action.type === 'note') noteAction(ctx, action);
      else if (action.type === 'spi-miso') spiMiso(ctx, action);
      else throw new Error('Unknown action ' + action.type);
      return { steps: ctx.steps, final: ctx.st, txn: ctx.txn };
    }

    // A sequence of actions; values may be functions of the state reached so far.
    function runAll(state, actions) {
      var st = state, steps = [], chapters = [];
      actions.forEach(function (raw) {
        var a = {};
        Object.keys(raw).forEach(function (k) { a[k] = typeof raw[k] === 'function' && k !== 'when' ? raw[k](st) : raw[k]; });
        if (raw.when && !raw.when(st)) return;
        var r = run(st, a);
        if (r.steps.length) chapters.push({ start: steps.length, title: a.chapter || actionTitle(a) });
        r.steps.forEach(function (s) { s.chapter = chapters.length - 1; steps.push(s); });
        st = r.final;
      });
      return { steps: steps, final: st, chapters: chapters };
    }
    function actionTitle(a) {
      if (a.type === 'access') return instrText(a) + '  →  ' + describe(((a.base >>> 0) + (a.offset | 0)) >>> 0);
      if (a.type === 'gpio') return 'gpio_' + a.bank + ' pin ' + a.pin + ' ' + (a.level ? 'rises' : 'falls');
      if (a.type === 'uart-rx') return 'uart_rx receives ' + hex8(a.byte);
      if (a.type === 'time') return a.until === 'event' ? 'Wait for the next device event' : a.cycles + ' peripheral clocks pass';
      if (a.type === 'csr') return a.field + ' ← ' + (a.value ? 1 : 0);
      if (a.type === 'mret') return 'mret';
      if (a.type === 'note') return a.title;
      return a.type;
    }

    return {
      layout: L,
      initial: settledInitial,
      preset: preset,
      PRESET_TIMER_GAP: PRESET_TIMER_GAP,
      resetValues: initial,
      run: run,
      runAll: runAll,
      classify: classify,
      describe: describe,
      beatOf: beatOf,
      irqView: irqView,
      timerIrq: timerIrq,
      deviceIrq: deviceIrq,
      sourceLevels: sourceLevels,
      uartPending: uartPending,
      eligible: eligible,
      nextEvent: nextEvent,
      uartLeft: uartLeft,
      spiLeft: spiLeft,
      instrText: instrText,
      actionTitle: actionTitle
    };
  }

  var api = {
    create: create,
    COMPONENTS: COMPONENTS,
    INSTANCES: INSTANCES,
    CAUSE: CAUSE,
    CAUSE_NAME: CAUSE_NAME,
    format: { hex32: hex32, hex64: hex64, hex8: hex8, hexShort: hexShort, size: size, bits: bits, maskText: maskText }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrismSystemBusModel = api;
})(typeof window !== 'undefined' ? window : this);
