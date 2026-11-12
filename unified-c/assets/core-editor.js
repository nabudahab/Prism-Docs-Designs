/* Browser-local assembly editor. Execution belongs to PrismSim's RTL models. */
(function () {
  'use strict';
  let serial = 0;
  function element(tag, attrs, children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function ([name, value]) {
      if (name === 'text') el.textContent = value;
      else if (name === 'class') el.className = value;
      else el.setAttribute(name, value);
    });
    (children || []).forEach(child => el.appendChild(child)); return el;
  }
  function examples(core) {
    const traces = window.PRISM_CORE_TRACES || {};
    const list = [
      { name: 'Demo program', source: (traces[core === 'singlecycle' ? 'singlecycle' : core] || {}).program || 'li a0, 5\nhalt\n' },
      { name: 'Loop and branch', source: '# Add 4 + 3 + 2 + 1 into a0.\n.text\n    li a0, 0\n    li t0, 4\nloop:\n    add a0, a0, t0\n    addi t0, t0, -1\n    bnez t0, loop\n    halt\n' },
      { name: 'Store, load and dependency', source: '# a1 depends on the value loaded into a0.\n.text\n    la t0, value\n    li t1, 7\n    sw t1, 0(t0)\n    lw a0, 0(t0)\n    addi a1, a0, 1\n    halt\n.data\n.balign 4\nvalue: .word 0\n' },
      { name: 'Read the cycle CSR', source: '# Read the cycle counter before and after arithmetic.\n.text\n    csrr t0, cycle\n    li a0, 5\n    addi a0, a0, 1\n    csrr t1, cycle\n    sub a1, t1, t0\n    halt\n' }
    ];
    if (core === 'base') list.push({ name: 'Divide latencies', source: '# A divide holds EX for 1 + its significant 3-bit dividend groups.\n# A divide right behind one on the same registers reuses its result,\n# unless the first one overwrote a source.\n.text\n    li t0, 5\n    li t1, 3\n    div a0, t0, t1      # 5 / 3: 2 EX cycles\n    rem a4, t0, t1      # same registers: reuses the result, 1 EX cycle\n    li t2, -1\n    divu a1, t2, t1     # 0xffffffff / 3: 12 EX cycles\n    addi a2, a1, 1      # waits one bubble for the quotient\n    rem a3, t0, zero    # remainder by zero: 1 EX cycle\n    divu t2, t2, t1     # overwrites its own source...\n    remu a5, t2, t1     # ...so this divides again: 12 EX cycles\n    halt\n' });
    if (core === 'hazard3') list.push({ name: 'Multiply and divide', source: '# A multiply result is used at once; the divide stalls D/X.\n.text\n    li t0, 7\n    li t1, 3\n    mul a0, t0, t1\n    addi a1, a0, 1\n    div a2, a1, t1\n    rem a3, a1, t1\n    halt\n' });
    else if (core === 'base') list.push({ name: 'Multiply chain', source: '# Each multiply uses the preceding result.\n.text\n    li t0, 3\n    li a0, 7\n    mul a1, a0, t0\n    mul a2, a1, t0\n    mulhu a3, a2, t0\n    halt\n' });
    else list.push({ name: 'Call and return', source: '# jal writes the return address to ra.\n.text\n    li a0, 6\n    call twice\n    halt\ntwice:\n    add a0, a0, a0\n    ret\n' });
    return list;
  }
  function mount(slot, options) {
    const core = options.core, id = 'ce-' + core + '-' + (++serial), programs = examples(core);
    const storageKey = 'prism-core-source-' + core;
    const section = element('section', { class: 'ce', 'aria-labelledby': id + '-title' });
    const title = element('h2', { id: id + '-title', text: 'Run your own program' });
    const profile = window.PrismAsm && window.PrismAsm.profiles[core];
    const description = element('p', { class: 'ce-profile', text: profile ? profile.description : 'Assembler is unavailable.' });
    const help = element('p', { id: id + '-help', class: 'ce-help', text: 'The bench’s code memory starts at 0x00000000 (32 KiB); data, read-only data and BSS share its 32 KiB data memory at 0x80000000. End with the halt macro (csrwi mie, 0 followed by wfi). A cycle limit also stops the run.' });
    const example = element('select', { id: id + '-example' }, programs.map((p, i) => element('option', { value: String(i), text: p.name })));
    const load = element('button', { type: 'button', text: 'Load example' });
    const source = element('textarea', { id: id + '-source', class: 'ce-source', rows: '16', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off', 'aria-describedby': id + '-help ' + id + '-position' });
    source.value = programs[0].source;
    try { const saved = window.sessionStorage.getItem(storageKey); if (saved !== null) source.value = saved; } catch (_) { /* file:// and storage restrictions are supported */ }
    const position = element('span', { id: id + '-position', class: 'ce-position', text: 'Line 1, column 1' });
    const CONFIGS = {
      singlecycle: [['singlecycle', 'Cacheless'], ['singlecycle_cached', 'Cached']],
      hazard3: [['hazard3', 'Prism tile'], ['hazard3_ahb', 'Direct AHB memory']]
    };
    const config = element('select', { id: id + '-config' }, (CONFIGS[core] || []).map(([value, text]) => element('option', { value, text })));
    const limit = element('input', { id: id + '-limit', type: 'number', min: '1', max: '20000', step: '1', value: '2000', inputmode: 'numeric' });
    const assembleButton = element('button', { type: 'button', text: 'Assemble' });
    const runButton = element('button', { type: 'button', class: 'ce-run', text: 'Run', 'aria-describedby': id + '-availability' });
    const demoButton = element('button', { type: 'button', text: 'Show the recorded demo' });
    const availability = element('p', { id: id + '-availability', class: 'ce-help' });
    const status = element('p', { class: 'ce-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', text: 'Assemble to check the source and view the listing.' });
    const diagnostics = element('ul', { class: 'ce-errors', 'aria-label': 'Assembly diagnostics' });
    const details = element('details', { class: 'ce-listing' });
    details.hidden = true;
    const summary = element('summary', { text: 'Assembly listing' });
    const listing = element('pre', { tabindex: '0', 'aria-label': 'Assembly listing: address, bytes, source line and source' });
    details.appendChild(summary); details.appendChild(listing);
    function field(label, control) { return element('div', { class: 'ce-field' }, [element('label', { for: control.id, text: label }), control]); }
    const toolbar = element('div', { class: 'ce-controls' }, [field('Example program', example), load]);
    const controls = element('div', { class: 'ce-controls' });
    if (CONFIGS[core]) controls.appendChild(field('Configuration', config));
    controls.appendChild(field('Cycle limit (1–20000)', limit));
    controls.appendChild(assembleButton); controls.appendChild(runButton); controls.appendChild(demoButton);
    [title, description, help, toolbar, element('label', { for: source.id, class: 'ce-source-label', text: 'RISC-V assembly' }), source, position, controls, availability, status, diagnostics, details].forEach(el => section.appendChild(el));
    slot.replaceChildren(section);
    let busy = false, revision = 0, runId = 0;
    function simCore() { return CONFIGS[core] ? config.value : core; }
    function refreshAvailability() {
      const available = !!(window.PrismSim && window.PrismSim.available(simCore()));
      runButton.disabled = busy || !available || !window.PrismAsm;
      assembleButton.disabled = busy || !window.PrismAsm;
      availability.textContent = available ? 'Run executes this program on the Prism RTL compiled to WebAssembly.' : 'RTL simulation is not available for this configuration in this build. You can still assemble and inspect the listing.';
      runButton.textContent = busy ? 'Running…' : 'Run';
    }
    function persist() { try { window.sessionStorage.setItem(storageKey, source.value); } catch (_) { /* retain the text in this editor */ } }
    function updatePosition() {
      const before = source.value.slice(0, source.selectionStart || 0), lines = before.split('\n');
      position.textContent = 'Line ' + lines.length + ', column ' + (lines[lines.length - 1].length + 1);
    }
    function changed() {
      revision++; persist(); details.hidden = true; diagnostics.replaceChildren(); source.removeAttribute('aria-invalid');
      status.textContent = busy ? 'Source changed while the run is in progress. Assemble and run again to use these edits.' : 'Source changed. Assemble or run to check it.';
      updatePosition(); refreshAvailability();
    }
    function selectLine(line, column) {
      const lines = source.value.split('\n'); let start = 0;
      for (let i = 1; i < line && i <= lines.length; i++) start += lines[i - 1].length + 1;
      start += Math.max(0, column - 1);
      source.focus(); source.setSelectionRange(start, start + 1);
      const lineHeight = parseFloat(window.getComputedStyle(source).lineHeight) || 22;
      source.scrollTop = Math.max(0, (line - 3) * lineHeight); updatePosition();
    }
    function diagnostic(item, warning) {
      const button = element('button', { type: 'button', text: (warning ? 'Warning: ' : '') + 'Line ' + item.line + ', column ' + item.column + ': ' + item.message });
      button.addEventListener('click', () => selectLine(item.line, item.column));
      diagnostics.appendChild(element('li', warning ? { class: 'ce-warning' } : {}, [button]));
    }
    function assemble() {
      diagnostics.replaceChildren(); details.hidden = true;
      const result = window.PrismAsm.assemble(source.value, { profile: core }); persist();
      source.setAttribute('aria-invalid', result.ok ? 'false' : 'true');
      result.errors.forEach(e => diagnostic(e, false)); result.warnings.forEach(e => diagnostic(e, true));
      if (!result.ok) { status.textContent = 'Assembly failed: ' + result.errors.length + ' error' + (result.errors.length === 1 ? '' : 's') + '. Select an error to move to its source line.'; return null; }
      const code = result.segments.find(s => s.base === 0), data = result.segments.find(s => s.base === 0x80000000);
      status.textContent = 'Assembled ' + (code ? code.bytes.length : 0) + ' code bytes and ' + (data ? data.bytes.length : 0) + ' data bytes; ' + Object.keys(result.symbols).length + ' symbols.';
      function hex(n, width) { return (n >>> 0).toString(16).padStart(width, '0'); }
      // Bound the rendered preview; .space can legitimately emit 32768 rows.
      const rows = result.listing.slice(0, 512);
      listing.textContent = 'Address   Value     Line  Source\n' + rows.map(r => hex(r.address, 8) + '  ' + hex(r.word, r.size * 2).padEnd(8) + '  ' + String(r.line).padStart(4) + '  ' + r.source.trim()).join('\n') + (rows.length < result.listing.length ? '\n… Showing the first 512 of ' + result.listing.length + ' entries.' : '');
      summary.textContent = 'Assembly listing (' + result.listing.length + ' entries)'; details.hidden = false;
      return result;
    }
    source.addEventListener('input', changed);
    ['click', 'keyup', 'select'].forEach(event => source.addEventListener(event, updatePosition));
    config.addEventListener('change', function () { revision++; refreshAvailability(); });
    load.addEventListener('click', function () { source.value = programs[Number(example.value)].source; changed(); source.focus(); source.setSelectionRange(0, 0); updatePosition(); });
    assembleButton.addEventListener('click', assemble);
    runButton.addEventListener('click', async function () {
      if (busy || runButton.disabled) return;
      const maxCycles = Number(limit.value);
      if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 20000) { status.textContent = 'Cycle limit must be a whole number between 1 and 20000.'; limit.focus(); return; }
      const result = assemble(); if (!result) return;
      if (!result.segments[0].bytes.length) { status.textContent = 'The program has no code. Add instructions in .text before running.'; source.focus(); return; }
      const currentRevision = revision, currentRun = ++runId, selected = simCore(), submittedSource = source.value;
      busy = true; refreshAvailability(); status.textContent = 'Running on ' + ({ base: 'Base', hazard3: 'Hazard3 (Prism tile)', hazard3_ahb: 'Hazard3 (direct AHB memory)', singlecycle: 'Singlecycle cacheless', singlecycle_cached: 'Singlecycle cached' }[selected] || selected) + ' RTL…';
      try {
        const trace = await window.PrismSim.run(selected, { segments: result.segments, entry: 0, source: submittedSource }, { maxCycles });
        if (currentRun !== runId || !slot.contains(section)) return;
        if (revision !== currentRevision) { status.textContent = 'Run finished for an earlier source or configuration. Run again to show the current program.'; return; }
        options.diagram.replaceChildren();
        window.PrismCoreDiagrams.mount(options.diagram, core, { custom: { key: selected, label: 'Your program', trace }, symbols: result.symbols });
        const stop = trace.stop || {};
        const partial = trace.unsupported && trace.unsupported.length ? ' Some instructions (' + trace.unsupported.join(', ') + ') run as micro-op sequences the diagram does not attribute; their rows show D/X only.' : '';
        const at = Number.isInteger(stop.cycle) ? ' at cycle ' + stop.cycle : '';
        status.textContent = 'Your program is shown in the diagram. ' + (stop.reason === 'max_cycles' ? 'Reached the cycle limit' + at + '.' : stop.reason === 'halt' ? 'Stopped at halt' + at + '.' : stop.reason === 'wfi' ? 'Reached the cycle limit' + at + ' with the core asleep in WFI: no enabled interrupt arrives in this bench. Use halt (csrwi mie, 0 then wfi) to end a program.' : stop.reason === 'error' ? 'The bench stopped with an error' + at + ': ' + (stop.message || 'no result') + '.' : 'Run completed' + at + '.') + partial;
      } catch (error) {
        if (currentRun === runId && slot.contains(section)) status.textContent = 'Run failed: ' + (error && error.message ? error.message : String(error));
      } finally {
        busy = false; if (slot.contains(section)) refreshAvailability();
      }
    });
    demoButton.addEventListener('click', function () {
      runId++; options.diagram.replaceChildren(); window.PrismCoreDiagrams.mount(options.diagram, core);
      status.textContent = 'The recorded demo is shown in the diagram. Your source is kept below.';
    });
    refreshAvailability();
  }
  window.PrismCoreEditor = { mount };
})();
