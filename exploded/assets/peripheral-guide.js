/* Peripheral concepts. Protocol examples teach the boundary; the pinned
   address map and roadmap own register contracts and implementation status. */
(function () {
  'use strict';

  var TOPICS = [
    { id: 'i2c', label: 'I2C', title: 'I2C: a shared two-wire bus', region: 'i2c',
      summary: 'Address a target, exchange bytes and handle acknowledgements on SDA and SCL.' },
    { id: 'spi-qspi', label: 'SPI / QSPI', title: 'SPI / QSPI: a transaction has segments', region: 'spi',
      guide: 'qspi',
      summary: 'How chip select, line width, direction and dummy clocks make up one transaction.' },
    { id: 'watchdog', label: 'Watchdog', title: 'Watchdog: feed, pretimeout and reset', region: 'watchdog',
      summary: 'How firmware proves it is still making progress, and what the watchdog resets when it does not.' },
    { id: 'adc', label: 'ADC / XADC', title: 'ADC / XADC: analog inputs to digital samples', region: 'adc',
      summary: 'The board’s analog converter and the registers that deliver its samples.' },
    { id: 'can', label: 'CAN', title: 'CAN: controller and transceiver', region: 'can',
      summary: 'What the controller does with frames, and the external transceiver it needs.' },
    { id: 'dma', label: 'DMA', title: 'DMA: commands before data movement', region: 'dma',
      summary: 'The registers accept commands, but no data is moved yet. Why DMA waits for coherent caches.' }
  ];

  function forRegion(id) {
    var topic = TOPICS.filter(function (t) { return t.region === id; })[0];
    return topic ? { href: '#/reference/peripherals/' + topic.id, label: topic.label + ' concepts' } : null;
  }

  function render(context, id) {
    var h = context.h, table = context.table;
    var topic = TOPICS.filter(function (t) { return t.id === id; })[0];
    function link(href, text) { return h('a', { href: href, text: text }); }
    function p(text) { return h('p', { class: 'prose', text: text }); }
    function heading(text) { return h('h2', { text: text }); }
    function bullets(items) { return h('ul', { class: 'prose' }, items.map(function (t) { return h('li', { text: t }); })); }
    function sequence(label, steps) {
      return h('figure', { class: 'peripheral-sequence' },
        h('figcaption', { text: label }),
        h('ol', null, steps.map(function (step) {
          return h('li', null, h('strong', { text: step[0] }), h('span', { text: step[1] }));
        })));
    }
    function source(href, label, note) {
      return h('p', { class: 'source-line' }, link(href, label), ' — ' + note);
    }
    function content(key) {
      if (key === 'i2c') return [
        heading('Address a target, then exchange bytes'),
        p('In ordinary bidirectional I2C, devices pull SDA and SCL low or release them; pull-ups provide the high level. An address selects a target on the shared wires. This differs from SPI, which normally selects a device with a separate chip-select signal.'),
        sequence('Conceptual register read from a 7-bit-addressed target', [
          ['Select', 'START, target address + write, target ACK.'],
          ['Point', 'Send the target’s register index; target ACK.'],
          ['Read', 'Repeated START, address + read, target ACK; receive bytes.'],
          ['Finish', 'Controller NACKs the final byte, then sends STOP.']
        ]),
        p('The target’s data sheet defines its register-index format and read sequence. Some devices use a different transaction.'),
        heading('What firmware must distinguish'),
        bullets([
          'ACK/NACK reports whether the receiver acknowledged a byte. Finishing a bus command is different from receiving an ACK.',
          'Clock stretching lets a target hold SCL low. Prism’s controller waits for a stretched clock and ends a stalled command with a timeout.',
          'Repeated START keeps control of the bus between the write and read phases.'
        ]),
        source('https://www.nxp.com/docs/en/user-guide/UM10204.pdf', 'NXP UM10204, I2C-bus specification', 'protocol background.'),
        h('p', { class: 'prose' }, 'Compare ', link('#/reference/peripherals/spi-qspi', 'SPI / QSPI segments'), ' when the target uses chip select instead of a shared bus address.')
      ];
      if (key === 'spi-qspi') return [
        heading('Describe each segment'),
        p('Ordinary SPI uses a clock, chip select and separate transmit/receive data signals. Quad transfers use four data lines, with direction and output enables changing between segments. A single “quad” setting does not describe every phase of a flash command.'),
        sequence('Conceptual 1-1-4 flash read, with chip select held active across all segments', [
          ['Command · 1 line', 'Controller sends the device-specific read opcode.'],
          ['Address · 1 line', 'Controller sends the flash address.'],
          ['Dummy clocks', 'Allow the latency required by this command and device.'],
          ['Data · 4 lines', 'Controller releases the data outputs and receives the payload.']
        ]),
        p('Here, 1-1-4 names the command, address and data widths. The opcode, address length, optional mode bits, dummy clocks and any flash quad-enable setting come from the flash data sheet.'),
        heading('Keep these choices separate'),
        bullets([
          'Line width, transmit/receive direction and transfer length belong to each segment.',
          'Chip-select continuity joins segments into one device transaction; changes must respect the controller’s idle and pin-turnaround rules.',
          'Clock mode, frame widths and supported segment types need an explicit controller contract.',
          'Segmented SPI/QSPI does not establish memory-mapped flash or execute-in-place support.'
        ]),
        source('https://www.st.com/resource/en/application_note/an4760-quadspi-interface-on-stm32-microcontrollers-and-microprocessors-stmicroelectronics.pdf', 'ST AN4760, Quad-SPI interface', 'transaction background.')
      ];
      if (key === 'watchdog') return [
        heading('Feed it after useful progress'),
        p('A watchdog checks that firmware meets a deadline. Firmware deliberately feeds or refreshes it through the documented register operation. General loads, stores and interrupt activity are poor substitutes: a stuck loop can keep generating traffic.'),
        sequence('Conceptual watchdog with a pretimeout warning and a reset deadline', [
          ['Arm', 'Firmware configures the deadline and enables the watchdog.'],
          ['Feed', 'A valid feed after useful progress refreshes the countdown.'],
          ['Pretimeout', 'If supported and enabled, an early interrupt warns before expiry.'],
          ['Expire', 'If the deadline is missed, a reset request reaches the reset integration.']
        ]),
        heading('An interrupt and a reset have different jobs'),
        p('A pretimeout gives responsive firmware a chance to record a fault or recover. Reset provides a later recovery path when firmware cannot service that interrupt. Acknowledging an interrupt must not be assumed to feed the watchdog; the software contract defines each effect.'),
        bullets([
          'Read the feed key, tick source, reload rules, enable/disable behavior and reset values in the register reference before programming it.',
          'A watchdog clocked from the same stopped clock cannot detect that clock failure. An independent clock is a separate hardware property.',
          'A peripheral reset-request output is only one part of system recovery. Confirm which reset domain consumes it and how reset cause survives.'
        ]),
        source('https://www.st.com/content/st_com/en/technical-documents/stm32c551cc_asset/chunk-005-topic-stm32c5-db-ds-functional-overview-tim.html', 'ST DS14928, Timers and watchdogs', 'examples of refresh, early-warning and reset behavior.')
      ];
      if (key === 'adc') return [
        heading('The analog conversion happens in the hard block'),
        p('An ADC measures an analog input and produces a digital sample that firmware can read. On supported 7-series FPGA devices, XADC is dedicated converter hardware. SystemVerilog can control it and expose results over MMIO.'),
        sequence('Conceptual input path', [
          ['Analog source', 'Board routing and input conditioning deliver a suitable voltage.'],
          ['Platform XADC', 'The FPGA hard block performs analog-to-digital conversion.'],
          ['Digital adapter', 'A platform interface transfers conversion control and sample results.'],
          ['MMIO / firmware', 'The CPU reads the documented sample and status representation.']
        ]),
        heading('Check the platform and the sample contract'),
        bullets([
          'The FPGA package, analog pins and board wiring determine accessible channels.',
          'Input range, reference, source impedance and acquisition requirements come from the XADC and board documentation.',
          'Sample packing, channel identification, ready/overrun behavior and interrupt semantics belong to the adapter’s software contract.'
        ]),
        source('https://docs.amd.com/r/en-US/ug480_7Series_XADC/Analog-to-Digital-Converter', 'AMD UG480, XADC analog-to-digital converter', 'converter and analog-input requirements; consult the selected board’s schematic too.')
      ];
      if (key === 'can') return [
        heading('Digital controller, external transceiver'),
        p('The CAN controller handles digital frame timing and protocol state. A CAN transceiver connects its transmit/receive signals to the differential CANH/CANL wires. The FPGA’s digital pins do not directly replace that electrical interface.'),
        sequence('Conceptual CAN connection, with receive traffic travelling back toward the CPU', [
          ['Firmware', 'Programs a documented frame command and handles results.'],
          ['CAN controller', 'Processes digital frames, arbitration and protocol errors.'],
          ['Transceiver', 'Converts between logic-level signals and the physical bus.'],
          ['CAN network', 'Uses suitable wiring, termination and other CAN nodes.']
        ]),
        heading('Read the implemented subset'),
        p('Prism’s controller handles classical CAN frames with standard 11-bit identifiers, through one transmit snapshot and one receive mailbox. Extended frames are discarded without an acknowledgement. An accepted transmit command is different from a frame completing on a live network.'),
        source('https://www.ti.com/lit/an/sloa101b/sloa101b.pdf', 'TI SLOA101B, Introduction to CAN', 'controller, transceiver and physical-bus background.')
      ];
      return [
        heading('Commands without a transfer engine'),
        p('Prism’s DMA captures commands over MMIO but has no bus master. An accepted command completes with BACKEND_UNAVAILABLE and moves no data.'),
        table([
          { label: 'Boundary', render: function (r) { return r[0]; } },
          { label: 'Meaning', render: function (r) { return r[1]; } }
        ], [
          ['CPU → command interface', 'A CPU load/store reaches the device as an MMIO target; START captures the command.'],
          ['DMA → memory', 'A transfer engine would issue reads and writes as a separate bus master.'],
          ['CPU cache ↔ memory', 'Ownership and visibility must be settled before a future engine accesses cached buffers.']
        ], { caption: 'DMA command and memory boundaries', stack: true }),
        heading('Coherence comes first'),
        h('p', { class: 'prose' }, 'A CPU can hold newer buffer contents in a dirty cache line while RAM still has older bytes, and cache_fabric_if is non-coherent. A transfer engine that shares buffers with the CPU therefore needs the ', link('#/architecture/coherent-bus', 'coherent interconnect'), '.')
      ];
    }

    if (id && !topic) return h('div', { class: 'page' },
      context.pageHeader('Peripheral concept not found'),
      h('p', null, link('#/reference/peripherals', 'Browse peripheral concepts')));

    var reference = context.data;
    var regions = reference && reference.memory && reference.memory.regions || [];
    var addressMap = '#/reference/address-map';
    function addressText(value) { return '0x' + value.toString(16).toUpperCase().padStart(8, '0'); }
    var contracts = TOPICS.filter(function (t) { return !topic || t.id === topic.id; }).map(function (t) {
      var region = regions.filter(function (r) { return r.id === t.region; })[0];
      var irq = reference && reference.memory.interrupts.filter(function (i) { return i.name === t.region; })[0];
      return region && { topic: t, region: region, irq: irq };
    }).filter(Boolean);
    var contractTable = contracts.length ? table([
      { label: 'Component', render: function (r) { return link(addressMap + '/' + r.region.id, r.topic.label); } },
      { label: 'MMIO base', render: function (r) { return h('code', { text: addressText(r.region.base) }); } },
      { label: 'Register window', render: function (r) { return r.region.component.register_bytes + ' bytes'; } },
      { label: 'IRQ source bit', render: function (r) { return r.irq ? String(r.irq.bit) : '—'; } },
      { label: 'Registers and fields', render: function (r) { return link(addressMap + '/' + r.region.id, 'Open register reference'); } }
    ], contracts, { caption: 'Peripheral reserved regions', stack: true }) : null;
    var nav = h('nav', { class: 'peripheral-guide-nav', 'aria-label': 'Peripheral concepts' },
      [{ id: '', label: 'All concepts' }].concat(TOPICS).map(function (t) {
        return h('a', { href: '#/reference/peripherals' + (t.id ? '/' + t.id : ''),
          'aria-current': (topic ? t.id === topic.id : !t.id) ? 'page' : null, text: t.label });
      }));
    var scope = topic ? null : h('p', { class: 'prose' }, 'Each SoC installs only some of these peripherals. The ', link(addressMap, 'address map'), ' lists their reserved regions, registers and fields.');

    return h('div', { class: 'page peripheral-guide' },
      h('p', { class: 'eyebrow', text: 'Peripheral concepts' }),
      context.pageHeader(topic ? topic.title : 'Peripheral concepts', topic ? topic.summary : 'Short background on I2C, SPI, the watchdog, the ADC, CAN and DMA for firmware writers. Register tables are in the address map.'),
      topic && context.status && context.status(topic.region) ? h('p', null, context.statusBadge(context.status(topic.region))) : null,
      nav, scope,
      contractTable,
      topic ? h('p', { class: 'prose' }, 'For setup, programming and checks, follow the ',
        link('#/guides/' + (topic.guide || topic.id), topic.label + ' guide'), '.') : null,
      topic && topic.id === 'spi-qspi' ? p('QSPI shares the SPI MMIO base. Segment registers use this base plus their documented offsets; there is no separate QSPI region.') : null,
      topic ? content(topic.id) : [
        h('div', { class: 'peripheral-guide-cards' }, TOPICS.map(function (t) {
          return h('a', { class: 'panel', href: '#/reference/peripherals/' + t.id }, h('strong', { text: t.label }), h('span', { text: t.summary }));
        })),
        heading('I2C, SPI / QSPI and CAN meet different devices'),
        table([
          { label: 'Interface', render: function (r) { return link('#/reference/peripherals/' + r[0], r[1]); } },
          { label: 'Connection', render: function (r) { return r[2]; } },
          { label: 'Firmware concern', render: function (r) { return r[3]; } }
        ], [
          ['i2c', 'I2C', 'Shared SDA/SCL wires; target address selects the device.', 'START/STOP, acknowledgements and target-specific byte sequences.'],
          ['spi-qspi', 'SPI / QSPI', 'Clock and chip select; data-line usage depends on the segment.', 'Clock mode, segment width/direction, dummy clocks and select continuity.'],
          ['can', 'CAN', 'A digital controller reaches a network through a transceiver.', 'Frames, arbitration and the controller’s documented error behavior.']
        ], { caption: 'Peripheral interface concepts', stack: true }),
        h('p', { class: 'prose' }, 'To document your own component, use ', link('#/tools/peripheral-docs', 'Generate peripheral docs'), ' with its TOML and RTL.')
      ]);
  }

  window.PrismPeripheralGuide = { render: render, forRegion: forRegion };
})();
