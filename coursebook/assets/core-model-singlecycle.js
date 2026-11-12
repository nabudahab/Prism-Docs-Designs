/* Singlecycle datapath model: geometry, RTL notes and the per-cycle frame. */
(function () {
  'use strict';
  var DP = 'source/core_tiles/singlecycle/rtl/datapath.sv';
  var U = 'source/core_tiles/singlecycle/rtl/units/';

  var blocks = {
    trapmux: { kind: 'mux', x: 30, y: 282, w: 20, h: 76, label: '', layer: null,
      info: { kind: 'Selector', title: 'Trap or next PC', text: ['At the rising edge, an accepted trap loads `trap_target`; otherwise a retiring instruction loads `next_pc`. Trap entry wins over retirement and wake-up.'], src: [DP + ' · architectural_boundary'] } },
    pc: { kind: 'reg', x: 70, y: 275, w: 58, h: 90, label: 'PC', badgeY: 369,
      info: { kind: 'State', title: 'Program counter', text: ['Updates only at a rising edge where the instruction retires or a trap is taken. While fetch or data waits, PC holds and the instruction’s register, CSR and memory effects wait.', 'Reset loads `PC_INIT`, which `core_tile` takes from `RESET_PC`.'], src: [DP + ' · architectural_boundary'] } },
    add4: { kind: 'add', x: 190, y: 118, w: 46, h: 56, label: '+4', tx: 4,
      info: { kind: 'Adder', title: 'PC + 4', text: ['Sequential successor. Feeds the next-PC selector and the write-back selector (link value for JAL/JALR).'], src: [DP + ' · pc_mux, writeback_mux'] } },
    fetch: { kind: 'mem', x: 190, y: 270, w: 120, h: 100, label: 'Instruction', sub: 'port · icache_if', badgeX: 262,
      info: { kind: 'Interface', title: 'Instruction port (icache_if)', text: ['The datapath drives `read_enable` and `address = pc`. The memory side answers with `hit` and `read_data`, or `access_fault`.', 'Without a hit the instruction cannot retire, so PC and the instruction’s effects wait. `read_enable` drops while halted, sleeping in WFI, or taking an interrupt.'], src: ['source/core_tiles/singlecycle/rtl/interfaces/icache_if.vh', DP] } },
    control: { kind: 'ctl', x: 370, y: 66, w: 150, h: 64, label: 'Control', sub: 'control.sv',
      info: { kind: 'Decoder', title: 'Control (decode)', text: ['Combinational opcode/funct decoder producing `decode_control_t`: ALU operation and operand selects, `reg_src`, `pc_src`, memory read/write and size, CSR, MRET, WFI, FENCE.I, ECALL/EBREAK and `illegal`.', 'Decoded side effects are qualified by `retire` in the datapath, so a trap or memory wait suppresses them.'], src: [U + 'control.sv', 'source/core_tiles/singlecycle/rtl/packages/control_types_pkg.vh'] } },
    rf: { kind: 'box', x: 390, y: 270, w: 130, h: 150, label: 'Register file', sub: '32 × 32 bit', ty: 35, badgeY: 424,
      pins: [[396, 288, 'rs1'], [396, 316, 'rs2'], [396, 344, 'rd'], [396, 408, 'wdata'], [514, 308, 'rdat1', 'end'], [514, 358, 'rdat2', 'end']],
      info: { kind: 'State', title: 'Register file', text: ['Two combinational reads and one write on the rising edge. The write enable is `retire && reg_write`; writes to x0 are dropped.'], src: [U + 'register_file.sv'] } },
    imm: { kind: 'box', x: 390, y: 450, w: 120, h: 44, label: 'Immediate', sub: 'imm_gen.sv',
      info: { kind: 'Decoder', title: 'Immediate generator', text: ['Extracts and sign-extends the I, S, B, U or J immediate from the instruction.'], src: [U + 'imm_gen.sv'] } },
    muxA: { kind: 'mux', x: 598, y: 262, w: 22, h: 70, label: '',
      info: { kind: 'Selector', title: 'ALU port A', text: ['`alu_src_a_pc` selects the PC (AUIPC) instead of `rdat1`.'], src: [DP + ' · aluif.port_a'] } },
    muxB: { kind: 'mux', x: 598, y: 352, w: 22, h: 70, label: '',
      info: { kind: 'Selector', title: 'ALU port B', text: ['`alu_src_b_imm` selects the immediate instead of `rdat2` (I-type, loads, stores, JALR, AUIPC).'], src: [DP + ' · aluif.port_b'] } },
    alu: { kind: 'alu', x: 660, y: 254, w: 90, h: 176, label: 'ALU', tx: 8,
      info: { kind: 'Execution', title: 'ALU', text: ['Add/sub, shifts, logic and set-less-than. Also forms load/store addresses and the JALR target. Flags `zero`, `neg` and `overflow` drive branch decisions.'], src: [U + 'alu.sv'] } },
    br: { kind: 'box', x: 660, y: 450, w: 130, h: 44, label: 'Branch decision', sub: 'branch_control.sv', badgeX: 752, badgeY: 498,
      info: { kind: 'Execution', title: 'Branch decision', text: ['Uses `funct3` and the ALU flags. BEQ/BNE/BLT/BGE compare SUB flags; BLTU/BGEU use the zero flag of an SLTU result.'], src: [U + 'branch_control.sv'] } },
    pcimm: { kind: 'add', x: 590, y: 118, w: 46, h: 56, label: '+', tx: 4,
      info: { kind: 'Adder', title: 'PC + immediate', text: ['Target for JAL and taken conditional branches.'], src: [DP + ' · pc_mux'] } },
    pcmux: { kind: 'mux', x: 890, y: 66, w: 24, h: 150, label: '',
      pins: [[886, 78, 'pc+4', 'end'], [886, 103, 'mepc', 'end'], [886, 128, 'pc+imm', 'end'], [886, 153, 'jalr', 'end'], [886, 178, 'pc', 'end']],
      info: { kind: 'Selector', title: 'Next PC', text: ['Starts from PC+4. `pc_src = BRANCH` selects PC+imm for JAL or a taken branch; `PC_JALR` selects the ALU result with bit 0 cleared. MRET selects `mepc`; HALT holds the current PC.'], src: [DP + ' · pc_mux'] } },
    dport: { kind: 'mem', x: 822, y: 280, w: 108, h: 110, label: 'Data port', sub: 'dcache_if', badgeX: 866,
      info: { kind: 'Interface', title: 'Data port (dcache_if)', text: ['Address is the ALU result; store data is `rdat2`. Read/write enables assert only when the fetched instruction is valid and passed decode, target and alignment checks.', 'The memory side answers with `hit`, read data (low-justified) or `access_fault`. Without `hit` the instruction cannot retire.'], src: ['source/core_tiles/singlecycle/rtl/interfaces/dcache_if.vh', DP] } },
    ldx: { kind: 'box', x: 960, y: 343, w: 100, h: 44, label: 'Load extend', sub: 'size, unsigned',
      info: { kind: 'Datapath', title: 'Load extension', text: ['The memory path right-justifies byte and halfword data; this block sign- or zero-extends it by `size` and `load_unsigned`.'], src: [DP + ' · load_extension'] } },
    wbmux: { kind: 'mux', x: 1120, y: 275, w: 26, h: 180, label: '',
      pins: [[1116, 283, 'csr', 'end'], [1116, 318, 'pc+4', 'end'], [1116, 359, 'load', 'end'], [1116, 388, 'alu', 'end'], [1116, 422, 'imm', 'end']],
      info: { kind: 'Selector', title: 'Write-back value', text: ['`reg_src` selects the ALU result, loaded value, PC+4 or the U-immediate (LUI). A CSR instruction overrides it with the old CSR value.'], src: [DP + ' · writeback_mux'] } },
    csr: { kind: 'trap', x: 960, y: 62, w: 120, h: 76, label: 'CSR file', sub: 'csr_file.sv', layer: 'trap', badgeX: 1045,
      info: { kind: 'State', title: 'CSR file', text: ['Machine CSRs: mstatus, mie, mtvec, mscratch, mepc, mcause, mtval, counters and MWBERR. Reads return the old value to the write-back selector; writes commit only with `retire`.', 'Supplies `mepc` for MRET, `mtvec` for trap entry and the pending interrupt mask.'], src: [U + 'csr_file.sv'] } },
    trap: { kind: 'trap', x: 1180, y: 62, w: 160, h: 76, label: 'Traps', sub: 'exceptions, interrupts', layer: 'trap', badgeY: 142,
      info: { kind: 'Control', title: 'Synchronous exceptions and interrupts', text: ['Exception priority: PC alignment, fetch fault, illegal/CSR, ECALL, EBREAK, next-PC alignment, data alignment, then data response fault. Pre-access checks suppress the data enables.', 'An enabled pending interrupt is taken only between instructions (`instruction_active` low). `mtvec` mode 1 vectors interrupts only.'], src: [DP + ' · synchronous_exceptions, interrupt_priority'] } },
    retire: { kind: 'ctl', x: 180, y: 206, w: 100, h: 34, label: 'retire', layer: 'ctl', badgeX: 306, badgeY: 215,
      info: { kind: 'Control', title: 'Retire', text: ['`retire = instruction_valid && !exception && (!memory_op || data.hit) && (!fence_i || data.flushed)`.', 'It enables the PC update, register write, CSR commit and the retirement report. Without it, the resident instruction simply waits.'], src: [DP + ' · retire'] } },
    adapter: { kind: 'mem', x: 190, y: 600, w: 740, h: 70, label: 'Cacheless adapter', sub: 'caches.sv: fetch passes through; a memory instruction is saved while its registered data beat completes', layer: 'mem', variant: 'singlecycle',
      info: { kind: 'Memory side', title: 'Cacheless adapter', text: ['Fetch goes straight to the fabric. When the fetched instruction is a load or store, the adapter saves the instruction and registers one 64-bit data beat; the instruction retires on the edge that beat completes.', 'Each memory instruction therefore takes an instruction beat and then a data beat.'], src: ['source/core_tiles/singlecycle/rtl/caches.sv'] } },
    icache: { kind: 'mem', x: 150, y: 600, w: 230, h: 70, label: 'I-cache', sub: '16 lines × 8 B, direct-mapped', layer: 'mem', variant: 'singlecycle_cached', badgeX: 320,
      info: { kind: 'Memory side', title: 'Instruction cache', text: ['128 bytes, direct-mapped, two instructions per 8-byte line. A hit completes combinationally; a miss registers one refill beat. FENCE.I invalidates every line after the D-cache flush.'], src: ['source/core_tiles/singlecycle/rtl/caches/icache.sv'] } },
    dcache: { kind: 'mem', x: 700, y: 600, w: 250, h: 70, label: 'D-cache', sub: '8 sets × 2 ways × 16 B\nwrite-back, write-allocate', layer: 'mem', variant: 'singlecycle_cached', ty: -4, badgeX: 790,
      info: { kind: 'Memory side', title: 'Data cache', text: ['256 bytes, two-way set associative, write-back and write-allocate. Tags are compared on the live address, so a warm access completes in the same cycle. A miss writes back a dirty victim, then refills two 64-bit beats.', 'Addresses outside cacheable RAM bypass allocation as single uncached beats.'], src: ['source/core_tiles/singlecycle/rtl/caches/dcache.sv'] } },
    fabric: { kind: 'box', x: 430, y: 724, w: 280, h: 44, label: 'Memory fabric', sub: 'to RAM, ROM and MMIO', layer: 'mem',
      info: { kind: 'Component', title: 'Memory fabric', text: ['Arbitrates the tile’s instruction and data channels onto `system_bus_if`. Data has priority. This diagram stops at the tile boundary.'], src: ['source/memory_fabrics/direct/rtl/cache_fabric.sv'] } }
  };

  function W(pts, name, extra) { var w = { pts: pts, name: name }; Object.keys(extra || {}).forEach(function (k) { w[k] = extra[k]; }); return w; }
  var wires = {
    pc_fetch: W([[128, 320], [190, 320]], 'pc → instruction address', { vt: [159, 333], info: { title: 'pc', text: ['Fetch address. The instruction port receives the full PC; the memory side selects the word.'] } }),
    pc_up: W([[155, 320], [155, 129], [190, 129]], 'pc → PC+4', { dots: [[155, 320]], info: { title: 'pc', text: ['PC to the sequential adder.'] } }),
    four: W([[170, 163], [190, 163]], 'constant 4', { lab: [[166, 167, '4', 'end']], info: { title: 'Constant 4' } }),
    pc_right: W([[155, 190], [570, 190], [570, 129], [590, 129]], 'pc → PC+imm', { dots: [[155, 190], [570, 190]], lab: [[300, 184, 'pc']], info: { title: 'pc', text: ['PC to the branch/JAL target adder and ALU port A.'] } }),
    pc_muxA: W([[570, 190], [570, 277], [598, 277]], 'pc → ALU port A', { info: { title: 'pc', text: ['Selected for AUIPC.'] } }),
    pc_hold: W([[570, 190], [876, 190], [876, 184], [890, 184]], 'pc → next PC (hold)', { info: { title: 'pc (hold)', text: ['HALT selects the current PC as its successor.'] } }),
    pc4_top: W([[236, 146], [260, 146], [260, 38], [856, 38], [856, 84], [890, 84]], 'pc+4 → next PC', { lab: [[300, 32, 'pc + 4']], dots: [[856, 38]], vt: [400, 38], info: { title: 'pc + 4', text: ['Default successor.'] } }),
    pc4_wb: W([[856, 38], [1086, 38], [1086, 324], [1120, 324]], 'pc+4 → write-back', { info: { title: 'pc + 4', text: ['Link value written by JAL and JALR.'] } }),
    ins: W([[310, 320], [335, 320]], 'instruction', { arrow: false, info: { title: 'instruction', text: ['`fetch.read_data`: the 32-bit instruction. It is meaningful only with `fetch.hit`.'] } }),
    ins_bus: W([[335, 98], [335, 512]], 'instruction fields', { arrow: false, dots: [[335, 320]], info: { title: 'Instruction fields', text: ['Bit fields fan out to decode, the register file, the immediate generator, the CSR file and branch decision.'] } }),
    ins_ctl: W([[335, 98], [370, 98]], 'opcode, funct3, funct7', { lab: [[329, 80, 'opcode,', 'end'], [329, 92, 'funct', 'end']], info: { title: 'opcode, funct3, funct7' } }),
    ins_rs1: W([[335, 288], [390, 288]], 'rs1 = instr[19:15]', { lab: [[340, 282, '[19:15]']], info: { title: 'rs1 index', text: ['instr[19:15]'] } }),
    ins_rs2: W([[335, 316], [390, 316]], 'rs2 = instr[24:20]', { lab: [[340, 310, '[24:20]']], info: { title: 'rs2 index', text: ['instr[24:20]'] } }),
    ins_rd: W([[335, 344], [390, 344]], 'rd = instr[11:7]', { lab: [[340, 338, '[11:7]']], info: { title: 'rd index', text: ['instr[11:7]'] } }),
    ins_imm: W([[335, 472], [390, 472]], 'instruction → immediate', { info: { title: 'instruction', text: ['Whole instruction to the immediate generator.'] } }),
    ins_f3: W([[335, 512], [710, 512], [710, 494]], 'funct3 → branch decision', { lab: [[600, 506, 'funct3']], info: { title: 'funct3', text: ['Selects the branch condition.'] } }),
    rdat1: W([[520, 317], [598, 317]], 'rdat1', { vt: [559, 304], info: { title: 'rdat1', text: ['Value of rs1.'] } }),
    rdat2: W([[520, 367], [598, 367]], 'rdat2', { vt: [559, 380], info: { title: 'rdat2', text: ['Value of rs2.'] } }),
    store: W([[575, 367], [575, 440], [796, 440], [796, 360], [822, 360]], 'rdat2 → store data', { dots: [[575, 367]], lab: [[585, 454, 'store data']], vt: [700, 440], info: { title: 'Store data', text: ['`data.write_data = rdat2`; the memory side places byte/halfword lanes.'] } }),
    imm_out: W([[510, 472], [555, 472], [555, 163], [590, 163]], 'imm → PC+imm', { dots: [[555, 472]], vt: [516, 502, 'start'], info: { title: 'imm', text: ['Sign-extended immediate.'] } }),
    imm_muxB: W([[555, 407], [598, 407]], 'imm → ALU port B', { dots: [[555, 407]], info: { title: 'imm → port B' } }),
    imm_wb: W([[555, 472], [555, 528], [1110, 528], [1110, 429], [1120, 429]], 'imm → write-back (LUI)', { lab: [[800, 522, 'imm (LUI)']], info: { title: 'U-immediate', text: ['LUI writes the immediate directly (`reg_src = R_IMMEDIATE`).'] } }),
    portA: W([[620, 297], [660, 297]], 'ALU port A', { vt: [664, 304, 'start'], info: { title: 'port_a' } }),
    portB: W([[620, 387], [660, 387]], 'ALU port B', { vt: [664, 380, 'start'], info: { title: 'port_b' } }),
    alu_out: W([[750, 342], [806, 342]], 'ALU result', { arrow: false, vt: [786, 329], dots: [[806, 342]], info: { title: 'ALU result', text: ['Data address, write-back value or JALR target.'] } }),
    alu_addr: W([[806, 342], [806, 300], [822, 300]], 'ALU → data address', { dots: [[806, 300]], info: { title: 'Data address', text: ['`data.address = aluif.port_out`.'] } }),
    alu_jalr: W([[806, 300], [806, 159], [890, 159]], 'ALU & ~1 → next PC', { lab: [[800, 226, 'alu & ~1', 'end']], info: { title: 'JALR target', text: ['ALU result with bit 0 cleared.'] } }),
    alu_wb: W([[806, 342], [806, 470], [1090, 470], [1090, 394], [1120, 394]], 'ALU → write-back', { lab: [[960, 464, 'alu result']], info: { title: 'ALU result → write-back' } }),
    flags: W([[710, 403], [710, 450]], 'zero, neg, overflow', { lab: [[716, 428, 'flags']], info: { title: 'ALU flags', text: ['`zero`, `neg`, `overflow`.'] } }),
    taken: W([[790, 482], [940, 482], [940, 226], [907, 226], [907, 212]], 'branch taken', { cls: 'ctl', layer: 'ctl', lab: [[946, 300, 'taken']], info: { title: 'branch_taken', text: ['With `pc_src = BRANCH`, a conditional branch selects PC+imm only when taken; JAL always does.'] } }),
    pcimm_out: W([[636, 146], [880, 146], [880, 134], [890, 134]], 'PC+imm → next PC', { lab: [[648, 140, 'pc + imm']], vt: [770, 146], info: { title: 'pc + imm', text: ['JAL and branch target.'] } }),
    next_pc: W([[914, 141], [930, 141], [930, 18], [16, 18], [16, 300], [30, 300]], 'next_pc', { lab: [[500, 13, 'next_pc']], vt: [600, 18], info: { title: 'next_pc', text: ['Loaded into PC when the instruction retires.'] } }),
    pc_in: W([[50, 320], [70, 320]], 'PC input', { info: { title: 'PC input' } }),
    rdata: W([[930, 365], [960, 365]], 'data.read_data', { vt: [924, 373, 'end'], info: { title: 'read data', text: ['Right-justified load data from the memory side.'] } }),
    wb: W([[1146, 365], [1170, 365], [1170, 548], [365, 548], [365, 400], [390, 400]], 'write-back value', { latch: true, lab: [[700, 542, 'write-back value']], vt: [1150, 420, 'start'], info: { title: 'writeback', text: ['Written to rd at the rising edge where the instruction retires.'] } }),
    // Control signals
    ctl_trunk: W([[520, 98], [530, 98], [530, 232], [1133, 232]], 'decoded controls', { cls: 'ctl', layer: 'ctl', arrow: false, info: { title: 'Decoded controls', text: ['`decode_control_t` fields from Control.'] } }),
    ctl_wen: W([[430, 130], [430, 270]], 'reg_write', { cls: 'ctl', layer: 'ctl', latch: true, lab: [[436, 256, 'reg_write']], info: { title: 'reg_write', text: ['Register write enable, ANDed with `retire`.'] } }),
    ctl_a: W([[609, 232], [609, 268]], 'alu_src_a_pc', { cls: 'ctl', layer: 'ctl', lab: [[614, 226, 'src_a']], info: { title: 'alu_src_a_pc' } }),
    ctl_b: W([[590, 232], [590, 245], [632, 245], [632, 430], [609, 430], [609, 418]], 'alu_src_b_imm', { cls: 'ctl', layer: 'ctl', lab: [[637, 346, 'src_b']], info: { title: 'alu_src_b_imm' } }),
    ctl_op: W([[700, 232], [700, 276]], 'alu_op', { cls: 'ctl', layer: 'ctl', lab: [[706, 250, 'alu_op']], info: { title: 'alu_op' } }),
    ctl_mem: W([[921, 232], [921, 280]], 'mem_read, mem_write, size', { cls: 'ctl', layer: 'ctl', lab: [[915, 246, 'r/w, size', 'end']], info: { title: 'Memory controls', text: ['`mem_read`, `mem_write`, `size`, gated by the pre-access checks.'] } }),
    ctl_wb: W([[1133, 232], [1133, 278]], 'reg_src, csr', { cls: 'ctl', layer: 'ctl', lab: [[1139, 255, 'reg_src']], info: { title: 'reg_src / csr' } }),
    ctl_pc: W([[897, 232], [897, 213]], 'pc_src, mret, halt', { cls: 'ctl', layer: 'ctl', info: { title: 'pc_src, mret, halt' } }),
    ret_pc: W([[180, 223], [99, 223], [99, 275]], 'PC write enable', { cls: 'ctl', layer: 'ctl', lab: [[104, 240, 'retire']], info: { title: 'PC write enable', text: ['PC loads on `retire` or trap entry.'] } }),
    fetch_ret: W([[200, 270], [200, 240]], 'fetch.hit', { cls: 'ctl', layer: 'ctl', info: { title: 'fetch.hit' } }),
    // Traps and CSRs
    csr_addr: W([[335, 98], [335, 52], [1000, 52], [1000, 62]], 'CSR address = instr[31:20]', { cls: 'trap', layer: 'trap', lab: [[700, 66, 'csr address [31:20]']], info: { title: 'CSR address', text: ['instr[31:20].'] } }),
    csr_opnd: W([[545, 317], [545, 210], [1020, 210], [1020, 138]], 'CSR operand (rs1 or zimm)', { cls: 'trap', layer: 'trap', dots: [[545, 317]], lab: [[628, 204, 'csr operand: rs1 or zimm']], info: { title: 'CSR operand', text: ['`rdat1`, or the 5-bit zero-extended immediate for the I forms.'] } }),
    csr_rd: W([[1070, 138], [1070, 289], [1120, 289]], 'old CSR value', { cls: 'trap', layer: 'trap', lab: [[1064, 160, 'read', 'end']], vt: [1058, 180], info: { title: 'CSR read data', text: ['Old value returned to rd.'] } }),
    mepc: W([[960, 109], [946, 109], [946, 250], [826, 250], [826, 109], [890, 109]], 'mepc → next PC', { cls: 'trap', layer: 'trap', lab: [[950, 180, 'mepc']], info: { title: 'mepc', text: ['MRET successor.'] } }),
    csr_trap: W([[1080, 100], [1180, 100]], 'mtvec, pending', { cls: 'trap', layer: 'trap', lab: [[1106, 94, 'mtvec,'], [1106, 112, 'pending']], info: { title: 'mtvec and pending interrupts' } }),
    trap_tgt: W([[1260, 62], [1260, 0], [6, 0], [6, 340], [30, 340]], 'trap_target', { cls: 'trap', layer: 'trap', lab: [[640, -4, 'trap_target, trap_enter']], info: { title: 'Trap entry', text: ['`trap_enter` loads `{mtvec[31:2],2\'b00}` (+4×cause for vectored interrupts) into PC.'] } }),
    // Memory side
    fetch_mem: W([[250, 370], [250, 600]], 'instruction request', { layer: 'mem', lab: [[256, 470, 'fetch']], info: { title: 'Instruction request', text: ['The fetch port to the memory side.'] } }),
    data_mem: W([[870, 390], [870, 600]], 'data request', { layer: 'mem', lab: [[876, 500, 'load/store']], info: { title: 'Data request' } }),
    ibeat: W([[250, 670], [250, 746], [430, 746]], 'instruction beat', { cls: 'bus', layer: 'mem', lab: [[258, 740, 'instruction channel']], vt: [330, 762], info: { title: 'Instruction channel (cache_fabric_if)', text: ['One 64-bit beat at a time; completes on the rising edge with `instruction_wait` low.'] } }),
    dbeat: W([[870, 670], [870, 746], [710, 746]], 'data beat', { cls: 'bus', layer: 'mem', lab: [[862, 740, 'data channel', 'end']], vt: [790, 762], info: { title: 'Data channel (cache_fabric_if)', text: ['One 64-bit beat at a time; read or write with a byte mask.'] } })
  };
  wires.ld_wb = W([[1060, 365], [1120, 365]], 'loaded value', { info: { title: 'Loaded value', text: ['Extended load data to the write-back selector.'] } });

  var model = {
    title: 'Singlecycle datapath',
    desc: 'Single-cycle RV32 datapath. PC drives the instruction port; decode, register read, ALU, data port and write-back all happen before one rising edge, which retires the instruction. Memory waits hold PC and state.',
    w: 1350, h: 796, y0: -16,
    layers: [{ key: 'ctl', label: 'control' }, { key: 'trap', label: 'traps & CSRs', on: false }, { key: 'mem', label: 'memory side' }],
    regions: [
      { x: 140, y: 584, w: 830, h: 196, label: 'memory side', layer: 'mem', lx: 980, ly: 600 }
    ],
    contracts: [{ id: 'cache_fabric_if', label: 'cache_fabric_if', x1: 140, x2: 960, y: 700, cx: 560, layer: 'mem' }],
    contractInfo: { cache_fabric_if: { info: { kind: 'Contract', title: 'cache_fabric_if', text: ['Blocking, non-coherent instruction and data channels from the tile to the fabric. Each carries one 64-bit beat with no IDs; a beat completes on a rising edge with wait low.'], src: ['source/contracts/interfaces/cache_fabric_if.vh'] } } },
    blocks: blocks,
    wires: wires,
    stages: [['Fetch', 250], ['Decode', 450], ['Execute', 720], ['Memory', 880], ['Write-back', 1130]],
    variants: [{ key: 'singlecycle', label: 'Cacheless', trace: 'singlecycle' }, { key: 'singlecycle_cached', label: 'Cached', trace: 'singlecycle_cached' }],
    detailHint: 'Select any block or wire for its role and RTL source. Values shown are from the recorded simulation.'
  };

  model.onVariant = function (diagram, v) {
    Object.keys(blocks).forEach(function (id) {
      if (blocks[id].variant) diagram.blocks[id].style.display = blocks[id].variant === v.key ? '' : 'none';
    });
  };

  function hex(v) { if (typeof v === 'number') v = (v >>> 0).toString(16); return '0x' + String(v).replace(/^0+(?=.)/, ''); }
  function dynAt(trace, c) {
    for (var i = 0; i < trace.dyn.length; i++) if (trace.dyn[i].cells[c] !== undefined) return trace.dyn[i];
    return null;
  }
  var COLOR = 'var(--i0)', WAIT = 'var(--wait)', HOT = 'var(--hot)';
  var DSTATE = ['idle', 'write-back low', 'write-back high', 'refill low', 'refill high', 'flush', 'clean'];
  var ALUW = { alu: 1, alui: 1, load: 1, store: 1, branch: 1, jalr: 1, auipc: 1 };
  var IMMU = { alui: 1, load: 1, store: 1, branch: 1, jal: 1, jalr: 1, lui: 1, auipc: 1 };

  // rs1/rs2 are null for an instruction without that operand; x0 is still a read.
  function reads(r) { return r !== null && r !== undefined; }

  // Lighting a wire also lights what feeds it, back to the block that drives
  // it (core-diagrams.js), so a frame names the wire ends in use, not the
  // trunks they branch from.
  model.frame = function (trace, c, variant) {
    var t = trace.cycles[c], d = dynAt(trace, t.c);
    var F = { wires: {}, blocks: {}, values: {}, tokens: [] };
    function on(id, color, hot) { F.wires[id] = { color: color || COLOR, hot: hot }; }
    function val(id, v) { F.values[id] = hex(v); }
    var cached = variant.key === 'singlecycle_cached';
    var fetchOK = t.fre && t.fhit;
    // The memory side behind a beat on either channel.
    function beats() {
      var I = cached ? 'icache' : 'adapter', D = cached ? 'dcache' : 'adapter';
      if (F.wires.ibeat && !F.blocks[I]) F.blocks[I] = { wait: true };
      if (F.wires.dbeat && !F.blocks[D]) F.blocks[D] = { wait: true };
      if (F.wires.ibeat || F.wires.dbeat) F.blocks.fabric = { on: true };
      return F;
    }
    if (t.halted) {
      F.blocks.pc = { badge: 'halted' };
      if (cached && t.dst) F.blocks.dcache = { wait: true, badge: DSTATE[t.dst] };
      if (t.bdr || t.bdw) { on('dbeat', WAIT); val('dbeat', t.bda); }
      if (t.bir) on('ibeat', WAIT);
      return beats();
    }
    if (!t.fre) { F.blocks.fetch = { badge: 'fetch off (WFI)' }; return F; }
    on('pc_fetch'); val('pc_fetch', t.pc);
    F.blocks.pc = { on: true, badge: t.ret ? 'loads ' + hex(t.npc) : 'holds' };
    if (!fetchOK) {
      F.blocks.fetch = { wait: true, badge: cached ? 'I-cache miss' : 'waits for beat' };
      on('fetch_mem', WAIT);
      if (t.bir) { on('ibeat', WAIT); val('ibeat', t.bia); }
      if (cached) F.blocks.icache = { wait: true, badge: t.ist ? 'refill ' + hex(t.bia) : 'miss' };
      else F.blocks.adapter = { wait: true, badge: 'instruction beat' };
      F.tokens.push({ x: 250, y: 395, text: 'fetch ' + hex(t.pc), color: WAIT });
      return beats();
    }
    var k = d ? d.cls : 'other';
    F.tokens.push({ x: 250, y: 395, text: d ? d.text : t.ins, color: COLOR });
    F.blocks.fetch = { on: true, badge: cached ? 'I-cache hit' : (t.saved ? 'saved' : 'beat done') };
    // The instruction comes from the cache, or from the beat that completes at this edge.
    if (cached) { on('fetch_mem'); F.blocks.icache = { on: true, badge: 'hit' }; }
    else if (t.bir) { on('fetch_mem'); on('ibeat'); val('ibeat', t.bia); F.blocks.adapter = { on: true }; }
    on('ins_ctl'); val('ins', t.ins);
    F.blocks.control = { on: true };
    on('ctl_pc'); on('fetch_ret');
    F.blocks.retire = t.ret ? { on: true, badge: 'retire' } : { wait: true, badge: 'wait' };
    if (t.ret) on('ret_pc');
    var aluUsed = !!ALUW[k], r1 = !!d && reads(d.rs1), r2 = !!d && reads(d.rs2);
    if (r1) { on('ins_rs1'); val('rdat1', t.r1); }
    if (r2) { on('ins_rs2'); val('rdat2', t.r2); }
    if (d && d.rd) on('ins_rd');
    F.blocks.rf = { on: !!(d && (r1 || r2 || d.rd)) };
    if (IMMU[k]) { on('ins_imm'); val('imm_out', t.imm); F.blocks.imm = { on: true }; }
    if (aluUsed) {
      F.blocks.alu = { on: true };
      on('ctl_op'); on('ctl_a'); on('ctl_b');
      on(t.apc ? 'pc_muxA' : 'rdat1');
      on(t.bimm ? 'imm_muxB' : 'rdat2');
      F.blocks.muxA = { on: true }; F.blocks.muxB = { on: true };
      on('portA'); val('portA', t.pa); on('portB'); val('portB', t.pb);
      val('alu_out', t.alu);
    }
    // Next PC: the selected source is drawn hot when it is not PC+4.
    var nsel = 'pc4';
    if (k === 'branch' || k === 'jal') { on('pc_right'); on('imm_out'); F.blocks.pcimm = { on: true }; on('pcimm_out'); }
    if (k === 'branch') { on('flags'); on('ins_f3'); F.blocks.br = { on: true, badge: t.tk ? 'taken' : 'not taken' }; on('taken'); if (t.tk) nsel = 'pcimm'; }
    if (k === 'jal') nsel = 'pcimm';
    if (k === 'jalr') nsel = 'jalr';
    if (k === 'mret') nsel = 'mepc';
    if (k === 'halt') nsel = 'hold';
    var link = t.rw && !t.csr && t.rsrc === 2;
    if (nsel === 'pc4' || link) { on('pc_up'); on('four'); F.blocks.add4 = { on: true }; }
    if (nsel === 'pc4') { on('pc4_top'); val('pc4_top', t.npc); }
    if (nsel === 'pcimm') { on('pcimm_out', HOT, true); val('pcimm_out', t.npc); }
    if (nsel === 'jalr') { on('alu_jalr', HOT, true); }
    if (nsel === 'mepc') { on('mepc', HOT, true); F.blocks.csr = { on: true }; }
    if (nsel === 'hold') on('pc_hold', HOT, true);
    F.blocks.pcmux = { on: true }; F.blocks.trapmux = { on: true };
    on('next_pc'); val('next_pc', t.npc); on('pc_in');
    // Memory access
    var loaded = false;
    if (t.dre || t.dwe) {
      var waiting = !t.dhit;
      on('alu_addr', waiting ? WAIT : COLOR); on('ctl_mem');
      if (t.dwe) { on('store', waiting ? WAIT : COLOR); val('store', t.dwd); }
      F.blocks.dport = { on: !waiting, wait: waiting, badge: (t.dwe ? 'store' : 'load') + (waiting ? ' · waits' : ' · done') };
      on('data_mem', waiting ? WAIT : COLOR);
      if (t.bdr || t.bdw) { on('dbeat', WAIT); val('dbeat', t.bda); }
      if (!cached) F.blocks.adapter = { wait: waiting, on: !waiting, badge: !waiting ? 'data beat done' : (t.saved ? 'data beat in flight' : 'capturing data request') };
      if (cached) F.blocks.dcache = waiting ? { wait: true, badge: DSTATE[t.dst] || 'miss' } : { on: true, badge: 'hit' };
      if (t.dre && t.dhit) { loaded = true; on('rdata'); val('rdata', t.drd); F.blocks.ldx = { on: true }; on('ld_wb'); }
    } else if (cached && t.dst) {
      F.blocks.dcache = { wait: true, badge: DSTATE[t.dst] };
      if (t.bdr || t.bdw) on('dbeat', WAIT);
    }
    // Write-back, once its source has a value: a load waits for the data.
    if (t.rw && (t.csr || t.rsrc !== 1 || loaded)) {
      on('ctl_wb'); on('ctl_wen');
      F.blocks.wbmux = { on: true };
      if (t.csr) { on('csr_rd'); val('csr_rd', t.wb); }
      else if (t.rsrc === 0) { on('alu_wb'); }
      else if (t.rsrc === 2) { on('pc4_wb'); }
      else if (t.rsrc === 3) { on('imm_wb'); }
      on('wb'); val('wb', t.wb);
      if (t.ret && t.rd) F.blocks.rf = { on: true, badge: 'x' + t.rd + ' ← ' + hex(t.wb) };
      if (t.ret && !t.rd) F.blocks.rf = { on: true, badge: 'x0: write dropped' };
    }
    if (k === 'csr') { on('csr_addr'); if (r1) on('csr_opnd'); F.blocks.csr = { on: true, badge: t.ret ? 'commit' : '' }; }
    if (k === 'wfi') F.blocks.trap = { on: true, badge: 'WFI: sleep after retire' };
    return beats();
  };

  model.isEvent = function (trace, c) { return trace.cycles[c].ret === 1 || trace.cycles[c].exc === 1; };

  var CAUSES = { 0: 'instruction address misaligned', 1: 'instruction access fault', 2: 'illegal instruction', 3: 'breakpoint', 4: 'load address misaligned', 5: 'load access fault', 6: 'store address misaligned', 7: 'store access fault', 11: 'environment call from M-mode' };
  function causeText(n) { return (CAUSES[n] || 'cause ' + n) + ' (mcause ' + n + ')'; }

  model.narrate = function (trace, c, variant) {
    var t = trace.cycles[c], d = dynAt(trace, t.c);
    var cached = variant.key === 'singlecycle_cached';
    var head = ['Cycle ' + t.c + ' · PC ' + hex(t.pc) + ' · '];
    if (t.halted) {
      var lastRetired = trace.dyn.filter(function (x) { return x.fate === 'retired'; }).pop();
      var how = lastRetired && lastRetired.cls === 'halt' ? 'Prism HALT (`0xffffffff`) retired and stops the core.' :
        'The final WFI retired with interrupts masked. The test bench’s FINISH_ON_WFI option ends the run once the D-cache is flushed; ordinary firmware would sleep until an enabled interrupt is pending.';
      return [['Cycle ' + t.c + ' · halted'], [(cached && (t.dst || t.bdw) ? 'The D-cache writes its dirty lines back to memory (' + (DSTATE[t.dst] || 'write-back') + '). ' : '') + how]];
    }
    if (d) head.push({ text: d.text, color: COLOR });
    var lines = [head];
    if (t.sleep) { lines.push(['Asleep after WFI: fetch is off until an enabled interrupt is pending. This bench raises no interrupts.']); return lines; }
    if (!t.fre) { lines.push(['Fetch is disabled.']); return lines; }
    if (t.exc) { lines.push(['Trap: ' + causeText(t.ecause) + '. The instruction does not retire; at the rising edge PC loads the trap target from mtvec, and mepc and mcause are written.']); return lines; }
    if (!t.fhit) {
      lines.push([cached ? 'I-cache miss: the cache refills the 8-byte line at `' + hex(t.bia) + '` over the instruction channel. PC, registers and memory keep their values.' :
        'Waiting for the instruction beat from the fabric (the run’s memory latency). PC, registers and memory keep their values; cycle counters still advance.']);
      return lines;
    }
    var dd = d || { cls: 'other' };
    if ((t.dre || t.dwe) && !t.dhit) {
      if (cached) {
        var st = ['idle', 'writing back the dirty victim (low beat)', 'writing back the dirty victim (high beat)', 'refilling the line (low beat)', 'refilling the line (high beat)', 'flushing', 'cleaning'][t.dst] || 'waiting';
        lines.push(['D-cache miss on ' + (t.dwe ? 'store to ' : 'load from ') + '`' + hex(t.dad) + '`: ' + st + '. The instruction cannot retire until `hit`, so PC, registers and memory keep their values.']);
      } else {
        if (!t.saved) lines.push(['The instruction beat has completed. At this rising edge the adapter saves the instruction and registers its data beat (' + (t.dwe ? 'store to ' : 'load from ') + '`' + hex(t.dad) + '`); the instruction cannot retire yet.']);
        else lines.push(['The adapter holds the saved instruction while its registered data beat (' + (t.dwe ? 'store to ' : 'load from ') + '`' + hex(t.dad) + '`) waits on the fabric. The instruction retires on the edge that completes it.']);
      }
      return lines;
    }
    var eff = [];
    if (t.ret) {
      if (t.rw && t.rd) eff.push('`x' + t.rd + '` ← `' + hex(t.wb) + '`');
      if (t.dwe) eff.push('memory[`' + hex(t.dad) + '`] ← `' + hex(t.dwd) + '`');
      eff.push('PC ← `' + hex(t.npc) + '`');
      var why = { branch: t.tk ? 'Branch taken: PC+imm.' : 'Branch not taken: PC+4.', jal: 'JAL: PC+imm, link PC+4.', jalr: 'JALR: (rs1+imm) & ~1, link PC+4.', load: 'Load: address from the ALU; data through load extension.', store: 'Store: address from the ALU, data from rs2.', lui: 'LUI: the immediate goes straight to write-back.', csr: 'CSR access: old value to rd; the write commits with retirement.', wfi: 'WFI retires, then the core sleeps until an enabled interrupt is pending.' }[dd.cls] || 'ALU result to write-back.';
      lines.push(['Retires at the next rising edge: ' + eff.join(', ') + '. ' + why]);
    }
    return lines;
  };

  model.chart = function (trace) {
    var rows = trace.dyn.map(function (d) {
      var keys = Object.keys(d.cells).map(Number), cells = {}, jump = d.retire !== undefined ? d.retire : keys[keys.length - 1];
      keys.forEach(function (k) {
        var st = d.cells[k];
        cells[k] = st === 'retire' ? { text: 'R', color: COLOR, title: 'retires' } : st === 'fetch' ? { text: 'F', color: WAIT, cls: 'stall', title: 'waiting for instruction' } : st === 'data' ? { text: 'D', color: WAIT, title: 'waiting for data' } :
          st === 'trap' ? { text: 'T', color: 'var(--hot)', title: 'trap: ' + causeText(d.cause) } : st === 'sleep' ? { text: 'z', color: 'var(--muted)', title: 'asleep after WFI' } : { text: '·', color: 'var(--muted)' };
      });
      return { pc: d.pc === null ? '' : hex(d.pc).replace('0x', ''), text: d.text + (d.fate === 'inflight' ? ' (run ended)' : ''), cells: cells, jump: jump, cls: d.fate === 'trap' ? 'trapped' : '' };
    });
    return { title: 'Instruction timeline', corner: 'instruction \\ cycle', hint: 'One instruction at a time. Select a cell or instruction to jump there.', rows: rows,
      legend: [['', 'F waiting for instruction', 'color-mix(in srgb, var(--wait) 55%, transparent)'], ['k-wait', 'D waiting for data'], ['', 'R retires at the next edge', 'var(--i0)']].concat(trace.dyn.some(function (d) { return d.fate === 'trap'; }) ? [['k-fwd', 'T trap']] : []) };
  };
  model.currentRows = function (trace, c) {
    var a = trace.cycles[c].c;
    for (var i = 0; i < trace.dyn.length; i++) if (trace.dyn[i].cells[a] !== undefined) return [i];
    return [];
  };
  model.startCycle = 11;

  window.PrismCoreDiagrams.define('singlecycle', model);
})();
