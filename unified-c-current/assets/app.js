/* Prism documentation site: hash router, views and the generated firmware
   reference. Normal views insert data as text through h(). Peripheral previews
   use the shared renderer after schema validation; it escapes every author value.
   Requires data/reference.js to load first
   (it defines window.PRISM_REFERENCE); views report missing data instead. */
(function () {
  'use strict';

  var DATA = window.PRISM_REFERENCE;
  var main = document.getElementById('main');
  var announcer = document.getElementById('announcer');
  var localDocuments = [];

  /* ---------- DOM and formatting helpers ---------- */

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(value));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === undefined || kid === null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  function replace(el) {
    el.replaceChildren();
    for (var i = 1; i < arguments.length; i++) append(el, arguments[i]);
  }
  function svg(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') el.textContent = attrs[key];
      else el.setAttribute(key, String(attrs[key]));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function chevron() {
    var ns = 'http://www.w3.org/2000/svg';
    var icon = document.createElementNS(ns, 'svg');
    icon.setAttribute('class', 'chev');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    [['d', 'M6 3l5 5-5 5'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'],
     ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']].forEach(function (a) { path.setAttribute(a[0], a[1]); });
    icon.appendChild(path);
    return icon;
  }

  function hex(n, digits) {
    var s = (n >>> 0).toString(16).toUpperCase();
    while (s.length < (digits || 8)) s = '0' + s;
    return '0x' + s;
  }
  function hexNode(n) {
    // Group a 32-bit address as two half-words for reading; copies stay plain.
    var s = hex(n);
    return h('span', { class: 'mono', 'aria-label': s },
      h('span', { 'aria-hidden': 'true' }, s.slice(0, 6), h('span', { class: 'hex-gap' }), s.slice(6)));
  }
  function shortMask(n) { return '0x' + (n >>> 0).toString(16).toUpperCase(); }
  function size(bytes) {
    var units = ['bytes', 'KiB', 'MiB', 'GiB'];
    var value = bytes, unit = 0;
    while (value >= 1024 && value % 1024 === 0 && unit < units.length - 1) { value /= 1024; unit++; }
    if (unit === 0) return bytes + (bytes === 1 ? ' byte' : ' bytes');
    return value + ' ' + units[unit];
  }
  function sourcePath(label) {
    // Exporter labels look like "prism:source/soc/memory.toml" or "external:<hash>/name".
    return String(label || '').replace(/^prism:/, '');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function announce(message) {
    announcer.textContent = '';
    window.setTimeout(function () { announcer.textContent = message; }, 30);
  }

  /* ---------- Clipboard with file:// fallback ---------- */

  function legacyCopy(text) {
    var area = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:-9999px;opacity:0' });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }
  function selectContents(node) {
    if (!node || !window.getSelection) return;
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function copyText(text, button, what, fallbackNode) {
    var label = button.querySelector('.copy-label') || button;
    var original = button.getAttribute('data-original') || label.textContent;
    button.setAttribute('data-original', original);
    function finish(ok) {
      window.clearTimeout(button._copyTimer);
      if (ok) {
        button.setAttribute('data-state', 'done');
        if (label !== button || !button.classList.contains('addr-button')) label.textContent = 'Copied';
        announce('Copied ' + what + ' to the clipboard');
      } else {
        button.setAttribute('data-state', 'manual');
        if (!button.classList.contains('addr-button')) label.textContent = 'Press Ctrl+C';
        if (fallbackNode) selectContents(fallbackNode);
        else {
          // Preserve the full value when its visible label is shortened, or
          // when the button has no adjacent selectable text (for example bases).
          var manual = button._manualCopy;
          if (!manual || !manual.isConnected) {
            manual = h('input', { type: 'text', readonly: true, class: 'manual-copy', 'aria-label': 'Copy ' + what + ' manually' });
            button.insertAdjacentElement('afterend', manual);
            button._manualCopy = manual;
          }
          manual.value = text;
          manual.focus();
          manual.select();
        }
        announce('Copying is blocked here. The text is selected; press Control C or Command C to copy it.');
      }
      button._copyTimer = window.setTimeout(function () {
        button.removeAttribute('data-state');
        if (!button.classList.contains('addr-button')) label.textContent = original;
      }, ok ? 1600 : 4000);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { finish(legacyCopy(text)); });
    } else {
      finish(legacyCopy(text));
    }
  }
  function copyButton(text, what, fallbackNode, labelText) {
    var button = h('button', { type: 'button', class: 'copy-button', 'aria-label': 'Copy ' + what },
      h('span', { class: 'copy-label', text: labelText || 'Copy' }));
    button.addEventListener('click', function () { copyText(text, button, what, fallbackNode); });
    return button;
  }
  function addressButton(value, what) {
    var text = hex(value);
    var button = h('button', { type: 'button', class: 'addr-button', title: 'Copy ' + text, 'aria-label': 'Copy address ' + text + (what ? ' of ' + what : '') }, hexNode(value));
    button.addEventListener('click', function () { copyText(text, button, text, button); });
    return button;
  }

  function codeBlock(text, title, what, renderer) {
    var code = h('code', null, renderer ? renderer(text) : text);
    var pre = h('pre', { tabindex: '0' }, code);
    return h('div', { class: 'codeblock' },
      h('div', { class: 'codeblock-head' }, h('span', { class: 'mono', text: title }), copyButton(text, what, code)),
      pre);
  }
  function table(columns, rows, options) {
    options = options || {};
    var head = h('tr', null, columns.map(function (c) {
      return h('th', { scope: 'col', class: c.num ? 'num' : null, text: c.label });
    }));
    var body = h('tbody', null, rows.map(function (row) {
      var tr = h('tr', { class: row._class || null });
      columns.forEach(function (c) {
        var value = c.render(row);
        var empty = value === null || value === undefined || value === '';
        tr.appendChild(h('td', { 'data-label': c.label, class: [c.num ? 'num' : '', empty && c.optional ? 'empty-cell' : ''].join(' ').trim() || null }, empty ? '' : value));
      });
      return tr;
    }));
    var tableEl = h('table', { class: options.stack ? 'stack-table' : null },
      options.caption ? h('caption', { class: 'visually-hidden', text: options.caption }) : null,
      h('thead', null, head), body);
    return h('div', { class: 'table-scroll' + (options.stack ? ' stack' : ''), role: 'region', tabindex: '0', 'aria-label': options.caption || 'Table' }, tableEl);
  }

  /* ---------- Data checks ---------- */

  function dataProblem(part, reference) {
    var data = arguments.length > 1 ? reference : DATA;
    if (!data || typeof data !== 'object') return 'missing';
    if (data.schema_version !== 1) return 'version';
    if (part && (!data[part] || typeof data[part] !== 'object')) return 'incomplete';
    return null;
  }
  function dataNotice(problem, part, reference) {
    var data = arguments.length > 2 ? reference : DATA;
    var title, detail;
    if (problem === 'missing') {
      title = 'Generated reference data is missing';
      detail = 'This page reads reference data created by the website build. From the Prism-Website directory run make, then open dist/index.html. The site/ source directory has no generated data, so opening site/index.html shows this message.';
    } else if (problem === 'version') {
      title = 'Reference data has an unexpected schema version';
      detail = 'This page understands schema version 1 but found ' + JSON.stringify(data && data.schema_version) + '. Rebuild with make so the site and data come from the same checkout.';
    } else {
      title = 'Reference data is incomplete';
      detail = 'The generated reference has no "' + part + '" section. Rebuild with make and check the exporter output for validation errors.';
    }
    return h('div', { class: 'notice notice-error', role: 'status' }, h('h2', { text: title }), h('p', { text: detail }));
  }

  /* ---------- Architecture diagram ---------- */

  var PARTS = {
    system: { summary: 'Composes independent SoCs and owns their clocks and logical routes.', kind: 'Composition', title: 'System', path: 'System TOML', color: 'system',
      text: 'A system TOML manifest composes independent SoCs and owns their clocks, logical routes and required board binding. Shared clocks do not imply shared memory.' },
    soc: { summary: 'One processor tile with its own address map, fabric, RAM, boot ROM and peripherals.', kind: 'Composition', title: 'SoC', path: 'SoC TOML',
      text: 'Currently one processor tile, with the SoC’s own address map, fabric, RAM, boot ROM and peripherals. The SoC manifest names the tile manifest, the fabric, the memories, the peripherals and the memory map. RAM and ROM sizes come from the memory map, and each installed peripheral adds its own pins to the SoC.' },
    other: { summary: 'Another SoC in the same system, with its own tile, address map, memory and peripherals.', kind: 'Composition', title: 'Another SoC', path: 'SoC TOML',
      text: 'Each SoC in a system keeps its own tile, address map, memory and peripheral state. A system can place several on one FPGA.' },
    tile: { summary: 'A core joined to an instruction cache and a data cache, or to none. The tile implements cache_fabric_if.', kind: 'Component', title: 'Processor tile', path: 'Tile manifest',
      text: 'A tile manifest names one core, one instruction cache and one data cache; false in place of a cache connects the core without one. Any supplied core works with any supplied cache. A core manifest requests the compiler ISA and microarchitecture settings. Prism generates package headers and checks the requested ISA against the elaborated hardware. Every tile connects to the rest of the SoC through cache_fabric_if.' },
    cache_fabric_if: { summary: 'Blocking, non-coherent instruction and data channels from tile to fabric.', kind: 'Interface', title: 'cache_fabric_if', contract: true, color: 'cache', path: 'source/contracts/interfaces/cache_fabric_if.vh',
      text: 'Independent blocking instruction and data channels from tile to fabric. Each channel carries one current 64-bit beat, with no IDs. A beat completes on a rising clk edge with wait low, including an error completion. The two channels share no ordering guarantee, and the interface has no snoop or reservation channel: it provides no coherence.' },
    fabric: { summary: 'Arbitrates the tile’s instruction and data channels onto the system request path.', kind: 'Component', title: 'Memory fabric', path: 'source/memory_fabrics/direct/rtl/cache_fabric.sv',
      text: 'Merges the tile’s instruction and data requests into one stream for the system bus. The supplied fabric serves a data request before an instruction fetch, so continuous data traffic can hold a fetch back.' },
    system_bus_if: { summary: 'Blocking request path for RAM, ROM and MMIO, with one beat outstanding and no request ID.', kind: 'Interface', title: 'system_bus_if', contract: true, color: 'bus', path: 'source/soc/interfaces/system_bus_if.vh',
      text: 'Blocking request path for RAM, ROM and MMIO, with one selected beat outstanding. The target reports FREE, BUSY, ACCESS or ERROR; a rising edge with ACCESS or ERROR completes the active beat. Requests carry no ID.' },
    routing: { summary: 'Decodes the SoC’s address map and selects RAM, ROM or MMIO.', kind: 'Component', title: 'Address routing', path: 'source/soc/buses/rtl/system_bus.sv',
      text: 'Decodes the SoC’s address map and selects RAM, ROM or MMIO; memory and peripherals are peers. Misaligned beats, simultaneous enables, storage holes, ROM writes and instruction fetches from MMIO complete with ERROR.' },
    memory: { summary: 'Private to this SoC and reached over system_bus_if.', kind: 'Component', title: 'RAM and boot ROM', path: 'SoC TOML', link: ['#/reference/address-map', 'See storage in the address map'],
      text: 'Private to this SoC and reached over system_bus_if. The address map lists each memory’s base, installed bytes and reserved bytes.' },
    mmio_if: { summary: 'Peripheral port carrying one 64-bit beat at a time.', kind: 'Interface', title: 'mmio_if', contract: true, color: 'mmio', path: 'source/soc/interfaces/mmio_if.vh', link: ['#/architecture/system-bus', 'Trace the system bus and interrupts'],
      text: 'The port every peripheral implements. It carries one 64-bit transfer (a beat) at a time; a beat completes on the rising edge with valid && ready. Peripherals can run on a clock separate from the CPU clock: each beat is then carried across the two clocks, and interrupt levels are synchronized on the way back.' },
    peripherals: { summary: 'Board-neutral RTL selected by SoC TOML.', kind: 'Component', title: 'Peripherals', path: 'source/soc/peripherals/', link: ['#/reference/address-map', 'See reserved regions and registers'],
      text: 'Board-neutral RTL selected by SoC TOML. Each peripheral’s component manifest describes its registers.' },
    platform: { summary: 'Owns FPGA pads and clock primitives.', kind: 'Platform', title: 'Platform', path: 'source/platform/', color: 'system',
      text: 'Owns FPGA pads and clock primitives. Boards differ only in platform adapters and routing; peripheral RTL stays the same.' }
  };
  var PART_ORDER = ['system', 'soc', 'tile', 'cache_fabric_if', 'fabric', 'system_bus_if', 'routing', 'memory', 'mmio_if', 'peripherals', 'other', 'platform'];

  function diagram(options) {
    var buttons = [];
    var detail = h('div', { class: 'arch-detail panel', id: 'arch-detail', 'aria-live': 'polite' });
    function reveal() {
      // Below the side-by-side breakpoint the detail sits under the diagram;
      // bring it into view so a tap has a visible result.
      if (!window.matchMedia('(min-width: 1180px)').matches) {
        var smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        detail.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
      }
    }

    function select(key, focus) {
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-part') === key)); });
      var part = PARTS[key];
      replace(detail,
        h('span', { class: 'kind' },
          part.color ? h('span', { class: 'swatch', style: 'background: var(--c-' + part.color + ')', 'aria-hidden': 'true' }) : null,
          part.kind),
        h('h3', { class: part.contract ? 'contract' : null, text: part.title }),
        h('p', { text: part.summary }),
        h('p', { class: 'path' }, h('code', { text: part.path })),
        h('p', { class: 'detail-links' },
          options && options.entries ? h('a', { href: '#' + location.hash.replace(/^#/, ''), onclick: function (event) {
            event.preventDefault();
            options.entries(key);
          }, text: 'Read the full entry' }) : null,
          part.link ? h('a', { href: part.link[0], text: part.link[1] }) : null));
      if (focus) detail.focus();
    }
    function block(key, cls, title, sub) {
      var b = h('button', { type: 'button', class: 'arch-part' + (cls ? ' ' + cls : ''), 'data-part': key, 'aria-pressed': 'false', 'aria-controls': 'arch-detail' },
        h('span', { class: 't', text: title }), sub ? h('span', { class: 's', text: sub }) : null);
      b.addEventListener('click', function () { select(key); reveal(); });
      buttons.push(b);
      return b;
    }
    function seam(key, cls) {
      var b = h('button', { type: 'button', class: 'arch-seam ' + cls, 'data-part': key, 'aria-pressed': 'false', 'aria-label': key + ' contract', 'aria-controls': 'arch-detail' },
        h('span', { class: 'chip', text: key }));
      b.addEventListener('click', function () { select(key); reveal(); });
      buttons.push(b);
      return b;
    }

    var soc = h('div', { class: 'arch-soc' },
      block('soc', 'arch-label', 'SoC', 'private address map'),
      h('div', { class: 'arch-stack' },
        block('tile', null, 'Processor tile', 'core + caches or adapter'),
        seam('cache_fabric_if', 'cache'),
        block('fabric', null, 'Memory fabric', 'I/D arbitration'),
        seam('system_bus_if', 'bus'),
        block('routing', null, 'Address routing', 'RAM, ROM or MMIO'),
        h('div', { class: 'arch-split' },
          h('div', null, seam('system_bus_if', 'bus'), block('memory', null, 'RAM + boot ROM')),
          h('div', null, seam('mmio_if', 'mmio'), block('peripherals', null, 'Peripherals', 'board-neutral')))));

    var other = h('div', { class: 'arch-soc ghost' },
      h('span', { class: 'arch-part arch-label', 'aria-hidden': 'true', style: 'cursor: default' }, h('span', { class: 't', text: 'SoC' }), h('span', { class: 's', text: 'its own map' })),
      h('div', { class: 'ghost-body' },
        h('span', { class: 'ghost-bar', 'aria-hidden': 'true', text: 'tile' }),
        h('span', { class: 'ghost-bar seam', 'aria-hidden': 'true' }),
        block('other', null, 'Independent SoC', 'own tile, memory and peripherals'),
        h('span', { class: 'ghost-bar seam', 'aria-hidden': 'true' }),
        h('span', { class: 'ghost-bar', 'aria-hidden': 'true', text: 'peripherals' })));

    var figure = h('figure', { class: 'arch panel', style: 'margin: 0' },
      h('figcaption', { class: 'visually-hidden', text: 'Prism architecture. A system contains independent SoCs. In each SoC a processor tile connects through cache_fabric_if to a memory fabric, which connects through system_bus_if to address routing. Routing reaches RAM and boot ROM over system_bus_if and peripherals over mmio_if. The platform connects the system to FPGA pads and clocks. Select any part for details.' }),
      h('div', { class: 'arch-system' },
        block('system', 'arch-label system', 'System', 'TOML: instances, clocks and nets'),
        h('div', { class: 'arch-socs' }, soc, other)),
      h('div', { class: 'arch-pins', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'), h('span'), h('span')),
      h('div', { class: 'arch-platform' }, block('platform', null, 'Platform', 'FPGA pads and clock primitives')));

    detail.setAttribute('tabindex', '-1');
    select(options && options.initial || 'cache_fabric_if');
    var wrap = h('div', { class: 'arch-wrap' + (options && options.side ? ' side' : '') }, figure, detail);
    // Lets the page's full entries select a part and return to the diagram.
    wrap.showPart = function (key) {
      select(key);
      var smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      wrap.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
      detail.focus({ preventScroll: true });
    };
    return wrap;
  }

  /* ---------- Core datapath pages (recorded RTL traces) ---------- */

  var CORE_PAGES = {
    singlecycle: {
      title: 'Singlecycle core',
      lede: 'One instruction at a time. PC drives the instruction port, and decode, register read, ALU, data access and write-back all complete before the rising edge that retires the instruction. While memory waits, PC, the register file and memory keep their values until the instruction can retire.',
      program: 'singlecycle',
      notes: [
        'Cacheless and Cached show the same core in two tiles: one with `instruction_cache` and `data_cache` set to `false`, and one with the supplied instruction cache and the `live_data` data cache. The datapath is the same.',
        'The animation replays a simulation of the RTL in which memory answers one cycle after a request, as the supplied SoC RAM does. Without caches, each instruction waits for its fetch; with them, hits answer in the same cycle. The demo program runs its body twice.'
      ]
    },
    hazard3: {
      title: 'Hazard3 core',
      lede: 'Upstream Hazard3, a three-stage pipeline, with Prism’s configuration. Fetch runs ahead into a two-word queue and assembles instructions by halfword; decode and execute share one stage, with full bypassing, a one-entry branch target buffer and a combinational multiplier; M completes data accesses and writes the register file. The page shows the same program in two memory configurations.',
      program: 'hazard3',
      notes: [
        '“Prism tile” is Hazard3 as Prism builds it: an adapter converts each of its AHB ports to `cache_fabric_if`. The adapter adds a register, so a memory transfer takes at least two cycles and fetch delivers at most one word every two cycles; D/X often waits for instructions. “Direct AHB memory” connects the same core straight to a memory that answers in the same cycle, which is what Hazard3 is designed for, to show what the adapters cost. Both runs compute the same results.',
        'Prism builds Hazard3 v1.0-rc1 with its M, A, C, bit-manipulation and Hazard3-specific extensions enabled; the Hazard3 guide lists them. The default compiler ISA includes its supported bit-manipulation extensions and omits Zcb/Zcmp because the pinned GCC 13.2 toolchain rejects those names. The editor here accepts `rv32im_zicsr_zifencei` mnemonics and never compresses them; raw `.half` and `.word` data can still hold compressed instructions, which the core executes.',
        'Instructions are coloured from D/X on. “Retired” in the chart means the instruction left M normally.',
        'The animation replays a simulation of the RTL in which memory answers one cycle after a request, as for the other cores.'
      ]
    },
    base: {
      title: 'Base core',
      lede: 'A five-stage, single-issue pipeline with private I- and D-caches. Branches resolve in EX with a 2-bit predictor in IF; loads, multiplies and divides finish in MEM, and a divide holds EX for 1 to 12 cycles while it iterates; results forward to EX from MEM and WB.',
      program: 'base',
      notes: [
        'MUL, MULH, MULHSU and MULHU take one EX cycle. DIV, DIVU, REM and REMU use a divider that forms three quotient bits per cycle after skipping the dividend’s leading zero 3-bit groups, so a divide stays in EX for 2 to 12 cycles, or 1 when the divisor is zero. A dependent instruction waits one bubble after a multiply or divide.',
        'The animation replays a simulation of the RTL in which memory answers one cycle after a request. The demo program runs its body twice. The first pass, from cycle 0, misses in both caches; the second pass starts at cycle 80 and nearly always hits. The divides after it show the divider’s 2-, 12- and 1-cycle cases, a `rem` that reuses the preceding `div`’s quotient and remainder (1 cycle), and a pair that cannot (the first `div` overwrites a source, so the `rem` divides again). Choose the label `pass` and step between its visits to compare them.'
      ]
    }
  };

  var CORE_TILES = [
    { name: 'singlecycle', page: 'singlecycle', isa: 'rv32i_zicsr_zifencei', text: 'One instruction at a time. The simplest core to read. Its supplied tile has no caches.' },
    { name: 'base', page: 'base', isa: 'rv32im_zicsr_zifencei', text: 'Five-stage pipeline with a 2-bit branch predictor and hardware multiply and divide. Setting `isa` to `rv32i_zicsr_zifencei` in its core manifest removes the multiplier and divider. The manifest’s `DIV_BITS` microarchitecture setting controls quotient bits per divider iteration. Its supplied tile has a 128-byte instruction cache and a 256-byte data cache.' },
    { name: 'hazard3', page: 'hazard3', isa: 'rv32imac_zicsr_zifencei_zba_zbb_zbkb_zbs', text: 'Upstream Hazard3 v1.0-rc1 (three-stage pipeline) behind AHB adapters. Its core manifest chooses the compiler ISA; the default omits Zcb/Zcmp for the pinned GCC 13.2 toolchain. Its supplied tile has no caches.' }
  ];

  function coresView() {
    return h('div', { class: 'page page-wide layer-page' },
      architectureCrumb(),
      pageHeader('Core tiles', 'Prism supplies three cores. A tile manifest joins a core to an instruction cache and a data cache, or to none, and your SoC manifest names the tile. Any core works with any supplied cache. Each datapath page animates the core cycle by cycle, and you can assemble your own program and run it on the RTL in your browser.'),
      h('div', { class: 'core-tiles' }, table([
        { label: 'Core', render: function (r) { return h('code', { text: r.name }); } },
        { label: 'Instruction set (compiler -march)', render: function (r) { return h('code', { text: r.isa }); } },
        { label: 'Description', render: function (r) { return [inlineCode(r.text), r.page ? [' ', h('a', { href: '#/architecture/datapath/' + r.page, text: 'Datapath' })] : [' ', h('a', { href: '#/tutorials/instantiate-core', text: 'Instantiate a core' })]]; } }
      ], CORE_TILES, { caption: 'Cores' })),
      h('p', null, 'All tiles meet the fabric through ', h('code', { text: 'cache_fabric_if' }), ', which is blocking and non-coherent. To write your own, see ', h('a', { href: '#/tutorials/custom-tile', text: 'Write a custom core or tile' }), '.'));
  }

  function coreView(key, embedded) {
    var P = CORE_PAGES[key], T = window.PRISM_CORE_TRACES;
    LAYERS.core = key;
    var page = h('div', { class: embedded ? 'architecture-panel core-panel' : 'page page-wide layer-page' },
      embedded ? null : architectureCrumb(true),
      embedded ? h('div', { class: 'core-panel-head' },
        h('nav', { class: 'core-picker', 'aria-label': 'Core datapath' }, ['singlecycle', 'base', 'hazard3'].map(function (choice) {
          return h('a', { href: '#/architecture/datapath/' + choice, 'aria-current': key === choice ? 'page' : null, text: CORE_PAGES[choice].title.replace(/ core$/, '') });
        }))) : pageHeader(P.title, P.lede));
    if (embedded) page.appendChild(h('p', { class: 'lede core-lede', text: P.lede }));
    if (!T || !window.PrismCoreDiagrams || !T[P.program] || !window.PrismCoreDiagrams.has(key)) {
      page.appendChild(h('div', { class: 'notice notice-error', role: 'status' },
        h('h2', { text: 'No diagram recording in this build' }),
        h('p', { text: 'This view needs the core recording and renderer. Rebuild with make.' })));
      return page;
    }
    var holder = h('div', { class: 'core-diagram' });
    var editor = h('div', { class: 'core-editor-slot' });
    page.appendChild(holder); page.appendChild(editor);
    page.appendChild(h('h2', { text: 'About this view' }));
    page.appendChild(h('ul', { class: 'prose' }, P.notes.map(function (n) { return h('li', null, inlineCode(n)); })));
    window.PrismCoreDiagrams.mount(holder, key);
    if (window.PrismCoreEditor) window.PrismCoreEditor.mount(editor, { core: key, diagram: holder });
    editor.addEventListener('input', function (event) {
      if (event.target && event.target.classList && event.target.classList.contains('ce-source')) WORKLOAD.coreSource[key] = event.target.value;
    });
    onLeave(function () {
      // Detach mounted sections so an old editor run cannot publish a late result.
      window.PrismCoreDiagrams.unmount(holder);
      holder.replaceChildren(); editor.replaceChildren();
    });
    return page;
  }

  /* ---------- Architecture layers: core, local caches, future coherent bus, system bus ---------- */

  // One persistent Architecture hub. Standalone core pages keep their own notes.
  // The core tab remembers the selected core; other layers are independent.
  var LAYERS = { core: 'base' };
  // In-memory hand-off between layer pages (never persisted): the Caches tab
  // reports its program and last access; the System bus tab offers that access.
  var WORKLOAD = { program: null, lastAccess: null, coreSource: {} };
  var LAYER_TABS = [
    { key: 'overview', label: 'Overview', sub: 'SoC, parts and contracts', href: function () { return '#/architecture'; } },
    { key: 'core', n: '1', label: 'Core datapath', sub: 'pipeline and assembly', href: function () { return '#/architecture/datapath/' + LAYERS.core; } },
    { key: 'caches', n: '2', label: 'Local caches', sub: 'I-cache and D-cache', href: function () { return '#/architecture/caches'; } },
    { key: 'coherent', n: '3', label: 'Coherent bus', sub: 'in development', href: function () { return '#/architecture/coherent-bus'; }, future: true },
    { key: 'bus', n: '4', label: 'System bus and interrupts', sub: 'RAM, ROM, peripherals, IRQs', href: function () { return '#/architecture/system-bus'; } },
    { key: 'accelerators', label: 'Accelerators · WIP', sub: 'MMIO commands, coherent data', href: function () { return '#/architecture/accelerators'; }, future: true }
  ];
  function architectureCrumb(core) {
    return h('p', { class: 'crumb architecture-crumb' },
      h('a', { href: '#/architecture', text: 'Architecture' }),
      core ? [' / ', h('a', { href: '#/architecture/core', text: 'Core datapath' })] : null);
  }
  function updateLayerTabs(nav, active) {
    LAYER_TABS.forEach(function (t) {
      var a = nav.querySelector('[data-layer="' + t.key + '"]'), current = t.key === active;
      a.href = t.href(); a.setAttribute('aria-selected', String(current));
      a.tabIndex = current ? 0 : -1;
      if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      a.querySelector('.layer-sub').textContent = t.key === 'core' ? CORE_PAGES[LAYERS.core].title + ' · ' + t.sub : t.sub;
    });
  }
  function layerTabs(active) {
    var nav = h('nav', { class: 'layer-tabs', 'aria-label': 'Architecture layers' },
      h('ol', { role: 'tablist', 'aria-label': 'Architecture views' }, LAYER_TABS.map(function (t) {
        return h('li', { role: 'presentation', class: t.future ? 'is-future' : null },
          h('a', { id: 'architecture-tab-' + t.key, role: 'tab', 'data-layer': t.key, href: t.href(), 'aria-controls': 'architecture-panel' },
            t.n ? h('span', { class: 'layer-n', 'aria-hidden': 'true', text: t.n }) : null,
            h('span', { class: 'layer-text' }, h('span', { class: 'layer-label', text: t.label }), h('span', { class: 'layer-sub' }))));
      })));
    updateLayerTabs(nav, active);
    nav.addEventListener('keydown', function (event) {
      var tabs = Array.prototype.slice.call(nav.querySelectorAll('[role="tab"]'));
      var i = tabs.indexOf(event.target), next;
      if (i < 0) return;
      if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else if (event.key === ' ') { event.preventDefault(); event.target.click(); return; }
      else return;
      event.preventDefault(); tabs[next].focus();
    });
    return nav;
  }
  function renderArchitecture(panel, active) {
    var hub = main.querySelector('.architecture-hub');
    if (!hub) {
      hub = h('div', { class: 'page page-wide layer-page architecture-hub' },
        pageHeader('Architecture'), layerTabs(active),
        h('section', { id: 'architecture-panel', role: 'tabpanel', tabindex: '0' }));
      main.replaceChildren(hub);
    } else updateLayerTabs(hub.querySelector('.layer-tabs'), active);
    var region = hub.querySelector('#architecture-panel');
    region.setAttribute('aria-labelledby', 'architecture-tab-' + active);
    region.replaceChildren(panel);
    // On narrow screens the tab strip scrolls horizontally; reveal only its selection.
    window.requestAnimationFrame(function () {
      var nav = hub.querySelector('.layer-tabs');
      if (!nav.isConnected) return;
      var tab = nav.querySelector('[aria-selected="true"]'), n = nav.getBoundingClientRect(), t = tab.getBoundingClientRect();
      if (t.left < n.left) nav.scrollLeft += t.left - n.left - 3;
      else if (t.right > n.right) nav.scrollLeft += t.right - n.right + 3;
    });
  }
  function panelHeader(title, lede) {
    return [h('h2', { class: 'architecture-panel-title', text: title }), lede ? h('p', { class: 'lede', text: lede }) : null];
  }

  // Views may register cleanup (timers, animation frames) for the next route change.
  var routeCleanup = [];
  function onLeave(fn) { if (typeof fn === 'function') routeCleanup.push(fn); }
  function leaveRoute() {
    var list = routeCleanup; routeCleanup = [];
    list.forEach(function (fn) { try { fn(); } catch (error) { /* a view's cleanup must not block navigation */ } });
  }

  function cachePage(active, content) {
    var choices = [
      { key: 'noncoherent', label: 'Noncoherent', href: '#/architecture/caches' },
      { key: 'coherent', label: 'Coherent · WIP', href: '#/architecture/caches/coherent' }
    ];
    var tabs = h('nav', { class: 'cache-tabs', 'aria-label': 'Cache coherence' },
      h('div', { role: 'tablist', 'aria-label': 'Cache implementations' }, choices.map(function (choice) {
        var selected = choice.key === active;
        return h('a', {
          id: 'cache-tab-' + choice.key,
          href: choice.href,
          role: 'tab',
          'aria-selected': String(selected),
          'aria-controls': 'cache-panel',
          tabindex: selected ? '0' : '-1',
          text: choice.label
        });
      })));
    tabs.addEventListener('keydown', function (event) {
      var items = Array.prototype.slice.call(tabs.querySelectorAll('[role="tab"]'));
      var index = items.indexOf(event.target);
      var next;
      if (index < 0) {
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        next = (index + 1) % items.length;
      }
      else if (event.key === 'Home') {
        next = 0;
      }
      else if (event.key === 'End') {
        next = items.length - 1;
      }
      else if (event.key === ' ') {
        event.preventDefault();
        event.target.click();
        return;
      }
      else {
        return;
      }
      event.preventDefault();
      items[next].focus();
    });
    return h('div', { class: 'architecture-panel cache-page' },
      h('div', { class: 'cache-panel-head' }, panelHeader('Local caches'), tabs),
      h('section', { id: 'cache-panel', role: 'tabpanel', 'aria-labelledby': 'cache-tab-' + active }, content));
  }

  function cacheView() {
    var holder = h('div', { class: 'cache-explorer-slot' });
    var importBox = h('div');
    var page = cachePage('noncoherent', [
      importBox, holder,
      h('p', { class: 'prose' }, 'For what happens below the fabric, see ', h('a', { href: '#/architecture/system-bus', text: 'System bus and interrupts' }), '.')]);
    function mountExplorer(program) {
      if (!window.PrismCacheExplorer || typeof window.PrismCacheExplorer.mount !== 'function') {
        replace(holder, h('div', { class: 'notice', role: 'status' }, h('h2', { text: 'The cache explorer is not in this build' }),
          h('p', null, 'This page loads ', h('code', { text: 'assets/cache-model.js' }), ' and ', h('code', { text: 'assets/cache-explorer.js' }), '. Rebuild with make once they are present, then open dist/index.html.')));
        return;
      }
      leaveRoute();
      replace(holder);
      var options = {
        compact: true,
        onProgram: function (source) { WORKLOAD.program = String(source); },
        // null: the reader reset the explorer or started a new program session.
        onAccess: function (access) {
          if (access === null) { WORKLOAD.lastAccess = null; return; }
          if (!access || (access.op !== 'lw' && access.op !== 'sw') || typeof access.address !== 'number') return;
          WORKLOAD.lastAccess = { op: access.op, mnemonic: typeof access.mnemonic === 'string' ? access.mnemonic : null,
            size: typeof access.size === 'number' ? access.size : null, address: access.address >>> 0,
            value: typeof access.value === 'number' ? access.value >>> 0 : null,
            cacheable: typeof access.cacheable === 'boolean' ? access.cacheable : null,
            region: access.region || null, provenance: access.provenance || null };
        }
      };
      if (typeof program === 'string') options.initialProgram = program;
      var handle;
      try { handle = window.PrismCacheExplorer.mount(holder, options); }
      catch (error) {
        replace(holder, h('div', { class: 'notice notice-error', role: 'status' }, h('h2', { text: 'The cache explorer failed to start' }), h('p', { text: String(error && error.message || error) })));
        return;
      }
      if (handle && typeof handle.dispose === 'function') onLeave(function () { handle.dispose(); });
    }
    // Offer the Base core editor's program only on request: the cache explorer
    // accepts its own subset and reports what it cannot run.
    var coreSource = WORKLOAD.coreSource.base;
    if (coreSource === undefined) { try { coreSource = window.sessionStorage.getItem('prism-core-source-base'); } catch (error) { coreSource = null; } }
    if (coreSource && coreSource !== WORKLOAD.program && window.PrismCacheExplorer) {
      replace(importBox, h('div', { class: 'notice layer-import' },
        h('p', null, 'You edited a program on the Base core page. The cache explorer runs its own subset of instructions, so loading it may report lines it cannot run.'),
        h('button', { type: 'button', class: 'button small', text: 'Load the Base core program here', onclick: function () { replace(importBox); mountExplorer(coreSource); } })));
    }
    mountExplorer(typeof WORKLOAD.program === 'string' ? WORKLOAD.program : undefined);
    return page;
  }

  function coherentCacheView() {
    var holder = h('div', { class: 'cache-coherence-slot' });
    var page = cachePage('coherent', holder);
    if (!window.PrismCoherentCaches || typeof window.PrismCoherentCaches.mount !== 'function') {
      replace(holder, h('div', { class: 'notice', role: 'status' },
        h('h3', { text: 'Coherent caches · WIP' }),
        h('p', { text: 'The coherence explorer is not in this build. Rebuild with make.' })));
      return page;
    }
    var handle = window.PrismCoherentCaches.mount(holder);
    if (handle && typeof handle.dispose === 'function') {
      onLeave(function () {
        handle.dispose();
      });
    }
    return page;
  }

  function busView(selectedId) {
    var holder = h('div', { class: 'system-bus-slot' });
    var page = h('div', { class: 'architecture-panel bus-page' },
      panelHeader('System bus, peripherals and interrupts', 'Click a peripheral to raise its interrupt and watch the level travel the RTL’s wires to the core, then the handler claim and complete it over the bus.'),
      h('p', { class: 'layer-caption' }, h('strong', { text: 'Example SoC' }),
        h('span', { class: 'layer-caption-long', text: ': the Base core, RAM, ROM, a timer, the interrupt controller, two GPIO banks, a UART and SPI, with the peripherals on their own clock. The other peripherals have register tables only.' })),
      holder, peripheralControls(selectedId));
    if (!window.PrismSystemBus) {
      replace(holder, h('div', { class: 'notice notice-error', role: 'status' }, h('h2', { text: 'The system bus view is missing' }),
        h('p', { text: 'This page needs assets/system-bus-model.js and assets/system-bus.js. Rebuild with make, then open dist/index.html.' })));
      return page;
    }
    // The last completed Caches-tab access, metadata intact; the bus view
    // decides whether it can trace it (word lw/sw only, never widened).
    var handoff = WORKLOAD.lastAccess ? Object.assign({ from: 'Caches tab' }, WORKLOAD.lastAccess) : null;
    var handle = window.PrismSystemBus.mount(holder, { handoff: handoff });
    if (handle && handle.dispose) onLeave(handle.dispose);
    return page;
  }

  function coherentView() {
    var R = window.PRISM_ROADMAP || {};
    function find(list, key, pattern) { return (list || []).filter(function (x) { return pattern.test(x[key] || ''); }); }
    var status = find(R.status, 'area', /coheren|multi-tile/i);
    var planned = find(R.planned, 'workstream', /coheren|multi-tile/i).filter(function (row) {
      var name = String(row.workstream).toLowerCase();
      return !status.some(function (s) {
        var area = String(s.area).toLowerCase();
        return area === name || area.indexOf(name + ' (') === 0;
      });
    });
    return h('div', { class: 'architecture-panel coherent-page' },
      panelHeader('Coherent cache bus', 'Shared coherent memory for several tiles is in development. The supplied memory system is non-coherent.'),
      h('p', { class: 'prose' }, 'An illustrative MESI protocol runs in ', h('a', { href: '#/architecture/caches/coherent', text: 'Local caches → Coherent' }), '.'),
      h('h2', { text: 'The supplied memory system' }),
      h('ul', { class: 'prose' },
        h('li', null, h('code', { text: 'cache_fabric_if' }), ' is blocking and non-coherent: a tile’s private caches are never told about writes made by anything else.'),
        h('li', null, 'One SoC has one tile.'),
        h('li', null, 'A system composes independent SoCs. Each has its own RAM, ROM and peripherals; shared clocks do not mean shared memory.')),
      h('h2', { text: 'On the roadmap' }),
      status.length || planned.length ? h('ul', { class: 'status-list' },
        status.map(function (row) {
          return h('li', null, h('span', { class: 'status-badge status-' + String(row.status).toLowerCase().replace(/\s+/g, '-'), text: row.status }),
            h('div', null, h('p', { class: 'status-area' }, inlineCode(row.area))));
        }),
        planned.map(function (row) {
          return h('li', null, h('span', { class: 'status-badge status-planned', text: 'Planned' }),
            h('div', null, h('p', { class: 'status-area' }, row.workstream + ': ' + row.capability), h('p', { class: 'status-evidence' }, inlineCode(row.notes || ''))));
        })) :
        h('p', null, 'See the ', h('a', { href: '#/roadmap', text: 'roadmap' }), ' for shared memory and coherence work.'));
  }

  /* ---------- Memory-mapped hardware accelerators (WIP design intent) ---------- */

  function acceleratorRegions() {
    return ((DATA.memory || {}).regions || []).filter(function (r) { return /^accelerator_[0-3]$/.test(r.id); });
  }

  function isWipAcceleratorIrq(source) {
    return acceleratorRegions().some(function (r) { return r.id === source.name && r.status === 'WIP'; });
  }

  function interruptSourcesTable(sources, caption) {
    return table([
      { label: 'Source', render: function (r) { return [h('code', { text: r.name }), isWipAcceleratorIrq(r) ? [' ', h('span', { class: 'status-badge status-wip', text: 'WIP' })] : null]; } },
      { label: 'Bit', num: true, render: function (r) { return String(r.bit); } },
      { label: 'Claim ID', num: true, render: function (r) { return String(r.bit + 1); } },
      { label: 'Mask', num: true, render: function (r) { return h('span', { class: 'mono', text: hex(r.mask) }); } }
    ], sources, { caption: caption, stack: true });
  }

  function acceleratorsView() {
    var regions = acceleratorRegions();
    var interrupts = ((DATA.memory || {}).interrupts || []).filter(isWipAcceleratorIrq);
    return h('div', { class: 'architecture-panel accelerators-page' },
      panelHeader('Memory-mapped hardware accelerators · WIP', 'A proposed way to add specialized compute next to the processor cores: commands over MMIO, data transfers to and from RAM, and a planned coherence protocol shared with the cores.'),
      h('h2', { text: 'Proposed operation' }),
      h('ol', { class: 'prose' },
        h('li', null, h('strong', { text: 'Issue commands over MMIO. ' }), 'Software controls an accelerator through its command/control region.'),
        h('li', null, h('strong', { text: 'Move data through RAM. ' }), 'The accelerator reads input data from RAM and writes results back to RAM. The MMIO command window is separate from these data transfers.'),
        h('li', null, h('strong', { text: 'Share data coherently. ' }), 'The data path uses the same coherence protocol as the cores, so their caches and the accelerator can share data.'),
        h('li', null, h('strong', { text: 'Raise completion and error interrupts. ' }), 'Each slot has one reserved interrupt source for notifying the core.')),
      h('p', { class: 'prose', text: 'An accelerator is instantiated much like a core at the composition boundary, with access to the shared coherent memory system. Command formats, transfer and error contracts, coherence and ordering rules, and interrupt handling are open design questions.' }),
      h('p', { class: 'prose' }, 'Accelerators depend on the coherent interconnect; see the ',
        h('a', { href: '#/architecture/coherent-bus', text: 'coherent bus' }), ' and the ', h('a', { href: '#/roadmap', text: 'roadmap' }), '.'),
      h('h2', { text: 'Command/control reservations' }),
      h('p', { class: 'section-intro', text: 'The address map reserves four 4 KiB command/control slots and four interrupt sources, one of each per accelerator.' }),
      regions.length ? table([
        { label: 'Slot', render: function (r) { return h('a', { href: '#/reference/address-map/' + r.id }, h('code', { text: r.id })); } },
        { label: 'Base', render: function (r) { return hexNode(r.base); } },
        { label: 'Last address (inclusive)', render: function (r) { return hexNode(r.last); } },
        { label: 'Reserved size', render: function (r) { return size(r.bytes); } }
      ], regions, { caption: 'Accelerator command/control address reservations', stack: true }) :
        h('p', { class: 'empty', text: 'The address map has no accelerator reservations.' }),
      h('h2', { text: 'Interrupt source reservations' }),
      h('p', { class: 'section-intro' }, 'The generated ', h('code', { text: 'PRISM_IRQ_ACCELERATOR_n_ID' }),
        ' constant is the source bit index; ', h('code', { text: '_MASK' }), ' is its bit mask. The controller’s claim/completion ID is the bit index plus one. These identities are separate from ', h('code', { text: 'mcause' }), '.'),
      interrupts.length ? interruptSourcesTable(interrupts, 'Accelerator interrupt source reservations') :
        h('p', { class: 'empty', text: 'The address map has no accelerator interrupt sources.' }));
  }

  /* ---------- Roadmap (pinned copy of Prism's status and planned work) ---------- */

  function inlineCode(text) {
    // Roadmap cells are plain text with `code` spans; render spans as <code>.
    return String(text).split('`').map(function (part, i) {
      return i % 2 ? h('code', { text: part }) : part;
    });
  }

  function roadmapView() {
    var R = window.PRISM_ROADMAP;
    if (!R || R.schema !== 'prism-roadmap-v1') {
      return h('div', { class: 'page' }, pageHeader('Roadmap'),
        h('div', { class: 'notice notice-error', role: 'status' },
          h('h2', { text: 'Roadmap data is missing' }),
          h('p', { text: 'This page reads data/roadmap.js, which the website build creates from content/roadmap/. Run make, then open dist/index.html.' })));
    }
    var counts = {};
    R.status.forEach(function (row) { counts[row.status] = (counts[row.status] || 0) + 1; });
    function badge(value) {
      return h('span', { class: 'status-badge status-' + value.toLowerCase().replace(/\s+/g, '-'), text: value });
    }
    return h('div', { class: 'page' },
      pageHeader('Roadmap', 'What Prism implements today, what is in development, and the work planned next.'),

      h('h2', { text: 'Current status' }),
      h('p', { class: 'section-intro' }, ['Implemented', 'In development', 'WIP', 'Partial', 'Planned'].filter(function (k) { return counts[k]; }).map(function (k, i) {
        return [i ? ' · ' : '', String(counts[k]) + ' ' + (k === 'WIP' ? k : k.toLowerCase())];
      }), '.'),
      h('ul', { class: 'status-list' }, R.status.map(function (row) {
        return h('li', null,
          badge(row.status),
          h('div', null,
            h('p', { class: 'status-area' }, row.area === 'Memory-mapped hardware accelerators' ? h('a', { href: '#/architecture/accelerators', text: row.area }) : inlineCode(row.area))));
      })),

      h('h2', { text: 'Planned development' }),
      h('p', { class: 'section-intro', text: 'Each workstream names the capability it adds and where the work starts.' }),
      h('ol', { class: 'plan-grid' }, R.planned.map(function (item) {
        return h('li', { class: 'plan-card panel' },
          h('h3', null, inlineCode(item.workstream)),
          h('p', { class: 'plan-capability' }, inlineCode(item.capability)),
          h('p', { class: 'plan-notes' }, inlineCode(item.notes)));
      })));
  }

  /* ---------- Views ---------- */

  function pageHeader(title, lede) {
    return [h('h1', { id: 'page-title', tabindex: '-1', text: title }), lede ? h('p', { class: 'lede', text: lede }) : null];
  }

  /* Hero illustration: firmware sees one microcontroller (the white beam);
     the prism splits it into the hardware layers an RTL engineer can change.
     Rays exit in spectral order and reuse the contract colours of the diagram. */
  function heroArt() {
    var entry = [166, 191];
    var layers = [
      { color: 'system', exit: [285, 170], end: [410, 62], title: 'System', sub: 'SoCs, clocks, FPGA', mono: false },
      { color: 'mmio', exit: [291.6, 185.6], end: [410, 142], title: 'Peripherals', sub: 'mmio_if', mono: true },
      { color: 'bus', exit: [298.2, 201.2], end: [410, 222], title: 'Memory fabric', sub: 'system_bus_if', mono: true },
      { color: 'cache', exit: [304.8, 216.8], end: [410, 302], title: 'Processor tile', sub: 'cache_fabric_if', mono: true }
    ];
    function pt(p) { return p[0] + ',' + p[1]; }
    var first = layers[0].exit, last = layers[layers.length - 1].exit;

    var stops = layers.map(function (l, i) {
      return svg('stop', { offset: (i / (layers.length - 1)), 'stop-color': 'var(--c-' + l.color + ')' });
    });
    return svg('svg', { class: 'hero-art', viewBox: '0 30 640 305', role: 'img', 'aria-labelledby': 'hero-art-title' },
      svg('title', { id: 'hero-art-title', text: 'Firmware sees one microcontroller. Prism splits it into layers you can change: system, peripherals, memory fabric and processor tile.' }),
      svg('defs', null,
        svg('linearGradient', { id: 'hero-fan', gradientUnits: 'userSpaceOnUse', x1: 0, y1: first[1], x2: 0, y2: last[1] }, stops)),
      svg('text', { class: 'beam-title', x: 0, y: 150, text: 'Firmware' }),
      svg('text', { class: 'ray-sub', x: 0, y: 174, text: 'one microcontroller' }),
      svg('path', { class: 'beam', pathLength: 1, d: 'M0,236 L' + (entry[0] + 40) + ',' + entry[1] }),
      svg('g', { transform: 'translate(40 0)' },
        svg('polygon', { class: 'fan', points: [pt(entry), pt(first), pt(last)].join(' '), fill: 'url(#hero-fan)' }),
        svg('path', { class: 'prism', d: 'M230,40 L340,300 L120,300 Z' }),
        layers.map(function (l, i) {
          var y = l.end[1];
          return svg('g', { class: 'ray', style: '--ray: var(--c-' + l.color + '); --i: ' + i },
            svg('path', { pathLength: 1, d: 'M' + pt(l.exit) + ' L' + pt(l.end) }),
            svg('circle', { cx: l.end[0], cy: y, r: 4.5 }),
            svg('text', { class: 'ray-title', x: 424, y: y + 2, text: l.title }),
            svg('text', { class: 'ray-sub' + (l.mono ? ' mono' : ''), x: 424, y: y + 24, text: l.sub }));
        })));
  }

  function homeView() {
    // Two equal entry columns, one per audience. Template tutorials stay out of
    // the home page until they have instructions; Roadmap lists them.
    var firmwareTasks = [
      ['#/reference/address-map', 'Look up the address map', 'Storage, reserved regions, registers, fields and interrupt bits.'],
      ['#/reference/platformio', 'Build firmware with PlatformIO', 'Project options, toolchain details and the application setup guide.']
    ];
    var rtlTasks = [
      ['#/architecture', 'Explore the architecture', 'A clickable block diagram of a SoC and the three interfaces that connect its parts.'],
      ['#/architecture/core', 'Step through a core', 'Singlecycle, Base and Hazard3 datapaths, cycle by cycle, with your own program run on the RTL.'],
      ['#/architecture/caches', 'Follow loads and stores through the caches', 'Cache hits, misses, refills and write-backs for your own loads and stores.'],
      ['#/architecture/system-bus', 'Trace the system bus and interrupts', 'A load or store from the fabric to RAM, ROM or a peripheral, and an interrupt back to the core.'],
      ['#/tools/peripheral-docs', 'Document a custom peripheral', 'Generate a register reference from your TOML and share it with firmware developers.']
    ];
    function taskGroup(title, sub, items) {
      return h('section', { class: 'task-group' }, h('h3', null, title, h('span', { class: 'task-group-sub', text: sub })),
        h('ul', { class: 'task-list' }, items.map(function (t) {
          return h('li', null, h('a', { href: t[0] },
            h('span', { class: 'task-title' }, h('span', { text: t[1] })),
            h('span', { class: 'task-desc', text: t[2] })));
        })));
    }

    var problem = dataProblem('memory');
    var reference = problem ? dataNotice(problem, 'memory') : null;

    return h('div', { class: 'page' },
      h('section', { class: 'hero' },
        h('div', { class: 'hero-grid' },
          h('div', { class: 'hero-text' },
            h('h1', { id: 'page-title', tabindex: '-1', text: 'A Bare Metal SoC in SystemVerilog that you configure and build' }),
            h('p', { class: 'lede', text: 'Prism is written in synthesizable SystemVerilog and runs in simulation or on an FPGA. Firmware engineers write against its address map and upload builds at runtime, as on any microcontroller. RTL engineers can swap the core, change the memory fabric or add a peripheral; each layer meets the next at a documented contract.' }),
            h('p', { class: 'lede', text: 'The supplied cores, contracts and firmware tools are RV32.' })),
          heroArt(),
          h('div', { class: 'button-row' },
            h('a', { class: 'button primary', href: '#/guides/getting-started', text: 'Get started' }),
            h('a', { class: 'button', href: '#/architecture', text: 'Explore the architecture' }),
            h('a', { class: 'button', href: '#/reference/address-map', text: 'Open the address map' })))),
      h('h2', { class: 'visually-hidden', text: 'Start with a task' }),
      h('div', { class: 'task-groups home-tasks' },
        taskGroup('Firmware', 'Program a Prism SoC', firmwareTasks),
        taskGroup('RTL', 'Change or extend the hardware', rtlTasks)),
      reference,
      h('nav', { class: 'home-more', 'aria-label': 'Project' },
        h('a', { href: '#/guides' }, h('strong', { text: 'Guides' }), h('span', { text: 'Prism’s guides, from first steps to verification.' })),
        h('a', { href: '#/roadmap' }, h('strong', { text: 'Roadmap' }), h('span', { text: 'What is implemented, in development and planned.' }))));
  }

  function architectureView() {
    var layers = [
      ['Your SoC manifest', 'The tile, the fabric, the peripherals and the memory map'],
      ['Your tile manifest', 'Which core, instruction cache and data cache form the processor tile'],
      ['Your memory map', 'Addresses, and the RAM and ROM sizes'],
      ['Your core manifest', 'Requested compiler ISA and microarchitecture settings consumed by generated package headers'],
      ['Your system manifest', 'Which SoCs go on the board, their clock frequencies and the board pins they use'],
      ['Your firmware project', 'C code, built with Make or PlatformIO'],
      ['RTL', 'How a core, memory fabric or peripheral works inside']
    ];
    var entries = {};
    var explorer = diagram({ side: true, entries: function (key) {
      var item = entries[key];
      Object.keys(entries).forEach(function (k) { entries[k].classList.toggle('is-target', k === key); });
      var smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      item.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
      item.focus({ preventScroll: true });
    } });
    return h('div', { class: 'architecture-panel architecture-overview' },
      h('p', { class: 'lede', text: 'A SoC is one processor with its own RAM, boot ROM and peripherals. Prism calls the processor together with its caches a tile, and the block that merges the tile’s instruction and data requests the memory fabric. A system is one or more SoCs on one FPGA; they share no memory.' }),
      h('p', { class: 'section-intro' }, 'New to Prism? Read ', h('a', { href: '#/guides/getting-started', text: 'Getting started' }), ' first. Click a block or a connection in the diagram to see what it does.'),
      explorer,
      h('p', { class: 'section-intro' }, 'Step through the layers one at a time: ',
        h('a', { href: '#/architecture/datapath/base', text: 'a core datapath' }), ', its ',
        h('a', { href: '#/architecture/caches', text: 'local caches' }), ', then the ',
        h('a', { href: '#/architecture/system-bus', text: 'system bus, peripherals and interrupts' }), '.'),
      h('h2', { text: 'Parts and interfaces' }),
      h('p', { class: 'section-intro', text: 'The full entry for each part of the diagram, in reading order.' }),
      h('ul', { class: 'boundary-list' }, PART_ORDER.map(function (key) {
        var part = PARTS[key];
        var item = h('li', { id: 'part-' + key, tabindex: '-1', style: part.color ? '--seam: var(--c-' + part.color + ')' : null },
          h('div', null,
            h('h3', { class: 'name' + (part.contract ? ' contract' : ''), text: part.title }),
            h('div', { class: 'kind', text: part.kind }),
            h('button', { type: 'button', class: 'link-button', onclick: function () { explorer.showPart(key); }, text: 'Show in diagram' })),
          h('div', null, h('p', { text: part.text }), h('div', { class: 'path' }, h('code', { text: part.path }))));
        entries[key] = item;
        return item;
      })),
      h('h2', { text: 'What you edit' }),
      h('p', { class: 'section-intro' }, 'Each hardware choice is made in one file. Every action is a Make target followed by the manifest it acts on, for example ', h('code', { text: 'make lint <your SoC manifest>' }), '.'),
      table([
        { label: 'File', render: function (r) { return h('strong', { text: r[0] }); } },
        { label: 'What it decides', render: function (r) { return r[1]; } }
      ], layers, { caption: 'What you edit', stack: true }));
  }

  var TUTORIALS = {
    'instantiate-core': {
      title: 'Quickstart: instantiate a core',
      lede: 'Select a supplied core, place it in a SoC and run firmware on it.',
      outline: ['Create a SoC configuration and choose its core', 'Check the simulation tools', 'Build and program the FPGA', 'Build and upload an application'],
      canonical: ['docs/getting-started.md', 'docs/nexys_video_quickstart.md'],
      related: [['#/architecture', 'Architecture'], ['#/reference/platformio', 'PlatformIO build'], ['#/reference/address-map', 'Address map']]
    },
    'custom-tile': {
      title: 'Write a custom core or tile',
      lede: 'Wrap a core so its tile implements cache_fabric_if, then declare it so a SoC can select it.',
      outline: ['The tile boundary and cache_fabric_if obligations', 'Component manifest: sources, entry points, interfaces and capabilities', 'Select the tile from a SoC', 'Compare retirement against Spike'],
      canonical: ['docs/adding-a-core.md', 'docs/interfaces.md', 'docs/verification.md', 'docs/test-catalog.md'],
      related: [['#/architecture', 'Architecture and contracts']]
    },
    'systems': {
      title: 'Compose a system',
      lede: 'Compose independent SoCs in a system TOML manifest and build them for Nexys Video.',
      outline: ['Declare several SoCs in one system', 'Assign clocks and logical routes', 'Map routes to Nexys Video pads and clock primitives', 'Upload firmware to each SoC'],
      canonical: ['docs/configuration.md', 'docs/fpga.md', 'docs/uart_upload.md'],
      related: [['#/architecture', 'Architecture'], ['#/reference/address-map', 'Address map']]
    }
  };

  function richText(text) {
    // Tutorial text: `code` spans and [text](#/route or https://) links; all else is text.
    var out = [];
    String(text).split(/(`[^`]*`|\[[^\]]+\]\([^)]*\))/).forEach(function (part) {
      if (!part) return;
      var link = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(part);
      if (part.charAt(0) === '`' && part.length > 1) out.push(h('code', { text: part.slice(1, -1) }));
      else if (link && (link[2].indexOf('#/') === 0 || link[2].indexOf('https://') === 0)) {
        out.push(h('a', { href: link[2], text: link[1], rel: link[2].indexOf('https://') === 0 ? 'noopener' : null }));
      } else out.push(part);
    });
    return out;
  }

  // Tutorial stages point at sections of Prism's guides, which the site
  // publishes at #/guides/<file stem> (assets/guides.js).
  function guideRef(ref) {
    var key = ref.doc.replace(/^docs\//, '').replace(/\.md$/, '');
    var G = window.PrismGuides;
    var label = [G ? guideTitle(key) : h('code', { text: ref.doc }), ' › ', ref.section];
    var target = G && G.href(key, ref.section);
    return target ? h('a', { href: target }, label) : h('span', null, label);
  }

  function guideTitle(key) {
    var match = window.PrismGuides.list().filter(function (g) { return g.key === key; })[0];
    return match ? match.title : key;
  }

  function tutorialView(key) {
    var t = (window.PRISM_TUTORIALS || {})[key];
    if (!t) return tutorialTemplateView(key);
    var audience = { firmware: 'Firmware', rtl: 'RTL', both: 'Firmware and RTL' }[t.audience];
    var stages = t.stages.map(function (stage, i) {
      return h('li', { class: 'tutorial-step', id: 'stage-' + stage.id },
        h('div', { class: 'step-head' },
          h('span', { class: 'step-number', 'aria-hidden': 'true', text: String(i + 1) }),
          h('h3', null, h('span', { class: 'visually-hidden', text: 'Stage ' + (i + 1) + ': ' }), richText(stage.title))),
        h('p', null, richText(stage.text)),
        h('div', { class: 'stage-guide' }, h('span', { class: 'stage-label', text: 'Prism guide' }),
          h('ul', null, stage.guide.map(function (ref) { return h('li', null, guideRef(ref)); }))),
        stage.see ? h('div', { class: 'stage-guide' }, h('span', { class: 'stage-label', text: 'On this site' }),
          h('ul', null, stage.see.map(function (link) { return h('li', null, h('a', { href: link.href, text: link.text })); }))) : null);
    });
    return h('div', { class: 'page tutorial' },
      pageHeader(t.title, t.lede),
      h('dl', { class: 'facts tutorial-facts' },
        h('div', null, h('dt', { text: 'For' }), h('dd', { text: audience })),
        h('div', null, h('dt', { text: 'You will have' }), h('dd', null, richText(t.outcome)))),
      t.prerequisites.length ? [h('h2', { text: 'Before you start' }),
        h('ul', { class: 'prereq-list' }, t.prerequisites.map(function (p) { return h('li', null, richText(p)); }))] : null,
      h('h2', { text: 'Stages' }),
      h('p', { class: 'section-intro', text: 'Each stage links to the section of Prism’s guides that has the commands and details.' }),
      h('ol', { class: 'tutorial-steps' }, stages),
      h('h2', { text: 'Next' }),
      h('ul', { class: 'next-list' }, t.next.map(function (link) { return h('li', null, h('a', { href: link.href, text: link.text })); })));
  }

  function tutorialTemplateView(key) {
    var t = TUTORIALS[key];
    return h('div', { class: 'page prose' },
      pageHeader(t.title, t.lede),
      h('div', { class: 'notice notice-template' },
        h('h2', { text: 'This tutorial is a template' }),
        h('p', { text: 'Its steps will appear here once the content is approved. Until then, follow the canonical guides in the Prism repository:' }),
        h('p', null, t.canonical.map(function (path, i) { return [i ? ', ' : '', h('code', { text: path })]; }))),
      h('h2', { text: 'Planned sections' }),
      h('ol', { class: 'outline' }, t.outline.map(function (s) { return h('li', { text: s }); })),
      h('div', { class: 'related' }, h('h2', { text: 'Available now' }),
        h('ul', null, t.related.map(function (r) { return h('li', null, h('a', { href: r[0], text: r[1] })); }))));
  }

  function pageContents(sections) {
    // The router owns location.hash, so these links scroll instead of navigating.
    return h('nav', { class: 'page-contents', 'aria-label': 'On this page' },
      h('span', { class: 'page-contents-label', text: 'On this page' }),
      sections.filter(Boolean).map(function (section) {
        return h('a', { href: '#' + location.hash.replace(/^#/, ''), onclick: function (event) {
          event.preventDefault();
          var target = section[1];
          target.setAttribute('tabindex', '-1');
          target.scrollIntoView({ block: 'start' });
          target.focus({ preventScroll: true });
        }, text: section[0] });
      }));
  }

  function registerTable(region, hits) {
    hits = hits || {};
    var regs = region.registers || [];
    if (!regs.length) return h('p', { class: 'empty', text: 'No register layout is bound to this region in the memory map.' });
    var hasNotes = regs.some(function (r) { return r.notes; });
    var columns = [
      { label: 'Offset', num: true, render: function (r) { return h('span', { class: 'mono', text: shortMask(r.offset) }); } },
      { label: 'Address', render: function (r) { return addressButton(r.address, region.id + ' ' + r.name); } },
      { label: 'Register', render: function (r) { return h('code', { text: r.name }); } },
      { label: 'Access', render: function (r) { return h('span', { class: 'access ' + r.access, title: { ro: 'Read-only', rw: 'Read/write', wo: 'Write-only' }[r.access] || r.access, text: r.access }); } },
      { label: 'Fields', optional: true, render: function (r) {
        if (!r.fields || !r.fields.length) return '';
        return h('span', { class: 'fields' }, r.fields.map(function (f) {
          var bits = f.width > 1 ? '[' + (f.lsb + f.width - 1) + ':' + f.lsb + ']' : '[' + f.lsb + ']';
          return h('span', { class: 'field-chip', title: f.name + ' mask ' + hex(f.mask) }, f.name, h('span', { class: 'dim', text: bits + ' ' + shortMask(f.mask) }));
        }));
      } }
    ];
    if (hasNotes) columns.push({ label: 'Notes', optional: true, render: function (r) { return r.notes ? h('span', { class: 'reg-notes', text: r.notes }) : ''; } });
    var rows = regs.map(function (r) { return Object.assign({ _class: hits[region.id] && hits[region.id][r.name] ? 'hit' : null }, r); });
    return table(columns, rows, { caption: 'Registers of ' + region.id, stack: true });
  }

  // Manifests write keys and masks such as the watchdog feed key in hex;
  // show integers above 16 bits the same way.
  function capabilitiesJson(capabilities) {
    return JSON.stringify(capabilities, function (key, value) {
      return typeof value === 'number' && Number.isInteger(value) && value > 0xFFFF ? '0x' + value.toString(16).toUpperCase() : value;
    }, 2);
  }

  // A roadmap status row named after a region (for example "DMA") marks that
  // device as not yet complete wherever the site shows it.
  function regionStatus(id) {
    var rows = (window.PRISM_ROADMAP || {}).status || [];
    var name = String(id).toLowerCase();
    var row = rows.filter(function (r) {
      var area = String(r.area).toLowerCase();
      return area === name || area.indexOf(name + ' ') === 0;
    })[0];
    return row && row.status !== 'Implemented' ? row.status : null;
  }

  function statusBadge(status) {
    return h('span', { class: 'status-badge status-' + status.toLowerCase().replace(/\s+/g, '-'), text: status });
  }

  function regsLinks(region, skipControls) {
    if (!(region.registers || []).length) return null;
    if (skipControls) return null;
    return h('p', { class: 'meta register-links' },
      h('a', { href: '#/architecture/system-bus/' + encodeURIComponent(region.id), text: 'Peripheral controls and registers' }));
  }

  function peripheralControls(selectedId) {
    var memory = DATA && DATA.memory;
    if (!memory) return null;
    var regions = (memory.regions || []).filter(function (r) { return (r.registers || []).length; });
    var region = regions.filter(function (r) { return r.id === selectedId; })[0] || regions.filter(function (r) { return r.id === 'gpio_a'; })[0] || regions[0];
    var scopes = {
      uart: 'The interactive model transmits and receives bytes and raises the UART interrupt. Receive injects a byte.',
      spi: 'The interactive model runs classic SPI frames through the first 28 bytes of registers. QSPI segment registers share the SPI base.',
      pwm: 'Three 16-bit timers with prescalers and one 32-bit timer, with eight fixed channels per timer.',
      watchdog: 'Feed, pretimeout and reset-request controls. reset_request is an output for the system reset logic.',
      can: 'Classical CAN with standard 11-bit identifiers, data and remote frames. Extended frames are discarded without an acknowledgement.',
      adc: 'Reads tagged samples from the FPGA XADC through a platform adapter, which you wire to the board for your platform.',
      dma: 'Captures MMIO commands. The DMA has no bus master, so an accepted command completes with BACKEND_UNAVAILABLE.',
      gpio_a: 'The interactive model takes register writes and injected inputs, and raises edge interrupts.',
      gpio_b: 'The interactive model takes register writes and injected inputs, and raises edge interrupts.',
      timer: 'The interactive model runs MTIME and MTIMECMP and raises the machine-timer interrupt. Time advances only with the model actions.',
      irq: 'The interactive model handles priority, enable, claim and completion for its four routed sources.'
    };
    var concept = region && window.PrismPeripheralGuide && window.PrismPeripheralGuide.forRegion(region.id);
    var irq = region && (memory.interrupts || []).filter(function (i) { return i.name === region.id; })[0];
    var capabilities = region && region.component && region.component.capabilities;
    return h('section', { class: 'peripheral-controls', 'aria-label': 'Peripheral controls and registers' },
      h('h2', { text: 'Peripheral controls and registers' }),
      h('p', { class: 'section-intro', text: 'Select a device to see its registers and fields.' }),
      h('nav', { class: 'peripheral-guide-nav', 'aria-label': 'Peripheral control references' }, regions.map(function (r) {
        return h('a', { href: '#/architecture/system-bus/' + encodeURIComponent(r.id), 'aria-current': region && r.id === region.id ? 'page' : null,
          text: r.id === 'spi' ? 'SPI / QSPI' : r.id === 'watchdog' ? 'Watchdog' : r.id.toUpperCase() });
      })),
      region ? h('div', { class: 'peripheral-control-reference', 'data-region': region.id },
        h('h3', null, (region.id === 'spi' ? 'SPI / QSPI' : region.id.toUpperCase()) + ' control / status reference', regionStatus(region.id) ? [' ', statusBadge(regionStatus(region.id))] : null),
        h('p', null, h('code', { text: hex(region.base) }), ' · ' + size(region.bytes) + ' reserved · ' + size(region.component && region.component.register_bytes || region.register_extent) + ' register window',
          irq ? ' · IRQ source bit ' + irq.bit + ', claim ID ' + (irq.bit + 1) : ''),
        scopes[region.id] ? h('p', { class: 'notice control-scope', text: scopes[region.id] }) : null,
        h('p', { class: 'register-links' }, h('a', { href: '#/reference/address-map/' + encodeURIComponent(region.id), text: 'Open in the address map' }),
          concept ? [' · ', h('a', { href: concept.href, text: concept.label })] : null),
        regsLinks(region, true),
        capabilities !== undefined ? h('details', { class: 'region-capabilities' }, h('summary', { text: 'Declared capabilities' }),
          codeBlock(capabilitiesJson(capabilities), 'Manifest capabilities (JSON)', 'declared component capabilities')) : null,
        registerTable(region)) : null,
      h('p', { class: 'section-intro' }, h('a', { href: '#/reference/address-map/accelerator_0', text: 'Accelerator slots 0–3 and IRQ reservations · WIP' })));
  }

  /* ----- Address map ----- */

  function addressMapView(selectedId) {
    var reference = DATA;
    var routeBase = '#/reference/address-map';
    var problem = dataProblem('memory', reference);
    if (problem) return h('div', { class: 'page' }, pageHeader('Address map'), dataNotice(problem, 'memory', reference));
    var memory = reference.memory;
    var regions = (memory.regions || []).slice().sort(function (a, b) { return a.base - b.base; });
    var storage = memory.storage || [];
    var aperture = memory.aperture;

    // Storage
    var storageList = h('div', null, storage.map(function (s) {
      var ratio = s.reserved_bytes > 0 ? Math.min(1, s.bytes / s.reserved_bytes) : 0;
      var percent = ratio * 100;
      return h('div', { class: 'storage-row' },
        h('div', { class: 'storage-name', text: s.name }),
        h('div', null,
          h('div', { class: 'storage-meta' },
            h('span', null, h('span', { class: 'dim', text: 'Base' }), addressButton(s.base, s.name)),
            h('span', null, h('span', { class: 'dim', text: 'Last reserved' }), addressButton(s.last, s.name + ' reservation end')),
            s.bytes > 0 ? h('span', null, h('span', { class: 'dim', text: 'Last installed' }), addressButton(s.base + s.bytes - 1, s.name + ' installed end')) : null),
          h('div', { class: 'meter', role: 'img', 'aria-label': size(s.bytes) + ' installed of ' + size(s.reserved_bytes) + ' reserved' },
            h('span', { style: 'width: ' + percent.toFixed(3) + '%' })),
          h('div', { class: 'meter-legend', text: size(s.bytes) + ' installed of ' + size(s.reserved_bytes) + ' reserved' })));
    }));

    var apertureFacts = aperture ? h('dl', { class: 'facts' },
      h('div', null, h('dt', { text: 'Base' }), h('dd', null, addressButton(aperture.base, 'peripheral aperture'))),
      h('div', null, h('dt', { text: 'Last address' }), h('dd', null, addressButton(aperture.base + aperture.bytes - 1, 'peripheral aperture end'))),
      h('div', null, h('dt', { text: 'Size' }), h('dd', { text: size(aperture.bytes) })),
      h('div', null, h('dt', { text: 'Peripheral stride' }), h('dd', { text: size(aperture.peripheral_stride) }))) : null;

    // Reserved regions with filter, address lookup and expandable registers.
    var expanded = {};
    var hits = {};
    var items = [];
    var query = '';
    var onlyRegisters = false;

    var searchInput = h('input', { type: 'search', id: 'region-search', autocomplete: 'off', spellcheck: 'false',
      placeholder: regions.length ? 'uart, irq_enable, ' + hex(regions[0].base) : 'Region or register name',
      'aria-describedby': 'region-search-hint' });
    var onlyBox = h('input', { type: 'checkbox', id: 'only-registers' });
    var resultLine = h('p', { class: 'result-line', 'aria-live': 'polite' });
    var lookup = h('div', { class: 'lookup', hidden: true, 'aria-live': 'polite' });
    var list = h('ul', { class: 'region-list' });


    function renderBody(item) {
      var r = item.region;
      var concept = window.PrismPeripheralGuide && window.PrismPeripheralGuide.forRegion(r.id);
      var component = r.component || {};
      var regWindow = typeof component.register_bytes === 'number' ? component.register_bytes : r.register_extent;
      replace(item.body,
        r.description ? h('p', { class: 'desc', text: r.description }) : null,
        /^accelerator_[0-3]$/.test(r.id) ? h('p', { class: 'meta' }, h('a', { href: '#/architecture/accelerators', text: 'Accelerator architecture · WIP' }), ' · proposed command and coherent data paths') : null,
        concept ? h('p', { class: 'meta' }, h('a', { href: concept.href, text: concept.label }), ' · protocol and integration background') : null,
        r.contract || typeof regWindow === 'number' ? h('p', { class: 'meta' },
          r.contract ? ['Software contract ', h('code', { text: r.contract })] : null,
          r.contract && typeof regWindow === 'number' ? ' · ' : null,
          typeof regWindow === 'number' ? size(regWindow) + ' register window' : null,
          component.top ? [' · top module ', h('code', { text: component.top })] : null) : null,
        component.capabilities !== undefined ? h('details', { class: 'region-capabilities' },
          h('summary', { text: 'Declared capabilities' }),
          codeBlock(capabilitiesJson(component.capabilities), 'Manifest capabilities (JSON)', 'declared component capabilities')) : null,
        regsLinks(r),
        registerTable(r, hits));
    }

    function setExpanded(item, open) {
      expanded[item.region.id] = open;
      item.toggle.setAttribute('aria-expanded', String(open));
      item.body.hidden = !open;
      if (open) renderBody(item);
    }

    regions.forEach(function (r) {
      var regs = r.registers || [];
      var bodyId = 'region-body-' + r.id;
      var subText = r.layout_name
        ? 'Layout ' + r.layout_name + ', ' + plural(regs.length, 'register', 'registers')
        : 'No register layout';
      var toggle = h('button', { type: 'button', class: 'region-toggle', 'aria-expanded': 'false', 'aria-controls': bodyId },
        chevron(),
        h('span', { class: 'region-id' }, r.id + (r.id === 'spi' ? ' / QSPI' : ''), r.status === 'WIP' ? [' ', h('span', { class: 'status-badge status-wip', text: 'WIP' })] : regionStatus(r.id) ? [' ', statusBadge(regionStatus(r.id))] : null),
        h('span', { class: 'region-range' }, hexNode(r.base), h('span', { class: 'dim', text: 'to' }), hexNode(r.last), h('span', { class: 'dim', text: size(r.bytes) })),
        h('span', { class: 'region-sub', text: subText }));
      var body = h('div', { class: 'region-body', id: bodyId, hidden: true });
      var li = h('li', { class: 'region', id: 'region-' + r.id },
        h('div', { class: 'region-head' }, toggle, copyButton(hex(r.base), 'base address of ' + r.id, null, 'Copy base')),
        body);
      var item = { region: r, li: li, toggle: toggle, body: body };
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') !== 'true';
        setExpanded(item, open);
        if (open) selectRegion(r.id, false);
      });
      items.push(item);
      list.appendChild(li);
    });

    function selectRegion(id, scroll) {
      items.forEach(function (it) { it.li.classList.toggle('selected', it.region.id === id); });
      var route = routeBase + '/' + encodeURIComponent(id);
      if (location.hash !== route) {
        try { history.replaceState(null, '', route); } catch (error) { /* some file:// contexts refuse; selection still works */ }
      }
      if (scroll) {
        var target = items.filter(function (it) { return it.region.id === id; })[0];
        if (target) target.li.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }

    function parseAddress(q) {
      var m = /^0x([0-9a-f_]{1,9})$/i.exec(q.trim());
      if (!m) return null;
      var value = parseInt(m[1].replace(/_/g, ''), 16);
      return value >= 0 && value <= 0xFFFFFFFF ? value : null;
    }

    function describeAddress(addr) {
      var text = hex(addr) + ' ';
      var region = regions.filter(function (r) { return addr >= r.base && addr <= r.last; })[0];
      if (region) {
        var word = addr - (addr % 4);
        var reg = (region.registers || []).filter(function (g) { return g.address === word; })[0];
        return { region: region, register: reg, text: text + 'is in reserved region ' + region.id + ' at offset ' + shortMask(addr - region.base) +
          (reg ? ', register ' + reg.name + (addr !== word ? ' (byte ' + (addr - word) + ')' : '') : '') + '.' };
      }
      var mem = storage.filter(function (s) { return addr >= s.base && addr <= s.last; })[0];
      if (mem) {
        var installed = addr < mem.base + mem.bytes;
        return { text: text + (installed
          ? 'is in installed ' + mem.name + ' at offset ' + shortMask(addr - mem.base) + '.'
          : 'is in the ' + mem.name + ' reservation, beyond the ' + size(mem.bytes) + ' installed.') };
      }
      if (aperture && addr >= aperture.base && addr < aperture.base + aperture.bytes) {
        return { text: text + 'is in the peripheral aperture but outside every reserved region.' };
      }
      return { text: text + 'is outside the address map.' };
    }

    function applyFilter(fromInput) {
      var q = query.trim().toLowerCase();
      var addr = parseAddress(q);
      var shown = 0;
      hits = {};
      lookup.hidden = true;
      lookup.classList.remove('miss');
      var found = null;
      if (addr !== null) {
        found = describeAddress(addr);
        lookup.textContent = found.text;
        lookup.hidden = false;
        if (!found.region) lookup.classList.add('miss');
        if (found.register) { hits[found.region.id] = {}; hits[found.region.id][found.register.name] = true; }
      }
      items.forEach(function (item) {
        var r = item.region;
        var regs = r.registers || [];
        var visible = true;
        if (onlyRegisters && !regs.length) visible = false;
        if (visible && q) {
          if (addr !== null) {
            visible = !!found.region && found.region.id === r.id;
          } else {
            var concept = window.PrismPeripheralGuide && window.PrismPeripheralGuide.forRegion(r.id);
            var regionText = [r.id, r.layout_name, r.contract, r.description, r.status, concept && concept.label].join(' ').toLowerCase();
            var regionMatch = regionText.indexOf(q) !== -1;
            var regHits = {};
            regs.forEach(function (g) {
              var text = [g.name, g.notes || ''].concat((g.fields || []).map(function (f) { return f.name; })).join(' ').toLowerCase();
              if (text.indexOf(q) !== -1) regHits[g.name] = true;
            });
            var anyReg = Object.keys(regHits).length > 0;
            if (anyReg) hits[r.id] = regHits;
            visible = regionMatch || anyReg;
          }
        }
        item.li.hidden = !visible;
        if (visible) shown++;
        if (visible && fromInput && hits[r.id]) setExpanded(item, true);
        else if (expanded[r.id]) renderBody(item);
      });
      resultLine.textContent = shown === regions.length
        ? 'Showing all ' + plural(regions.length, 'reserved region', 'reserved regions') + '.'
        : 'Showing ' + shown + ' of ' + plural(regions.length, 'reserved region', 'reserved regions') + '.';
    }

    var debounce;
    searchInput.addEventListener('input', function () {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(function () { query = searchInput.value; applyFilter(true); }, 120);
    });
    searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && searchInput.value) { searchInput.value = ''; query = ''; applyFilter(true); }
    });
    onlyBox.addEventListener('change', function () { onlyRegisters = onlyBox.checked; applyFilter(false); });

    var expandAll = h('button', { type: 'button', class: 'button small', text: 'Expand all' });
    var collapseAll = h('button', { type: 'button', class: 'button small', text: 'Collapse all' });
    expandAll.addEventListener('click', function () { items.forEach(function (it) { if (!it.li.hidden) setExpanded(it, true); }); });
    collapseAll.addEventListener('click', function () { items.forEach(function (it) { setExpanded(it, false); }); });

    applyFilter(false);
    var selected = selectedId && items.filter(function (it) { return it.region.id === selectedId; })[0];
    if (selected) {
      setExpanded(selected, true);
      selected.li.classList.add('selected');
      window.setTimeout(function () { selected.li.scrollIntoView({ block: 'start' }); }, 0);
    }

    var interrupts = memory.interrupts || [];

    var storageHeading = h('h2', { text: 'Storage' });
    var apertureHeading = aperture ? h('h2', { text: 'Peripheral aperture' }) : null;
    var regionsHeading = h('h2', { text: 'Reserved regions' });
    var interruptsHeading = h('h2', { text: 'Interrupts' });
    return h('div', { class: 'page' },
      pageHeader('Address map', 'Where RAM, ROM and each peripheral sit in the 32-bit address space. The map reserves a region for every supplied peripheral; a peripheral answers in its region only when your SoC manifest installs it.'),
      h('p', { class: 'section-intro' }, h('a', { href: '#/architecture/system-bus', text: 'Peripheral controls and registers' }), ' · For protocol and integration background, read ',
        h('a', { href: '#/reference/peripherals', text: 'Peripheral concepts' }), '.'),
      pageContents([['Storage', storageHeading], apertureHeading && ['Peripheral aperture', apertureHeading],
        ['Reserved regions', regionsHeading], ['Interrupts', interruptsHeading]]),
      storageHeading,
      storageList,
      aperture ? [apertureHeading, apertureFacts] : null,
      regionsHeading,
      h('div', { class: 'toolbar' },
        h('div', { class: 'field' },
          h('label', { for: 'region-search', text: 'Filter regions and registers' }),
          searchInput,
          h('span', { class: 'hint', id: 'region-search-hint', text: 'Matches region, register and field names. Enter a hexadecimal address starting with 0x to find what it maps to.' })),
        h('label', { class: 'check', for: 'only-registers' }, onlyBox, 'Only regions with registers'),
        h('div', { class: 'actions' }, expandAll, collapseAll)),
      lookup,
      resultLine,
      regions.length ? list : h('p', { class: 'dim', text: 'The memory map declares no reserved regions.' }),
      interruptsHeading,
      h('p', { class: 'section-intro', text: 'Bit is the source bit at the external interrupt controller; claim ID is that bit plus one, returned by current_irq. Neither is an mcause value.' }),
      interrupts.length ? interruptSourcesTable(interrupts, 'Interrupt sources') : h('p', { class: 'dim', text: 'The memory map declares no interrupt sources.' }),
      h('h2', { text: 'Add a peripheral' }),
      h('p', { class: 'prose' }, 'The ', h('a', { href: '#/guides/integration', text: 'Add a peripheral guide' }),
        ' builds a small teaching peripheral, ', h('code', { text: 'pwm_lab' }), ', from RTL through firmware and board routing. The ',
        h('a', { href: '#/guides/manifests', text: 'manifest reference' }), ' defines the register and component keys.'));
  }

  /* ----- Peripheral concepts ----- */

  function peripheralConceptsView(topic) {
    if (!window.PrismPeripheralGuide) return h('div', { class: 'page' }, pageHeader('Peripheral concepts'),
      h('p', { class: 'notice notice-error', text: 'Peripheral concept guides could not load. Rebuild the site and reopen this page.' }));
    return window.PrismPeripheralGuide.render({ h: h, table: table, pageHeader: pageHeader, data: DATA, status: regionStatus, statusBadge: statusBadge }, topic);
  }

  /* ----- PlatformIO ----- */

  function platformioView() {
    var problem = dataProblem('platformio');
    if (problem) return h('div', { class: 'page' }, pageHeader('PlatformIO build'), dataNotice(problem, 'platformio'));
    var p = DATA.platformio;
    var engines = p.engines || {};
    var packages = p.packages || {};
    var options = p.options || [];

    var packageRows = Object.keys(packages).map(function (name) { return Object.assign({ name: name }, packages[name]); });

    return h('div', { class: 'page' },
      pageHeader('PlatformIO build', 'Build and upload C and C++ programs with PlatformIO. Create an application with the SDK target, then open its folder in Zed or VS Code. It includes main.c, hardware-derived headers, the runtime, bundled PlatformIO tools, a Make wrapper and editor metadata.'),
      h('p', { class: 'prose' }, 'The ', h('a', { href: '#/guides/firmware#1-blink-with-platformio', text: 'firmware guide' }),
        ' walks through a first build, upload and serial monitor.'),
      h('dl', { class: 'facts' },
        h('div', null, h('dt', { text: 'Platform' }), h('dd', null, h('code', { text: p.name }))),
        h('div', null, h('dt', { text: 'Version' }), h('dd', { text: String(p.version) })),
        Object.keys(engines).map(function (engine) {
          return h('div', null, h('dt', { text: engine === 'platformio' ? 'PlatformIO Core' : engine }), h('dd', { class: 'mono', text: engines[engine] }));
        })),

      h('h2', { text: 'Project options' }),
      h('p', { class: 'section-intro' }, 'Set these in a ', h('code', { text: 'platformio.ini' }), ' environment. The ',
        h('a', { href: '#/guides/firmware#project-options', text: 'firmware guide' }), ' explains each option and what an unset option selects. Required inputs apply when custom_target is unset; generated applications use their bundled contract.'),
      table([
        { label: 'Option', render: function (r) { return h('code', { text: r.name }); } },
        { label: 'Required', render: function (r) { return r.required ? 'Yes' : 'No'; } },
        { label: 'Default', render: function (r) {
          if (r.default === null || r.default === undefined) return h('span', { class: 'dim', text: r.required ? 'None; set it' : 'None' });
          if (r.default === '') return h('span', { class: 'dim', text: 'Not set' });
          return h('code', { text: String(r.default) });
        } }
      ], options, { caption: 'Project options', stack: true }),

      packageRows.length ? [h('h2', { text: 'Packages' }), table([
        { label: 'Package', render: function (r) { return h('code', { text: r.name }); } },
        { label: 'Version', render: function (r) { return h('span', { class: 'mono', text: r.version || '' }); } },
        { label: 'Type', render: function (r) { return r.type || ''; } }
      ], packageRows, { caption: 'Platform packages', stack: true }),
        (p.package_overrides || []).map(function (rule) {
          return h('p', { class: 'section-intro' }, h('code', { text: rule.package }),
            ' is installed automatically unless ',
            h('code', { text: rule.optional_when_environment || rule.optional_when_option }),
            rule.optional_when_environment
              ? ' is set in the environment to the prefix of an installed toolchain.'
              : ' selects an existing toolchain.');
        })] : null);
  }

  /* ----- Local peripheral documents: input files stay in this browser ----- */

  function contractView() {
    var content = window.PRISM_DOC_TOOLING.contract;
    return h('div', { class: 'page' }, pageHeader(content.title, content.lede),
      h('div', { class: 'button-row' }, h('a', { class: 'button primary', href: '#/tools/peripheral-docs', text: 'Open the generator' })),
      content.sections.map(function (section) {
        return h('section', { id: section.id }, h('h2', { text: section.title }),
          (section.paragraphs || []).map(function (p) { return h('p', { class: 'prose', text: p }); }),
          section.bullets ? h('ul', { class: 'prose' }, section.bullets.map(function (p) { return h('li', { text: p }); })) : null,
          section.table ? table(section.table.columns.map(function (label, i) { return { label: label, render: function (row) { return row[i]; } }; }), section.table.rows, { caption: section.title, stack: true }) : null,
          (section.code || []).map(function (block) { return codeBlock(block.text, block.label || block.language, block.label || 'example'); }));
      }));
  }

  async function localFile(input) {
    var selected = input.files && input.files[0];
    if (!selected) return null;
    if (selected.size > window.PrismPeripheralDocs.MAX) throw new Error(selected.name + ': file exceeds 1 MiB');
    var bytes = await selected.arrayBuffer();
    var text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) { throw new Error(selected.name + ': invalid UTF-8'); }
    return { name: selected.name, text: text };
  }
  function docDownload(label, name, type, content) {
    var link = h('a', { class: 'button small', href: '#', download: name, text: label });
    link.addEventListener('click', function () {
      var url = URL.createObjectURL(new Blob([content], { type: type }));
      link.href = url;
      window.setTimeout(function () { URL.revokeObjectURL(url); link.href = '#'; }, 60000);
    });
    return link;
  }
  function documentPreview(doc) {
    var engine = window.PrismPeripheralDocs, tooling = window.PRISM_DOC_TOOLING;
    engine.validate(doc, tooling.schema);
    var html = engine.html(doc, tooling.styles);
    var json = JSON.stringify(doc, null, 2) + '\n';
    var preview = h('div', { class: 'doc-preview', role: 'region', 'aria-label': 'Generated documentation for ' + doc.name });
    var template = document.createElement('template');
    // This is the shared renderer's escaped markup, never raw input text.
    template.innerHTML = engine.article(doc);
    preview.appendChild(template.content);
    return h('section', { class: 'doc-result' }, h('h2', { text: doc.title || doc.name }),
      h('p', { class: 'section-intro', text: 'This local document is separate from the published reference. Download it to share, or reopen its JSON in the generator.' }),
      h('div', { class: 'button-row' }, docDownload('Download HTML', doc.name + '.html', 'text/html;charset=utf-8', html),
        docDownload('Download JSON', doc.name + '.json', 'application/json', json)),
      preview);
  }
  async function rememberDocument(doc) {
    var id = doc.name + '-' + (await window.PrismPeripheralDocs.sha(JSON.stringify(doc))).slice(0, 12);
    var old = localDocuments.find(function (item) { return item.id === id; });
    if (old) old.doc = doc; else localDocuments.push({ id: id, doc: doc });
    var list = document.getElementById('local-document-links');
    if (!list) {
      var sidebar = document.getElementById('sidebar');
      sidebar.appendChild(h('p', { class: 'nav-group', text: 'Local documents · this session' }));
      list = h('ul', { class: 'nav-list', id: 'local-document-links' }); sidebar.appendChild(list);
    }
    replace(list, localDocuments.map(function (item) { return h('li', null, h('a', { href: '#/local/' + item.id, text: item.doc.title || item.doc.name })); }));
  }
  function localDocumentView(id) {
    var item = localDocuments.find(function (item) { return item.id === id; });
    if (!item) return h('div', { class: 'page' }, pageHeader('Open a peripheral document', 'Local documents stay in the current browser session. Reopen a saved JSON file to view it again.'),
      h('a', { class: 'button', href: '#/tools/peripheral-docs', text: 'Open generator and import JSON' }));
    return h('div', { class: 'page' }, documentPreview(item.doc));
  }
  function generatorView() {
    var engine = window.PrismPeripheralDocs;
    var status = h('p', { class: 'generator-status', id: 'generator-status', role: 'status', 'aria-live': 'polite' });
    var output = h('div', { id: 'generator-result' });
    function field(label, input, hint) {
      if (hint) input.setAttribute('aria-describedby', input.id + '-hint');
      return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input,
        hint ? h('span', { class: 'hint', id: input.id + '-hint', text: hint }) : null);
    }
    function fileInput(id, accept) { return h('input', { id: id, type: 'file', accept: accept }); }
    var registers = fileInput('doc-registers', '.toml');
    registers.required = true;
    var component = fileInput('doc-component', '.toml');
    var rtl = fileInput('doc-rtl', '.sv,.v');
    var moduleName = h('input', { id: 'doc-module', type: 'text', placeholder: 'Explicit module name, e.g. uart', autocomplete: 'off' });
    var title = h('input', { id: 'doc-title', type: 'text', maxlength: '200', placeholder: 'Optional display title' });
    var mode = h('select', { id: 'doc-address-mode' }, h('option', { value: 'offsets', text: 'Offsets only' }), h('option', { value: 'base', text: 'Region from the published map' }), h('option', { value: 'custom', text: 'Region from my memory TOML' }));
    var baseRegion = h('select', { id: 'doc-base-region' }, h('option', { value: '', text: 'Choose a reserved region' }),
      DATA.memory.regions.map(function (region) { return h('option', { value: region.id, text: region.id + ' · ' + hex(region.base) }); }));
    var mapFile = fileInput('doc-map', '.toml');
    var customRegion = h('select', { id: 'doc-custom-region' }, h('option', { value: '', text: 'Choose a memory map first' }));
    var baseFields = h('div', { hidden: true }, field('Reserved region', baseRegion));
    var customFields = h('div', { class: 'generator-grid', hidden: true }, field('Memory map TOML', mapFile), field('Reserved region', customRegion));
    mode.addEventListener('change', function () { baseFields.hidden = mode.value !== 'base'; customFields.hidden = mode.value !== 'custom'; });
    mapFile.addEventListener('change', async function () {
      try {
        var input = await localFile(mapFile);
        var regions = input ? engine.mmioLayout(engine.parse(input)) : {};
        replace(customRegion, h('option', { value: '', text: 'Choose a reserved region' }), Object.keys(regions).map(function (key) { return h('option', { value: key, text: key + ' · ' + hex(regions[key].base) }); }));
        status.textContent = '';
      } catch (error) { status.textContent = error.message; replace(customRegion, h('option', { value: '', text: 'Choose a valid map' })); }
    });
    var moduleHint = h('span', { class: 'hint', id: 'doc-module-hint', text: 'Required with an RTL file. The generator copies only the adjacent // header.' });
    moduleName.setAttribute('aria-describedby', 'doc-module-hint');
    var options;
    // Point an error at the input it concerns: mark it invalid, describe it
    // with the status message and move focus there.
    function markInvalid(message) {
      [registers, component, rtl, moduleName, baseRegion, mapFile, customRegion].forEach(function (input) {
        input.removeAttribute('aria-invalid');
        var described = (input.getAttribute('aria-describedby') || '').split(' ').filter(function (id) { return id && id !== 'generator-status'; });
        if (described.length) input.setAttribute('aria-describedby', described.join(' ')); else input.removeAttribute('aria-describedby');
      });
      if (!message) return;
      var target = /reserved region|base region/i.test(message) ? (mode.value === 'custom' ? customRegion : baseRegion)
        : /memory map/i.test(message) ? mapFile
        : /module/i.test(message) ? moduleName
        : /\bRTL\b/.test(message) ? rtl
        : /component/i.test(message) ? component
        : /register/i.test(message) ? registers : null;
      if (!target) return;
      if (options && options.contains(target)) options.open = true;
      target.setAttribute('aria-invalid', 'true');
      target.setAttribute('aria-describedby', ((target.getAttribute('aria-describedby') || '') + ' generator-status').trim());
      target.focus();
    }
    async function suggestModule() {
      try {
        var input = await localFile(component) || await localFile(registers);
        if (!input) return;
        var manifest = engine.parse(input), entry = manifest.entrypoints && manifest.entrypoints.peripheral;
        moduleName.placeholder = entry && entry.top ? 'Declared top: ' + entry.top + ' (type this name)' : 'Explicit module name, e.g. uart';
      } catch (_) { /* generation reports the input error */ }
    }
    component.addEventListener('change', suggestModule); registers.addEventListener('change', suggestModule);
    var submit = h('button', { class: 'button primary', type: 'submit', text: 'Generate documentation' });
    var form = h('form', { class: 'generator-form' },
      h('div', { class: 'generator-grid' }, field('Register description TOML · required', registers, 'Full component manifest or reduced SDK description.'), field('Display title', title)),
      options = h('details', { class: 'generator-options' }, h('summary', { text: 'Add placement, component context or RTL metadata for JSON' }),
        field('Addresses', mode), baseFields, customFields,
        field('Separate component manifest · optional', component, 'Use only when the register input is a reduced description.'),
        h('div', { class: 'generator-grid' }, field('RTL file · optional', rtl), h('div', { class: 'field' }, h('label', { for: moduleName.id, text: 'Module name' }), moduleName, moduleHint))),
      h('div', { class: 'button-row' }, submit, h('a', { href: '#/tools/peripheral-docs-contract', text: 'Read the peripheral docs contract' })), status);
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); submit.disabled = true; status.textContent = 'Reading local files…'; markInvalid(null);
      try {
        if (mode.value === 'base' && !baseRegion.value) throw new Error('Choose a reserved region from the published map');
        if (mode.value === 'custom' && !(mapFile.files && mapFile.files.length)) throw new Error('Choose a custom memory map');
        var doc = await engine.generate({ registerFile: await localFile(registers), title: title.value,
          componentFile: await localFile(component), rtlFile: await localFile(rtl), moduleName: moduleName.value.trim(),
          mapFile: mode.value === 'custom' ? await localFile(mapFile) : null, regionName: customRegion.value,
          baseRegion: mode.value === 'base' ? baseRegion.value : null, baseReference: DATA });
        engine.validate(doc, window.PRISM_DOC_TOOLING.schema);
        await rememberDocument(doc); replace(output, documentPreview(doc));
        status.textContent = 'Generated ' + doc.name + '. Files stayed in your browser; the published map is unchanged.';
        announce('Peripheral documentation generated');
      } catch (error) { status.textContent = 'Generation stopped: ' + error.message; markInvalid(error.message); }
      finally { submit.disabled = false; }
    });
    var imported = fileInput('doc-import', '.json');
    imported.addEventListener('change', async function () {
      try {
        var input = await localFile(imported);
        if (!input) return;
        var doc = engine.validate(JSON.parse(input.text), window.PRISM_DOC_TOOLING.schema);
        await rememberDocument(doc); replace(output, documentPreview(doc)); status.textContent = 'Opened ' + doc.name + ' locally.';
      } catch (error) { status.textContent = 'Import stopped: ' + error.message; }
    });
    return h('div', { class: 'page' }, pageHeader('Generate peripheral docs', 'Give firmware developers a reference for your own peripheral. Choose your TOML, add an RTL header if you have one, and download a page in the Prism style.'),
      h('p', { class: 'prose', text: 'Files are read locally in your browser. Custom documents stay separate from the published reference.' }),
      form, h('h2', { class: 'generator-import-heading', text: 'Open shared documentation' }), field('Peripheral document JSON', imported, 'Reopen a file generated by this tool. Local documents appear in the navigation for this session.'), output);
  }

  /* ----- Prism's guides (generated from Prism main by make update) ----- */

  function guideView(key) {
    var G = window.PrismGuides;
    if (!G) return h('div', { class: 'page' }, pageHeader('Guides'),
      h('p', { class: 'notice notice-error', text: 'The guides could not load. Rebuild the site and reopen this page.' }));
    if (key) return G.view(key) || notFoundView();
    return h('div', { class: 'page' },
      pageHeader('Guides', 'Prism’s guides, from first steps to verification. The tutorials link into them.'),
      h('ul', { class: 'next-list' }, G.list().map(function (g) {
        return h('li', null, h('a', { href: '#/guides/' + g.key, text: g.title }));
      })));
  }

  function notFoundView() {
    return h('div', { class: 'page prose' }, pageHeader('Page not found', 'This address does not match a page on this site.'),
      h('p', null, h('a', { href: '#/', text: 'Go to the overview' })));
  }

  /* ---------- Router ---------- */

  var ROUTES = [
    { path: '', title: 'Overview', view: homeView },
    { path: 'architecture', title: 'Architecture', view: architectureView, shell: 'architecture', tab: 'overview' },
    { path: 'roadmap', title: 'Roadmap', view: roadmapView },
    { path: 'guides', title: 'Guides', view: guideView, param: true },
    { path: 'architecture/core', title: 'Core tiles', view: coresView },
    { path: 'architecture/datapath', title: 'Core datapath', view: function () { return coreView(LAYERS.core, true); }, shell: 'architecture', tab: 'core' },
    { path: 'architecture/datapath/base', title: 'Base datapath', view: function () { return coreView('base', true); }, shell: 'architecture', tab: 'core' },
    { path: 'architecture/datapath/singlecycle', title: 'Singlecycle datapath', view: function () { return coreView('singlecycle', true); }, shell: 'architecture', tab: 'core' },
    { path: 'architecture/datapath/hazard3', title: 'Hazard3 datapath', view: function () { return coreView('hazard3', true); }, shell: 'architecture', tab: 'core' },
    { path: 'architecture/caches', title: 'Local caches', view: cacheView, shell: 'architecture', tab: 'caches' },
    { path: 'architecture/caches/coherent', title: 'Coherent caches (WIP)', view: coherentCacheView, shell: 'architecture', tab: 'caches' },
    { path: 'architecture/system-bus', title: 'System bus, peripherals and interrupts', view: busView, shell: 'architecture', tab: 'bus', param: true },
    { path: 'architecture/coherent-bus', title: 'Coherent cache bus (in development)', view: coherentView, shell: 'architecture', tab: 'coherent' },
    { path: 'architecture/accelerators', title: 'Memory-mapped hardware accelerators (WIP)', view: acceleratorsView, shell: 'architecture', tab: 'accelerators' },
    { path: 'tutorials/instantiate-core', title: 'Build a SoC and run a program', view: function () { return tutorialView('instantiate-core'); } },
    { path: 'tutorials/hazard3', title: 'Use Hazard3', view: function () { return tutorialView('hazard3'); } },
    { path: 'tutorials/custom-tile', title: 'Write your own core', view: function () { return tutorialView('custom-tile'); } },
    { path: 'tutorials/systems', title: 'Put SoCs on a board', view: function () { return tutorialView('systems'); } },
    { path: 'tutorials/multi-soc', title: 'Put SoCs on a board', view: function () { return tutorialView('systems'); } },
    { path: 'reference/address-map', title: 'Address map', view: addressMapView, param: true },
    { path: 'reference/peripherals', title: 'Peripheral concepts', view: peripheralConceptsView, param: true },
    { path: 'reference/platformio', title: 'PlatformIO build', view: platformioView }
    ,{ path: 'tools/peripheral-docs', title: 'Generate peripheral docs', view: generatorView }
    ,{ path: 'tools/peripheral-docs-contract', title: 'Peripheral docs contract', view: contractView }
    ,{ path: 'local', title: 'Local peripheral document', view: localDocumentView, param: true }
  ];

  function resolve(hash) {
    var path = hash.replace(/^#\/?/, '');
    // Guide pages carry a section anchor after a second #: #/guides/fpga#3-program-the-fpga.
    var fragment = null;
    if (path.indexOf('#') !== -1) { fragment = path.slice(path.indexOf('#') + 1); path = path.slice(0, path.indexOf('#')); }
    path = path.replace(/\/+$/, '');
    // Keep old bookmarks working while all navigation lives under Architecture.
    if (path === 'cores' || path.indexOf('cores/') === 0) path = 'architecture/core' + path.slice(5);
    // Each core has one page, under the Architecture hub.
    if (/^architecture\/core\/(singlecycle|base|hazard3)$/.test(path)) path = 'architecture/datapath/' + path.split('/')[2];
    if (path === 'buses/mmio') path = 'architecture/system-bus';
    if (path === 'architecture/caches/noncoherent') {
      path = 'architecture/caches';
    }
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (path === r.path) return { route: r, fragment: fragment };
      if (r.param && path.indexOf(r.path + '/') === 0) {
        var param;
        try { param = decodeURIComponent(path.slice(r.path.length + 1)); } catch (error) { param = null; }
        return { route: r, param: param, fragment: fragment };
      }
    }
    return { route: { path: null, title: 'Page not found', view: notFoundView } };
  }

  var lastPath, lastShell, lastPageKey;
  function render(initial) {
    var hash = location.hash || '#/';
    if (hash.indexOf('#/') !== 0 && hash !== '#') {
      // An in-page anchor such as the skip link; keep the current view.
      if (lastPath !== undefined) return;
      hash = '#/';
    }
    var match = resolve(hash);
    var pageKey = match.route.path === 'guides' ? 'guides/' + (match.param || '') : match.route.path;
    var samePage = pageKey === lastPageKey;
    lastPageKey = pageKey;
    var sameHub = lastShell === 'architecture' && match.route.shell === 'architecture';
    var sameCachePage = sameHub && match.route.tab === 'caches' && /^architecture\/caches(?:\/|$)/.test(lastPath || '');
    var focused = document.activeElement;
    var pickerHref = focused && focused.matches('.core-picker a') ? focused.getAttribute('href') : null;
    lastPath = match.route.path; lastShell = match.route.shell;
    leaveRoute();
    var view = match.route.view(match.param);
    if (match.route.shell === 'architecture') renderArchitecture(view, match.route.tab);
    else main.replaceChildren(view);
    var title = match.route.path === 'guides' && match.param && window.PrismGuides ? guideTitle(match.param) : match.route.title;
    document.title = title + ' – Prism documentation';
    var current = match.route.path === null ? null : '#/' + match.route.path;
    if ((match.route.path === 'local' || match.route.path === 'guides') && match.param) current += '/' + match.param;
    document.querySelectorAll('.nav-list a').forEach(function (a) {
      if (a.getAttribute('href') === current ||
          (match.route.tab === 'core' && a.getAttribute('href') === '#/architecture/datapath') ||
          (match.route.tab === 'caches' && a.getAttribute('href') === '#/architecture/caches')) {
        a.setAttribute('aria-current', 'page');
      }
      else {
        a.removeAttribute('aria-current');
      }
    });
    // Open a collapsed section when the current page is it or inside it;
    // otherwise leave it as the reader set it.
    document.querySelectorAll('.nav-parent').forEach(function (li) {
      var sub = li.querySelector('.nav-sub');
      if (sub && li.querySelector('[aria-current="page"]')) setNavSection(li, true);
    });
    closeNav(false);
    if (match.route.path === 'guides' && match.fragment && window.PrismGuides) {
      window.PrismGuides.reveal(match.fragment);
      return;
    }
    if (!initial && (!match.param || match.route.path === 'guides')) {
      if (!samePage && !sameHub) window.scrollTo(0, 0);
      var focus = sameHub ?
        (sameCachePage && main.querySelector('.cache-tabs [aria-selected="true"]')) ||
        (pickerHref && main.querySelector('.core-picker a[href="' + pickerHref + '"]')) ||
        main.querySelector('.layer-tabs [aria-selected="true"]') : document.getElementById('page-title');
      if (focus) focus.focus({ preventScroll: true });
    }
  }

  /* ---------- Collapsible navigation sections ---------- */

  function setNavSection(li, open) {
    var button = li.querySelector('.nav-toggle'), sub = li.querySelector('.nav-sub');
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('.visually-hidden').textContent = (open ? 'Hide' : 'Show') + ' ' + (button.getAttribute('data-nav-label') || 'core pages');
    sub.hidden = !open;
  }
  document.querySelectorAll('.nav-parent .nav-toggle').forEach(function (button) {
    button.addEventListener('click', function () {
      setNavSection(button.closest('.nav-parent'), button.getAttribute('aria-expanded') !== 'true');
    });
  });

  /* ---------- Mobile navigation ---------- */

  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('backdrop');
  var menuButton = document.getElementById('menu-button');
  var closeButton = document.getElementById('close-button');
  var narrow = window.matchMedia('(max-width: 959px)');

  function openNav() {
    sidebar.classList.add('open');
    backdrop.hidden = false;
    menuButton.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    syncMenuButton();
    var first = sidebar.querySelector('[aria-current="page"]') || sidebar.querySelector('a');
    window.setTimeout(function () { (first || closeButton).focus(); }, 0);
  }
  function closeNav(returnFocus) {
    if (!sidebar.classList.contains('open')) return;
    sidebar.classList.remove('open');
    backdrop.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    syncMenuButton();
    if (returnFocus) menuButton.focus();
  }
  // On wide screens the same button hides or shows the sidebar column.
  var root = document.documentElement;
  var menuLabel = document.getElementById('menu-label');
  function syncMenuButton() {
    var label;
    if (narrow.matches) {
      var open = sidebar.classList.contains('open');
      menuButton.setAttribute('aria-expanded', String(open));
      label = open ? 'Close navigation' : 'Open navigation';
    } else {
      var shown = !root.classList.contains('nav-hidden');
      menuButton.setAttribute('aria-expanded', String(shown));
      label = shown ? 'Hide navigation' : 'Show navigation';
    }
    menuLabel.textContent = label;
    menuButton.setAttribute('title', label);
  }
  menuButton.addEventListener('click', function () {
    if (narrow.matches) {
      if (sidebar.classList.contains('open')) closeNav(true); else openNav();
    } else {
      var hide = !root.classList.contains('nav-hidden');
      root.classList.toggle('nav-hidden', hide);
      try { localStorage.setItem('prism-nav', hide ? 'hidden' : 'shown'); } catch (error) { /* not persisted */ }
    }
    syncMenuButton();
  });
  closeButton.addEventListener('click', function () { closeNav(true); });
  backdrop.addEventListener('click', function () { closeNav(true); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) { closeNav(true); return; }
    // Keep Tab inside the open drawer.
    if (event.key === 'Tab' && sidebar.classList.contains('open') && narrow.matches) {
      var focusable = Array.prototype.filter.call(sidebar.querySelectorAll('a, button'), function (el) { return el.offsetParent !== null; });
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  var onBreakpoint = function () { if (!narrow.matches) closeNav(false); syncMenuButton(); };
  if (narrow.addEventListener) narrow.addEventListener('change', onBreakpoint); else narrow.addListener(onBreakpoint);
  syncMenuButton();

  /* ---------- Theme ---------- */

  var themeButton = document.getElementById('theme-button');
  var themeLabel = document.getElementById('theme-label');
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || (darkQuery.matches ? 'dark' : 'light');
  }
  function syncThemeLabel() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    themeLabel.textContent = 'Switch to ' + next + ' theme';
    themeButton.setAttribute('title', 'Switch to ' + next + ' theme');
  }
  themeButton.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('prism-theme', next); } catch (error) { /* not persisted */ }
    syncThemeLabel();
    announce(next === 'dark' ? 'Dark theme' : 'Light theme');
  });
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', syncThemeLabel);
  syncThemeLabel();

  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  /* ---------- Start ---------- */

  document.querySelector('.skip-link').addEventListener('click', function (event) {
    event.preventDefault();
    var heading = document.getElementById('page-title');
    (heading || main).focus();
  });
  window.addEventListener('hashchange', function () { render(false); });
  render(true);
})();
