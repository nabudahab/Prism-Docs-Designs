/* Hazard3 three-stage pipeline model (upstream Hazard3 v1.0-rc1, Prism's
 * profile): geometry, RTL notes and the per-cycle frame. Two configurations:
 * `hazard3` is Prism's tile (AHB ports through ahb_to_blocking to
 * cache_fabric_if); `hazard3_ahb` connects the same hazard3_tile's AHB ports
 * straight to the website bench's AHB memory. core-trace-compiler.js
 * produces the compiled view it reads. */
(function () {
  'use strict';
  var U = 'thirdparty/hazard3/hdl/';
  var CORE = U + 'hazard3_core.v';
  var FE = U + 'hazard3_frontend.v';
  var H = 'source/core_tiles/hazard3/rtl/';

  function bar(x, title, text, src) {
    return { kind: 'bar', x: x, y: 70, w: 16, h: 690, label: '', info: { kind: 'Pipeline register', title: title, text: text, src: src } };
  }

  var blocks = {
    cir: bar(560, 'CIR (current instruction register)', ['The frontend’s `fd_cir` holds up to two halfwords: one 32-bit instruction, two 16-bit instructions, or a 16-bit instruction and the first half of the next. `fd_cir_vld` counts the valid halfwords (0, 1 or 2). D/X consumes 2 or 4 bytes per instruction; when X stalls, the CIR keeps its instruction.', 'Each halfword carries a bus-error flag and a predicted-branch tag from the fetch that returned it.'], [FE + ' · instruction assembly', CORE + ' · fd_cir']),
    xm: bar(1290, 'X/M register', ['Carries the X result (`xm_result`), the destination and source register numbers, the memory operation and address alignment, and exception and sleep flags. There is no PC or instruction word in it; the diagram’s M occupant comes from the trace compiler’s observer.', 'With `m_stall` it holds; otherwise X loads it, or a bubble when X stalls or a trap is about to enter.'], [CORE + ' · Pipe Stage X → M']),

    npc: { kind: 'mux', x: 40, y: 300, w: 22, h: 110,
      info: { kind: 'Selector', title: 'Next fetch address', text: ['`fetch_addr` runs ahead of the program counter in 4-byte steps. An accepted jump loads the word-aligned target (plus 4 if its address phase went out in the same cycle); a BTB hit on the word being requested loads the predicted target; otherwise `fetch_addr + 4`.'], src: [FE + ' · fetch_addr'] } },
    fa: { kind: 'reg', x: 80, y: 310, w: 70, h: 90, label: 'Fetch', sub: 'address',
      info: { kind: 'State', title: 'Fetch address', text: ['The next word to request on the instruction port. Fetches are always aligned 32-bit words, even with compressed instructions enabled; alignment to instruction boundaries happens after the FIFO.'], src: [FE + ' · fetch_addr, mem_addr'] } },
    amux: { kind: 'mux', x: 190, y: 320, w: 20, h: 70, badgeX: 210, pins: [[204, 408, 'jump']],
      info: { kind: 'Selector', title: 'Address phase', text: ['A jump target goes straight onto the instruction bus in the cycle the jump is accepted, ahead of `fetch_addr`. The frontend accepts a jump only when no address phase is held (`mem_addr_hold`).'], src: [FE + ' · mem_addr_r, jump_target_rdy'] } },
    add4: { kind: 'add', x: 180, y: 440, w: 46, h: 56, label: '+4', tx: 4, info: { kind: 'Adder', title: 'fetch_addr + 4', text: ['Sequential fetch: the next word.'], src: [FE + ' · fetch_addr'] } },
    btb: { kind: 'ctl', x: 180, y: 150, w: 150, h: 80, label: 'BTB', sub: '1 entry\nbackward branches', badgeY: 234,
      info: { kind: 'Front end', title: 'Branch target buffer', text: ['One entry: source address, size and target. A taken backward conditional branch that was not predicted allocates it in X (`x_btb_set`). When the word being fetched contains the source, fetch goes to the target next and the branch’s halfwords are tagged as predicted.', 'X checks the prediction with an inverted comparison: a predicted branch that should fall through redirects to the next instruction. A failed prediction, FENCE.I or a trap clears the entry.'], src: [FE + ' · Branch target buffer', CORE + ' · x_btb_set, x_btb_clear'] } },
    fifo: { kind: 'mem', x: 300, y: 300, w: 110, h: 110, label: 'Prefetch', sub: 'FIFO\n2 × 32 bit',
      info: { kind: 'Front end', title: 'Prefetch FIFO', text: ['Two 32-bit entries, each with a halfword-valid mask, an error flag and predicted-branch tags. Returning fetch data goes into the first free entry, or, when the FIFO is empty and the assembly buffer has room, straight into instruction assembly. A jump clears all entries; responses to fetches issued before the jump are counted and dropped.'], src: [FE + ' · Fetch queue, Bus Pipeline Tracking'] } },
    align: { kind: 'box', x: 430, y: 290, w: 110, h: 130, label: 'Align', sub: 'halfword\nassembly\n+ hwbuf',
      info: { kind: 'Front end', title: 'Instruction assembly', text: ['Shifts halfwords from the FIFO (or the bypass) into the CIR as D/X consumes 2 or 4 bytes. A spare halfword waits in `hwbuf`, so a 32-bit instruction that starts at an address ending in 2 is assembled from two fetched words.', 'The register numbers of the next instruction are pre-decoded here, so the register file can be read a cycle early.'], src: [FE + ' · instruction assembly, predecode'] } },

    dpc: { kind: 'reg', x: 600, y: 150, w: 60, h: 60, label: 'PC', badgeX: 638,
      info: { kind: 'State', title: 'Program counter (D/X)', text: ['`d_pc`, the address of the instruction in the CIR. It advances by 2 or 4 as instructions are consumed, loads the target when a jump is accepted, and loads the BTB target when a predicted branch is consumed. If the instruction that jumped has to stay in D/X (M is stalled), the PC keeps its address until that instruction leaves.'], src: [U + 'hazard3_decode.v · d_pc'] } },
    inc: { kind: 'add', x: 690, y: 154, w: 40, h: 52, label: '+', tx: 3, info: { kind: 'Adder', title: 'PC + 2 or + 4', text: ['By the size of the instruction just consumed.'], src: [U + 'hazard3_decode.v · d_pc'] } },
    dec: { kind: 'ctl', x: 600, y: 258, w: 150, h: 72, label: 'Decode', sub: 'decompress · decode',
      info: { kind: 'Decoder', title: 'Decompress and decode', text: ['A 16-bit instruction is expanded to its 32-bit equivalent, then decoded into ALU, memory, multiply/divide, branch and CSR controls and an immediate. There is no D/X register: decode and execute share one stage.', 'Illegal instructions become an X exception. Zcmp push/pop expand into micro-op sequences here.'], src: [U + 'hazard3_decode.v', U + 'hazard3_instr_decompress.v'] } },
    rf: { kind: 'box', x: 600, y: 420, w: 150, h: 150, label: 'Register file', ty: 18,
      pins: [[606, 444, 'rs1, rs2'], [606, 554, 'rd, value'], [744, 444, 'rdata1', 'end'], [744, 534, 'rdata2', 'end']],
      info: { kind: 'State', title: 'Register file', text: ['32 × 32 bit, two read ports and one write port, all on the rising edge. Reads use the register numbers pre-decoded in F, so the values are registered by the time the instruction is in D/X; while X stalls, the read addresses hold.', 'M writes `m_result` to `xm_rd` at the edge that ends the instruction’s M cycle.'], src: [U + 'hazard3_regfile_1w2r.v', CORE + ' · regs'] } },
    stall: { kind: 'ctl', x: 600, y: 610, w: 150, h: 70, label: 'Stall control', sub: 'RAW · divide\nbus · trap',
      info: { kind: 'Control', title: 'X stall', text: ['X stalls for a load-use dependency, a divide in progress, a data address phase the bus has not accepted, an M stall, trap sequencing, AMO work, or a jump the frontend cannot accept yet. The CIR and the register-file read addresses then hold.', 'With full bypassing, the only RAW stall for the instructions this editor accepts is on a load result: rs1 always, rs2 unless the consumer is a store using it only as data (forwarded later, in M). SC results stall the same way; AMOs run their own sequence from X.'], src: [CORE + ' · x_stall, x_stall_on_raw'] } },

    byA: { kind: 'mux', x: 800, y: 405, w: 22, h: 80, badgeX: 804, pins: [[796, 412, 'rf', 'end'], [796, 437, 'xm', 'end'], [796, 462, 'mw', 'end']],
      info: { kind: 'Selector', title: 'rs1 bypass', text: ['Priority: x0 reads zero, then `xm_result` (the instruction now in M), then `mw_result` (the value M wrote most recently, kept while M stalls), then the register file.'], src: [CORE + ' · x_rs1_bypass'] } },
    byB: { kind: 'mux', x: 800, y: 500, w: 22, h: 80, badgeX: 804, pins: [[796, 507, 'rf', 'end'], [796, 532, 'xm', 'end'], [796, 557, 'mw', 'end']],
      info: { kind: 'Selector', title: 'rs2 bypass', text: ['Same priority as rs1.'], src: [CORE + ' · x_rs2_bypass'] } },
    opA: { kind: 'mux', x: 896, y: 420, w: 20, h: 66, pins: [[892, 472, 'pc', 'end']], info: { kind: 'Selector', title: 'ALU operand A', text: ['The bypassed rs1, or the PC (AUIPC, JAL/JALR link).'], src: [CORE + ' · x_op_a'] } },
    opB: { kind: 'mux', x: 896, y: 510, w: 20, h: 66, pins: [[892, 562, 'imm', 'end']], info: { kind: 'Selector', title: 'ALU operand B', text: ['The bypassed rs2, or the immediate.'], src: [CORE + ' · x_op_b'] } },
    alu: { kind: 'alu', x: 956, y: 400, w: 90, h: 190, label: 'ALU', tx: 8, info: { kind: 'Execution', title: 'ALU', text: ['Integer operations, including the Zba, Zbb, Zbs and Zbkb bit-manipulation instructions this configuration enables. Load/store addresses and branch targets come from the separate address adder.'], src: [U + 'arith/hazard3_alu.v'] } },
    brc: { kind: 'ctl', x: 900, y: 150, w: 150, h: 56, label: 'Branch compare', sub: 'hazard3_branchcmp.v', badgeX: 962,
      info: { kind: 'Execution', title: 'Branch comparison', text: ['A dedicated comparator (`FAST_BRANCHCMP`) on the bypassed operands. For a branch the BTB predicted taken, the result is inverted, so the jump request means “recover to the fall-through address”.', 'A branch whose operand is still a load in M does not request a jump until the load-use stall ends.'], src: [U + 'arith/hazard3_branchcmp.v', CORE + ' · x_branch_cmp, x_jump_req'] } },
    asel: { kind: 'mux', x: 1040, y: 225, w: 18, h: 56, pins: [[1036, 229, 'pc', 'end'], [1036, 257, 'rs1', 'end']], info: { kind: 'Selector', title: 'Address base', text: ['rs1 for loads, stores and JALR; the PC for branches and JAL.'], src: [CORE + ' · x_addr_sum'] } },
    aadd: { kind: 'add', x: 1090, y: 232, w: 46, h: 60, label: '+', tx: 4, info: { kind: 'Adder', title: 'Address adder', text: ['`x_addr_sum`: base plus offset. It is both the jump target (bit 0 cleared for JALR) and the data address, which goes out as an address phase from X; the data phase completes in M.'], src: [CORE + ' · x_addr_sum, x_jump_target'] } },
    mul: { kind: 'alu', x: 930, y: 625, w: 110, h: 70, label: 'MUL ×', tx: 8,
      info: { kind: 'Execution', title: 'Fast multiplier', text: ['MUL, MULH, MULHSU and MULHU use the fast multiplier. With `MUL_FASTER`, it is combinational: the selected half of the product enters `xm_result` at the end of X, so a dependent instruction takes it through the bypass with no stall.'], src: [U + 'arith/hazard3_mul_fast.v', CORE + ' · x_use_fast_mul'] } },
    div: { kind: 'box', x: 930, y: 718, w: 130, h: 52, label: 'DIV / REM', sub: '2 bits per cycle',
      info: { kind: 'Execution', title: 'Sequential divider', text: ['DIV, DIVU, REM and REMU run in `hazard3_muldiv_seq`: operand preparation, an arithmetic loop with two iterations per clock (`MULDIV_UNROLL=2`), then sign correction. X stalls until the result is valid; a trap kills the operation.'], src: [U + 'arith/hazard3_muldiv_seq.v', CORE + ' · has_muldiv'] } },
    csr: { kind: 'trap', x: 1090, y: 560, w: 100, h: 48, label: 'CSRs', layer: 'trap', badgeX: 1114,
      info: { kind: 'State', title: 'CSR file', text: ['Read and written in X when no trap is pending and X is not stalled. The read value is the instruction’s result. Illegal accesses raise an X exception.'], src: [U + 'hazard3_csr.v', CORE + ' · x_csr_wdata'] } },
    xres: { kind: 'mux', x: 1240, y: 410, w: 22, h: 170, pins: [[1236, 427, 'alu', 'end'], [1236, 467, 'mul', 'end'], [1236, 507, 'div', 'end'], [1236, 547, 'csr', 'end']],
      info: { kind: 'Selector', title: 'X result', text: ['Into `xm_result`: the CSR read value, the fast-multiply product, the divider result or the ALU result. For a store, it carries the store data (the ALU passes rs2). AMOs and SC use additional paths not drawn here.'], src: [CORE + ' · xm_result'] } },
    jsel: { kind: 'mux', x: 1200, y: 92, w: 20, h: 62, badgeX: 1250, badgeY: 158, pins: [[1196, 98, 'trap', 'end'], [1196, 128, 'X', 'end']],
      info: { kind: 'Selector', title: 'Jump target', text: ['`f_jump_target`: a trap entry or MRET from M wins over a jump from X.'], src: [CORE + ' · f_jump_req, f_jump_target'] } },

    ldsel: { kind: 'box', x: 1400, y: 410, w: 100, h: 50, label: 'Load align', sub: 'pick · extend',
      info: { kind: 'Datapath', title: 'Load data', text: ['Picks the byte or halfword lane by the address’s low bits and sign- or zero-extends it.'], src: [CORE + ' · m_rdata_pick_sext'] } },
    sdm: { kind: 'mux', x: 1400, y: 560, w: 20, h: 70, pins: [[1396, 572, 'xm', 'end'], [1396, 612, 'mw', 'end']],
      info: { kind: 'Selector', title: 'Late store-data bypass', text: ['If the store’s rs2 is the register M wrote most recently (`mw_rd`), the data comes from `mw_result` instead of `xm_result`. This is why a store does not stall on a load that is still in M. Bytes and halfwords are replicated across the bus lanes.'], src: [CORE + ' · m_wdata, bus_wdata_d'] } },
    mres: { kind: 'mux', x: 1560, y: 400, w: 22, h: 120, pins: [[1556, 432, 'load', 'end'], [1556, 492, 'xm', 'end']],
      info: { kind: 'Selector', title: 'M result', text: ['`m_result`: the extended load data for a load (or the SC success flag), otherwise `xm_result`.'], src: [CORE + ' · m_result'] } },
    mw: { kind: 'reg', x: 1610, y: 620, w: 60, h: 70, label: 'MW', sub: 'rd, value',
      info: { kind: 'State', title: 'MW bypass history', text: ['`mw_rd` and `mw_result` keep the value M wrote most recently, for bypass to X and for the late store-data bypass. They hold while M is stalled, so the value can be used several cycles later. It is not a pipeline stage: no instruction occupies it.'], src: [CORE + ' · mw_result, mw_rd'] } },

    trapu: { kind: 'trap', x: 1380, y: 140, w: 210, h: 58, label: 'Trap entry', sub: 'exceptions in M · IRQs · MRET', layer: 'trap',
      info: { kind: 'Control', title: 'Traps, interrupts and MRET', text: ['An exception is taken against the instruction in M: it does not write its register, and the trap target (from `mtvec`) wins over any jump from X. An interrupt is taken between the instruction in M and the one in X, after pending load/store work. MRET returns to `mepc` through the same request.'], src: [CORE + ' · m_trap_enter_vld', U + 'hazard3_csr.v'] } },
    pwr: { kind: 'trap', x: 1380, y: 230, w: 210, h: 46, label: 'Sleep control', sub: 'WFI', layer: 'trap',
      info: { kind: 'Control', title: 'WFI and sleep', text: ['WFI stalls in M until a locally enabled interrupt is pending. In Prism’s simulation benches, `+FINISH_ON_WFI` ends the run when WFI sleeps with all `mie` bits clear and the frontend has drained (the `halt` macro). That terminal marker is in Prism’s tile wrapper, not in upstream Hazard3.'], src: [U + 'hazard3_power_ctrl.v', H + 'hazard3_tile.sv · verification_halted'] } },

    iport: { kind: 'mem', x: 120, y: 852, w: 230, h: 56, label: 'Instruction port', sub: 'ahb_to_blocking.sv', layer: 'mem', badgeX: 172,
      info: { kind: 'Adapter', title: 'Instruction port', text: ['Hazard3’s AHB instruction port, converted by Prism’s adapter to the blocking `cache_fabric_if` instruction channel. Each 32-bit fetch is one 64-bit beat; the adapter picks the addressed half. There is no I-cache.'], src: [H + 'ahb_to_blocking.sv', H + 'core_tile.sv'] },
      variantSub: { hazard3_ahb: 'AHB5 · no adapter' },
      variantInfo: { hazard3_ahb: { kind: 'Port', title: 'Instruction port', text: ['Hazard3’s AHB instruction port, connected straight to the bench memory without Prism’s adapter. The address phase goes out in one cycle and, with no wait states, the word returns in the next while the following address goes out, so fetch can deliver one 32-bit word per cycle. There is no I-cache.'], src: [U + 'hazard3_cpu_2port.v', 'qa/core-diagrams (website bench)'] } } },
    dport: { kind: 'mem', x: 1160, y: 852, w: 320, h: 56, label: 'Data port', sub: 'ahb_to_blocking.sv · exclusives', layer: 'mem',
      info: { kind: 'Adapter', title: 'Data port', text: ['The AHB data port, converted to the blocking data channel with byte masks. The address phase is accepted from X; the data phase completes in M. The adapter also keeps the LR/SC reservation (installed cacheable RAM only, 16-byte granule). There is no D-cache.'], src: [H + 'ahb_to_blocking.sv', H + 'core_tile.sv'] },
      variantSub: { hazard3_ahb: 'AHB5 · exclusives' },
      variantInfo: { hazard3_ahb: { kind: 'Port', title: 'Data port', text: ['The AHB data port, connected straight to the bench memory. The address phase is accepted from X; the data phase completes in M, in the next cycle with no wait states. The bench memory keeps the LR/SC reservation that Prism’s data adapter would otherwise hold. There is no D-cache.'], src: [U + 'hazard3_cpu_2port.v', 'qa/core-diagrams (website bench)'] } } },
    mem: { kind: 'box', x: 620, y: 952, w: 360, h: 38, label: 'Bench memory', layer: 'mem',
      info: { kind: 'Test bench', title: 'Bench memory', text: ['The website’s bench answers both channels from one flat 64 KiB array: code at 0x00000000 and data RAM at 0x80000000, with the run’s memory latency. Timing here is tile plus bench memory, not a full SoC with its fabric and arbitration.'], src: ['qa/core-diagrams (website bench)'] },
      variantInfo: { hazard3_ahb: { kind: 'Test bench', title: 'Bench memory', text: ['An AHB memory model on each port, both backed by one flat 64 KiB array: code at 0x00000000 and data RAM at 0x80000000. A data phase ends the run’s memory latency after its address phase is accepted; latency 1 means no wait states. This is Hazard3’s intended environment (single-cycle on-chip SRAM), not Prism’s tile: there is no adapter, fabric or arbitration.'], src: ['qa/core-diagrams (website bench)'] } } }
  };

  function W(pts, name, extra) { var w = { pts: pts, name: name }; Object.keys(extra || {}).forEach(function (k) { w[k] = extra[k]; }); return w; }
  var I = function (t, txt) { return { title: t, text: txt ? [].concat(txt) : undefined }; };
  var wires = {
    // F
    npc_fa: W([[62, 355], [80, 355]], 'next fetch address', { info: I('Next fetch address') }),
    fa_amux: W([[150, 345], [190, 345]], 'fetch_addr', { info: I('fetch_addr', 'The next word to request.') }),
    aph: W([[210, 355], [232, 355], [232, 852]], 'instruction address phase', { lab: [[226, 600, 'address phase', 'end']], vt: [232, 760], info: I('Instruction address phase', 'An aligned 32-bit fetch request on the AHB instruction port.') }),
    fa_add: W([[165, 345], [165, 460], [180, 460]], 'fetch_addr → +4', { dots: [[165, 345]], info: I('fetch_addr') }),
    four: W([[170, 485], [180, 485]], '4', { lab: [[166, 489, '4', 'end']], info: I('Constant 4') }),
    add_npc: W([[226, 468], [244, 468], [244, 525], [18, 525], [18, 318], [40, 318]], 'fetch_addr + 4', { lab: [[44, 519, 'fetch_addr + 4']], info: I('fetch_addr + 4', 'Sequential next fetch.') }),
    fa_btb: W([[165, 345], [165, 190], [180, 190]], 'fetch_addr → BTB', { info: I('fetch_addr', 'Compared with the BTB source word.') }),
    btb_npc: W([[180, 215], [28, 215], [28, 345], [40, 345]], 'predicted target', { lab: [[44, 209, 'predicted target']], vt: [100, 228], info: I('BTB target', 'On a BTB hit for the word being fetched.') }),
    redirect: W([[1220, 123], [1240, 123], [1240, 88], [8, 88], [8, 420], [200, 420], [200, 390]], 'jump', { lab: [[300, 82, 'jump target (X) or trap target (M)']], vt: [700, 88], info: I('Jump', '`f_jump_now`: an accepted jump. The target goes onto the instruction bus in the same cycle; the FIFO is cleared and older responses are dropped.') }),
    jt_npc: W([[8, 385], [40, 385]], 'jump → fetch address', { dots: [[8, 385]], info: I('Jump target', 'fetch_addr continues from the target.') }),
    idata: W([[330, 852], [330, 410]], 'instruction data', { vt: [330, 700], lab: [[336, 800, 'data phase']], info: I('Instruction data phase', 'A 32-bit word returned on the instruction port.') }),
    bypass: W([[330, 440], [420, 440], [420, 400], [430, 400]], 'FIFO bypass', { dots: [[330, 440]], lab: [[340, 454, 'bypass']], info: I('FIFO bypass', 'Fetch data goes straight to instruction assembly when the FIFO is empty.') }),
    fifo_al: W([[410, 355], [430, 355]], 'queued word', { info: I('Oldest FIFO entry') }),
    al_cir: W([[540, 355], [560, 355]], 'instruction', { info: I('Next CIR contents') }),
    predec: W([[540, 400], [590, 400], [590, 440], [600, 440]], 'pre-decoded rs1, rs2', { info: I('Pre-decoded register numbers', 'The register file is read with the next instruction’s rs1/rs2 one cycle early.') }),
    btb_set: W([[1036, 150], [1036, 104], [255, 104], [255, 150]], 'BTB set / clear', { cls: 'ctl', layer: 'ctl', lab: [[440, 99, 'BTB set / clear']], info: I('BTB update', 'Set by a taken backward branch that was not predicted; cleared by a failed prediction, FENCE.I or a trap.') }),
    hold: W([[600, 640], [576, 640]], 'hold CIR', { cls: 'ctl', layer: 'ctl', lab: [[556, 644, 'hold', 'end']], info: I('x_stall', 'The CIR keeps its instruction and the register-file read addresses hold.') }),
    // D/X
    cir_dec: W([[576, 292], [600, 292]], 'instruction', { info: I('CIR instruction') }),
    cir_pc: W([[576, 180], [600, 180]], 'consumed size', { info: I('Instruction size', '2 or 4 bytes, from the CIR.') }),
    pc_inc: W([[660, 172], [690, 172]], 'pc → +', { info: I('pc') }),
    inc_pc: W([[730, 180], [746, 180], [746, 122], [580, 122], [580, 165], [600, 165]], 'pc + 2 / + 4', { lab: [[606, 117, 'pc + 2 / 4']], info: I('Next PC') }),
    pcbus: W([[630, 210], [630, 236], [1040, 236]], 'pc', { lab: [[790, 230, 'pc']], vt: [700, 236], info: I('pc', 'To the address adder and ALU port A.') }),
    pcA: W([[852, 236], [852, 478], [896, 478]], 'pc → ALU', { dots: [[852, 236]], info: I('pc', 'AUIPC and the JAL/JALR link value.') }),
    dec_xm: W([[750, 300], [1290, 300]], 'rd, memop, controls', { lab: [[880, 294, 'rd · memop · controls']], info: I('Controls to X/M') }),
    alu_op: W([[1001, 300], [1001, 427]], 'aluop', { cls: 'ctl', layer: 'ctl', dots: [[1001, 300]], lab: [[1007, 360, 'aluop']], info: I('d_aluop', 'Decoded in D/X and used in the same cycle: selects the ALU operation, including the bit-manipulation extensions (U/hazard3_core.v, hazard3_alu .aluop).') }),
    imm: W([[750, 318], [860, 318]], 'imm', { arrow: false, lab: [[760, 312, 'imm']], info: I('Immediate') }),
    imm_b: W([[860, 318], [860, 568], [896, 568]], 'imm → ALU', { dots: [[860, 318]], info: I('Immediate to ALU port B', 'For immediate arithmetic, LUI, AUIPC, and the JAL/JALR link offset (4, or 2 for a compressed jump).') }),
    imm_a: W([[860, 318], [1075, 318], [1075, 280], [1090, 280]], 'offset → address adder', { dots: [[860, 318]], info: I('Offset', 'Immediate offset of a load, store, branch, JAL or JALR.') }),
    rdat1: W([[750, 440], [756, 440], [756, 418], [800, 418]], 'rdata1', { vt: [775, 400], info: I('rs1 value (register file)') }),
    rdat2: W([[750, 530], [756, 530], [756, 513], [800, 513]], 'rdata2', { vt: [775, 590], info: I('rs2 value (register file)') }),
    xmB: W([[1298, 760], [1298, 792], [764, 792], [764, 443], [800, 443]], 'xm_result bypass', { lab: [[960, 787, 'xm_result (instruction in M)']], info: I('X/M bypass', '`xm_result`: the result of the instruction now in M.') }),
    xmB2: W([[764, 538], [800, 538]], 'xm_result → rs2', { dots: [[764, 538]], info: I('X/M bypass') }),
    mwB: W([[1640, 690], [1640, 808], [772, 808], [772, 468], [800, 468]], 'mw_result bypass', { lab: [[960, 803, 'mw_result (last value M wrote)']], info: I('MW bypass', '`mw_result`: the value M wrote most recently; kept while M stalls.') }),
    mwB2: W([[772, 563], [800, 563]], 'mw_result → rs2', { dots: [[772, 563]], info: I('MW bypass') }),
    opa: W([[822, 445], [896, 445]], 'rs1 (bypassed)', { vt: [824, 431, 'start'], info: I('Bypassed rs1') }),
    opb: W([[822, 540], [896, 540]], 'rs2 (bypassed)', { vt: [824, 526, 'start'], info: I('Bypassed rs2') }),
    pA: W([[916, 453], [956, 453]], 'operand A', { info: I('x_op_a') }),
    pB: W([[916, 543], [956, 543]], 'operand B', { info: I('x_op_b') }),
    alu_out: W([[1046, 495], [1194, 495], [1194, 433], [1240, 433]], 'ALU result', { vt: [1120, 495], info: I('ALU result') }),
    br1: W([[835, 445], [835, 190], [900, 190]], 'rs1 → compare', { dots: [[835, 445]], info: I('Bypassed rs1') }),
    br2: W([[845, 540], [845, 170], [900, 170]], 'rs2 → compare', { dots: [[845, 540]], info: I('Bypassed rs2') }),
    jreq: W([[1050, 178], [1210, 178], [1210, 154]], 'jump request', { cls: 'ctl', layer: 'ctl', lab: [[1060, 192, 'jump request']], info: I('x_jump_req', 'Taken branch, JAL, JALR, or recovery from a wrong prediction.') }),
    rs1_a: W([[835, 264], [1040, 264]], 'rs1 → address adder', { dots: [[835, 264]], info: I('Bypassed rs1') }),
    a_add: W([[1058, 253], [1090, 253]], 'base', { info: I('Address base') }),
    a_out: W([[1136, 262], [1180, 262]], 'address sum', { arrow: false, vt: [1140, 247, 'start'], info: I('x_addr_sum') }),
    jt_x: W([[1180, 262], [1180, 134], [1200, 134]], 'jump target', { dots: [[1180, 262]], info: I('x_jump_target', 'Bit 0 cleared for JALR.') }),
    daddr: W([[1180, 262], [1180, 852]], 'data address phase', { lab: [[1174, 700, 'data address', 'end']], vt: [1200, 650, 'end'], info: I('Data address phase', 'Issued from X; the data phase completes when the instruction is in M.') }),
    mul_a: W([[835, 445], [835, 650], [930, 650]], 'rs1 → multiplier', { info: I('Bypassed rs1') }),
    mul_b: W([[845, 540], [845, 680], [930, 680]], 'rs2 → multiplier', { info: I('Bypassed rs2') }),
    mul_x: W([[1040, 660], [1203, 660], [1203, 473], [1240, 473]], 'product', { vt: [1120, 660], info: I('Product half', 'Low word for MUL, high word for MULH/MULHSU/MULHU.') }),
    div_a: W([[835, 650], [835, 736], [930, 736]], 'rs1 → divider', { info: I('Bypassed rs1') }),
    div_b: W([[845, 680], [845, 754], [930, 754]], 'rs2 → divider', { info: I('Bypassed rs2') }),
    div_x: W([[1060, 744], [1212, 744], [1212, 513], [1240, 513]], 'divider result', { vt: [1136, 744], info: I('Quotient or remainder') }),
    csr_w: W([[835, 590], [1090, 590]], 'CSR write data', { cls: 'trap', layer: 'trap', dots: [[835, 590]], info: I('CSR write data', 'rs1 or a 5-bit immediate.') }),
    csr_x: W([[1190, 584], [1226, 584], [1226, 553], [1240, 553]], 'CSR read value', { cls: 'trap', layer: 'trap', info: I('CSR read value') }),
    x_xm: W([[1262, 495], [1290, 495]], 'X result', { info: I('Into xm_result') }),
    // M
    xm_m: W([[1306, 498], [1560, 498]], 'xm_result', { vt: [1360, 498], info: I('xm_result', 'The X result, or store data for a store.') }),
    xm_sd: W([[1340, 498], [1340, 578], [1400, 578]], 'store data', { dots: [[1340, 498]], info: I('Store data from xm_result') }),
    mw_sd: W([[1640, 705], [1374, 705], [1374, 618], [1400, 618]], 'mw_result → store data', { dots: [[1640, 705]], info: I('Late store-data bypass', 'The value M wrote most recently.') }),
    sdata: W([[1420, 595], [1428, 595], [1428, 852]], 'store data', { vt: [1428, 760], info: I('Store data', 'As driven on the bus: replicated across byte lanes for SB and SH.') }),
    rdata: W([[1470, 852], [1470, 460]], 'load data', { vt: [1470, 760], info: I('Load data phase') }),
    xm_ld: W([[1306, 300], [1450, 300], [1450, 410]], 'memop, alignment', { lab: [[1316, 294, 'memop · align']], info: I('Memory operation and address low bits') }),
    ld_m: W([[1500, 438], [1560, 438]], 'loaded value', { info: I('Extended load data') }),
    res: W([[1582, 460], [1600, 460]], 'm_result', { arrow: false, vt: [1586, 445, 'start'], info: I('m_result') }),
    wb_rf: W([[1600, 460], [1690, 460], [1690, 826], [582, 826], [582, 552], [600, 552]], 'register write', { latch: true, lab: [[960, 821, 'rd ← m_result (rising edge)']], info: I('Register write', '`m_reg_wen`: an instruction in M with a nonzero rd and no exception, once its data phase is done.') }),
    res_mw: W([[1600, 460], [1600, 600], [1640, 600], [1640, 620]], 'm_result → MW', { dots: [[1600, 460]], info: I('Into mw_result') }),
    mstall: W([[1200, 852], [1200, 776], [720, 776], [720, 680]], 'data wait', { cls: 'ctl', layer: 'ctl', lab: [[758, 788, 'data wait', 'end']], info: I('m_stall', 'An unfinished data phase holds M, and therefore X.') }),
    // traps
    exc: W([[1306, 170], [1380, 170]], 'exception', { cls: 'trap', layer: 'trap', info: I('Exception in M', 'Carried in X/M from the instruction that raised it.') }),
    trap_t: W([[1380, 150], [1370, 150], [1370, 44], [1164, 44], [1164, 104], [1200, 104]], 'trap target', { cls: 'trap', layer: 'trap', lab: [[1176, 38, 'trap / MRET target']], info: I('Trap target', 'mtvec on entry, mepc for MRET.') }),
    wfi: W([[1306, 253], [1380, 253]], 'WFI in M', { cls: 'trap', layer: 'trap', info: I('WFI', 'Sleeps in M.') }),
    // memory side
    ibeat: W([[235, 908], [235, 971], [620, 971]], 'instruction channel', { cls: 'bus', layer: 'mem', lab: [[245, 965, 'instruction channel']], vt: [440, 971], info: I('Instruction channel (cache_fabric_if)'), variantInfo: { hazard3_ahb: I('Instruction port (AHB)', 'Address and data phases between Hazard3 and the bench memory.') } }),
    dbeat: W([[1320, 908], [1320, 971], [980, 971]], 'data channel', { cls: 'bus', layer: 'mem', lab: [[1310, 965, 'data channel', 'end']], vt: [1150, 971], info: I('Data channel (cache_fabric_if)'), variantInfo: { hazard3_ahb: I('Data port (AHB)', 'Address and data phases between Hazard3 and the bench memory.') } })
  };

  var model = {
    title: 'Hazard3 three-stage pipeline',
    desc: 'Hazard3 pipeline: F with fetch address, single-entry BTB, two-word prefetch FIFO and halfword instruction assembly into the CIR; D/X with decode, register file read a cycle early, bypass from X/M and MW, ALU, branch comparator, address adder, fast multiplier and sequential divider; M with load alignment, late store-data bypass and register write. Two AHB ports either convert to cache_fabric_if (Prism tile) or connect straight to the bench memory.',
    w: 1720, h: 1000,
    layers: [{ key: 'ctl', label: 'control' }, { key: 'trap', label: 'traps & CSRs', on: false }, { key: 'mem', label: 'memory side' }],
    heads: [[290, 22, 'F'], [925, 22, 'D/X'], [1500, 22, 'M'], [568, 62, 'CIR'], [1298, 62, 'X/M']],
    regions: [{ x: 100, y: 842, w: 1400, h: 156, label: 'memory side', layer: 'mem', lx: 1510, ly: 862 }],
    contracts: [{ id: 'cache_fabric_if', label: 'cache_fabric_if', x1: 120, x2: 1480, y: 932, cx: 800, layer: 'mem', variants: ['hazard3'] }],
    contractInfo: { cache_fabric_if: { info: { kind: 'Contract', title: 'cache_fabric_if', text: ['Blocking, non-coherent instruction and data channels from the tile to the fabric. Each carries one 64-bit beat with no IDs; a beat completes on a rising edge with wait low.'], src: ['source/contracts/interfaces/cache_fabric_if.vh'] } } },
    blocks: blocks,
    wires: wires,
    stages: [['F', 290], ['D/X', 925], ['M', 1500]],
    variants: [{ key: 'hazard3', label: 'Prism tile', trace: 'hazard3' }, { key: 'hazard3_ahb', label: 'Direct AHB memory', trace: 'hazard3_ahb' }],
    detailHint: 'Select any block or wire for its role and RTL source. Each instruction keeps one colour from D/X to M; fetch activity is shown without instruction colours.'
  };

  function hex(v) { if (v === null || v === undefined) return '—'; if (typeof v === 'number') v = (v >>> 0).toString(16); return '0x' + String(v).replace(/^0x/, '').replace(/^0+(?=.)/, ''); }
  var PAL = ['var(--i0)', 'var(--i1)', 'var(--i2)', 'var(--i3)', 'var(--i4)', 'var(--i5)'];
  function col(d) { return PAL[d.id % PAL.length]; }
  var HOT = 'var(--hot)', WAIT = 'var(--wait)', FETCH = 'var(--muted)';
  var STAGE_X = { f: 290, dx: 925, m: 1500 };
  // ALU operand B is the immediate for these (JAL/JALR: the link offset 4 or 2,
  // U/hazard3_decode.v RVOPC_JAL/JALR). Branches, loads and stores keep rs2 on
  // the ALU; their offset goes to the address adder.
  var ALU_IMM = { alui: 1, lui: 1, auipc: 1, jal: 1, jalr: 1 };
  var ADDR = { branch: 1, jal: 1, jalr: 1, load: 1, store: 1 };
  var CAUSES = { 0: 'instruction address misaligned', 1: 'instruction access fault', 2: 'illegal instruction', 3: 'breakpoint', 4: 'load address misaligned', 5: 'load access fault', 6: 'store/AMO address misaligned', 7: 'store/AMO access fault', 8: 'environment call from U-mode', 11: 'environment call from M-mode' };
  function causeText(n) { return (CAUSES[n] || 'cause ' + n) + ' (mcause ' + n + ')'; }
  var STALLS = { raw: 'load-use', div: 'divide', mem: 'address waits', trap: 'trap', amo: 'atomic', jump: 'jump not accepted', m: 'M stalled' };
  var STALL_TEXT = { mem: 'its data address phase waits for the bus', trap: 'a trap is being entered', amo: 'an atomic sequence is in progress', jump: 'the frontend cannot accept the jump yet', m: 'M is stalled' };
  // xm_memop encodings (U/hazard3_ops.vh): 0-4 loads, 5-7 stores, 8 LR, 9 SC, 0x0a AMO, 0x10 none.
  function memLoad(op) { return op !== null && op !== undefined && (op <= 4 || op === 8); }
  function memStore(op) { return op >= 5 && op <= 7 || op === 9; }
  function has(t, e) { return t.ev && t.ev.indexOf(e) >= 0; }
  function except(x) { return x !== null && x !== undefined && x !== 10 ? x : null; } // 10 = MRET, not a fault
  // A store whose data register (not its address register) is being loaded by
  // the instruction in M: the RAW rule does not stall it for the data, and M
  // forwards the data from MW (U/hazard3_core.v x_stall_on_raw, m_wdata).
  function lateStore(D, Mi) { return !!(D && Mi && D.cls === 'store' && Mi.cls === 'load' && D.rs2 && D.rs2 === Mi.rd && D.rs1 !== Mi.rd); }
  function inst(trace, id) { return id === null || id === undefined ? null : trace.dyn[id]; }
  // True when this D/X occupant already had a jump accepted on an earlier cycle
  // and stays in D/X (CIR lock, U/hazard3_decode.v cir_lock).
  function redirected(trace, c) {
    var dx = trace.cycles[c].dx || {};
    if (dx.locked !== undefined) return !!dx.locked;
    for (var k = c - 1; k >= 0; k--) {
      var p = trace.cycles[k];
      if (!p.dx || p.dx.id !== dx.id) return false;
      if (p.jump && p.jump.from === 'x') return true;
    }
    return false;
  }
  // Store data as driven on the bus: bytes and halfwords are replicated (U/hazard3_core.v bus_wdata_d).
  function laneData(Mi, v) {
    if (v === null || v === undefined || !Mi) return v;
    if (/^sb /.test(Mi.text)) { var b = v & 0xff; return ((b << 24) | (b << 16) | (b << 8) | b) >>> 0; }
    if (/^sh /.test(Mi.text)) { var hw = v & 0xffff; return ((hw << 16) | hw) >>> 0; }
    return v;
  }
  function inflightAfterWfi(D, t) { return !!(D && D.fate === 'inflight' && (t.sleep || t.halted)); }

  // rs1/rs2 are null for an instruction without that operand; x0 is still a read.
  function reads(r) { return r !== null && r !== undefined; }

  // Lighting a wire also lights what feeds it, back to the block that drives
  // it (core-diagrams.js), so a frame names the wire ends in use, not the
  // trunks they branch from.
  model.frame = function (trace, c) {
    var t = trace.cycles[c], f = t.f || {}, dx = t.dx || {}, m = t.m || {}, bus = t.bus || {};
    var F = { wires: {}, blocks: {}, values: {}, tokens: [] };
    function on(id, color, hot) { F.wires[id] = { color: color, hot: hot }; }
    function val(id, x) { if (x !== null && x !== undefined) F.values[id] = hex(x); }
    function blk(id, o) { F.blocks[id] = o; }
    function active(id) { return !!(F.blocks[id] && (F.blocks[id].on || F.blocks[id].wait)); }
    var D = inst(trace, dx.id), Mi = inst(trace, m.id);

    // Stage tokens: fetch activity is anonymous; D/X and M carry instruction colours.
    var fparts = [];
    if (f.aph) fparts.push('request ' + hex(f.aph.addr));
    if (f.dph) fparts.push((f.discard ? 'drop ' : 'word ') + hex(f.dph.addr));
    if (!fparts.length) fparts.push(bus.i && bus.i.read ? 'fetch waits' : (t.sleep || t.halted ? 'fetch idle' : 'no fetch'));
    F.tokens.push({ x: STAGE_X.f, y: 38, text: fparts.join(' · '), bubble: true });
    function token(stage, d, extra) {
      if (!d) { F.tokens.push({ x: STAGE_X[stage], y: 38, text: '—', bubble: true, minw: 40 }); return; }
      var last = Math.max.apply(null, Object.keys(d.cells).map(Number));
      var strike = (d.fate === 'squashed' || d.fate === 'trap') && last === t.c;
      F.tokens.push({ x: STAGE_X[stage], y: 38, text: d.text + (extra || '') + (strike && d.fate === 'trap' ? ' · trap' : ''), color: col(d), strike: strike });
    }
    if (D) token('dx', D, dx.stall && dx.stall.length ? ' · stalled' : '');
    else F.tokens.push({ x: STAGE_X.dx, y: 38, text: dx.starved ? 'waiting for instruction' : '—', bubble: true, minw: 40 });
    token('m', Mi, m.stall ? ' · waits' : '');

    // F
    var btb = f.btb || {};
    if (btb.valid) { on('fa_btb', FETCH); blk('btb', { on: true, badge: hex(btb.src) + ' → ' + hex(btb.target) }); }
    if (f.aph) {
      on('aph', FETCH); val('aph', f.aph.addr); blk('iport', { on: true, badge: 'request ' + hex(f.aph.addr) });
      if (t.jump) { blk('amux', { on: true, badge: 'jump target' }); }
      else { on('fa_amux', FETCH); blk('amux', { on: true }); }
      if (btb.hit) { on('btb_npc', HOT, true); val('btb_npc', btb.target); blk('btb', { on: true, badge: 'hit → ' + hex(btb.target) }); }
      else if (!t.jump) { on('fa_add', FETCH); on('four', FETCH); on('add_npc', FETCH); blk('add4', { on: true }); }
      on('npc_fa', FETCH); blk('npc', { on: true });
    }
    blk('fa', { on: !!f.aph, badge: hex(f.addr) });
    // A returning word is queued, passed straight to instruction assembly, or
    // dropped (U/hazard3_frontend.v fifo_push, cir_room_for_fetch).
    var fifo = f.fifo || [], words = fifo.filter(function (e) { return e && e.hw; }).length, drop = !!(f.dph && f.discard);
    var queued = !!f.dph && (!!f.push || drop || !f.bypass);
    if (f.dph) {
      if (queued) on('idata', drop ? WAIT : FETCH);
      val('idata', f.dph.data);
      if (!f.aph) blk('iport', { on: true, badge: drop ? 'word dropped' : (f.dph.err ? 'bus error' : 'word from ' + hex(f.dph.addr)) });
    } else if (bus.i && bus.i.read && bus.i.wait) blk('iport', { wait: true, badge: 'waiting' });
    if (f.bypass) on('bypass', FETCH);
    if (f.pop) on('fifo_al', FETCH);
    blk('fifo', { on: words > 0 || !!f.push || !!f.pop || (queued && !drop), wait: drop, badge: words + ' of 2 words' + (f.push ? ' · fill' : drop ? ' · drop' : '') });
    blk('align', { on: (f.level || 0) > 0 || !!f.bypass || !!f.pop || !!D, badge: (f.level || 0) + ' halfword' + (f.level === 1 ? '' : 's') });

    // Jumps
    if (t.jump) {
      on('redirect', HOT, true); val('redirect', t.jump.target); on('jt_npc', HOT, true);
      blk('jsel', { on: true, badge: t.jump.from === 'm' ? (t.mret ? 'MRET' : 'trap') : 'from X' });
      if (t.jump.from === 'm') { on('trap_t', HOT, true); if (!active('trapu')) blk('trapu', { on: true }); }
      else { on('jt_x', HOT, true); on('jreq', HOT, true); }
      blk('npc', { on: true });
      if (!active('amux')) blk('amux', { on: true, badge: 'jump target' });
    }
    if (has(t, 'btb_set') || has(t, 'btb_clear') || has(t, 'mispredict')) {
      on('btb_set', has(t, 'btb_set') ? HOT : WAIT, true);
      if (!active('btb')) blk('btb', { on: true, badge: has(t, 'btb_set') ? 'set' : 'cleared' });
    }

    // D/X
    if (D) {
      var dc = col(D), k = D.cls, stalled = dx.stall && dx.stall.length, fault = except(dx.except);
      on('al_cir', dc); on('cir_dec', dc);
      blk('dec', { on: true, badge: (dx.len || D.len) === 2 ? '16-bit, expanded' : (fault !== null ? causeText(fault).replace(/ \(mcause.*/, '') : '') });
      // PC update, read from the next cycle: sequential, loaded (jump or prediction) or held.
      var nx = trace.cycles[c + 1], npc = nx && nx.dx ? nx.dx.pc : undefined, len = dx.len || D.len || 4;
      if (npc === undefined || npc === dx.pc) blk('dpc', { on: true, badge: hex(dx.pc) + (npc === dx.pc ? ' · holds' : '') });
      else if (npc === ((dx.pc + len) >>> 0)) { on('cir_pc', dc); on('pc_inc', dc); on('inc_pc', dc); blk('dpc', { on: true, badge: hex(dx.pc) }); blk('inc', { on: true, badge: '+' + len }); }
      else blk('dpc', { on: true, badge: hex(dx.pc) + ' → ' + hex(npc) });
      // X/M takes the instruction unless X stalls (then it takes a bubble).
      if (!stalled) on('dec_xm', dc);
      if (reads(D.rs1) || reads(D.rs2)) blk('rf', { on: true });
      if (stalled) { on('hold', WAIT, true); blk('stall', { wait: true, badge: dx.stall.map(function (s) { return STALLS[s] || s; }).join(', ') }); }
      // Bypass selectors. While D/X stalls, the selected value is not yet the
      // one the instruction will use, so its source is not drawn.
      function operand(n, reg, how, v) {
        if (!reads(reg)) return;
        var A = n === 1;
        if (stalled) { blk(A ? 'byA' : 'byB', { on: true }); return; }
        if (how === 'xm') on(A ? 'xmB' : 'xmB2', HOT, true);
        else if (how === 'mw') on(A ? 'mwB' : 'mwB2', HOT, true);
        else if (how === 'rf') on(A ? 'rdat1' : 'rdat2', dc);
        blk(A ? 'byA' : 'byB', { on: true, badge: how === 'x0' ? 'x0' : '' });
        val(A ? 'opa' : 'opb', v);
      }
      operand(1, D.rs1, dx.byp1, dx.r1);
      if (lateStore(D, Mi)) blk('byB', { on: true, badge: 'in M' });
      else operand(2, D.rs2, dx.byp2, dx.r2);
      // ALU: arithmetic, the JAL/JALR link value, and values it passes through
      // on operand B: a store's data and LUI's immediate (ALUOP_RS2).
      if (k === 'alu' || ALU_IMM[k] || k === 'store') {
        var fromPc = k === 'auipc' || k === 'jal' || k === 'jalr', fromRs1 = k === 'alu' || k === 'alui';
        blk('alu', { on: true }); on('alu_op');
        if (fromPc) on('pcA', dc);
        if (fromRs1) on('opa', dc);
        if (fromPc || fromRs1) { blk('opA', { on: true }); on('pA', dc); }
        if (ALU_IMM[k]) on('imm_b', dc); else on('opb', dc);
        blk('opB', { on: true, badge: k === 'jal' || k === 'jalr' ? 'link +' + len : '' });
        on('pB', dc); on('alu_out', dc); val('alu_out', dx.alu); on('x_xm', dc); blk('xres', { on: true });
      }
      if (k === 'branch') {
        on('br1', dc); on('br2', dc);
        var raw = stalled && dx.stall.indexOf('raw') >= 0;
        blk('brc', { on: true, badge: raw ? 'operand not ready' : redirected(trace, c) ? 'jump already taken' : dx.br ? (dx.br.predicted ? 'predicted; ' : '') + (dx.br.taken ? 'taken' : 'not taken') : '' });
      }
      // Address adder: drawn when its sum is used, as an accepted jump target
      // or as the data address of a request.
      var jumps = !!t.jump && t.jump.from === 'x', req = null;
      if (k === 'load' || k === 'store') {
        // The request itself: recorded address phase if available; never for a faulting access.
        req = dx.dreq !== undefined ? dx.dreq : (fault === null && !(stalled && dx.stall.indexOf('raw') >= 0) ? { addr: dx.addr, ready: !(stalled && dx.stall.indexOf('mem') >= 0) } : null);
      }
      if (jumps || req) {
        on(k === 'jalr' || k === 'load' || k === 'store' ? 'rs1_a' : 'pcbus', dc); on('imm_a', dc); on('a_add', dc); val('a_out', dx.addr);
        blk('asel', { on: true }); blk('aadd', { on: true });
        if (req) {
          on('daddr', req.ready ? dc : WAIT, !req.ready); val('daddr', req.addr);
          blk('dport', req.ready ? { on: true, badge: (k === 'load' ? 'read ' : 'write ') + hex(req.addr) } : { wait: true, badge: 'address waits' });
        }
        if (jumps && (k === 'jal' || k === 'jalr')) blk('brc', { on: true, badge: 'unconditional' });
      }
      if (k === 'mul') {
        on('mul_a', dc); on('mul_b', dc); on('mul_x', dc); val('mul_x', dx.mulres); on('x_xm', dc);
        blk('mul', { on: true, badge: 'combinational' }); blk('xres', { on: true });
      }
      if (k === 'div') {
        on('div_a', dc); on('div_b', dc);
        var dv = dx.div || {};
        blk('div', stalled ? { wait: true, badge: dv.state ? String(dv.state) : 'busy' } : { on: true, badge: 'result ready' });
        if (!stalled) { on('div_x', dc); on('x_xm', dc); blk('xres', { on: true }); }
      }
      if (k === 'csr' && dx.csr) {
        // Actual strobes when recorded; otherwise the decoded intent, only on a cycle that is not stalled.
        var rd = dx.csr.rstb !== undefined ? dx.csr.rstb : dx.csr.ren && !stalled;
        var wr = dx.csr.wstb !== undefined ? dx.csr.wstb : dx.csr.wen && !stalled;
        if (wr && reads(D.rs1)) on('csr_w', dc);   // the immediate forms write a 5-bit constant instead
        if (rd) { on('csr_x', dc); val('csr_x', dx.csr.rdata); on('x_xm', dc); blk('xres', { on: true }); }
        blk('csr', { on: !!(rd || wr), badge: hex(dx.csr.addr) + (rd && wr ? ' read, write' : rd ? ' read' : wr ? ' write' : ' waits') });
      }
    }
    // The jump request and the BTB update are drawn from the comparator block.
    if ((F.wires.jreq || F.wires.btb_set) && !active('brc')) blk('brc', { on: true });

    // M: memory activity from the recorded memory operation, not the instruction class.
    if (Mi) {
      var mc = col(Mi), mfault = except(m.except), mem = mfault === null && (memLoad(m.memop) || memStore(m.memop));
      if (mem) {
        var waiting = !!m.stall;
        if (waiting) {
          on('mstall', WAIT, true); blk('dport', { wait: true, badge: 'data phase waits' });
          if (!active('stall')) blk('stall', { wait: true, badge: STALLS.m });
        }
        if (memLoad(m.memop) && !waiting) {
          on('xm_ld', mc); on('rdata', mc); val('rdata', m.rdata); blk('ldsel', { on: true }); on('ld_m', mc);
          if (!active('dport')) blk('dport', { on: true, badge: 'read done' });
        }
        if (memStore(m.memop)) {
          var late = has(t, 'store_bypass');
          on(late ? 'mw_sd' : 'xm_sd', late ? HOT : mc, late);
          on('sdata', waiting ? WAIT : mc); val('sdata', laneData(Mi, m.wdata)); blk('sdm', { on: true, badge: late ? 'from MW' : '' });
          if (!waiting) blk('dport', { on: true, badge: 'write done' });
        }
      } else if (mfault === null && m.wen) on('xm_m', mc);
      if (m.wen) {
        blk('mres', { on: true }); val('res', m.result); on('wb_rf', mc); on('res_mw', mc);
        blk('rf', { on: true, badge: 'x' + m.rd + ' ← ' + hex(m.result) }); blk('mw', { on: true });
      }
    }
    if (t.trap) { on('exc', HOT, true); blk('trapu', { on: true, badge: t.trap.irq ? 'interrupt ' + t.trap.cause : causeText(t.trap.cause) }); }
    if (t.mret) blk('trapu', { on: true, badge: 'MRET → ' + hex(t.mret.target) });
    if (t.sleep) { on('wfi', WAIT); blk('pwr', { wait: true, badge: t.halted ? 'halted' : 'asleep' }); }

    // Memory side: a beat in flight on either channel.
    if (bus.i && bus.i.read) {
      on('ibeat', bus.i.wait ? WAIT : FETCH); val('ibeat', bus.i.addr);
      if (!active('iport')) blk('iport', { on: true });
    }
    if (bus.d && (bus.d.read || bus.d.write)) {
      on('dbeat', bus.d.wait ? WAIT : (Mi ? col(Mi) : FETCH)); val('dbeat', bus.d.addr);
      if (!active('dport')) blk('dport', { on: true });
    }
    if (F.wires.ibeat || F.wires.dbeat) blk('mem', { on: true });
    return F;
  };

  model.isEvent = function (trace, c) {
    var ev = trace.cycles[c].ev || [];
    return ev.some(function (e) { return e !== 'fetch'; });
  };

  function q(s) { return '`' + s + '`'; }
  var CSR_NAMES = { 0x300: 'mstatus', 0x304: 'mie', 0x305: 'mtvec', 0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval', 0x344: 'mip', 0xb00: 'mcycle', 0xb02: 'minstret', 0xc00: 'cycle', 0xc02: 'instret' };

  model.narrate = function (trace, c) {
    var t = trace.cycles[c], f = t.f || {}, dx = t.dx || {}, m = t.m || {};
    var D = inst(trace, dx.id), Mi = inst(trace, m.id);
    var head = ['Cycle ' + t.c + ' · '];
    if (D) { head.push('D/X '); head.push({ text: D.text, color: col(D) }); head.push(' '); }
    if (Mi) { head.push('M '); head.push({ text: Mi.text, color: col(Mi) }); }
    if (!D && !Mi) head.push(t.halted ? 'halted' : 'no instruction in D/X or M');
    var say = [], stalled = !!(dx.stall && dx.stall.length), raw = stalled && dx.stall.indexOf('raw') >= 0;
    var fault = except(dx.except), late = inflightAfterWfi(D, t), done = D && redirected(trace, c);
    if (t.halted) say.push('WFI is asleep with every interrupt disabled (the `halt` macro), and the frontend has drained. The bench’s FINISH_ON_WFI option ends the run here; ordinary firmware would sleep until an enabled interrupt is pending.');
    else if (t.sleep) say.push('Asleep after WFI: M holds the WFI until an enabled interrupt is pending. This bench raises no interrupts.');
    if (t.trap && !t.trap.irq) say.push((Mi ? q(Mi.text) + ' in M' : 'The instruction in M') + ' raises ' + causeText(t.trap.cause) + '. It does not write its register; mepc and mcause are written and fetch restarts at ' + q(hex(t.trap.target)) + ' (mtvec). The instructions behind it are discarded.');
    if (t.trap && t.trap.irq) say.push('Interrupt ' + t.trap.cause + ' is taken between the instruction in M and the one in X; fetch restarts at ' + q(hex(t.trap.target)) + '.');
    if (t.mret) say.push('MRET returns to ' + q(hex(t.mret.target)) + ' (mepc).');
    if (D && fault !== null) say.push(q(D.text) + ' raises ' + causeText(fault) + ' in X' + (D.cls === 'load' || D.cls === 'store' ? '; no bus request is made' : '') + '. The exception goes to M, where the trap is taken.');
    // Branches and jumps: unresolved, requested, accepted, or already redirected.
    var jumpNow = t.jump && t.jump.from === 'x';
    if (D && dx.br) {
      if (raw) say.push(q(D.text) + ' waits for an operand from the load in M; its comparison is not final yet.');
      else if (done && !jumpNow) say.push(q(D.text) + ' has already redirected fetch; it stays in D/X until it can move to M.');
      else if (jumpNow && has(t, 'mispredict')) say.push(q(D.text) + ' was predicted taken by the BTB, but falls through: X jumps to the next instruction, ' + q(hex(t.jump.target)) + ', and the BTB entry is cleared.');
      else if (jumpNow) say.push(q(D.text) + ' is taken: the jump to ' + q(hex(t.jump.target)) + ' is accepted, and the target goes onto the instruction bus this cycle. Queued fetches behind the branch are dropped.');
      else if (dx.br.recover && stalled && dx.stall.indexOf('jump') >= 0) say.push(q(D.text) + ' requests a jump to ' + q(hex(dx.br.target)) + '; the frontend cannot accept it yet.');
      else if (dx.br.predicted && dx.br.taken) say.push(q(D.text) + ' was predicted taken by the BTB and is taken: no jump from X, fetch is already at the target.');
      else if (!dx.br.taken && !stalled) say.push(q(D.text) + ' is not taken.');
      if (has(t, 'btb_set')) say.push('The branch jumps backwards and was not predicted, so it is stored in the BTB: the next time fetch reaches it, fetch goes straight to the target.');
    } else if (D && jumpNow) say.push(q(D.text) + ' jumps to ' + q(hex(t.jump.target)) + ' from X. The target goes onto the instruction bus this cycle; queued fetches behind it are dropped.');
    else if (D && done && (D.cls === 'jal' || D.cls === 'jalr')) say.push(q(D.text) + ' has already redirected fetch; it stays in D/X until it can move to M.');
    if (D && stalled) {
      if (raw && Mi && !dx.br) say.push(q(D.text) + ' needs ' + q('x' + Mi.rd) + ' from ' + q(Mi.text) + ', a load still in M. It waits in D/X until the load has written the register, then takes the value from MW.');
      if (dx.stall.indexOf('div') >= 0) say.push(q(D.text) + ' is in the divider; D/X holds until its result is valid.');
      var explained = raw || late || done || jumpNow;
      var other = dx.stall.filter(function (s) { return s !== 'raw' && s !== 'div' && !(s === 'm' && explained); });
      if (other.length) say.push(q(D.text) + ' waits in D/X: ' + other.map(function (s) { return STALL_TEXT[s] || s; }).join(', and ') + '.');
    }
    if (lateStore(D, Mi)) say.push(q(D.text) + ' has no extra wait for its store data, ' + q('x' + D.rs2) + ': M forwards it from MW after the load writes it.');
    if (D && !stalled && ((dx.byp1 === 'xm' || dx.byp1 === 'mw') && D.rs1 || (dx.byp2 === 'xm' || dx.byp2 === 'mw') && D.rs2)) {
      var parts = [];
      if (D.rs1 && (dx.byp1 === 'xm' || dx.byp1 === 'mw')) parts.push(q('x' + D.rs1) + ' from ' + (dx.byp1 === 'xm' ? 'X/M' : 'MW'));
      if (D.rs2 && !lateStore(D, Mi) && (dx.byp2 === 'xm' || dx.byp2 === 'mw')) parts.push(q('x' + D.rs2) + ' from ' + (dx.byp2 === 'xm' ? 'X/M' : 'MW'));
      if (parts.length) say.push('Bypass: ' + q(D.text) + ' takes ' + parts.join(' and ') + '.');
    }
    if (D && D.cls === 'csr' && dx.csr) {
      var crd = dx.csr.rstb !== undefined ? dx.csr.rstb : dx.csr.ren && !stalled, cwr = dx.csr.wstb !== undefined ? dx.csr.wstb : dx.csr.wen && !stalled;
      var cname = CSR_NAMES[dx.csr.addr] ? q(CSR_NAMES[dx.csr.addr]) + ' (' + hex(dx.csr.addr) + ')' : q(hex(dx.csr.addr));
      if (crd || cwr) say.push(q(D.text) + (crd && cwr ? ' reads and writes ' : crd ? ' reads ' : ' writes ') + cname + ' in X' + (crd ? '; the old value is its result' : '') + '.');
    }
    if (D && has(t, 'div_done')) say.push(q(D.text) + ': the divider’s result is valid; it enters X/M at the next edge.');
    if (late) say.push(q(D.text) + ' was fetched after the WFI' + (done || jumpNow ? ' and has redirected fetch, but it' : ' and') + ' stays in D/X; it does not reach M.');
    if (has(t, 'predict') && f.btb) say.push('Fetch has reached the branch at ' + q(hex(f.btb.src)) + ' that the BTB holds, so the next fetch goes to ' + q(hex(f.btb.target)) + ' instead of the next word.');
    if (D && D.cls === 'mul' && !stalled) say.push(q(D.text) + ': the fast multiplier is combinational, so the product is ready at the end of X.');
    if (D && (D.cls === 'load' || D.cls === 'store') && fault === null && !raw) {
      var req = dx.dreq !== undefined ? dx.dreq : { addr: dx.addr, ready: !(stalled && dx.stall.indexOf('mem') >= 0) };
      if (req && req.ready) say.push(q(D.text) + ' sends its address, ' + q(hex(req.addr)) + ', from X; the data phase happens in M.');
    }
    var mfault = except(m.except), mmem = Mi && mfault === null && (memLoad(m.memop) || memStore(m.memop));
    if (mmem && m.stall) say.push(q(Mi.text) + ' waits for its data phase; M and X hold.');
    if (mmem && has(t, 'store_bypass')) say.push(q(Mi.text) + ' takes its store data from MW, the value M wrote most recently.');
    if (Mi && m.wen) say.push('M writes ' + q('x' + m.rd) + ' ← ' + q(hex(m.result)) + ' at the next edge.');
    if (has(t, 'discard')) say.push('The response to ' + q(hex(f.dph ? f.dph.addr : 0)) + ', requested before the jump, arrives and is dropped.');
    if (!D && dx.starved && !t.sleep && !t.halted) say.push('D/X waits for instruction data: the CIR does not hold a complete instruction.');
    if (!say.length) say.push('No stalls this cycle.');
    return [head, [say.join(' ')]];
  };

  model.chart = function (trace) {
    var L = { dx: 'X', m: 'M' };
    var lo = trace.cycles[0].c, hi = trace.cycles[trace.cycles.length - 1].c;
    var shown = trace.dyn.filter(function (d) { return Object.keys(d.cells).some(function (k) { return k >= lo && k <= hi; }); });
    trace.rowIds = shown.map(function (d) { return d.id; });
    var rows = shown.map(function (d) {
      var cells = {}, keys = Object.keys(d.cells).map(Number).sort(function (a, b) { return a - b; });
      var prev = null, last = keys[keys.length - 1];
      keys.forEach(function (k) {
        var st = d.cells[k], held = st === prev;
        var sq = (d.fate === 'squashed' || d.fate === 'trap') && k === last;
        cells[k] = { text: L[st] || '?', color: col(d), cls: (held ? 'stall' : '') + (sq ? ' sq' : ''),
          title: (st === 'dx' ? 'decode/execute' : 'memory') + (held ? ' (held)' : '') + (sq ? (d.fate === 'trap' ? ', then trapped: ' + causeText(d.cause) : ', then discarded') : '') };
        prev = st;
      });
      return { pc: hex(d.pc).replace('0x', ''), text: d.text, cells: cells, jump: keys[0] || 0, cls: d.fate === 'squashed' ? 'squashed' : d.fate === 'trap' ? 'squashed trapped' : '' };
    });
    return { title: 'Pipeline occupancy', corner: 'instruction \\ cycle', hint: 'X = D/X, M = M. Fetch is not attributed to instructions (see the F stage). Outlined cells repeat a stage (held). Struck-through rows were discarded or (marked trap) faulted.', rows: rows,
      legend: [['k-fwd', 'jump, bypass, stall'], ['k-wait', 'waiting on the bus'], ['k-ctl', 'control signal']] };
  };
  model.currentRows = function (trace, c) {
    var t = trace.cycles[c], out = [];
    [t.dx && t.dx.id, t.m && t.m.id].forEach(function (id) { if (id !== null && id !== undefined) out.push(id); });
    return out.map(function (id) { return (trace.rowIds || []).indexOf(id); }).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
  };
  model.startCycle = 0;

  window.PrismCoreDiagrams.define('hazard3', model);
})();
