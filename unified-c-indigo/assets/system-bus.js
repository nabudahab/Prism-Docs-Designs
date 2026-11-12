/* System bus, asynchronous peripherals and interrupt return: interactive view
   of the representative teaching composition in system-bus-model.js.

     PrismSystemBus.mount(holder, options) -> { dispose(), trace(access) }
     options.handoff: { op: 'lw' | 'sw', address, value, from } prefills the
       load/store form (for example the last access from the Caches tab).

   The diagram, step player and state tables render model snapshots. Steps are
   generated from the RTL rules in the model, not from a recorded simulation. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var Model = window.PrismSystemBusModel;
  var F = Model && Model.format;
  var serial = 0;
  var fitSetting;

  /* ---------- DOM helpers ---------- */
  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid === undefined || kid === null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(el, k); }); return; }
    el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  function setKids(el) { el.replaceChildren(); for (var i = 1; i < arguments.length; i++) add(el, arguments[i]); }
  function s(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (attrs[key] === undefined || attrs[key] === null) return;
      if (key === 'text') el.textContent = attrs[key];
      else el.setAttribute(key, String(attrs[key]));
    });
    if (parent) parent.appendChild(el);
    return el;
  }
  function code(text) { return h('code', { text: text }); }
  // `code` spans and [label](#/route) links in plain strings.
  function rich(text) {
    var out = [];
    String(text).split(/(`[^`]*`|\[[^\]]+\]\(#\/[^)]*\))/).forEach(function (part) {
      if (!part) return;
      var link = /^\[([^\]]+)\]\((#\/[^)]*)\)$/.exec(part);
      if (part.charAt(0) === '`' && part.length > 1) out.push(code(part.slice(1, -1)));
      else if (link) out.push(h('a', { href: link[2], text: link[1] }));
      else out.push(part);
    });
    return out;
  }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function parseNumber(text) {
    var t = String(text || '').trim().replace(/_/g, '').toLowerCase();
    if (/^-?0x[0-9a-f]+$/.test(t)) { var neg = t.charAt(0) === '-'; var v = parseInt(t.replace('-', ''), 16); return neg ? -v : v; }
    if (/^-?[0-9]+$/.test(t)) return parseInt(t, 10);
    return NaN;
  }

  /* ---------- geometry ---------- */
  var W = 1340, H = 852, SPLIT = 790;
  var ROW0 = 84, PITCH = 70, ROWH = 60;
  var DEVX = 1046, DEVW = 226;
  function rowY(i) { return ROW0 + i * PITCH; }
  // Collector x and irq0 entry y for each external source (nested L-shapes).
  var COLLECT = { gpio_a: [1312, 614], uart0: [1302, 584], spi0: [1292, 554], gpio_b: [1282, 524] };

  function buildGraph(L) {
    var nodes = [], wires = [], lanes = [];
    var rows = {};
    L.devices.filter(function (d) { return d.name !== 'irq0'; }).forEach(function (d, i) { rows[d.name] = i; });
    rows.none = 5;
    var IRQY = rowY(6) - 10, IRQH = 150;
    nodes.push({ id: 'core', x: 36, y: 84, w: 228, h: 108, cls: 'is-core', title: 'Base core', tag: 'example' });
    nodes.push({ id: 'caches', x: 36, y: 230, w: 228, h: 152, cls: 'is-cache', title: 'Local caches', tag: 'I$ · D$', subAt: 372, subLines: 1 });
    lanes.push({ id: 'lane_line', x: 48, y: 262, w: 204, h: 40, label: 'Line fill / write-back', sub: 'cacheable RAM window' });
    lanes.push({ id: 'lane_io', x: 48, y: 308, w: 204, h: 40, label: 'Uncached beat (bypass)', sub: 'ROM, MMIO, other non-RAM' });
    nodes.push({ id: 'csr', x: 36, y: 642, w: 228, h: 182, cls: 'is-csr', title: 'Trap logic and CSRs', tag: '' });
    nodes.push({ id: 'fabric', x: 336, y: 258, w: 124, h: 92, cls: 'is-module', title: 'Fabric', tag: '' });
    nodes.push({ id: 'system_bus', x: 500, y: 246, w: 172, h: 116, cls: 'is-module', title: 'system_bus', tag: '' });
    nodes.push({ id: 'ram', x: 396, y: 64, w: 182, h: 112, cls: 'is-memory', title: 'RAM', tag: '' });
    nodes.push({ id: 'rom', x: 596, y: 64, w: 168, h: 112, cls: 'is-memory', title: 'Boot ROM', tag: '' });
    nodes.push({ id: 'cdc', x: 716, y: 246, w: 148, h: 116, cls: 'is-bridge', title: 'mmio_cdc', tag: '' });
    nodes.push({ id: 'decoder', x: 900, y: ROW0, w: 116, h: IRQY + IRQH - ROW0, cls: 'is-decoder', title: 'mmio_', title2: 'decode_bus', tag: '' });
    L.devices.forEach(function (d) {
      if (d.name === 'irq0') nodes.push({ id: 'dev_irq0', x: DEVX, y: IRQY, w: DEVW, h: IRQH, cls: 'is-device is-irqc', title: '[' + d.index + '] irq0', tag: '', dev: d });
      else nodes.push({ id: 'dev_' + d.name, x: DEVX, y: rowY(rows[d.name]), w: DEVW, h: ROWH, cls: 'is-device is-source', title: '[' + d.index + '] ' + d.name, tag: '', dev: d, source: d.name });
    });
    nodes.push({ id: 'dev_none', x: DEVX, y: rowY(5), w: DEVW, h: ROWH, cls: 'is-none', title: 'No device → error', tag: '' });
    nodes.push({ id: 'sync_ext', x: 716, y: 700, w: 148, h: 58, cls: 'is-sync', title: 'external sync', tag: '' });
    nodes.push({ id: 'sync_tim', x: 716, y: 770, w: 148, h: 58, cls: 'is-sync', title: 'timer sync', tag: '' });

    // Transport wires.
    wires.push({ id: 'w_core_cache', c: 'c-core', pts: [[150, 192], [150, 230]], aria: 'Load or store request from the core’s MEM stage to the D-cache' });
    wires.push({ id: 'w_trap', c: 'c-trap', pts: [[120, 642], [120, 560], [28, 560], [28, 138], [36, 138]], aria: 'Trap redirect: PC ← mtvec on entry, PC ← mepc on mret', label: 'PC ← mtvec / mepc', lx: 128, ly: 600, anchor: 'start' });
    wires.push({ id: 'w_cfi', c: 'c-cache', pts: [[264, 304], [336, 304]], aria: 'cache_fabric_if data channel', label: 'cache_fabric_if', lx: 300, ly: 222 });
    wires.push({ id: 'w_sbi', c: 'c-bus', pts: [[460, 304], [500, 304]], aria: 'system_bus_if from the fabric to system_bus' });
    wires.push({ id: 'w_ram', c: 'c-bus', pts: [[548, 246], [548, 216], [487, 216], [487, 176]], aria: 'physical_ramif to RAM', label: 'physical_ramif', lx: 494, ly: 208, anchor: 'start' });
    wires.push({ id: 'w_rom', c: 'c-bus', pts: [[616, 246], [616, 216], [680, 216], [680, 176]], aria: 'romif to the boot ROM', label: 'romif', lx: 688, ly: 200, anchor: 'start' });
    wires.push({ id: 'w_mmio_cpu', c: 'c-mmio', pts: [[672, 304], [716, 304]], aria: 'cpu_mmio: mmio_if in the CPU clock domain' });
    wires.push({ id: 'w_mmio_per', c: 'c-mmio', pts: [[864, 304], [900, 304]], aria: 'peripherals: mmio_if in the peripheral clock domain' });
    L.devices.forEach(function (d) {
      var y = d.name === 'irq0' ? IRQY + 30 : rowY(rows[d.name]) + ROWH / 2;
      wires.push({ id: 'w_dev_' + d.name, c: 'c-mmio', pts: [[1016, y], [DEVX, y]], aria: 'devices[' + d.index + '] port to ' + d.name });
    });
    wires.push({ id: 'w_dev_none', c: 'c-error', pts: [[1016, rowY(5) + ROWH / 2], [DEVX, rowY(5) + ROWH / 2]], aria: 'Unmatched beats: the decoder answers with an error' });
    // Interrupt wires: separate from the transport.
    L.sources.forEach(function (d) {
      var c = COLLECT[d.name], y = rowY(rows[d.name]) + ROWH / 2;
      wires.push({ id: 'w_irq_' + d.name, c: 'c-irq', irq: true, pts: [[DEVX + DEVW, y], [c[0], y], [c[0], c[1]], [DEVX + DEVW, c[1]]],
        aria: d.name + ' irq level to irq_sources[' + d.bit + ']', entry: { y: c[1], label: 'src ' + d.bit } });
    });
    var irqMid = DEVX + DEVW / 2;
    wires.push({ id: 'w_ext_irq', c: 'c-irq', irq: true, pts: [[irqMid, IRQY + IRQH], [irqMid, 729], [864, 729]], aria: 'peripheral_external_irq from irq0 to the CPU-side synchronizer', label: 'peripheral_external_irq', lx: 968, ly: 719, anchor: 'middle' });
    wires.push({ id: 'w_ext_core', c: 'c-irq', irq: true, pts: [[716, 729], [264, 729]], aria: 'core external_irq into the tile', label: 'core external_irq', lx: 490, ly: 721 });
    var tRow = rowY(rows.timer0) + ROWH / 2;
    wires.push({ id: 'w_tim_irq', c: 'c-irq', irq: true, pts: [[DEVX + DEVW, tRow], [1326, tRow], [1326, 799], [864, 799]], aria: 'peripheral_timer_irq from timer0, bypassing irq0', label: 'peripheral_timer_irq', lx: 968, ly: 789, anchor: 'middle' });
    wires.push({ id: 'w_tim_core', c: 'c-irq', irq: true, pts: [[716, 799], [264, 799]], aria: 'core timer_irq into the tile', label: 'core timer_irq', lx: 490, ly: 791 });
    return { nodes: nodes, wires: wires, lanes: lanes, irqY: IRQY, irqH: IRQH };
  }

  /* ---------- part descriptions (RTL-backed) ---------- */
  function partInfo(id, L) {
    var ram = L.ram, rom = L.rom;
    var I = {
      core: { kind: 'Example core', title: 'Base core', text: [
        'This page uses Base as the example processor. Loads and stores compute their address in EX and access memory in MEM; an uncached access holds MEM until its response arrives, because every layer below is blocking.',
        'Base samples three machine interrupt levels into `mip` and takes a trap only at an instruction boundary, after older MEM/WB work drains. Any core tile meets the same bus through `cache_fabric_if`; the composition below the tile does not depend on the core.'],
        sources: ['source/core_tiles/base/rtl/pipeline/datapath.sv', 'source/core_tiles/base/rtl/pipeline/units/csr_file.sv'], links: [['#/architecture/core/base', 'Base datapath and assembly']] },
      caches: { kind: 'Tile component', title: 'Local caches', text: [
        'Only the RAM window ' + F.hex32(ram.base) + '–' + F.hex32(ram.last) + ' is cacheable (`memory_map_pkg::is_cacheable`). RAM accesses go through 16-byte lines: a miss reads two 8-byte beats with mask 0xFF, after writing back a dirty victim.',
        'ROM, peripheral and other non-RAM addresses bypass line allocation. Holes in the RAM reservation stay cacheable: they attempt a line fill, which errors and faults. The D-cache registers one beat with the access’s byte mask, issues it once and waits for the response, so a device side effect cannot repeat.',
        'The [Caches tab](#/architecture/caches) shows hits, misses and replacement.'],
        sources: ['source/core_tiles/base/rtl/caches/dcache.sv', 'source/soc/packages/memory_map_pkg.vh'], links: [['#/architecture/caches', 'Caches tab']] },
      lane_line: { kind: 'D-cache path', title: 'Line fill and write-back', text: ['Cacheable RAM traffic. Base’s D-cache has 8 sets × 2 ways × 16-byte lines, write-back and write-allocate: stores also fill the line first, and RAM sees a store only when the dirty line is written back.'], sources: ['source/core_tiles/base/rtl/caches/dcache.sv'], links: [['#/architecture/caches', 'Caches tab']] },
      lane_io: { kind: 'D-cache path', title: 'Uncached beat', text: ['For a word at offset +4 of an 8-byte beat the mask is 0xF0 and the data sits in the upper half; at +0 it is 0x0F. The response is shifted back down by the same byte offset.'], sources: ['source/core_tiles/base/rtl/caches/dcache.sv'] },
      csr: { kind: 'Core CSRs', title: 'Trap logic and CSRs', text: [
        'csr_file samples `external_irq` into mip.MEIP (bit 11) and `timer_irq` into mip.MTIP (bit 7) on every falling clk edge, whatever the enables are. Software cannot clear them through mip: only the source can.',
        'An interrupt is eligible when mstatus.MIE = 1 and (mie & mip) has a set bit. Priority: write-back error, external, software, timer. Entry sets mepc to the oldest unexecuted instruction, mcause to 0x8000_000B (external) or 0x8000_0007 (timer), mtval to 0, MPIE ← MIE, MIE ← 0, and jumps to mtvec (direct mode). mret sets MIE ← MPIE and MPIE ← 1.',
        'Neither trap entry nor mret talks to the interrupt controller. Claiming and completing are ordinary MMIO accesses by the handler.'],
        sources: ['source/core_tiles/base/rtl/pipeline/units/csr_file.sv', 'source/core_tiles/base/rtl/pipeline/datapath.sv', 'source/contracts/packages/trap_causes_pkg.vh'] },
      w_core_cache: { kind: 'Inside the tile', title: 'MEM-stage data request', text: ['The core’s data request to its D-cache. This is internal to the tile, not a Prism contract.'] },
      w_cfi: { kind: 'Interface contract', title: 'cache_fabric_if', mono: true, text: [
        'Blocking instruction and data channels from the tile to the fabric. Each beat is 8-byte aligned with a byte mask; a rising edge with wait = 0 completes it. It is not coherent: nothing here keeps another cache’s copy up to date.'],
        sources: ['source/contracts/interfaces/cache_fabric_if.vh'] },
      fabric: { kind: 'Component', title: 'Direct fabric', mono: false, text: [
        'Combinational arbiter for one tile. A data beat always wins over instruction fetch and can displace a waiting fetch; there is no grant register or queue. It drives system_bus_if with the selected beat and returns ACCESS or ERROR to the channel that owns it.'],
        sources: ['source/memory_fabrics/direct/rtl/cache_fabric.sv'] },
      w_sbi: { kind: 'Interface contract', title: 'system_bus_if', mono: true, text: ['One selected beat outstanding, no IDs. Targets report FREE, BUSY, ACCESS or ERROR; ACCESS or ERROR completes the beat on the rising edge.'], sources: ['source/soc/interfaces/system_bus_if.vh'] },
      system_bus: { kind: 'Component', title: 'system_bus', mono: true, text: [
        'Combinational router. address_decode selects RAM only inside its ' + F.size(ram.bytes) + ' installed and ROM only for reads inside its ' + F.size(rom.bytes) + ' installed: capacity is checked before the base is subtracted, so holes in a reservation do not alias storage.',
        'Every address in the peripheral aperture ' + F.hex32(L.mmio.base) + '–' + F.hex32(L.mmio.last) + ' raises mmio.valid (aligned data accesses only), including addresses where no device exists. While mmio.ready is low it answers BUSY.',
        'Misaligned beats, both enables, ROM writes, fetches from MMIO and unmapped addresses complete with ERROR at once.'],
        sources: ['source/soc/buses/rtl/system_bus.sv', 'source/soc/memory/rtl/address_decode.sv'] },
      w_ram: { kind: 'Target port', title: 'physical_ramif', mono: true, text: ['RAM sees the address minus ' + F.hex32(ram.base) + ', and only when the address lies in installed RAM.'], sources: ['source/soc/buses/rtl/system_bus.sv'] },
      ram: { kind: 'Storage', title: 'RAM', text: [
        F.size(ram.bytes) + ' installed at ' + F.hex32(ram.base) + ' inside a ' + F.size(ram.reserved) + ' reservation. A one-command synchronous RAM: it answers ACCESS after RAM_LAT cycles (default 1).',
        'Reads past the installed bytes complete with ERROR; for the cached core that becomes an access fault on refill.'],
        sources: ['source/soc/memory/rtl/ram.sv'], links: [['#/reference/address-map', 'Storage in the address map']] },
      w_rom: { kind: 'Target port', title: 'romif', mono: true, text: ['Reads only: romif.ramWEN is tied low.'], sources: ['source/soc/buses/rtl/system_bus.sv'] },
      rom: { kind: 'Storage', title: 'Boot ROM', text: [
        F.size(rom.bytes) + ' installed at ' + F.hex32(rom.base) + ' inside a ' + F.size(rom.reserved) + ' reservation. Reads answer ACCESS on the cycle after the address is registered. Writes and reads past the installed bytes complete with ERROR.',
        'ROM is not cacheable, so the core reads it one uncached beat at a time.'],
        sources: ['source/soc/memory/rtl/boot_rom.sv'] },
      w_mmio_cpu: { kind: 'Interface contract', title: 'mmio_if (cpu_mmio)', mono: true, text: ['The CPU-clock side of the peripheral port: one 64-bit beat, held from valid to completion. Completion is the clk edge with valid && ready; error alone does not complete it.'], sources: ['source/soc/interfaces/mmio_if.vh'] },
      cdc: { kind: 'Clock-domain bridge', title: 'mmio_cdc', mono: true, text: [
        'Present because this composition uses ASYNC_PERIPHERALS=1, as Prism’s FPGA wrappers do. One request at a time crosses by toggle handshake: the CPU side captures the request and flips request_toggle; two peripheral_clk flops synchronize it; the peripheral side raises valid until the device is ready, captures {error, read_data} and flips acknowledge_toggle; two clk flops bring it back; REPLY raises cpu.ready for one edge.',
        'Only the toggles are synchronized. The payload bundles are stable while their toggle crosses. How long a crossing takes depends on both clocks, so this page shows the order of edges, not a cycle count.',
        'The bridge carries no interrupt state. Interrupts have their own wires and synchronizers.'],
        sources: ['source/soc/buses/rtl/mmio_cdc.sv', 'source/soc/rtl/system.sv'] },
      w_mmio_per: { kind: 'Interface contract', title: 'mmio_if (peripherals)', mono: true, text: ['The same contract on peripheral_clk, from the bridge to the generated peripheral bank.'], sources: ['source/soc/interfaces/mmio_if.vh'] },
      decoder: { kind: 'Component', title: 'mmio_decode_bus', mono: true, text: [
        'Combinational. The decode address is the aligned beat address, plus 4 when any upper byte lane is enabled. A device port sees valid only when that address is inside its register window [base, base + register_bytes); every request field passes unchanged and the device validates the lanes.',
        'Windows in this composition: ' + L.devices.map(function (d) { return d.name + ' ' + F.hex32(d.base) + ' + ' + d.bytes; }).join(', ') + '.',
        'A beat that matches no window completes immediately with ready = 1, error = 1 and zero data. The optional external_bus port is disabled here (ENABLE_EXTERNAL = 0).'],
        sources: ['source/soc/buses/rtl/mmio_decode_bus.sv', 'scripts/build/soc.py'] },
      dev_none: { kind: 'Decoder default', title: 'No device', text: [
        'An access outside every modelled register window completes with an error. That covers devices this composition leaves out, the rest of each reservation past its register window, and the gaps between reservations.',
        'All of these reach mmio_decode_bus, which completes them with an error. The core reports a load or store access fault.'],
        sources: ['source/soc/buses/rtl/mmio_decode_bus.sv'], links: [['#/reference/address-map', 'Reserved regions']] },
      sync_ext: { kind: 'Synchronizer', title: 'external_sync[1:0]', mono: true, text: ['Two clk flops (ASYNC_REG) in system.sv carry peripheral_external_irq into the CPU domain. core external_irq = external_irq pin | external_sync[1]. It exists only with ASYNC_PERIPHERALS=1; otherwise the level connects directly.'], sources: ['source/soc/rtl/system.sv'] },
      sync_tim: { kind: 'Synchronizer', title: 'timer_sync[1:0]', mono: true, text: ['A separate pair of clk flops for peripheral_timer_irq. The timer never passes through irq0 or its synchronizer.'], sources: ['source/soc/rtl/system.sv'] },
      w_ext_irq: { kind: 'Interrupt level', title: 'peripheral_external_irq', mono: true, text: ['irq0’s output: 1 while any source is ACTIVE (pending, enabled and not in service). It is a retained level in the peripheral clock domain.'], sources: ['source/soc/peripherals/rtl/irq_controller.sv', 'source/soc/rtl/system.sv'] },
      w_ext_core: { kind: 'Interrupt level', title: 'core external_irq', mono: true, text: ['The synchronized level into the tile; Base maps it to mip.MEIP (bit 11).'], sources: ['source/core_tiles/base/rtl/pipeline/datapath.sv'] },
      w_tim_irq: { kind: 'Interrupt level', title: 'peripheral_timer_irq', mono: true, text: ['timer0’s comparator level, MTIME ≥ MTIMECMP (unsigned). It bypasses the IRQ controller entirely.'], sources: ['source/soc/peripherals/rtl/timer.sv'] },
      w_trap: { kind: 'Inside the tile', title: 'Trap redirect', text: ['On trap entry Base squashes younger work and fetches from mtvec (direct mode: every trap goes to one handler address). mret returns to mepc. Neither event sends anything to the bus or the interrupt controller.'], sources: ['source/core_tiles/base/rtl/pipeline/datapath.sv'] },
      w_tim_core: { kind: 'Interrupt level', title: 'core timer_irq', mono: true, text: ['The synchronized timer level into the tile; Base maps it to mip.MTIP (bit 7).'], sources: ['source/core_tiles/base/rtl/pipeline/datapath.sv'] }
    };
    if (I[id]) return I[id];
    var dm = /^(?:dev_|w_dev_|w_irq_)(.+)$/.exec(id);
    if (dm) {
      var d = L.byName[dm[1]];
      if (!d) return { kind: 'Part', title: id, text: [] };
      if (id.indexOf('w_dev_') === 0) return { kind: 'Device port', title: 'devices[' + d.index + '] → ' + d.name, mono: true, text: ['mmio_if from the decoder to ' + d.name + '. valid is raised only for beats whose decode address is inside ' + F.hex32(d.base) + ' + ' + d.bytes + ' bytes.'], sources: ['source/soc/buses/rtl/mmio_decode_bus.sv'] };
      if (id.indexOf('w_irq_') === 0) return { kind: 'Interrupt level', title: d.name + ' irq → irq_sources[' + d.bit + ']', mono: true, text: ['A level, not a pulse: it stays high while the device’s enabled pending condition holds. irq0 reports it as source ' + d.bit + ' and claim ID ' + d.id + '.'], sources: [d.comp.rtl, 'scripts/build/soc.py'] };
      return deviceInfo(d, L);
    }
    return { kind: 'Part', title: id, text: [] };
  }
  function regionBase(L, id) { var r = L.regions.filter(function (x) { return x.id === id; })[0]; return r ? r.base : 0; }
  function deviceInfo(d, L) {
    var head = d.name + ' is an instance of `' + d.comp.top + '` with a ' + d.bytes + '-byte modelled register window at ' + F.hex32(d.base) + ', inside the ' + F.size(d.region.bytes) + ' ' + d.region.id + ' reservation.';
    var T = {
      timer: ['ready is always 1. MTIME counts every peripheral_clk edge. timer_irq is the level MTIME ≥ MTIMECMP; after reset both are 0, so it is high until software raises MTIMECMP. A 32-bit access to +4 or +0xC uses the same beat address with mask 0xF0.',
        'It drives peripheral_timer_irq directly; it is not an irq0 source.'],
      irq: ['ready is always 1. Sources are level-sensitive. PENDING = installed source levels (PRESENT = ' + F.bits(L.present, 4) + ' here); ACTIVE = PENDING & ENABLE & ~in-service; irq = any ACTIVE bit.',
        'Reading CURRENT_IRQ returns the highest-priority ACTIVE source as ID = bit + 1 (0 = none; priority 0 still interrupts; ties go to the lower bit) and marks it in service. Writing that ID back completes it: only the in-service bit clears. Clear the device first, or its held level is claimed again.',
        'Errors (no effect): unmapped offsets, writes to PENDING, ACTIVE or PRESENT, partial CURRENT_IRQ accesses, and completing an ID that is not in service.'],
      gpio: ['ready is always 1. Inputs pass a two-flop synchronizer; IRQ_RISE/IRQ_FALL select which edges set IRQ_PENDING, which is recorded even when masked and cleared by writing one. irq = any (IRQ_PENDING & IRQ_ENABLE) bit.',
        'OUTPUT, SET, CLEAR and TOGGLE drive gpio_out only. They never reach the input or the edge detector, so writing outputs cannot raise an interrupt.'],
      uart: ['8N1 at DIVIDER peripheral clocks per bit (reset 868), one-byte receive register, no FIFO. A TX write while a frame is being sent holds ready low until it finishes; everything else completes at once.',
        'IRQ_PENDING = {FRAME_ERROR, OVERRUN, TX_COMPLETE, RX_VALID}. RX_VALID is cleared only by reading RX; the other three by writing one. irq = any (IRQ_PENDING & IRQ_ENABLE) bit.'],
      spi: ['Classic SPI subset only: the canonical 60-byte component adds QSPI segment registers and a second IRQ bit, which this model does not implement. Mode-0 master. A DATA write starts an 8-, 9- or 10-bit frame; DATA accesses wait while a frame is in progress. When the frame ends, RX_VALID (= IRQ_PENDING.COMPLETE) is set even if masked.',
        'irq = IRQ_ENABLE.COMPLETE & RX_VALID. Reading DATA or writing one to IRQ_PENDING clears it.']
    };
    var facts = [['Window', F.hex32(d.base) + ' + ' + d.bytes + ' B'], ['Reservation', d.region.id + ', ' + F.size(d.region.bytes)], ['devices[] index', String(d.index)]];
    if (d.bit !== null) facts.push(['Interrupt', 'source ' + d.bit + ', claim ID ' + d.id]);
    else if (d.irq === 'timer') facts.push(['Interrupt', 'peripheral_timer_irq (not through irq0)']);
    if (d.pins) facts.push(['Pins', d.pins]);
    return { kind: 'Peripheral', title: d.name + ' (' + d.comp.top + ')', mono: true, text: [head].concat(T[d.component]), facts: facts,
      sources: [d.comp.rtl, 'source/soc/peripherals/' + d.component + '.toml'], links: [['#/reference/address-map/' + encodeURIComponent(d.region.id), 'Registers in the address map']] };
  }

  // Grouped address choices for the load/store form.
  function targets(L) {
    var groups = [];
    groups.push({ label: 'Storage', items: [
      ['RAM + 0x100', L.ram.base, 0x100], ['RAM + 0x104 (upper word of a beat)', L.ram.base, 0x104],
      ['RAM hole: past ' + F.size(L.ram.bytes), (L.ram.base + L.ram.bytes) >>> 0, 0],
      ['Boot ROM + 0', L.rom.base, 0], ['Boot ROM + 4', L.rom.base, 4], ['ROM hole: past ' + F.size(L.rom.bytes), (L.rom.base + L.rom.bytes) >>> 0, 0]] });
    L.devices.forEach(function (d) {
      var items = (d.region.registers || []).filter(function (r) { return r.offset < d.bytes; }).slice(0, d.component === 'irq' ? 11 : 12).map(function (r) {
        return [d.name + ' ' + r.name.toUpperCase() + ' (+' + F.hexShort(r.offset) + ')', d.base, r.offset];
      });
      items.push([d.name + ' + ' + F.hexShort(d.bytes) + ' (past its window)', d.base, d.bytes]);
      groups.push({ label: d.name + ' (' + d.comp.top + ')', items: items });
    });
    groups.push({ label: 'No device in this composition', items: [['sysctrl reservation', regionBase(L, 'sysctrl'), 0], ['i2c reservation', regionBase(L, 'i2c'), 0], ['Outside every region', 0x20000000, 0]] });
    return groups;
  }

  /* ---------- summary steps ---------- */
  var GROUP_TITLES = {
    'req-tile': 'Tile → fabric: one uncached beat',
    'cdc-req': 'mmio_cdc carries the request into peripheral_clk',
    'cdc-rsp': 'mmio_cdc carries the response back to clk'
  };
  // Hops: a bus access becomes request out, device, response back.
  var PHASE = { core: 'out', 'req-tile': 'out', 'req-bus': 'out', 'cdc-req': 'out', 'cdc-rsp': 'back', 'rsp-core': 'back' };
  function phaseTitle(o) {
    var t = o.txn;
    if (!t || !PHASE[o.group]) return null;
    if (PHASE[o.group] === 'out') {
      var to = t.path === 'mmio' ? 'system_bus → mmio_cdc → decoder' : t.path === 'rom' ? 'system_bus → ROM' : t.path === 'cache' ? 'D-cache' : 'system_bus';
      return t.instr + ' (' + F.hex32(t.ea) + '): ' + (t.path === 'mmio' || t.path === 'rom' ? 'uncached beat → ' : '') + to;
    }
    return 'Response → core: ' + (t.outcome || t.result || 'done');
  }
  function summarize(steps) {
    var out = [];
    steps.forEach(function (st, i) {
      var last = out[out.length - 1];
      var key = PHASE[st.group] || st.group;
      if (last && last.chapter === st.chapter && last.key === key && !/^note-/.test(st.group)) {
        last.parts = union(last.parts, st.parts);
        last.flows = last.flows.concat(st.flows);
        last.subs.push(st.title);
        last.textLast = st.text;
        last.state = st.state; last.txn = st.txn; last.tone = last.tone || st.tone;
        last.title = GROUP_TITLES[st.group] || (st.group === 'irq-sync' ? st.title.replace('clk edge 2: ', 'Two clk flops → ') : st.title);
        last.kind = st.kind;
        last.last = i;
        return;
      }
      out.push({ key: key, group: st.group, chapter: st.chapter, title: st.title, text: st.text, textLast: null, subs: [st.title], parts: st.parts.slice(), flows: st.flows.slice(),
        state: st.state, txn: st.txn, tone: st.tone, kind: st.kind, first: i, last: i });
    });
    out.forEach(function (o) {
      if (o.subs.length > 1) { o.text = o.textLast; o.list = o.subs; }
      var pt = PHASE[o.group] && o.subs.length > 1 ? phaseTitle(o) : null;
      if (pt) o.title = pt;
    });
    return out;
  }
  function union(a, b) { var out = a.slice(); b.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); return out; }

  /* ---------- mount ---------- */
  function mount(holder, options) {
    options = options || {};
    var memory = window.PRISM_REFERENCE && window.PRISM_REFERENCE.memory;
    if (!Model || !memory) {
      setKids(holder, h('div', { class: 'notice notice-error', role: 'status' }, h('h2', { text: 'The system bus model is missing' }),
        h('p', { text: 'This view needs data/reference.js and assets/system-bus-model.js. Rebuild with make, then open dist/index.html.' })));
      return { dispose: function () {} };
    }
    var soc;
    try { soc = Model.create(memory); }
    catch (error) {
      setKids(holder, h('div', { class: 'notice notice-error', role: 'status' }, h('h2', { text: 'Address map data is incomplete' }), h('p', { text: String(error.message || error) })));
      return { dispose: function () {} };
    }
    var L = soc.layout, uid = 'sb' + (++serial), G = buildGraph(L);
    var usePreset = true;
    var committed = soc.preset();
    var rxNext = 0x41;
    var story = null, view = [], idx = 0, playing = false, timer = null, raf = null, speed = 1, detail = 'summary', selected = 'dev_gpio_a';
    var disposed = false;
    var parts = {}, wires = {}, dyn = {}, packets = null;

    if (fitSetting === undefined) {
      try { fitSetting = window.localStorage.getItem('prism-system-bus-scale') !== 'actual'; }
      catch (error) { fitSetting = true; }
    }
    var root = h('section', { class: 'sb' + (fitSetting ? ' sb-fit' : ''), 'aria-label': 'System bus, peripherals and interrupts' });
    root.style.setProperty('--sb-natural-w', W + 'px');

    /* ----- player bar ----- */
    var bStart = h('button', { type: 'button', class: 'sb-icon', 'aria-label': 'First step', title: 'First step', onclick: function () { pause(); go(0); } }, icon('first'));
    var bPrev = h('button', { type: 'button', class: 'sb-icon', 'aria-label': 'Previous step', title: 'Previous step', onclick: function () { pause(); go(idx - 1); } }, icon('prev'));
    var bPlay = h('button', { type: 'button', class: 'sb-icon sb-play', 'aria-label': 'Play', title: 'Play', onclick: function () { if (playing) pause(); else play(); } }, icon('play'));
    var bNext = h('button', { type: 'button', class: 'sb-icon', 'aria-label': 'Next step', title: 'Next step', onclick: function () { pause(); go(idx + 1); } }, icon('next'));
    var bEnd = h('button', { type: 'button', class: 'sb-icon', 'aria-label': 'Last step', title: 'Last step', onclick: function () { pause(); go(view.length - 1); } }, icon('last'));
    var speedSel = h('select', { id: uid + '-speed', onchange: function () { speed = parseFloat(speedSel.value); if (playing) { pause(); play(); } } },
      [['0.5', '0.5×'], ['1', '1×'], ['2', '2×'], ['4', '4×']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    speedSel.value = '1';
    var detailSel = h('input', { type: 'checkbox', id: uid + '-edges', onchange: function () { setDetail(detailSel.checked ? 'full' : 'summary'); } });
    var autoHandler = h('input', { type: 'checkbox', id: uid + '-handler', checked: true });
    var earlyComplete = h('input', { type: 'checkbox', id: uid + '-early' });
    var presetBtn = h('button', { type: 'button', class: 'sb-preset-btn', onclick: function () { usePreset = !usePreset; resetAll(); } });
    var presetNote = h('p', { class: 'sb-preset' });
    function setFit(on) {
      fitSetting = on;
      root.classList.toggle('sb-fit', on);
      fitBtn.setAttribute('aria-pressed', String(on));
      actualBtn.setAttribute('aria-pressed', String(!on));
      try { window.localStorage.setItem('prism-system-bus-scale', on ? 'fit' : 'actual'); } catch (error) { /* storage is optional */ }
      if (on) canvas.scrollLeft = 0;
      else followActive();
    }
    var fitBtn = h('button', { type: 'button', class: 'sb-fit-btn', 'aria-pressed': String(fitSetting),
      title: 'Fit the whole diagram to the page width', onclick: function () { setFit(true); } }, 'Fit to width');
    var actualBtn = h('button', { type: 'button', class: 'sb-fit-btn', 'aria-pressed': String(!fitSetting),
      title: 'Show the original size and follow the active hop', onclick: function () { setFit(false); } }, '100%');
    var handlerBar = h('div', { class: 'sb-handler-bar', role: 'group', 'aria-label': 'Handler instructions' });
    var progress = h('p', { class: 'sb-progress', 'aria-live': 'off' });
    // Options stay open on wide screens and start folded on phones.
    var optsBox = h('details', { class: 'sb-opts', open: !(window.matchMedia && window.matchMedia('(max-width: 700px)').matches) },
      h('summary', { text: 'Options' }),
      h('div', { class: 'sb-bar-opts' },
        h('label', { class: 'sb-inline', for: uid + '-speed' }, 'Speed', speedSel),
        h('label', { class: 'sb-check sb-small', for: uid + '-handler' }, autoHandler, 'Run the handler'),
        h('label', { class: 'sb-check sb-small', for: uid + '-early' }, earlyComplete, 'Complete before clearing the device'),
        h('label', { class: 'sb-check sb-small', for: uid + '-edges' }, detailSel, 'Every clock edge')));
    var bar = h('div', { class: 'sb-bar' },
      h('div', { class: 'sb-transport', role: 'group', 'aria-label': 'Step controls' }, bStart, bPrev, bPlay, bNext, bEnd),
      progress,
      h('div', { class: 'sb-scale-controls', role: 'group', 'aria-label': 'Diagram scale' }, fitBtn, actualBtn),
      optsBox);
    var stepTitle = h('p', { class: 'sb-step-title', 'aria-live': 'polite' });
    var handoffBox = h('div', { class: 'sb-handoff' });
    var caption = h('div', { class: 'sb-caption-bar' }, bar, stepTitle, h('div', { class: 'sb-bar-foot' }, presetNote, handlerBar), handoffBox);

    /* ----- diagram ----- */
    var canvas = h('div', { class: 'sb-canvas', tabindex: '-1' });
    var svg = drawSvg();
    canvas.appendChild(svg);
    var legend = h('ul', { class: 'sb-legend', 'aria-label': 'Legend' },
      legendItem('key-cache', 'cache_fabric_if'), legendItem('key-bus', 'system_bus_if'), legendItem('key-mmio', 'mmio_if'),
      legendItem('key-irq', 'interrupt level (separate wires)'), legendItem('key-irq-hi', 'level is 1'), legendItem('key-error', 'error path'),
      legendItem('key-step', 'active in this hop'));
    var figure = h('figure', { class: 'sb-figure' }, caption, canvas,
      h('figcaption', null, legend, h('p', { class: 'sb-figcap', text: 'Click a peripheral marked “IRQ ▸” to raise its interrupt; click any other block or wire for its RTL contract. Left of the dashed line runs on clk, right of it on peripheral_clk (ASYNC_PERIPHERALS=1). Hops are generated from the RTL rules, not recorded from a simulation; no cycle counts are implied across the two clocks.' })));

    /* ----- try it ----- */
    var tabs = [['access', 'Load / store'], ['inputs', 'Peripheral inputs and time'], ['core', 'Core and handler']];
    var tabButtons = {}, tabPanels = {};
    var tabList = h('div', { class: 'sb-tabs', role: 'tablist', 'aria-label': 'Do it yourself' });
    tabs.forEach(function (t, i) {
      var b = h('button', { type: 'button', role: 'tab', id: uid + '-tab-' + t[0], 'aria-controls': uid + '-panel-' + t[0], 'aria-selected': String(i === 0), tabindex: i === 0 ? '0' : '-1', text: t[1],
        onclick: function () { selectTab(t[0], false); }, onkeydown: function (e) {
          var k = tabs.map(function (x) { return x[0]; }), at = k.indexOf(t[0]);
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); selectTab(k[(at + (e.key === 'ArrowRight' ? 1 : k.length - 1)) % k.length], true); }
          else if (e.key === 'Home') { e.preventDefault(); selectTab(k[0], true); }
          else if (e.key === 'End') { e.preventDefault(); selectTab(k[k.length - 1], true); }
        } });
      tabButtons[t[0]] = b; tabList.appendChild(b);
      tabPanels[t[0]] = h('div', { role: 'tabpanel', id: uid + '-panel-' + t[0], 'aria-labelledby': uid + '-tab-' + t[0], class: 'sb-tabpanel', hidden: i !== 0 });
    });
    function selectTab(key, focus) {
      Object.keys(tabButtons).forEach(function (k) {
        var on = k === key;
        tabButtons[k].setAttribute('aria-selected', String(on)); tabButtons[k].tabIndex = on ? 0 : -1; tabPanels[k].hidden = !on;
      });
      if (focus) tabButtons[key].focus();
    }

    // Load / store form.
    var opSel = h('select', { id: uid + '-op', name: 'op' }, h('option', { value: 'lw', text: 'lw (load word)' }), h('option', { value: 'sw', text: 'sw (store word)' }));
    var baseIn = h('input', { id: uid + '-base', name: 'base', type: 'text', spellcheck: 'false', autocomplete: 'off', value: F.hex32(L.byName.gpio_a.base) });
    var offIn = h('input', { id: uid + '-off', name: 'offset', type: 'text', inputmode: 'numeric', spellcheck: 'false', autocomplete: 'off', value: '4', 'aria-describedby': uid + '-off-help' });
    var valIn = h('input', { id: uid + '-val', name: 'value', type: 'text', spellcheck: 'false', autocomplete: 'off', value: '0x0000_0005' });
    var pick = h('select', { id: uid + '-pick', name: 'target' }, h('option', { value: '', text: 'Choose a register or region…' }),
      targets(L).map(function (g, gi) { return h('optgroup', { label: g.label }, g.items.map(function (it, ii) { return h('option', { value: gi + ':' + ii, text: it[0] }); })); }));
    var TG = targets(L);
    var preview = h('div', { class: 'sb-preview', 'aria-live': 'polite' });
    var formError = h('p', { class: 'sb-form-error', role: 'alert' });
    var form = h('form', { class: 'sb-form', novalidate: true, onsubmit: function (e) { e.preventDefault(); runForm(); } },
      field('Target', pick, 'Fills t0 and the offset.'),
      h('div', { class: 'sb-form-row' }, field('Instruction', opSel), field('t0 (base register)', baseIn), field('Offset (−2048 … 2047)', offIn, null, uid + '-off-help'), field('t1 (store data)', valIn)),
      preview, formError,
      h('div', { class: 'sb-form-actions' }, h('button', { type: 'submit', class: 'sb-primary', text: 'Run this access' }),
        h('span', { class: 'sb-hint', text: 'Runs from the state at the end of the current story.' })));
    pick.addEventListener('change', function () {
      if (!pick.value) return;
      var p = pick.value.split(':'), it = TG[+p[0]].items[+p[1]];
      baseIn.value = F.hex32(it[1]); offIn.value = it[2] > 2047 ? '0' : String(it[2]);
      if (it[2] > 2047) baseIn.value = F.hex32((it[1] + it[2]) >>> 0);
      updatePreview();
    });
    [opSel, baseIn, offIn, valIn].forEach(function (el) { el.addEventListener('input', function () { pick.value = ''; updatePreview(); }); el.addEventListener('change', updatePreview); });
    tabPanels.access.append(form);
    function readForm() {
      var base = parseNumber(baseIn.value), off = parseNumber(offIn.value), val = parseNumber(valIn.value), op = opSel.value;
      if (isNaN(base) || base < 0 || base > 0xFFFFFFFF) return { error: 't0 must be a 32-bit value, for example 0x4001_0000.' };
      if (isNaN(off) || off < -2048 || off > 2047) return { error: 'The offset is a 12-bit signed immediate: −2048 to 2047.' };
      if (op === 'sw' && (isNaN(val) || val < -0x80000000 || val > 0xFFFFFFFF)) return { error: 't1 must be a 32-bit value.' };
      return { type: 'access', op: op, base: base >>> 0, offset: off, value: op === 'sw' ? (val >>> 0) : 0 };
    }
    function updatePreview() {
      valIn.disabled = opSel.value !== 'sw';
      var a = readForm();
      formError.textContent = '';
      if (a.error) { setKids(preview, h('p', { class: 'sb-dim', text: a.error })); return; }
      var ea = (a.base + a.offset) >>> 0, cls = soc.classify(ea), beat = soc.beatOf(ea, a.op, a.value);
      var path = ea & 3 ? 'Misaligned: traps in EX, no bus access' : cls.cacheable ? 'Cacheable: goes through the D-cache (line traffic only on a miss)' : 'Uncached beat ' + F.hex32(beat.address) + ', byte_enable ' + F.maskText(beat.mask) + (a.op === 'sw' ? ', write_data ' + F.hex64(beat.data) : '');
      setKids(preview, h('p', null, code(soc.instrText(a)), ' → ', h('strong', { text: F.hex32(ea) }), ' · ', soc.describe(ea)), h('p', { class: 'sb-dim', text: path }));
    }
    function runForm() {
      var a = readForm();
      if (a.error) { formError.textContent = a.error; return; }
      start([a], soc.instrText(a), false);
    }

    // Peripheral inputs and time.
    var pinRows = {};
    function pinRow(bank) {
      var dev = L.byName['gpio_' + bank];
      var row = h('div', { class: 'sb-pins', role: 'group', 'aria-label': dev.name + ' input pins' });
      for (var p = 7; p >= 0; p--) (function (pin) {
        row.appendChild(h('button', { type: 'button', class: 'sb-pin', 'aria-pressed': 'false', 'aria-label': dev.name + ' pin ' + pin, 'data-pin': pin,
          onclick: function () { var lvl = (committed.gpio[bank].pins >> pin) & 1; start([{ type: 'gpio', bank: bank, pin: pin, level: lvl ? 0 : 1 }], dev.name + ' pin ' + pin + (lvl ? ' falls' : ' rises'), false); } },
          h('span', { class: 'sb-pin-n', text: String(pin) }), h('span', { class: 'sb-pin-v', text: '0' })));
      })(p);
      pinRows[bank] = row;
      return h('div', { class: 'sb-input-block' }, h('p', { class: 'sb-mini-head', text: dev.name + ' gpio_in (pin 7 … 0)' }), row);
    }
    var rxIn = h('input', { id: uid + '-rx', type: 'text', value: '0x41', spellcheck: 'false', autocomplete: 'off', size: '6' });
    var rxFe = h('input', { id: uid + '-rxfe', type: 'checkbox' });
    var misoIn = h('input', { id: uid + '-miso', type: 'text', value: '0xA5', spellcheck: 'false', autocomplete: 'off', size: '6' });
    var inputError = h('p', { class: 'sb-form-error', role: 'alert' });
    tabPanels.inputs.append(
      h('p', { class: 'sb-dim', text: 'Pins and serial lines are outside the bus. Their effects reach the core only through interrupt levels, or when software reads the device.' }),
      h('div', { class: 'sb-input-grid' }, pinRow('a'), pinRow('b'),
        h('div', { class: 'sb-input-block' }, h('p', { class: 'sb-mini-head', text: 'uart0 uart_rx' }),
          h('div', { class: 'sb-inline-row' }, h('label', { for: uid + '-rx', text: 'Byte' }), rxIn,
            h('label', { class: 'sb-check' }, rxFe, ' stop bit low (framing error)'),
            h('button', { type: 'button', text: 'Receive', onclick: function () {
              var b = parseNumber(rxIn.value);
              if (isNaN(b) || b < 0 || b > 255) { inputError.textContent = 'The UART byte must be 0 to 255 (0x00 to 0xFF).'; return; }
              inputError.textContent = '';
              start([{ type: 'uart-rx', byte: b, frameError: rxFe.checked }], 'uart_rx receives ' + F.hex8(b), false);
            } }))),
        h('div', { class: 'sb-input-block' }, h('p', { class: 'sb-mini-head', text: 'spi0 spi_miso' }),
          h('div', { class: 'sb-inline-row' }, h('label', { for: uid + '-miso', text: 'The attached device answers' }), misoIn,
            h('span', { class: 'sb-dim', text: 'during the next frame (stand-in for a real device)' }))),
        h('div', { class: 'sb-input-block' }, h('p', { class: 'sb-mini-head', text: 'Peripheral time' }),
          h('div', { class: 'sb-inline-row' },
            h('button', { type: 'button', text: '+100 clocks', onclick: function () { start([{ type: 'time', cycles: 100 }], '100 peripheral clocks pass', false); } }),
            h('button', { type: 'button', text: '+10 000 clocks', onclick: function () { start([{ type: 'time', cycles: 10000 }], '10 000 peripheral clocks pass', false); } }),
            h('button', { type: 'button', text: 'Run to the next device event', onclick: function () { start([{ type: 'time', until: 'event' }], 'Wait for the next device event', false); } })))),
      inputError);
    misoIn.addEventListener('change', function () {
      var v = parseNumber(misoIn.value);
      if (isNaN(v) || v < 0 || v > 0x3FF) { inputError.textContent = 'MISO data must be 0 to 0x3FF (up to 10 bits).'; return; }
      inputError.textContent = '';
      committed.spi.miso = v;
      if (story) story.final.spi.miso = v;
    });

    // Core and handler.
    var csrBoxes = {};
    function csrToggle(field, label, help) {
      var cb = h('input', { type: 'checkbox', id: uid + '-' + field.replace('.', '-') });
      cb.addEventListener('change', function () { start([{ type: 'csr', field: field, value: cb.checked }], field + ' ← ' + (cb.checked ? 1 : 0), false); });
      csrBoxes[field] = cb;
      return h('label', { class: 'sb-switch', for: cb.id }, cb, h('span', null, h('strong', { text: label }), h('span', { class: 'sb-dim', text: ' ' + help })));
    }
    var claimBtn = h('button', { type: 'button', onclick: function () { start([{ type: 'access', op: 'lw', base: L.byName.irq0.base, offset: 0x18, value: 0 }], 'Claim: lw CURRENT_IRQ', false); } }, 'Claim: ', code('lw'), ' CURRENT_IRQ');
    var completeBtn = h('span', { class: 'sb-complete-set' });
    var mretBtn = h('button', { type: 'button', onclick: function () { start([{ type: 'mret' }], 'mret', false); } }, code('mret'));
    var resetBtn = h('button', { type: 'button', class: 'sb-reset', text: 'Reset the whole system', onclick: function () { resetAll(); } });
    var coreState = h('p', { class: 'sb-core-state', 'aria-live': 'polite' });
    tabPanels.core.append(
      h('div', { class: 'sb-switches' }, csrToggle('mstatus.MIE', 'mstatus.MIE', 'global machine interrupt enable'), csrToggle('mie.MEIE', 'mie.MEIE', 'external (irq0) enable'), csrToggle('mie.MTIE', 'mie.MTIE', 'timer enable')),
      coreState,
      h('p', { class: 'sb-mini-head', text: 'Handler steps (ordinary instructions)' }),
      h('div', { class: 'sb-inline-row' }, claimBtn, completeBtn, mretBtn),
      h('p', { class: 'sb-dim', text: 'Clear the cause in the device (for example a W1C store from the Load / store tab) before completing, or a level source is claimed again.' }),
      h('div', { class: 'sb-inline-row' }, resetBtn));

    var tryBox = h('section', { class: 'sb-panel sb-try', 'aria-labelledby': uid + '-try' }, h('h2', { id: uid + '-try', text: 'Do it yourself' }), tabList, tabPanels.access, tabPanels.inputs, tabPanels.core);

    /* ----- state panel ----- */
    var txnBox = h('div', { class: 'sb-txn' });
    var irqTable = h('div', { class: 'sb-irq' });
    var devBox = h('div', { class: 'sb-devstate' });
    var stateBox = h('section', { class: 'sb-panel sb-state', 'aria-labelledby': uid + '-state' }, h('h2', { id: uid + '-state', text: 'State at this step' }),
      h('h3', { text: 'Transaction' }), txnBox, h('h3', { text: 'Interrupt path' }), irqTable, h('h3', { text: 'Devices' }), devBox);

    /* ----- detail ----- */
    var detailBox = h('aside', { class: 'sb-panel sb-detail', id: uid + '-part', tabindex: '-1', 'aria-live': 'polite', 'aria-label': 'Selected part' });

    /* ----- routing table ----- */
    var routing = routingTable();

    var announcer = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
    var more = h('details', { class: 'sb-more' }, h('summary', null, 'More: run any load or store, peripheral inputs, CSR switches, live state and the address routing table'),
      h('div', { class: 'sb-work' }, tryBox, stateBox), routing);
    setKids(root, figure, detailBox, more, announcer);
    setKids(holder, root);

    if (options.handoff) showHandoff(options.handoff);
    updatePreview();
    showDetail();
    render();

    /* ---------- SVG ---------- */
    function legendItem(cls, label) {
      var ic = s('svg', { viewBox: '0 0 34 14', width: 34, height: 14, 'aria-hidden': 'true', class: 'sb-key ' + cls });
      s('path', { d: 'M2 7 H32' }, ic);
      return h('li', null, ic, label);
    }
    function drawSvg() {
      var svgEl = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-labelledby': uid + '-st', 'aria-describedby': uid + '-sd', class: 'sb-svg' });
      s('title', { id: uid + '-st', text: 'Representative Prism system: Base core tile, fabric, system_bus, RAM, boot ROM, mmio_cdc, peripheral decoder, six devices and interrupt wires' }, svgEl);
      s('desc', { id: uid + '-sd', text: 'The core’s D-cache sends RAM line traffic or one uncached beat over cache_fabric_if to the direct fabric and system_bus. system_bus routes to RAM, the boot ROM, or over mmio_if through mmio_cdc into the peripheral clock domain, where mmio_decode_bus selects timer0, irq0, gpio_a, uart0, spi0 or gpio_b, or answers with an error. Separate interrupt wires run from gpio_a, gpio_b, uart0 and spi0 into irq0, from irq0 through two clock-domain flops to the core’s external interrupt, and from timer0 through its own two flops to the core’s timer interrupt.' }, svgEl);
      // Clock domains.
      s('rect', { x: 8, y: 8, width: SPLIT - 8, height: H - 16, rx: 14, class: 'sb-domain sb-domain-cpu' }, svgEl);
      s('rect', { x: SPLIT, y: 8, width: W - SPLIT - 8, height: H - 16, rx: 14, class: 'sb-domain sb-domain-per' }, svgEl);
      s('line', { x1: SPLIT, y1: 14, x2: SPLIT, y2: H - 14, class: 'sb-split' }, svgEl);
      s('text', { x: 22, y: 30, class: 'sb-domain-label', text: 'clk domain' }, svgEl);
      s('text', { x: SPLIT + 14, y: 30, class: 'sb-domain-label', text: 'peripheral_clk domain' }, svgEl);
      // Tile boundary.
      s('rect', { x: 18, y: 44, width: 264, height: 796, rx: 12, class: 'sb-tile' }, svgEl);
      s('text', { x: 32, y: 68, class: 'sb-tile-label', text: 'Processor tile' }, svgEl);
      // Peripheral bank boundary.
      s('rect', { x: 884, y: 54, width: 446, height: G.irqY + G.irqH - 54 + 18, rx: 12, class: 'sb-bank' }, svgEl);
      s('text', { x: 898, y: 74, class: 'sb-tile-label', text: 'soc_peripherals (composed for this page)' }, svgEl);

      var wireLayer = s('g', { class: 'sb-wires' }, svgEl), nodeLayer = s('g', { class: 'sb-nodes' }, svgEl);
      packets = s('g', { class: 'sb-packets', 'aria-hidden': 'true' }, svgEl);
      G.wires.forEach(function (w) {
        var g = s('g', { class: 'sb-wire ' + w.c }, wireLayer);
        var d = w.pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
        s('path', { d: d, class: 'sb-line' }, g);
        var flow = s('path', { d: d, class: 'sb-flow' }, g);
        s('path', { d: d, class: 'sb-hit' }, g);
        var q = w.pts[w.pts.length - 1], p = w.pts[w.pts.length - 2];
        var dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, bx = q[0] - ux * 9, by = q[1] - uy * 9;
        s('polygon', { class: 'sb-arrow', points: [q[0], q[1], bx - uy * 4.5, by + ux * 4.5, bx + uy * 4.5, by - ux * 4.5].join(' ') }, g);
        if (w.label) s('text', { x: w.lx, y: w.ly, 'text-anchor': w.anchor || 'middle', class: 'sb-wire-label', text: w.label }, g);
        if (w.irq) dyn['lvl_' + w.id] = s('text', { x: w.pts[0][0] + (w.pts[1][0] >= w.pts[0][0] ? 6 : -6), y: w.pts[0][1] - 5, 'text-anchor': w.pts[1][0] >= w.pts[0][0] ? 'start' : 'end', class: 'sb-level', text: '0' }, g);
        wires[w.id] = { g: g, path: flow, def: w };
        interactive(g, w.id, w.aria);
      });
      G.nodes.forEach(function (n) {
        var g = s('g', { class: 'sb-node ' + n.cls }, nodeLayer);
        s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8, class: 'sb-box' }, g);
        var tx = n.x + 12, ty = n.y + 23;
        var t = s('text', { x: tx, y: ty, class: 'sb-node-title' }, g);
        s('tspan', { text: n.title }, t);
        if (n.tag) s('tspan', { text: '  ' + n.tag, class: 'sb-node-tag' }, t);
        if (n.source) {
          var bg = s('g', { class: 'sb-raise', 'aria-hidden': 'true' }, g);
          s('rect', { x: n.x + n.w - 62, y: n.y + 7, width: 54, height: 22, rx: 11 }, bg);
          s('text', { x: n.x + n.w - 35, y: n.y + 22.5, 'text-anchor': 'middle', text: 'IRQ ▸' }, bg);
        }
        if (n.title2) s('text', { x: tx, y: ty + 19, class: 'sb-node-title', text: n.title2 }, g);
        var lines = [];
        var first = n.subAt || ty + (n.title2 ? 40 : 21);
        var maxLines = n.subLines || Math.max(1, Math.floor((n.y + n.h - first - 2) / 18) + 1);
        for (var i = 0; i < maxLines; i++) lines.push(s('text', { x: tx, y: first + i * 18, class: 'sb-node-sub' }, g));
        dyn[n.id] = lines;
        parts[n.id] = g;
        interactive(g, n.id, n.source ? 'Raise the ' + n.source + ' interrupt' : n.title + (n.tag ? ' ' + n.tag : ''), n.source);
      });
      G.wires.forEach(function (w) {
        if (w.entry) s('text', { x: DEVX + DEVW - 8, y: w.entry.y + 4, 'text-anchor': 'end', class: 'sb-entry', text: w.entry.label }, nodeLayer);
      });
      G.lanes.forEach(function (ln) {
        var g = s('g', { class: 'sb-lane' }, nodeLayer);
        s('rect', { x: ln.x, y: ln.y, width: ln.w, height: ln.h, rx: 6, class: 'sb-lane-box' }, g);
        s('text', { x: ln.x + 10, y: ln.y + 17, class: 'sb-lane-title', text: ln.label }, g);
        s('text', { x: ln.x + 10, y: ln.y + 35, class: 'sb-lane-sub', text: ln.sub }, g);
        parts[ln.id] = g;
        interactive(g, ln.id, ln.label);
      });
      return svgEl;
    }
    function interactive(el, id, label, source) {
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', label);
      if (!source) el.setAttribute('aria-controls', uid + '-part');
      el.setAttribute('data-part', id);
      if (source) el.setAttribute('data-source', source);
      function act() { if (source) { selected = id; showDetail(); raise(source); } else choose(id, true); }
      el.addEventListener('click', function (e) { e.stopPropagation(); act(); });
      el.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act(); } });
      if (!parts[id] && !wires[id]) parts[id] = el;
    }
    function icon(kind) {
      var paths = { first: 'M5 4v12M16 4l-8 6 8 6z', prev: 'M14 4l-8 6 8 6z', next: 'M6 4l8 6-8 6z', last: 'M15 4v12M4 4l8 6-8 6z', play: 'M6 3.5l11 6.5-11 6.5z', pause: 'M6 4h3v12H6zM11 4h3v12h-3z' };
      var el = s('svg', { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': 'true' });
      s('path', { d: paths[kind], fill: 'currentColor', stroke: 'currentColor', 'stroke-width': kind === 'first' || kind === 'last' ? 1.6 : 0.6, 'stroke-linejoin': 'round' }, el);
      return el;
    }

    /* ---------- story control ---------- */
    function start(actions, title, fromReset, scenario, withHandler) {
      pause();
      var base = fromReset ? (usePreset ? soc.preset() : soc.initial()) : (story ? story.final : committed);
      var r;
      try { r = runChain(base, actions, withHandler); }
      catch (error) { formError.textContent = 'This action could not be modelled: ' + (error.message || error); return; }
      story = { title: title, scenario: scenario || null, base: base, steps: r.steps, chapters: r.chapters, final: r.final };
      committed = r.final;
      rebuildView();
      idx = 0;
      render();
      announce(title + '. ' + view.length + ' hops.');
      if (!reducedMotion() && view.length > 1) play();
    }
    // Run actions, then (optionally) the interrupt handler a firmware would
    // run: claim over MMIO, clear the device, complete over MMIO, mret.
    function runChain(base, actions, withHandler) {
      var steps = [], chapters = [], st = base;
      function part(list) {
        var r = soc.runAll(st, list), off = chapters.length;
        r.chapters.forEach(function (c) { chapters.push({ start: steps.length + c.start, title: c.title }); });
        r.steps.forEach(function (x) { x.chapter += off; steps.push(x); });
        st = r.final;
      }
      part(actions);
      var guard = 0, early = earlyComplete.checked;
      while (withHandler && autoHandler.checked && st.cpu.context === 'handler' && st.cpu.mcause !== null && (st.cpu.mcause >>> 31) && guard++ < 4) {
        part(handlerFor(st, early));
        early = false;
      }
      return { steps: steps, chapters: chapters, final: st };
    }
    function acc(op, base, offset, value, chapter) { return { type: 'access', op: op, base: base, offset: offset, value: value || 0, chapter: chapter }; }
    function mtimeLow(st) { return Number(st.timer.mtime & BigInt(0xFFFFFFFF)) >>> 0; }
    function handlerFor(st, early) {
      var irq = L.byName.irq0.base;
      if (st.cpu.mcause === Model.CAUSE.timer) {
        return [acc('sw', L.byName.timer0.base, 8, (mtimeLow(st) + soc.PRESET_TIMER_GAP) >>> 0, 'Handler: MTIMECMP_LOW ← MTIME + ' + soc.PRESET_TIMER_GAP + ' (clears timer_irq)'), { type: 'mret', chapter: 'Handler: mret' }];
      }
      var id = soc.irqView(st).winner;
      if (!id) return [acc('lw', irq, 0x18, 0, 'Handler: claim returns 0 (nothing active)'), { type: 'mret', chapter: 'Handler: mret' }];
      var d = L.sources.filter(function (x) { return x.id === id; })[0];
      var clear = d.component === 'gpio' ? acc('sw', d.base, 0x1C, 0xFF, 'Handler: clear ' + d.name + ' IRQ_PENDING (write one to clear)')
        : d.component === 'uart' ? acc('lw', d.base, 4, 0, 'Handler: read uart0 RX (clears RX_VALID)')
        : acc('lw', d.base, 0, 0, 'Handler: read spi0 DATA (clears RX_VALID)');
      var claim = acc('lw', irq, 0x18, 0, 'Handler: claim (lw CURRENT_IRQ → ' + id + ')');
      var complete = acc('sw', irq, 0x18, id, 'Handler: complete (sw ' + id + ' → CURRENT_IRQ)');
      var ret = { type: 'mret', chapter: 'Handler: mret' };
      return early ? [claim, complete, ret] : [claim, clear, complete, ret];
    }
    function raise(name) {
      var st = story ? story.final : committed, d = L.byName[name], actions;
      if (d.component === 'gpio') actions = [{ type: 'gpio', bank: d.bank, pin: 0, level: (st.gpio[d.bank].pins & 1) ? 0 : 1 }];
      else if (d.component === 'uart') { actions = [{ type: 'uart-rx', byte: rxNext }]; rxNext = rxNext >= 0x5A ? 0x41 : rxNext + 1; }
      else if (d.component === 'spi') actions = [acc('sw', d.base, 0, 0x3C, 'sw 0x3C → spi0 DATA (starts a frame)'), { type: 'time', until: 'event', chapter: 'The frame finishes' }];
      else actions = st.timer.mtime < st.timer.mtimecmp ? [{ type: 'time', until: 'event', chapter: 'MTIME counts up to MTIMECMP' }] : [{ type: 'note', title: 'timer_irq is already 1 (MTIME ≥ MTIMECMP)', parts: ['dev_timer0'] }];
      start(actions, name + ' raises its interrupt', false, null, true);
    }
    function resetAll() {
      pause(); committed = usePreset ? soc.preset() : soc.initial(); story = null; view = []; idx = 0; render();
      announce(usePreset ? 'Teaching preset restored' : 'All registers at reset values');
    }
    function rebuildView() {
      if (!story) { view = []; return; }
      view = detail === 'full' ? story.steps.map(function (st, i) { var o = Object.create(st); o.first = i; o.last = i; return o; }) : summarize(story.steps);
    }
    function setDetail(value) {
      var at = view[idx] ? view[idx].first : 0;
      detail = value;
      rebuildView();
      idx = 0;
      for (var i = 0; i < view.length; i++) if (view[i].first <= at && view[i].last >= at) { idx = i; break; }
      render();
    }
    function go(i) {
      if (!view.length) return;
      idx = Math.max(0, Math.min(view.length - 1, i));
      render();
    }
    function stepDuration() { return 1700 / speed; }
    function dwellFor() {
      var flows = view[idx] ? view[idx].flows.length : 0;
      return reducedMotion() ? 2200 / speed : stepDuration() + Math.min(3, flows) * 250 / speed + 600 / speed;
    }
    function play() {
      if (!view.length) return;
      var finished = idx >= view.length - 1 && (!anim || elapsedNow() >= dwellFor());
      if (anim && anim.idx === idx && !finished) {
        // Resume the frozen hop from where it stopped.
        playing = true;
        anim.start = now();
        syncPlay();
        if (!reducedMotion() && anim.items.length) loop();
        schedule();
        return;
      }
      if (idx >= view.length - 1) idx = 0;
      playing = true;
      render();
      schedule();
    }
    function schedule() {
      clearTimeout(timer);
      if (!playing) return;
      timer = setTimeout(function () {
        if (disposed || !playing) return;
        if (idx >= view.length - 1) { pause(); return; }
        idx++;
        render();
        schedule();
      }, Math.max(0, dwellFor() - elapsedNow()));
    }
    function pause() {
      if (anim && playing) { anim.base = elapsedNow(); anim.start = null; }
      playing = false;
      clearTimeout(timer);
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (bPlay) syncPlay();
    }
    function syncPlay() {
      root.classList.toggle('is-playing', playing);
      bPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
      bPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      bPlay.title = playing ? 'Pause' : 'Play';
    }

    /* ---------- render ---------- */
    function render() {
      var cur = view[idx] || null;
      var st = cur ? cur.state : committed;
      syncPlay();
      var none = !view.length;
      bStart.disabled = bPrev.disabled = none || idx === 0;
      bNext.disabled = bEnd.disabled = none || idx >= view.length - 1;
      bPlay.disabled = none || view.length < 2;
      progress.textContent = none ? 'Ready' : 'Hop ' + (idx + 1) + ' of ' + view.length;
      var ch = cur && story.chapters[cur.chapter];
      if (cur) setKids(stepTitle, ch ? h('span', { class: 'sb-chapter-tag', text: ch.title }) : null, cur.title);
      else setKids(stepTitle, 'Click ', h('strong', { text: 'gpio_a, gpio_b, uart0, spi0 or timer0' }), ' in the diagram to raise its interrupt.');
      stepTitle.className = 'sb-step-title' + (cur && cur.tone === 'error' ? ' is-error' : '');
      root.classList.toggle('has-step', !!cur);
      // Highlights.
      var active = cur ? cur.parts : [];
      var flowWires = {};
      (cur ? cur.flows : []).forEach(function (f) { flowWires[f.wire] = flowWires[f.wire] || f.dir; });
      Object.keys(parts).forEach(function (id) {
        parts[id].classList.toggle('is-active', active.indexOf(id) >= 0);
        parts[id].classList.toggle('is-error', !!(cur && cur.tone === 'error' && active.indexOf(id) >= 0));
        parts[id].setAttribute('aria-pressed', String(id === selected));
      });
      Object.keys(wires).forEach(function (id) {
        var w = wires[id], dir = flowWires[id];
        w.g.classList.toggle('is-flow', !!dir);
        w.g.classList.toggle('is-rsp', dir === 'rsp');
        w.g.classList.toggle('is-req', dir === 'req');
        w.g.setAttribute('aria-pressed', String(id === selected));
      });
      levelsUpdate(st);
      nodeText(st);
      animate(cur);
      followActive();
      stateUpdate(st, cur);
      controlsUpdate();
    }
    function levelsUpdate(st) {
      var v = soc.irqView(st);
      var lv = {};
      L.sources.forEach(function (d) { lv['w_irq_' + d.name] = soc.deviceIrq(st, d); });
      lv.w_ext_irq = v.irq; lv.w_tim_irq = soc.timerIrq(st);
      lv.w_ext_core = st.cpu.extSync[1] === 1; lv.w_tim_core = st.cpu.timSync[1] === 1;
      Object.keys(lv).forEach(function (id) {
        if (!wires[id]) return;
        wires[id].g.classList.toggle('is-high', !!lv[id]);
        if (dyn['lvl_' + id]) dyn['lvl_' + id].textContent = lv[id] ? '1' : '0';
      });
    }
    // Narrow screens: keep the active hop in view inside the scrolling canvas.
    function followActive() {
      if (root.classList.contains('sb-fit') || canvas.scrollWidth <= canvas.clientWidth + 4) return;
      var cur = view[idx];
      if (!cur) return;
      var xs = [];
      cur.parts.forEach(function (id) { if (parts[id] && parts[id].getBBox) { var bb = parts[id].getBBox(); xs.push(bb.x, bb.x + bb.width); } });
      cur.flows.forEach(function (f) { if (wires[f.wire]) { var bb = wires[f.wire].path.getBBox(); xs.push(bb.x, bb.x + bb.width); } });
      if (!xs.length) return;
      var scale = svg.getBoundingClientRect().width / W;
      var mid = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 * scale;
      var left = Math.max(0, mid - canvas.clientWidth / 2);
      if (canvas.scrollTo) canvas.scrollTo({ left: left, behavior: reducedMotion() ? 'auto' : 'smooth' }); else canvas.scrollLeft = left;
    }
    function setLines(id, lines) {
      var els = dyn[id] || [];
      els.forEach(function (el, i) { el.textContent = lines[i] || ''; });
    }
    // One cause/mask line per device; registers live in the inspector and state tables.
    function nodeText(st) {
      var c = st.cpu, v = soc.irqView(st);
      setLines('core', ['lw/sw access in MEM', c.context === 'handler' ? 'In a trap handler' : 'Running the main program', c.context === 'handler' ? 'mcause ' + F.hex32(c.mcause) : '']);
      setLines('caches', ['Internals: Caches tab']);
      setLines('csr', ['mstatus MIE ' + b(c.mstatusMIE) + ' MPIE ' + b(c.mstatusMPIE), 'mie  MEIE ' + b(c.MEIE) + ' MTIE ' + b(c.MTIE), 'mip  MEIP ' + b(c.MEIP) + ' MTIP ' + b(c.MTIP),
        'eligible: ' + (soc.eligible(st) ? 'yes' : 'no'), c.mcause !== null ? 'mcause ' + F.hex32(c.mcause) : 'mcause —', '', '']);
      setLines('fabric', ['direct', 'data first', 'no queue']);
      setLines('system_bus', ['address_decode', 'RAM · ROM · MMIO', 'BUSY until ready']);
      setLines('ram', [F.size(L.ram.bytes) + ' installed', 'of ' + F.size(L.ram.reserved) + ' reserved', 'at ' + F.hex32(L.ram.base)]);
      setLines('rom', [F.size(L.rom.bytes) + ' installed', 'of ' + F.size(L.rom.reserved) + ' reserved', 'at ' + F.hex32(L.rom.base)]);
      setLines('cdc', ['clk: ' + st.cdc.state, 'pclk: valid ' + st.cdc.active]);
      setLines('decoder', [L.devices.length + ' windows', 'else error']);
      setLines('dev_timer0', ['MTIME ≥ CMP → ' + b(soc.timerIrq(st))]);
      ['a', 'b'].forEach(function (k) { var x = st.gpio[k]; setLines('dev_gpio_' + k, ['pend ' + F.hex8(x.pend) + ' & en ' + F.hex8(x.ie)]); });
      setLines('dev_uart0', ['pend ' + F.bits(soc.uartPending(st.uart), 4) + ' & en ' + F.bits(st.uart.ie, 4)]);
      setLines('dev_spi0', ['RX_VALID ' + b(st.spi.rxValid) + ' & en ' + b(st.spi.ie)]);
      setLines('dev_irq0', ['PENDING ' + F.bits(v.pending, 4), 'ENABLE  ' + F.bits(st.irq.enable, 4), 'IN-SERV ' + F.bits(st.irq.inService, 4), 'ACTIVE  ' + F.bits(v.active, 4), 'claim → ID ' + v.winner, 'irq out ' + b(v.irq)]);
      setLines('dev_none', ['omitted devices, gaps']);
      setLines('sync_ext', ['flops ' + c.extSync[0] + ' → ' + c.extSync[1]]);
      setLines('sync_tim', ['flops ' + c.timSync[0] + ' → ' + c.timSync[1]]);
    }
    function b(x) { return x ? '1' : '0'; }
    function trim(t, n) { return t.length > n ? t.slice(0, n - 1) + '…' : t; }
    function shortBig(v) { var x = v.toString(16).toUpperCase(); return '0x' + (x.length > 8 ? '…' + x.slice(-8) : x); }

    // One clock drives packet travel: Pause freezes it (packets and dashes stay
    // where they are) and Play resumes from the same point. Without playback,
    // or with reduced motion, packets sit still, spread along their wires, each
    // with an arrowhead for its direction.
    var anim = null;
    function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
    function elapsedNow() { return anim ? anim.base + (playing && anim.start !== null ? now() - anim.start : 0) : 0; }
    function animate(cur) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      packets.replaceChildren();
      anim = { idx: idx, items: [], base: 0, start: playing ? now() : null };
      if (!cur || !cur.flows.length) return;
      var seen = {}, flows = cur.flows.filter(function (f) { var k = f.wire + f.dir + f.label; if (seen[k]) return false; seen[k] = true; return !!wires[f.wire]; });
      var perWire = {};
      anim.items = flows.map(function (f) {
        var g = s('g', { class: 'sb-packet sb-packet-' + f.dir }, packets);
        var label = f.label || '';
        var width = Math.max(18, label.length * 7.6 + 14);
        s('rect', { x: -width / 2, y: -11, width: width, height: 22, rx: 11 }, g);
        s('text', { x: 0, y: 4.5, 'text-anchor': 'middle', text: label }, g);
        var head = s('polygon', { class: 'sb-packet-head' }, g);
        var path = wires[f.wire].path;
        perWire[f.wire] = (perWire[f.wire] || 0) + 1;
        return { g: g, head: head, path: path, len: path.getTotalLength(), rev: f.dir === 'rsp', w: width, wire: f.wire, slot: perWire[f.wire] - 1 };
      });
      anim.items.forEach(function (it) { it.share = perWire[it.wire]; });
      if (!playing || reducedMotion()) { anim.items.forEach(function (it) { place(it, (it.slot + 1) / (it.share + 1)); }); return; }
      anim.items.forEach(function (it) { it.g.style.opacity = '0'; });
      loop();
    }
    function place(it, t) {
      var at = Math.max(0, Math.min(it.len, it.rev ? it.len * (1 - t) : it.len * t));
      var p = it.path.getPointAtLength(at);
      var a = it.path.getPointAtLength(Math.max(0, at - 2)), b2 = it.path.getPointAtLength(Math.min(it.len, at + 2));
      var dx = b2.x - a.x, dy = b2.y - a.y, l = Math.hypot(dx, dy) || 1, ux = dx / l * (it.rev ? -1 : 1), uy = dy / l * (it.rev ? -1 : 1);
      var off = Math.abs(ux) * it.w / 2 + Math.abs(uy) * 11 + 2;
      var tx = ux * (off + 8), ty = uy * (off + 8), bx = ux * off, by = uy * off;
      it.head.setAttribute('points', [tx, ty, bx - uy * 5.5, by + ux * 5.5, bx + uy * 5.5, by - ux * 5.5].map(function (v) { return v.toFixed(1); }).join(' '));
      it.g.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')');
    }
    function travel() { return stepDuration(); }
    function positionAt(el) {
      var items = anim.items, n = items.length, per = travel() / Math.max(1, Math.min(n, 3)), stride = per * (n > 3 ? 3 / n : 1), done = true;
      items.forEach(function (it, i) {
        var t = (el - i * stride) / per;
        if (t < 0) { done = false; it.g.style.opacity = '0'; return; }
        it.g.style.opacity = '1';
        if (t < 1) done = false;
        place(it, Math.min(1, t));
      });
      return done;
    }
    function loop() {
      raf = requestAnimationFrame(function () {
        raf = null;
        if (disposed || !playing || !anim) return;
        if (!positionAt(elapsedNow())) loop();
      });
    }

    function stateUpdate(st, cur) {
      // Transaction.
      var t = cur && cur.txn;
      if (!t) setKids(txnBox, h('p', { class: 'sb-dim', text: cur ? 'No load or store in this action.' : 'Run an access to see its beat here.' }));
      else {
        var rows = [['Instruction', code(t.instr)], ['Effective address', code(F.hex32(t.ea))], ['Target', t.target],
          ['Path', t.path === 'cache' ? 'D-cache (' + (t.cache || 'lookup') + ')' : t.path === 'mmio' ? 'uncached beat → mmio_cdc → decoder' : t.path === 'rom' ? 'uncached beat → system_bus → ROM' : t.path === 'none' ? (t.beats.length ? 'uncached beat → system_bus' : 'none') : '—']];
        if (t.reg) rows.push(['Register', t.reg]);
        setKids(txnBox, h('dl', { class: 'sb-facts' }, rows.map(function (r) { return h('div', null, h('dt', { text: r[0] }), h('dd', null, r[1])); })),
          t.beats.length ? h('div', { class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label': 'Beats on the bus' },
            h('table', { class: 'sb-table' }, h('thead', null, h('tr', null, ['Beat', 'Address', 'byte_enable', 'Data', 'Response'].map(function (c) { return h('th', { scope: 'col', text: c }); }))),
              h('tbody', null, t.beats.map(function (bt) {
                return h('tr', null, h('td', { text: (bt.kind === 'uncached' ? (bt.write ? 'write' : 'read') : bt.kind) }), h('td', null, code(F.hex32(bt.address))), h('td', null, code(F.hex8(bt.mask))),
                  h('td', null, bt.data !== null && bt.data !== undefined ? code(F.hex64(bt.data)) : bt.write ? '—' : h('span', { class: 'sb-dim', text: t.result ? (t.path === 'rom' && t.result === 'ACCESS' ? 'boot image' : '—') : 'pending' })),
                  h('td', { class: bt.response === 'ERROR' ? 'is-error' : null, text: t.result || bt.response ? (bt.response || t.result) : 'pending' }));
              })))) : null,
          h('p', { class: 'sb-outcome' + (t.result === 'ERROR' || /fault|misaligned/i.test(t.outcome || '') ? ' is-error' : '') }, h('strong', { text: 'Result: ' }), t.outcome || 'in progress…'));
      }
      // Interrupt path.
      var v = soc.irqView(st), c = st.cpu;
      var head = ['Source', 'Device condition', 'irq', 'ENABLE', 'PRIO', 'In service', 'ACTIVE'];
      var body = L.sources.map(function (d) {
        var on = function (n) { return (n >>> d.bit) & 1; };
        return h('tr', { class: on(v.active) ? 'is-hot' : null },
          h('th', { scope: 'row' }, d.name, h('span', { class: 'sb-dim', text: ' [' + d.bit + '] ID ' + d.id })),
          h('td', { text: condText(st, d) }), h('td', null, lvl(on(v.pending))), h('td', null, lvl(on(st.irq.enable))), h('td', { text: String(st.irq.prio[d.bit]) }),
          h('td', null, lvl(on(st.irq.inService))), h('td', null, lvl(on(v.active))));
      });
      setKids(irqTable,
        h('div', { class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label': 'irq0 sources' },
          h('table', { class: 'sb-table sb-irq-table' }, h('caption', { class: 'visually-hidden', text: 'irq0 sources' }), h('thead', null, h('tr', null, head.map(function (x) { return h('th', { scope: 'col', text: x }); }))), h('tbody', null, body))),
        h('dl', { class: 'sb-chain' },
          chain('irq0 claim winner', v.winner ? 'ID ' + v.winner + ' (' + srcLabel(v.winner) + ')' : '0 (none active)'),
          chain('peripheral_external_irq', v.irq ? '1' : '0', v.irq),
          chain('external_sync', c.extSync[0] + ' → ' + c.extSync[1], c.extSync[1] === 1),
          chain('mip.MEIP · mie.MEIE', b(c.MEIP) + ' · ' + b(c.MEIE), c.MEIP && c.MEIE),
          chain('timer0: MTIME ≥ MTIMECMP', F.hex64(st.timer.mtime) + ' vs ' + F.hex64(st.timer.mtimecmp) + ' → ' + (soc.timerIrq(st) ? '1' : '0'), soc.timerIrq(st)),
          chain('timer_sync', c.timSync[0] + ' → ' + c.timSync[1], c.timSync[1] === 1),
          chain('mip.MTIP · mie.MTIE', b(c.MTIP) + ' · ' + b(c.MTIE), c.MTIP && c.MTIE),
          chain('mstatus.MIE · MPIE', b(c.mstatusMIE) + ' · ' + b(c.mstatusMPIE)),
          chain('Trap eligible', soc.eligible(st) ? 'yes' : 'no', soc.eligible(st)),
          chain('Core', c.context === 'handler' ? 'in handler; mcause ' + F.hex32(c.mcause) + ' (' + (Model.CAUSE_NAME[c.mcause] || '') + ')' : 'main program')));
      // Devices.
      var u = st.uart, p = st.spi;
      setKids(devBox, h('dl', { class: 'sb-chain' },
        ['a', 'b'].map(function (k) { var x = st.gpio[k]; return chain('gpio_' + k, 'pins ' + F.hex8(x.pins) + ', INPUT ' + F.hex8(x.sync) + ', OUTPUT ' + F.hex8(x.out) + ', OE ' + F.hex8(x.oe) + ', IRQ_RISE ' + F.hex8(x.rise) + ', IRQ_FALL ' + F.hex8(x.fall)); }),
        chain('uart0', (u.txBusy ? 'sending ' + F.hex8(u.txByte) + ' (' + soc.uartLeft(u) + ' clocks left)' : 'TX idle') + '; RX ' + F.hex8(u.rxByte) + ', RX_VALID ' + b(u.rxValid) + ', OVERRUN ' + b(u.overrun) + ', FRAME_ERROR ' + b(u.frameError) + '; DIVIDER ' + u.divider + (u.sent.length ? '; sent ' + u.sent.map(F.hex8).join(' ') : '')),
        chain('spi0', (p.busy ? 'frame ' + F.hexShort(p.frame) + ' (' + soc.spiLeft(p) + ' clocks left)' : 'idle') + '; DATA ' + F.hexShort(p.received) + ', RX_VALID ' + b(p.rxValid) + ', cs_n ' + (p.csHold || p.busy ? 0 : 1) + ', FRAME_BITS ' + p.frameBits + ', DIVIDER ' + p.divider),
        chain('Peripheral time', st.time + ' peripheral_clk edges counted since reset')));
    }
    function condText(st, d) {
      if (d.component === 'gpio') { var g = st.gpio[d.bank]; return 'IRQ_PENDING ' + F.hex8(g.pend) + ' & IRQ_ENABLE ' + F.hex8(g.ie); }
      if (d.component === 'uart') return 'IRQ_PENDING ' + F.bits(soc.uartPending(st.uart), 4) + ' & IRQ_ENABLE ' + F.bits(st.uart.ie, 4);
      if (d.component === 'spi') return 'RX_VALID ' + b(st.spi.rxValid) + ' & IRQ_ENABLE ' + b(st.spi.ie);
      return '';
    }
    function srcLabel(id) { var d = L.sources.filter(function (x) { return x.id === id; })[0]; return d ? d.name : 'source ' + (id - 1); }
    function lvl(x) { return h('span', { class: 'sb-bit' + (x ? ' is-on' : ''), text: x ? '1' : '0' }); }
    function chain(k, v, hot) { return h('div', { class: hot ? 'is-hot' : null }, h('dt', { text: k }), h('dd', { text: v })); }

    // Completion offers exactly the IDs irq0 holds in service (none: a note).
    // Invalid completions remain possible from the load/store form, where
    // they fault as the RTL defines.
    function completeButtons(st, long) {
      var ids = [];
      for (var b = 0; b < 32; b++) if ((st.irq.inService >>> b) & 1) ids.push(b + 1);
      if (!ids.length) return h('span', { class: 'sb-dim sb-small', text: 'Nothing in service to complete.' });
      return ids.map(function (id) {
        return h('button', { type: 'button', 'data-complete': id, onclick: function () { start([acc('sw', L.byName.irq0.base, 0x18, id, 'Complete ' + id)], 'Complete ' + id, false); } },
          long ? ['Complete: ', code('sw'), ' ' + id + ' → CURRENT_IRQ'] : 'Complete ' + id);
      });
    }
    function controlsUpdate() {
      var st = committed;
      ['a', 'b'].forEach(function (k) {
        Array.prototype.forEach.call(pinRows[k].querySelectorAll('.sb-pin'), function (btn) {
          var pin = +btn.getAttribute('data-pin'), on = (st.gpio[k].pins >> pin) & 1;
          btn.setAttribute('aria-pressed', String(!!on));
          btn.querySelector('.sb-pin-v').textContent = on ? '1' : '0';
        });
      });
      csrBoxes['mstatus.MIE'].checked = st.cpu.mstatusMIE;
      csrBoxes['mie.MEIE'].checked = st.cpu.MEIE;
      csrBoxes['mie.MTIE'].checked = st.cpu.MTIE;
      setKids(completeBtn, completeButtons(st, true));
      setKids(coreState, 'At the end of the current story: ', h('strong', { text: st.cpu.context === 'handler' ? 'in a trap handler (mcause ' + F.hex32(st.cpu.mcause) + ')' : 'running the main program' }), '. ',
        'Trap eligible: ', h('strong', { text: soc.eligible(st) ? 'yes' : 'no' }), '.');
      setKids(presetNote, usePreset
        ? [h('strong', { text: 'Teaching preset' }), h('span', { class: 'sb-preset-long', text: ': firmware has already enabled every path (GPIO pin-0 edges, UART RX, SPI completion, irq0 sources 0–3, MTIMECMP = ' + soc.PRESET_TIMER_GAP + ', mie.MEIE, mie.MTIE, mstatus.MIE).' }), ' ']
        : [h('strong', { text: 'Reset values' }), h('span', { class: 'sb-preset-long', text: ': every enable is 0 and MTIMECMP = 0, so events are recorded in the devices but nothing reaches the core.' }), ' '],
        presetBtn);
      presetBtn.textContent = usePreset ? 'Use reset values instead' : 'Use the teaching preset';
      var c = st.cpu;
      if (c.context === 'handler') {
        setKids(handlerBar, h('span', { class: 'sb-handler-label', text: 'In the trap handler (mcause ' + F.hex32(c.mcause) + '):' }),
          h('button', { type: 'button', onclick: function () { start([acc('lw', L.byName.irq0.base, 0x18, 0, 'Claim')], 'Claim', false); } }, 'Claim'),
          completeButtons(st, false),
          h('button', { type: 'button', onclick: function () { start([{ type: 'mret' }], 'mret', false); } }, 'mret'));
      } else setKids(handlerBar);
    }

    /* ---------- detail ---------- */
    function choose(id, fromDiagram) {
      selected = id;
      showDetail();
      render();
      if (fromDiagram && window.matchMedia && !window.matchMedia('(min-width: 1500px)').matches) {
        detailBox.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }
    function showDetail() {
      var info = partInfo(selected, L);
      setKids(detailBox,
        h('p', { class: 'sb-kind', text: 'Selected · ' + info.kind }),
        h('h2', { class: info.mono ? 'mono' : null, text: info.title }),
        (info.text || []).slice(0, 1).map(function (t) { return h('p', null, rich(t)); }),
        h('details', { class: 'sb-detail-more' }, h('summary', { text: 'More from the RTL' }),
          (info.text || []).slice(1).map(function (t) { return h('p', null, rich(t)); }),
          info.facts ? h('dl', { class: 'sb-facts' }, info.facts.map(function (f) { return h('div', null, h('dt', { text: f[0] }), h('dd', { text: f[1] })); })) : null,
          info.sources && info.sources.length ? h('p', { class: 'sb-sources' }, 'Source: ', info.sources.map(function (src, i) { return [i ? ', ' : '', code(src)]; })) : null),
        info.links && info.links.length ? h('p', { class: 'sb-links' }, info.links.map(function (l) { return h('a', { href: l[0], text: l[1] }); })) : null);
    }

    /* ---------- routing table ---------- */
    function routingTable() {
      var rows = [];
      rows.push({ name: 'Boot ROM', base: L.rom.base, reserved: L.rom.reserved, inst: F.size(L.rom.bytes) + ' boot ROM', result: 'Reads: ROM. Writes and reads past ' + F.size(L.rom.bytes) + ': ERROR.', example: [L.rom.base, 0] });
      L.regions.forEach(function (r) {
        var d = L.installedRegions[r.id];
        rows.push({ name: r.id, base: r.base, reserved: r.bytes, inst: d ? d.name + ' (' + d.comp.top + '), ' + d.bytes + '-byte modelled window' : 'None',
          result: d ? 'Window: ' + d.name + ' registers. Rest of the reservation: decoder error.' : 'Decoder error.', example: [r.base >>> 0, 0], none: !d });
      });
      rows.push({ name: 'RAM', base: L.ram.base, reserved: L.ram.reserved, inst: F.size(L.ram.bytes) + ' RAM', result: 'Cacheable: line traffic through the D-cache. Past ' + F.size(L.ram.bytes) + ': refill ERROR, access fault.', example: [L.ram.base, 0x100] });
      return h('section', { class: 'sb-routing', 'aria-labelledby': uid + '-routing' },
        h('h2', { id: uid + '-routing', text: 'Where each address goes in the teaching model' }),
        h('p', { class: 'section-intro', text: 'A reservation is an address range, not a device. Only an installed device’s register window answers; every other address in the peripheral aperture gets the decoder’s error response.' }),
        h('div', { class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label': 'Address routing' },
          h('table', { class: 'sb-table sb-route-table' }, h('caption', { class: 'visually-hidden', text: 'Reserved regions, installed hardware and the result of an access' }),
            h('thead', null, h('tr', null, ['Region', 'Base', 'Reserved', 'Installed here', 'An access gets', ''].map(function (c) { return h('th', { scope: 'col', text: c }); }))),
            h('tbody', null, rows.map(function (r) {
              return h('tr', { class: r.none ? 'is-none' : null }, h('th', { scope: 'row', text: r.name }), h('td', null, code(F.hex32(r.base))), h('td', { text: F.size(r.reserved) }), h('td', { text: r.inst }), h('td', null, r.result, r.none ? h('p', null, h('a', { href: '#/reference/address-map/' + encodeURIComponent(r.name), text: 'Standard reservation / registers' })) : null),
                h('td', null, h('button', { type: 'button', class: 'link-button', text: 'Load into the form', onclick: function () {
                  more.open = true; baseIn.value = F.hex32(r.example[0]); offIn.value = String(r.example[1]); opSel.value = 'lw'; pick.value = ''; updatePreview(); selectTab('access', false);
                  tryBox.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); baseIn.focus({ preventScroll: true });
                } })));
            })))));
    }

    // Hand-off from the Caches tab: its last completed access. Only a 4-byte
    // lw/sw is loaded into the form; other sizes are explained, never widened.
    function showHandoff(hf) {
      if (!hf || typeof hf.address !== 'number') return;
      var mn = hf.mnemonic || hf.op, size = hf.size;
      var from = h('a', { href: '#/architecture/caches', text: hf.from || 'Caches tab' });
      var where = [code(mn), ' at ', code(F.hex32(hf.address)), hf.provenance ? ' (' + hf.provenance + ')' : ''];
      if (size !== 4 || (hf.op !== 'lw' && hf.op !== 'sw')) {
        setKids(handoffBox, h('p', { class: 'sb-handoff-note is-declined' }, 'Last completed access on the ', from, ': ', where,
          ', ' + (size ? size + ' byte' + (size === 1 ? '' : 's') : 'unknown size') + '. This page traces 32-bit lw/sw only and does not widen it, so it is not loaded.'));
        return;
      }
      var a = { op: hf.op, base: hf.address >>> 0, offset: 0, value: hf.value === null || hf.value === undefined ? 0 : hf.value >>> 0 };
      opSel.value = a.op; baseIn.value = F.hex32(a.base); offIn.value = '0'; valIn.value = F.hex32(a.value);
      var known = hf.op === 'sw' ? ' storing ' + F.hex32(a.value) : hf.value === null || hf.value === undefined ? ' (its value was not modelled there)' : ' (it read ' + F.hex32(hf.value) + ')';
      setKids(handoffBox, h('p', { class: 'sb-handoff-note' }, 'Last completed access on the ', from, ': ', where, known + '. ',
        h('button', { type: 'button', class: 'sb-primary', text: 'Trace it here', onclick: function () { runForm(); } })));
      updatePreview();
    }

    function announce(text) { announcer.textContent = ''; setTimeout(function () { announcer.textContent = text; }, 30); }
    function field(label, control, help, helpId) {
      return h('div', { class: 'sb-field' }, h('label', { for: control.id, text: label }), control, help ? h('span', { class: 'sb-help', id: helpId || null, text: help }) : null);
    }

    var api = {
      dispose: function () { disposed = true; pause(); if (raf) cancelAnimationFrame(raf); },
      trace: function (access) { showHandoff(access); runForm(); },
      // For QA: current view and state.
      _debug: function () { return { story: story, view: view, idx: idx, committed: committed, soc: soc }; }
    };
    return api;
  }

  window.PrismSystemBus = { mount: mount };
})();
