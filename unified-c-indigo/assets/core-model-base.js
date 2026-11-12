/* Base five-stage pipeline model: geometry, RTL notes and the per-cycle frame. */
(function () {
  'use strict';
  var R = 'source/core_tiles/base/rtl/';
  var DP = R + 'pipeline/datapath.sv';
  var C = 'source/core_tiles/common/rtl/pipeline/units/';

  function bar(id, x, label, text) {
    return { kind: 'bar', x: x, y: 70, w: 16, h: 740, label: '', clk: false,
      info: { kind: 'Pipeline register', title: label, text: text, src: [DP + ' · choose_stage_actions', 'source/core_tiles/common/rtl/pipeline/units/pipeline_register.sv'] } };
  }

  var blocks = {
    ifid: bar('ifid', 340, 'IF/ID', ['Holds one fetched instruction with its PC, PC+4 and prediction. It loads when fetch hits and decode can accept; a load-use or multiply-use hazard holds it; a redirect, fence, HALT, WFI or older fault invalidates it.']),
    idex: bar('idex', 730, 'ID/EX', ['Carries decoded controls, the register-file snapshot, the forwarding grants chosen in ID, the immediate, the PC-relative target and the prediction checks. A hazard sends an invalid bubble instead of the decoded instruction.', 'While EX is held behind a MEM wait, the bar re-captures the resolved operands so a departing WB value is not lost.']),
    exmem: bar('exmem', 1210, 'EX/MEM', ['Carries the ALU result, store data, resolved operands, CSR old/new values, the branch outcome the divide’s selected quotient or remainder magnitude and sign (divide_magnitude, divide_negate) and, inside the multiplier, the 64-bit product. The D-cache captures its EX tag probe at the same edge.']),
    memwb: bar('memwb', 1690, 'MEM/WB', ['Carries the final write-back value, already selected in MEM, so WB forwarding starts from a register. Loads into MEM/WB only when the MEM instruction completes.']),

    npc: { kind: 'mux', x: 60, y: 300, w: 22, h: 110,
      info: { kind: 'Selector', title: 'Next PC', text: ['`select_next_pc`: an EX redirect wins over a predicted-taken fetch, which wins over PC+4. An EX redirect uses the resolved target (taken), EX PC+4 (not taken) or the instruction PC (HALT).', '`pc_ffs` then applies priority: reset, acknowledged trap or interrupt, MRET, fence completion, WFI, and finally this selection when fetch is accepted or EX redirects.'], src: [DP + ' · select_next_pc, pc_ffs'] } },
    pc: { kind: 'reg', x: 100, y: 310, w: 56, h: 90, label: 'PC',
      info: { kind: 'State', title: 'Fetch PC', text: ['Advances when IF/ID accepts the fetch or EX redirects. An I-cache miss holds it while older stages keep draining.'], src: [DP + ' · pc_ffs'] } },
    bp: { kind: 'ctl', x: 190, y: 150, w: 130, h: 80, label: 'Predictor', sub: '16 entries\n2-bit, untagged', badgeX: 232, badgeY: 234,
      info: { kind: 'Front end', title: 'Branch predictor', text: ['Indexed by PC[5:2]. Branches 64 bytes apart share an entry, so one can train the other’s prediction. For BTYPE and JAL opcodes, a weak- or strong-taken counter predicts the learned target. JALR redirects from EX.', 'EX trains the entry when the branch advances: every resolved BTYPE/JAL writes its target and steps its 2-bit counter.'], src: [R + 'frontend/branch_pred.sv'] } },
    icache: { kind: 'mem', x: 190, y: 300, w: 130, h: 110, label: 'I-cache', sub: '16 lines × 8 B\ndirect-mapped', badgeX: 236,
      info: { kind: 'Cache', title: 'Instruction cache', text: ['128 bytes, direct-mapped, two instructions per line. A hit is combinational from the indexed tag; a miss registers one 8-byte refill on the instruction channel. A redirect during a refill lets that beat finish first.', 'FENCE.I invalidates every line after older refills drain.'], src: [R + 'caches/icache.sv', R + 'interfaces/icache_if.vh'] } },
    add4: { kind: 'add', x: 190, y: 440, w: 46, h: 56, label: '+4', tx: 4, info: { kind: 'Adder', title: 'PC + 4', text: ['Sequential fetch address; also carried in the packet for links and not-taken recovery.'], src: [DP + ' · build_ifid'] } },

    control: { kind: 'ctl', x: 400, y: 130, w: 140, h: 60, label: 'Control', sub: 'control.sv',
      info: { kind: 'Decoder', title: 'Control (decode)', text: ['Produces `decode_control_t`: ALU op and operand selects, memory read/write/size, write-back source, branch kind, CSR, multiply op, `mem_forwardable`, HALT, MRET, WFI and fence flags. Illegal encodings, including division and, in the `rv32i` variant, multiply, raise a decode exception.'], src: [R + 'pipeline/units/control.sv', R + 'packages/datapath_packets_pkg.vh'] } },
    bub: { kind: 'mux', x: 575, y: 128, w: 20, h: 64,
      info: { kind: 'Selector', title: 'Bubble insertion', text: ['On a hazard, ID/EX receives an invalid packet with cleared controls instead of the decoded instruction. IF/ID keeps the instruction for the next cycle.'], src: [DP + ' · build_idex'] } },
    rf: { kind: 'box', x: 420, y: 290, w: 150, h: 160, label: 'Register file', ty: 20,
      pins: [[426, 310, 'rs1'], [426, 340, 'rs2'], [426, 432, 'rd, value'], [564, 312, 'rdat1', 'end'], [564, 352, 'rdat2', 'end']],
      info: { kind: 'State', title: 'Register file', text: ['WB writes on the falling edge, so an instruction in ID reads the value written by WB in the same cycle. Reads use the raw rs1/rs2 fields; only packet validity decides whether they matter.'], src: [R + 'pipeline/units/register_file.sv'] } },
    imm: { kind: 'box', x: 420, y: 490, w: 130, h: 44, label: 'Immediate', sub: 'imm_gen.sv', info: { kind: 'Decoder', title: 'Immediate generator', text: ['Sign-extended immediate, used by the ALU, the target adders and the D-cache probe.'], src: [C + 'imm_gen.sv'] } },
    badd: { kind: 'add', x: 600, y: 530, w: 46, h: 56, label: '+', tx: 4,
      info: { kind: 'Adder', title: 'PC-relative target', text: ['Branch and JAL targets are added in ID and registered, away from the ALU. ID also folds the prediction into `expected_result` and flags `static_error` when a predicted-taken target differs.'], src: [DP + ' · build_idex'] } },
    hz: { kind: 'ctl', x: 420, y: 600, w: 170, h: 54, label: 'Hazard', sub: 'load · mul · div use',
      info: { kind: 'Control', title: 'Hazard unit', text: ['If the instruction in EX is a load, multiply or divide (its result completes in MEM) and the decoding instruction reads its nonzero destination, hold IF/ID and send a bubble to EX. One bubble is enough: the result then forwards from WB.'], src: [R + 'pipeline/units/hazard.sv', R + 'interfaces/hazard_if.vh'] } },
    fw: { kind: 'ctl', x: 420, y: 690, w: 170, h: 56, label: 'Forwarding', sub: 'grants for the next EX',
      info: { kind: 'Control', title: 'Forwarding unit (in ID)', text: ['Matches this instruction’s rs1/rs2 against the producers that will be in MEM and WB when it reaches EX: the current ID/EX and EX/MEM occupants. The younger producer wins. Grants are one-hot (saved, MEM or WB) and registered in ID/EX.', 'Loads and multiplies are not `mem_forwardable`; the hazard unit delays their consumers instead. x0 never matches.'], src: [R + 'pipeline/units/forwarding.sv', R + 'interfaces/forward_if.vh'] } },
    csr: { kind: 'trap', x: 600, y: 450, w: 90, h: 50, label: 'CSR file', layer: 'trap',
      info: { kind: 'State', title: 'CSR file', text: ['ID reads the old value; EX applies older in-flight CSR writes from MEM and WB to it and computes the new value. Software writes commit on the falling edge while the instruction is in WB. Trap entry and MRET update the CSRs through their own registered handoff, also on a falling edge (see Trap unit).', 'Decode traps on unimplemented CSR addresses and writes to read-only CSRs. MWBERR (0x7c0) records lost D-cache write-backs and drives interrupt 16.'], src: [R + 'pipeline/units/csr_file.sv', DP + ' · forward_old_value, calculate_write'] } },

    fwA: { kind: 'mux', x: 800, y: 305, w: 22, h: 80, pins: [[796, 314, 'rf', 'end'], [796, 339, 'mem', 'end'], [796, 364, 'wb', 'end']],
      info: { kind: 'Selector', title: 'Operand A forwarding', text: ['Applies the grant registered in ID/EX: the saved register value, the MEM bypass or the WB bypass.'], src: [DP + ' · forwarded_operand'] } },
    fwB: { kind: 'mux', x: 800, y: 420, w: 22, h: 80, pins: [[796, 429, 'rf', 'end'], [796, 454, 'mem', 'end'], [796, 479, 'wb', 'end']],
      info: { kind: 'Selector', title: 'Operand B forwarding', text: ['Same as operand A, for rs2.'], src: [DP + ' · forwarded_operand'] } },
    muxPA: { kind: 'mux', x: 870, y: 328, w: 20, h: 66, pins: [[868, 373, 'pc', 'end']], info: { kind: 'Selector', title: 'ALU port A', text: ['`alu.register_a` selects the forwarded rs1; otherwise the instruction PC (AUIPC).'], src: [DP + ' · aluif.port_a'] } },
    muxPB: { kind: 'mux', x: 870, y: 445, w: 20, h: 66, pins: [[880, 523, 'imm', 'middle']], info: { kind: 'Selector', title: 'ALU port B', text: ['`alu.immediate_b` selects the immediate; otherwise the forwarded rs2.'], src: [DP + ' · aluif.port_b'] } },
    alu: { kind: 'alu', x: 930, y: 330, w: 90, h: 180, label: 'ALU', tx: 8, info: { kind: 'Execution', title: 'ALU', text: ['Integer operations and load/store addresses. Branch comparisons and the JALR target have their own logic.'], src: [C + 'alu.sv'] } },
    br: { kind: 'ctl', x: 900, y: 150, w: 140, h: 64, label: 'Branch resolve', sub: 'branch_control.sv', badgeY: 218,
      info: { kind: 'Execution', title: 'Branch resolution', text: ['Compares the forwarded operands (equal, signed or unsigned less-than) and checks the result against the prediction prepared in ID. A wrong direction, a mismatched predicted target, or any JALR redirects fetch when the instruction leaves EX, and the younger IF/ID and ID/EX occupants are discarded.'], src: [C + 'branch_control.sv', 'source/core_tiles/common/rtl/interfaces/branch_control_if.vh', DP + ' · branch_mispredict, redirect_ex'] } },
    jadd: { kind: 'add', x: 1080, y: 162, w: 40, h: 56, label: '+', tx: 4, info: { kind: 'Adder', title: 'JALR target', text: ['Forwarded rs1 plus immediate, bit 0 cleared.'], src: [DP + ' · jalr_sum'] } },
    tmux: { kind: 'mux', x: 1140, y: 125, w: 20, h: 80, info: { kind: 'Selector', title: 'Resolved target', text: ['`branch_target_ex`: the JALR sum for JALR, otherwise the PC-relative target from ID.'], src: [DP + ' · branch_target_ex'] } },
    padd: { kind: 'add', x: 1060, y: 560, w: 46, h: 56, label: '+', tx: 4, info: { kind: 'Adder', title: 'D-cache tag probe', text: ['A separate rs1 + imm adder sends the address to the D-cache in EX. The cache captures the tag/way result as the instruction enters MEM, so MEM never recomputes tags.'], src: [DP + ' · probe_address', R + 'caches/dcache.sv · probe_registers'] } },
    mulpp: { kind: 'alu', x: 930, y: 630, w: 120, h: 80, label: 'MUL ×', tx: 8,
      info: { kind: 'Execution', title: 'Multiplier (EX)', text: ['Each forwarded operand is extended to 33 bits (its sign for a signed operand, zero otherwise), and one 33×33 signed multiply forms the 64-bit product for MUL, MULH, MULHSU and MULHU. It is captured at the EX/MEM edge, inside the multiplier.', 'On 7-series parts synthesis builds it from four DSP48E1 slices whose cascade adders sum the partial products within EX.'], src: [R + 'pipeline/units/multiplier.sv', R + 'interfaces/multiplier_if.vh'] } },

    dcache: { kind: 'mem', x: 1280, y: 420, w: 160, h: 140, label: 'D-cache', sub: '8 sets × 2 ways\n16 B lines, write-back', ty: 8, badgeX: 1344,
      info: { kind: 'Cache', title: 'Data cache', text: ['256 bytes, two-way, write-back and write-allocate, blocking. The access happens in MEM using the tag result probed in EX. A miss holds MEM, EX and ID while the cache writes back a dirty victim and refills two 64-bit beats.', 'Addresses outside cacheable RAM bypass the cache as single uncached beats. A failed refill or uncached response completes the access with `access_fault`, which becomes a precise load/store access fault in MEM. A failed write-back drops the line and is reported through MWBERR (CSR 0x7c0) and interrupt 16.'], src: [R + 'caches/dcache.sv', R + 'interfaces/dcache_if.vh'] } },
    ldx: { kind: 'box', x: 1470, y: 425, w: 84, h: 40, label: 'Extend', info: { kind: 'Datapath', title: 'Load formatting', text: ['Sign- or zero-extends byte and halfword loads.'], src: [DP + ' · format_load'] } },
    div: { kind: 'box', x: 930, y: 735, w: 120, h: 66, label: 'DIV ÷', sub: '3 bits per cycle',
      info: { kind: 'Execution', title: 'Divider (EX)', text: ['Restoring divider for DIV, DIVU, REM and REMU. The first EX cycle captures the operand magnitudes and skips the dividend’s leading zero 3-bit groups; each further cycle forms three quotient bits. The divide stays in EX for 1 + its significant groups: 2 cycles for a dividend below 8, up to 12 for one of 2^30 or more. A zero divisor finishes at capture (quotient all ones, remainder the dividend).', 'In the cycle the divide leaves EX, the divider selects the quotient or remainder and its sign; the EX/MEM edge loads both into the packet (divide_magnitude, divide_negate) with the rest of the payload. Nothing in MEM reads the divider, so the next divide can capture and iterate without touching the one in MEM.', 'A divide that enters EX directly behind a divide with the same rs1, rs2 and signedness, whose rd is neither source, reuses the stored quotient and remainder: decode sets divide_reuse, capture only selects the result and sign, and EX passes it on in one cycle. So div followed by rem on the same registers costs one extra EX cycle.', 'Negative signed dividends are counted as {~a[30:0], 1}, so they can take one cycle more than their magnitude needs. A divide removed from EX by a squash or interrupt is abandoned and recaptured when it re-executes.'], src: [R + 'pipeline/units/divider.sv', R + 'interfaces/divider_if.vh', DP + ' · divide'] } },
    divfix: { kind: 'box', x: 1300, y: 752, w: 62, h: 40, label: '±', sub: 'sign',
      info: { kind: 'Execution', title: 'Divide sign (MEM)', text: ['Negates the magnitude EX/MEM holds when its sign bit is set; quotient and remainder were chosen in EX. The result enters the write-back selector as `DIV_OUT`; like a multiply it forwards only from WB, so a dependent instruction waits one bubble.'], src: [DP + ' · build_memwb (DIV_OUT)', R + 'packages/datapath_packets_pkg.vh · divide_magnitude, divide_negate'] } },
    mulsel: { kind: 'mux', x: 1300, y: 645, w: 22, h: 50, pins: [[1296, 652, 'lo', 'end'], [1296, 676, 'hi', 'end']],
      info: { kind: 'Selector', title: 'Product half (MEM)', text: ['Selects product bits [31:0] for MUL or [63:32] for MULH, MULHSU and MULHU. The result enters the write-back selector as `MUL_OUT`, at the same point as a load, so a dependent instruction waits one bubble.'], src: [R + 'pipeline/units/multiplier.sv'] } },
    mbm: { kind: 'mux', x: 1250, y: 680, w: 18, h: 66,
      info: { kind: 'Selector', title: 'MEM bypass value', text: ['`select_mem_result`: the architectural result of the EX/MEM occupant, chosen by its write-back source: ALU result, U-immediate, PC+4 or CSR old value. Loads and multiplies are not available here; decode marks them not `mem_forwardable`.'], src: [DP + ' · select_mem_result'] } },
    rmux: { kind: 'mux', x: 1180, y: 128, w: 20, h: 92, badgeX: 1161, badgeY: 107,
      info: { kind: 'Selector', title: 'Recovery PC', text: ['By `pcSRC`: the resolved target when taken (BRANCH), the instruction’s PC+4 when not taken (CONTINUE), or its own PC for HALT (HOLD). Used only when EX redirects.', 'In the RTL this case is part of `select_next_pc` in IF; it is drawn here, next to its inputs.'], src: [DP + ' · select_next_pc'] } },
    wbmux: { kind: 'mux', x: 1590, y: 300, w: 24, h: 270, pins: [[1586, 309, 'pc+4', 'end'], [1586, 339, 'imm', 'end'], [1586, 379, 'alu', 'end'], [1586, 439, 'load', 'end'], [1586, 479, 'csr', 'end'], [1586, 519, 'div', 'end'], [1576, 542, 'mul', 'end']],
      info: { kind: 'Selector', title: 'Write-back value', text: ['Selected in MEM by `writeback.source` (ALU, load, PC+4, LUI immediate, CSR old value, multiply or divide) and registered in MEM/WB.'], src: [DP + ' · build_memwb'] } },
    wbblk: { kind: 'box', x: 1730, y: 380, w: 86, h: 80, label: 'Write-back', sub: 'falling edge',
      info: { kind: 'Stage', title: 'Write-back', text: ['A valid, fault-free MEM/WB occupant writes rd on the falling edge (CSR writes too, once). The same value is the WB bypass for EX until the instruction drains.'], src: [DP + ' · select_wb_result'] } },

    trapu: { kind: 'trap', x: 30, y: 600, w: 200, h: 60, label: 'Trap unit', sub: 'oldest exception, IRQ entry', layer: 'trap',
      info: { kind: 'Control', title: 'Traps, MRET, fence and WFI', text: ['The trap unit selects the oldest exception across stages, including a load/store access fault raised in MEM. Younger traps and MRET wait for an older data access to complete. Acceptance is registered at a rising edge, the CSR file applies entry on the falling edge, and the redirect happens at the next rising edge. Interrupts (including the write-back error interrupt 16) wait for older MEM/WB work to drain.', 'The same PC priority also handles MRET, fence completion (refetch at PC+4) and WFI.'], src: [R + 'pipeline/units/trap_unit.sv', DP + ' · trap_accept, acknowledge_trap, pc_ffs'] } },
    fence: { kind: 'trap', x: 1280, y: 120, w: 160, h: 56, label: 'Fence FSM', sub: 'clean D, invalidate I', layer: 'trap',
      info: { kind: 'Control', title: 'FENCE and FENCE.I', text: ['When a fence owns MEM: clean dirty D-cache lines, invalidate the I-cache for FENCE.I, release, then refetch the next instruction. Younger instructions are discarded.'], src: [DP + ' · instruction_fence'] } },
    fabric: { kind: 'box', x: 690, y: 1000, w: 250, h: 44, label: 'Memory fabric', sub: 'to RAM, ROM and MMIO', layer: 'mem',
      info: { kind: 'Component', title: 'Memory fabric', text: ['Arbitrates the instruction and data channels onto `system_bus_if`. Data has priority. This diagram stops at the tile boundary.'], src: ['source/memory_fabrics/direct/rtl/cache_fabric.sv'] } }
  };

  function W(pts, name, extra) { var w = { pts: pts, name: name }; Object.keys(extra || {}).forEach(function (k) { w[k] = extra[k]; }); return w; }
  var I = function (t, txt) { return { title: t, text: txt ? [].concat(txt) : undefined }; };
  var wires = {
    // IF
    pc_ic: W([[156, 355], [190, 355]], 'fetch address', { vt: [124, 412], info: I('Fetch address', 'Word-aligned PC to the I-cache and predictor.') }),
    pc_bp: W([[163, 355], [163, 175], [190, 175]], 'pc → predictor', { dots: [[163, 355]], info: I('pc → predictor') }),
    pc_add: W([[163, 355], [163, 451], [190, 451]], 'pc → +4', { info: I('pc → +4') }),
    four: W([[178, 485], [190, 485]], '4', { lab: [[175, 489, '4', 'end']], info: I('Constant 4') }),
    pc_ifid: W([[163, 451], [163, 541], [340, 541]], 'pc → IF/ID', { dots: [[163, 451]], lab: [[260, 535, 'pc']], info: I('pc', 'Carried with the instruction.') }),
    add_npc: W([[236, 468], [250, 468], [250, 520], [28, 520], [28, 315], [60, 315]], 'pc+4 → next PC', { lab: [[60, 514, 'pc + 4']], info: I('pc + 4', 'Default next fetch.') }),
    add_ifid: W([[250, 468], [340, 468]], 'pc+4 → IF/ID', { dots: [[250, 468]], info: I('pc + 4') }),
    ic_ifid: W([[320, 355], [340, 355]], 'instruction', { info: I('Instruction', 'Used only with `hit`.') }),
    ic_bp: W([[300, 300], [300, 230]], 'opcode', { lab: [[294, 268, 'opcode', 'end']], info: I('Fetched opcode', 'The predictor only predicts BTYPE and JAL opcodes.') }),
    bp_npc: W([[190, 210], [40, 210], [40, 340], [60, 340]], 'predicted target', { lab: [[84, 187, 'predicted'], [84, 199, 'target']], vt: [118, 210], info: I('Predicted target', 'From the BTB when the counter says taken.') }),
    bp_ifid: W([[320, 190], [340, 190]], 'prediction', { info: I('Prediction', 'Action and target, checked in EX.') }),
    npc_pc: W([[82, 355], [100, 355]], 'next PC', { info: I('Next PC') }),
    redirect: W([[1200, 174], [1205, 174], [1205, 90], [16, 90], [16, 365], [60, 365]], 'EX recovery PC', { lab: [[420, 84, 'recovery PC from EX']], vt: [680, 90], info: I('Recovery PC', 'Resolved target when taken, EX PC+4 when not taken, or the instruction PC for HALT.') }),
    mispredict: W([[1040, 180], [1052, 180], [1052, 110], [71, 110], [71, 304]], 'redirect', { cls: 'ctl', layer: 'ctl', lab: [[90, 104, 'redirect: mispredict or JALR']], info: I('redirect_ex', 'An advancing EX instruction that mispredicted, or any JALR. Selects the recovery PC and invalidates the two younger stages.') }),
    train: W([[970, 150], [970, 130], [255, 130], [255, 150]], 'predictor training', { cls: 'ctl', layer: 'ctl', lab: [[600, 125, 'train predictor']], info: I('Predictor update', 'Sent when the BTYPE/JAL instruction leaves EX.') }),
    // ID
    ifid_ins: W([[356, 355], [380, 355]], 'instruction', { arrow: false, info: I('Instruction') }),
    bus: W([[380, 160], [380, 705]], 'instruction fields', { arrow: false, dots: [[380, 355]], info: I('Instruction fields') }),
    ins_ctl: W([[380, 160], [400, 160]], 'opcode, funct', { info: I('opcode, funct3, funct7') }),
    ctl_bub: W([[540, 145], [575, 145]], 'decoded controls', { info: I('Decoded controls') }),
    zero: W([[560, 175], [575, 175]], 'empty packet', { lab: [[556, 179, '0', 'end']], info: I('Bubble', 'Invalid packet, controls cleared.') }),
    bub_idex: W([[595, 160], [730, 160]], 'controls', { lab: [[610, 154, 'controls']], info: I('Controls to ID/EX') }),
    ins_rs1: W([[380, 310], [420, 310]], 'rs1', { lab: [[384, 304, 'rs1']], info: I('rs1 index') }),
    ins_rs2: W([[380, 340], [420, 340]], 'rs2', { lab: [[384, 334, 'rs2']], info: I('rs2 index') }),
    ins_rd: W([[380, 270], [730, 270]], 'rd', { lab: [[620, 264, 'rd']], info: I('Destination index') }),
    bundle1: W([[356, 250], [730, 250]], 'pc, pc+4, prediction', { lab: [[396, 244, 'pc · pc+4 · prediction']], info: I('Carried fields', 'PC, PC+4 and the prediction travel with the instruction.') }),
    rdat1: W([[570, 320], [730, 320]], 'rdat1', { vt: [650, 320], info: I('rs1 value (register file)') }),
    rdat2: W([[570, 360], [705, 360], [705, 435], [730, 435]], 'rdat2', { vt: [650, 360], info: I('rs2 value (register file)') }),
    ins_imm: W([[380, 512], [420, 512]], 'instruction → immediate', { info: I('Instruction') }),
    imm_idex: W([[550, 512], [730, 512]], 'imm', { lab: [[553, 506, 'imm']], info: I('Immediate') }),
    imm_badd: W([[575, 512], [575, 575], [600, 575]], 'imm → target adder', { dots: [[575, 512]], info: I('Immediate') }),
    pc_badd: W([[356, 541], [600, 541]], 'pc → target adder', { info: I('pc') }),
    badd_out: W([[646, 558], [715, 558], [715, 140], [730, 140]], 'PC-relative target', { lab: [[651, 552, 'pc + imm']], info: I('PC-relative target', 'Branch/JAL target, registered in ID/EX.') }),
    ins_hz: W([[380, 625], [420, 625]], 'rs1, rs2 → hazard', { info: I('Source indices') }),
    ins_fw: W([[380, 705], [420, 705]], 'rs1, rs2 → forwarding', { info: I('Source indices') }),
    hz_nop: W([[585, 600], [585, 186]], 'nop_id', { cls: 'ctl', layer: 'ctl', lab: [[591, 598, 'bubble']], info: I('nop_id', 'Selects the empty packet for ID/EX.') }),
    hz_hold: W([[420, 645], [356, 645]], 'ifid_stall', { cls: 'ctl', layer: 'ctl', lab: [[392, 658, 'hold']], info: I('ifid_stall', 'Keeps the instruction in IF/ID.') }),
    hz_in: W([[736, 810], [736, 885], [690, 885], [690, 640], [590, 640]], 'EX load/multiply rd', { cls: 'ctl', layer: 'ctl', lab: [[600, 634, 'EX: load/mul/div']], info: I('EX producer', 'Destination of a load, multiply or divide now in EX.') }),
    fw_ex: W([[744, 810], [744, 900], [520, 900], [520, 746]], 'ID/EX rd', { cls: 'ctl', layer: 'ctl', lab: [[600, 895, 'ID/EX rd (next MEM)']], info: I('Producer in EX', 'Will be in MEM when the consumer reaches EX; `mem_forwardable` excludes loads and multiplies.') }),
    fw_mem: W([[1218, 810], [1218, 915], [500, 915], [500, 746]], 'EX/MEM rd', { cls: 'ctl', layer: 'ctl', lab: [[860, 910, 'EX/MEM rd (next WB)']], info: I('Producer in MEM', 'Will be in WB when the consumer reaches EX.') }),
    fw_out: W([[590, 718], [730, 718]], 'forwarding grants', { cls: 'ctl', layer: 'ctl', lab: [[600, 712, 'grants']], info: I('Grants', 'One-hot per operand: saved, MEM or WB.') }),
    csr_addr: W([[380, 470], [600, 470]], 'CSR address', { cls: 'trap', layer: 'trap', lab: [[440, 464, 'csr']], info: I('CSR address') }),
    csr_rd: W([[690, 475], [730, 475]], 'CSR old value', { cls: 'trap', layer: 'trap', info: I('CSR old value') }),
    // EX
    bundle2: W([[746, 250], [1210, 250]], 'pc, pc+4, imm, controls', { lab: [[981, 264, 'pc · pc+4 · imm · controls']], info: I('Carried fields') }),
    alu_op: W([[975, 250], [975, 355]], 'alu op', { cls: 'ctl', layer: 'ctl', dots: [[975, 250]], lab: [[981, 300, 'alu op']], info: I('ALU operation', '`aluif.op = idex_r.control.alu.op`: decoded in ID and carried in ID/EX. Selects add, subtract, shift, logic or set-less-than.') }),
    rd2: W([[746, 270], [1210, 270]], 'rd', { lab: [[1170, 264, 'rd']], info: I('Destination index') }),
    sv_a: W([[746, 320], [800, 320]], 'saved rs1', { info: I('Saved rs1', 'Register-file snapshot from ID.') }),
    sv_b: W([[746, 435], [800, 435]], 'saved rs2', { info: I('Saved rs2') }),
    gA: W([[746, 290], [811, 290], [811, 309]], 'grant A', { cls: 'ctl', layer: 'ctl', info: I('Grant for rs1') }),
    gB: W([[746, 405], [811, 405], [811, 424]], 'grant B', { cls: 'ctl', layer: 'ctl', info: I('Grant for rs2') }),
    memB: W([[1268, 713], [1280, 713], [1280, 832], [768, 832], [768, 345], [800, 345]], 'MEM bypass', { lab: [[880, 827, 'MEM bypass']], info: I('MEM bypass', 'Architectural result of the EX/MEM occupant (ALU, imm, PC+4 or CSR). Loads and multiplies are excluded; their consumers wait one bubble.') }),
    mb_alu: W([[1226, 690], [1250, 690]], 'ALU → MEM bypass', { info: I('ALU result') }),
    mb_imm: W([[1226, 704], [1250, 704]], 'imm → MEM bypass', { info: I('U-immediate') }),
    mb_pc4: W([[1226, 718], [1250, 718]], 'pc+4 → MEM bypass', { info: I('PC + 4') }),
    mb_csr: W([[1226, 732], [1250, 732]], 'CSR → MEM bypass', { info: I('CSR old value') }),
    memB2: W([[768, 460], [800, 460]], 'MEM bypass → B', { dots: [[768, 460]], info: I('MEM bypass') }),
    wbB: W([[1773, 848], [758, 848], [758, 370], [800, 370]], 'WB bypass', { dots: [[1773, 848]], lab: [[1020, 843, 'WB bypass']], info: I('WB bypass', 'The value WB is writing this cycle.') }),
    wbB2: W([[758, 485], [800, 485]], 'WB bypass → B', { dots: [[758, 485]], info: I('WB bypass') }),
    opA: W([[822, 345], [870, 345]], 'operand A', { vt: [824, 316, 'start'], info: I('Forwarded rs1') }),
    opB: W([[822, 460], [870, 460]], 'operand B', { vt: [824, 432, 'start'], info: I('Forwarded rs2') }),
    pcA: W([[774, 250], [774, 398], [858, 398], [858, 380], [870, 380]], 'pc → port A', { dots: [[774, 250]], info: I('pc', 'For AUIPC.') }),
    immB: W([[746, 512], [858, 512], [858, 500], [870, 500]], 'imm → port B', { info: I('imm') }),
    pA: W([[890, 361], [930, 361]], 'port A', { info: I('port_a') }),
    pB: W([[890, 478], [930, 478]], 'port B', { info: I('port_b') }),
    alu_out: W([[1020, 420], [1210, 420]], 'ALU result', { vt: [1110, 420], info: I('ALU result', 'Address for loads/stores or the integer result.') }),
    opA_up: W([[840, 345], [840, 240]], 'forwarded rs1', { arrow: false, dots: [[840, 345]], info: I('Forwarded rs1', 'To branch comparison and the JALR adder.') }),
    opA_br: W([[840, 240], [840, 178], [900, 178]], 'rs1 → branch', { info: I('Forwarded rs1') }),
    opB_br: W([[850, 460], [850, 200], [900, 200]], 'rs2 → branch', { dots: [[850, 460]], info: I('Forwarded rs2') }),
    opA_j: W([[840, 240], [1062, 240], [1062, 172], [1080, 172]], 'rs1 → JALR adder', { dots: [[840, 240]], info: I('Forwarded rs1') }),
    imm_j: W([[1072, 250], [1072, 208], [1080, 208]], 'imm → JALR adder', { dots: [[1072, 250]], info: I('imm', 'The immediate field of the ID/EX bundle.') }),
    j_out: W([[1120, 190], [1140, 190]], 'JALR target', { info: I('JALR target') }),
    t_r: W([[1160, 165], [1168, 165], [1168, 145], [1180, 145]], 'resolved target', { info: I('branch_target_ex', 'JALR sum or the PC-relative target.') }),
    pc4_r: W([[1164, 250], [1164, 175], [1180, 175]], 'EX pc+4 → recovery', { info: I('EX PC+4', 'Recovery for a not-taken branch that was predicted taken.') }),
    pc_r: W([[1172, 250], [1172, 205], [1180, 205]], 'EX pc → recovery', { info: I('EX PC', 'HALT holds its own PC.') }),
    pcsrc: W([[1040, 170], [1046, 170], [1046, 104], [1190, 104], [1190, 131]], 'pcSRC', { cls: 'ctl', layer: 'ctl', lab: [[1084, 117, 'pcSRC']], info: I('pcSRC', 'BRANCH when taken, CONTINUE when not, HOLD for HALT.') }),
    tgt_id: W([[746, 140], [1140, 140]], 'PC-relative target', { lab: [[752, 153, 'pc + imm']], info: I('PC-relative target') }),
    opA_dn: W([[840, 345], [840, 571], [1060, 571]], 'rs1 → probe adder', { info: I('Forwarded rs1') }),
    imm_p: W([[746, 605], [1060, 605]], 'imm → probe adder', { info: I('imm') }),
    probe: W([[1106, 588], [1300, 588], [1300, 560]], 'tag probe address', { lab: [[1120, 582, 'tag probe']], vt: [1170, 600], info: I('probe_address', 'rs1 + imm, looked up in EX; the hit/way result is captured as the packet enters MEM.') }),
    opA_mv: W([[840, 571], [840, 655]], 'forwarded rs1', { arrow: false, dots: [[840, 571]], info: I('Forwarded rs1', 'To the multiplier and divider.') }),
    opB_mv: W([[850, 460], [850, 685]], 'forwarded rs2', { arrow: false, info: I('Forwarded rs2', 'To the multiplier and divider.') }),
    opA_m: W([[840, 655], [930, 655]], 'rs1 → multiplier', { info: I('Forwarded rs1') }),
    opB_m: W([[850, 685], [930, 685]], 'rs2 → multiplier', { info: I('Forwarded rs2') }),
    opA_d: W([[840, 655], [840, 752], [930, 752]], 'rs1 → divider', { dots: [[840, 655]], info: I('Dividend', 'Forwarded rs1, sampled in the capture cycle.') }),
    opB_d: W([[850, 685], [850, 784], [930, 784]], 'rs2 → divider', { dots: [[850, 685]], info: I('Divisor', 'Forwarded rs2, sampled in the capture cycle.') }),
    div_hold: W([[1050, 745], [1210, 745]], 'divide_hold', { cls: 'ctl', layer: 'ctl', lab: [[1150, 739, 'hold']], info: I('divide_hold', 'Keeps the divide in EX: EX/MEM captures no copy (MEM gets a bubble), ID/EX holds, and an occupied IF/ID slot holds. An empty IF/ID slot may still take a fetch.') }),
    div_x: W([[1050, 772], [1210, 772]], 'selected result', { lab: [[1056, 788, 'q/r, sign']], vt: [1160, 772], info: I('Selected divide result', 'The quotient or remainder magnitude and its sign bit, selected in EX in the cycle the divide leaves. The divider drives them as transfer_magnitude and transfer_negate; the EX/MEM edge loads them into the packet’s divide_magnitude and divide_negate.') }),
    div_m: W([[1226, 772], [1300, 772]], 'divide_magnitude, divide_negate', { info: I('divide_magnitude, divide_negate', 'The divide’s result as the EX/MEM packet holds it. It loads with the rest of the payload, so a later divide in EX cannot change it.') }),
    div_wb: W([[1362, 772], [1580, 772], [1580, 525], [1590, 525]], 'divide result', { vt: [1500, 772], info: I('Divide result', 'Quotient or remainder with its sign restored.') }),
    store: W([[850, 530], [1210, 530]], 'store data', { dots: [[850, 530]], lab: [[1100, 524, 'store data']], info: I('Store data', 'Forwarded rs2.') }),
    pp: W([[1050, 670], [1210, 670]], '64-bit product', { lab: [[1090, 664, '64-bit product']], info: I('64-bit product', 'Captured at the EX/MEM edge inside the multiplier.') }),
    csr_ex: W([[746, 620], [1210, 620]], 'CSR old/new value', { cls: 'trap', layer: 'trap', lab: [[1100, 616, 'csr values']], info: I('CSR values', 'Old value after forwarding, and the computed write value.') }),
    // MEM
    bundle3: W([[1226, 250], [1556, 250], [1556, 315], [1590, 315]], 'pc+4', { lab: [[1240, 244, 'pc+4 · imm']], info: I('pc + 4', 'Link value for JAL/JALR.') }),
    imm_wb: W([[1544, 250], [1544, 345], [1590, 345]], 'imm (LUI)', { dots: [[1544, 250]], info: I('U-immediate (LUI)') }),
    alu_m: W([[1226, 420], [1250, 420], [1250, 385], [1590, 385]], 'ALU result → write-back', { info: I('ALU result') }),
    d_addr: W([[1250, 420], [1250, 440], [1280, 440]], 'D-cache address', { dots: [[1250, 420]], vt: [1286, 440, 'start'], info: I('Data address') }),
    d_wd: W([[1226, 530], [1265, 530], [1265, 480], [1280, 480]], 'store data', { info: I('Store data') }),
    d_rd: W([[1440, 445], [1470, 445]], 'read data', { vt: [1434, 446, 'end'], info: I('Read data') }),
    ld_wb: W([[1554, 445], [1590, 445]], 'loaded value', { info: I('Loaded value') }),
    csr_wb: W([[1226, 620], [1554, 620], [1554, 485], [1590, 485]], 'CSR old value → write-back', { cls: 'trap', layer: 'trap', info: I('CSR old value') }),
    pp_m: W([[1226, 670], [1280, 670], [1280, 658], [1300, 658]], 'product [31:0]', { info: I('Product bits [31:0]') }),
    pp_h: W([[1280, 670], [1280, 682], [1300, 682]], 'product [63:32]', { dots: [[1280, 670]], info: I('Product bits [63:32]') }),
    mul_wb: W([[1322, 670], [1570, 670], [1570, 549], [1590, 549]], 'multiply result', { vt: [1500, 670], info: I('Multiply result', 'The selected 32-bit half.') }),
    wb_out: W([[1614, 420], [1690, 420]], 'write-back value', { vt: [1652, 406], info: I('Write-back value', 'Registered in MEM/WB.') }),
    stall: W([[1420, 420], [1420, 215], [1226, 215]], 'mem_stall', { cls: 'ctl', layer: 'ctl', lab: [[1240, 209, 'miss: hold MEM, EX, ID']], info: I('mem_stall', 'An unfinished data access or fence holds MEM; EX and ID wait. WB still drains.') }),
    // WB
    wb_in: W([[1706, 420], [1730, 420]], 'MEM/WB value', { info: I('MEM/WB value') }),
    wb_rf: W([[1773, 460], [1773, 864], [368, 864], [368, 420], [420, 420]], 'register write', { lab: [[1030, 859, 'rd ← value (falling edge)']], vt: [1773, 600], info: I('Register write', 'Falling edge, so ID reads it in the same cycle.') }),
    // traps
    trap_npc: W([[48, 600], [48, 390], [60, 390]], 'trap/MRET/fence/WFI target', { cls: 'trap', layer: 'trap', lab: [[52, 590, 'trap · mret · fence · wfi']], info: I('Priority redirect', 'Applied in `pc_ffs` ahead of the normal next PC.') }),
    exc: W([[1698, 810], [1698, 930], [130, 930], [130, 660]], 'stage exceptions', { cls: 'trap', layer: 'trap', lab: [[860, 926, 'exceptions from ID, EX, MEM, WB']], info: I('Stage exceptions', 'Each packet carries its own exception; the oldest wins. MEM adds a load/store access fault when the D-cache completes the access with `access_fault`.') }),
    // memory side
    ibeat: W([[255, 410], [255, 1022], [690, 1022]], 'instruction channel', { cls: 'bus', layer: 'mem', lab: [[262, 1016, 'instruction channel']], vt: [450, 1034], info: I('Instruction channel (cache_fabric_if)', 'One 8-byte refill beat at a time.') }),
    dbeat: W([[1400, 560], [1400, 1022], [940, 1022]], 'data channel', { cls: 'bus', layer: 'mem', lab: [[1394, 1016, 'data channel', 'end']], vt: [1150, 1034], info: I('Data channel (cache_fabric_if)', 'Refill and write-back beats, or one uncached beat.') })
  };

  var model = {
    title: 'Base five-stage pipeline',
    desc: 'Base pipeline: IF with I-cache and branch predictor; ID with decode, register read, hazard and forwarding units; EX with forwarding selectors, ALU, branch resolution, D-cache tag probe and the multiplier forming the full 64-bit product, captured at EX/MEM; MEM with D-cache access, selection of the product half and write-back selection; WB writing the register file on the falling edge.',
    w: 1850, h: 1070,
    layers: [{ key: 'ctl', label: 'control' }, { key: 'trap', label: 'traps & CSRs', on: false }, { key: 'mem', label: 'memory side' }],
    heads: [[165, 22, 'IF'], [543, 22, 'ID'], [978, 22, 'EX'], [1458, 22, 'MEM'], [1773, 22, 'WB'], [348, 62, 'IF/ID'], [738, 62, 'ID/EX'], [1218, 62, 'EX/MEM'], [1698, 62, 'MEM/WB']],
    regions: [{ x: 140, y: 950, w: 1400, h: 110, label: 'memory side', layer: 'mem', lx: 1550, ly: 970 }],
    contracts: [{ id: 'cache_fabric_if', label: 'cache_fabric_if', x1: 140, x2: 1540, y: 975, cx: 815, layer: 'mem' }],
    contractInfo: { cache_fabric_if: { info: { kind: 'Contract', title: 'cache_fabric_if', text: ['Blocking, non-coherent instruction and data channels from the tile to the fabric. Each carries one 64-bit beat with no IDs; a beat completes on a rising edge with wait low.'], src: ['source/contracts/interfaces/cache_fabric_if.vh'] } } },
    blocks: blocks,
    wires: wires,
    stages: [['IF', 165], ['ID', 543], ['EX', 978], ['MEM', 1458], ['WB', 1740]],
    variants: [{ key: 'base', label: 'Base', trace: 'base' }],
    detailHint: 'Select any block or wire for its role and RTL source. Each instruction keeps one colour as it moves through the stages.'
  };

  function hex(v) { if (typeof v === 'number') v = (v >>> 0).toString(16); return '0x' + String(v).replace(/^0+(?=.)/, ''); }
  var PAL = ['var(--i0)', 'var(--i1)', 'var(--i2)', 'var(--i3)', 'var(--i4)', 'var(--i5)'];
  function col(d) { return PAL[d.id % PAL.length]; }
  var HOT = 'var(--hot)', WAIT = 'var(--wait)';
  var STAGE_X = { if: 165, id: 543, ex: 978, mem: 1458, wb: 1773 };
  var WB_SRC = { alu: 'alu', alui: 'alu', auipc: 'alu', load: 'load', jal: 'pc4', jalr: 'pc4', lui: 'imm', csr: 'csr', mul: 'mul', div: 'div' };
  var USES_IMM = { alui: 1, load: 1, store: 1, branch: 1, jal: 1, jalr: 1, lui: 1, auipc: 1 };
  var DSTATE = ['idle', 'writing back (low beat)', 'writing back (high beat)', 'refilling (low beat)', 'refilling (high beat)', 'flushing', 'cleaning'];
  var DBADGE = ['idle', 'write-back, low beat', 'write-back, high beat', 'refill, low beat', 'refill, high beat', 'flushing', 'cleaning'];
  // rs1/rs2 are null for an instruction without that operand; x0 is still a read.
  function reads(r) { return r !== null && r !== undefined; }

  // Groups a divide iterates after its capture cycle: its EX cycles minus one.
  function divGroups(d) {
    var n = 0;
    Object.keys(d.cells).forEach(function (k) { if (d.cells[k] === 'ex') n++; });
    return Math.max(0, n - 1);
  }

  function fetchDyn(trace, c) {
    for (var i = 0; i < trace.dyn.length; i++) if (trace.dyn[i].cells[c] === 'if') return trace.dyn[i];
    return null;
  }

  // Lighting a wire also lights what feeds it, back to the block that drives
  // it (core-diagrams.js), so a frame names the wire ends in use, not the
  // trunks they branch from.
  model.frame = function (trace, c) {
    var t = trace.cycles[c], ev = t.ev, v = t.v, dyn = trace.dyn;
    var F = { wires: {}, blocks: {}, values: {}, tokens: [] };
    function on(id, color, hot) { F.wires[id] = { color: color, hot: hot }; }
    function val(id, x) { F.values[id] = hex(x); }
    function blk(id, o) { F.blocks[id] = o; }
    var S = {};
    ['id', 'ex', 'mem', 'wb'].forEach(function (k) { S[k] = t.slots[k] === null || t.slots[k] === undefined ? null : dyn[t.slots[k]]; });
    var fd = fetchDyn(trace, t.c);
    // Stage tokens
    function token(stage, d, extra) {
      if (!d) { F.tokens.push({ x: STAGE_X[stage], y: 38, text: '—', bubble: true, minw: 40 }); return; }
      var strike = (d.fate === 'squashed' || d.fate === 'trap') && d.left === t.c && d.left_stage === stage;
      F.tokens.push({ x: STAGE_X[stage], y: 38, text: d.text + (extra || '') + (strike && d.fate === 'trap' ? ' · trap' : ''), color: col(d), strike: strike });
    }
    if (fd) token('if', fd);
    else if (ev.if !== 'off') F.tokens.push({ x: STAGE_X.if, y: 38, text: 'fetch ' + hex(t.pc) + (ev.redirect ? ' · discarded' : ' · waits'), bubble: true });
    else F.tokens.push({ x: STAGE_X.if, y: 38, text: 'fetch off', bubble: true });
    token('id', S.id);
    if (!S.ex && c > 0 && trace.cycles[c - 1].ev.bubble) F.tokens.push({ x: STAGE_X.ex, y: 38, text: 'bubble', bubble: true, minw: 60 });
    else token('ex', S.ex);
    token('mem', S.mem);
    token('wb', S.wb);

    // IF: cache state comes from recorded signals, whether or not this fetch survives.
    if (ev.if !== 'off') {
      var fc = fd ? col(fd) : 'var(--muted)';
      on('pc_ic', fc); val('pc_ic', t.pc);
      blk('pc', { on: true, badge: t.pcen ? 'next ' + hex(t.npc) : 'holds' });
      if (ev.if === 'miss') {
        var busy = ev.refill && (parseInt(ev.refill, 16) >>> 3) !== (parseInt(t.pc, 16) >>> 3);
        blk('icache', { wait: true, badge: busy ? 'busy: older refill' : 'miss: refill' });
        if (ev.refill) { on('ibeat', WAIT); val('ibeat', ev.refill); }
      } else {
        blk('icache', { on: true, badge: fd ? 'hit' : (ev.redirect ? 'hit · discarded' : 'hit · held') });
        on('ic_ifid', fc); on('pc_bp', fc); on('ic_bp', fc); on('pc_add', fc); on('four', fc); on('pc_ifid', fc); on('add_ifid', fc); on('bp_ifid', fc);
        blk('bp', { on: true, badge: ev.pred ? 'taken → ' + hex(v.bpt) : '' });
        blk('add4', { on: true });
      }
    } else if (ev.if === 'off') {
      blk('icache', { badge: 'fetch off' });
    }
    if (ev.refill && ev.if !== 'miss') { on('ibeat', WAIT); val('ibeat', ev.refill); blk('icache', { wait: true, badge: 'refill finishing' }); }
    // Next-PC selection
    if (ev.redirect) {
      on('redirect', HOT, true); val('redirect', t.npc); on('mispredict', HOT, true); on('npc_pc', HOT); blk('npc', { on: true });
      on(t.pcsrc === 1 ? 't_r' : t.pcsrc === 2 ? 'pc_r' : 'pc4_r', HOT, true); on('pcsrc', HOT, true);
      blk('rmux', { on: true, badge: t.pcsrc === 1 ? 'target' : t.pcsrc === 2 ? 'own PC' : 'PC+4' });
    } else if (t.pcen) {
      var fcol = fd ? col(fd) : 'var(--ink)';
      if (ev.pred) { on('bp_npc', fcol, true); val('bp_npc', v.bpt); } else on('add_npc', fcol);
      on('npc_pc', fcol); blk('npc', { on: true });
    }

    // ID
    var d = S.id;
    if (d) {
      var dc = col(d), r1 = reads(d.rs1), r2 = reads(d.rs2);
      on('ins_ctl', dc); on('bundle1', dc); blk('control', { on: true });
      if (ev.bubble) {
        on('zero', HOT, true); on('bub_idex', HOT, true); on('hz_nop', HOT, true); on('hz_hold', HOT, true); on('hz_in', HOT, true); on('ins_hz', dc);
        blk('hz', { on: true, badge: 'stall: bubble to EX' }); blk('bub', { on: true });
      } else {
        on('ctl_bub', dc); on('bub_idex', dc); blk('bub', { on: true });
      }
      if (r1) { on('ins_rs1', dc); on('rdat1', dc); }
      if (r2) { on('ins_rs2', dc); on('rdat2', dc); }
      if (d.rd) on('ins_rd', dc);
      blk('rf', { on: r1 || r2 });
      if (USES_IMM[d.cls]) { on('ins_imm', dc); on('imm_idex', dc); blk('imm', { on: true }); }
      if (d.cls === 'branch' || d.cls === 'jal') { on('pc_badd', dc); on('imm_badd', dc); on('badd_out', dc); blk('badd', { on: true }); }
      var g = t.grants;
      var gfx = [];
      if (d.rs1 && g[0] !== '100') gfx.push('rs1 ← ' + (g[0] === '010' ? 'MEM' : 'WB'));
      if (d.rs2 && g[1] !== '100') gfx.push('rs2 ← ' + (g[1] === '010' ? 'MEM' : 'WB'));
      if (r1 || r2) { on('ins_fw', dc); on('fw_out', dc); blk('fw', { on: true, badge: gfx.join(', ') }); if (gfx.length) { on('fw_ex', dc); on('fw_mem', dc); } }
      if (d.cls === 'csr') { on('csr_addr', dc); on('csr_rd', dc); blk('csr', { on: true }); }
    }

    // EX
    var e = S.ex;
    if (e) {
      var ec = col(e), k = e.cls, dv = ev.div || {};
      on('bundle2', ec); if (e.rd) on('rd2', ec);
      // Forwarding selectors: the grant picks the saved value or a bypass. A
      // divide samples its operands only in its capture cycle.
      var sampled = k !== 'div' || dv.state === 'idle';
      function operand(which, how) {
        var A = which === 'A';
        if (how === 'mem') on(A ? 'memB' : 'memB2', HOT, true);
        else if (how === 'wb') on(A ? 'wbB' : 'wbB2', HOT, true);
        else on(A ? 'sv_a' : 'sv_b', ec);
        on(A ? 'gA' : 'gB', ec);
        blk(A ? 'fwA' : 'fwB', { on: true });
        val(A ? 'opA' : 'opB', A ? v.opa : v.opb);
      }
      if (sampled && reads(e.rs1)) operand('A', ev.fwdA);
      if (sampled && reads(e.rs2)) operand('B', ev.fwdB);
      if ((ev.fwdA === 'mem' || ev.fwdB === 'mem') && S.mem && sampled) {
        var ms = WB_SRC[S.mem.cls];
        on({ alu: 'mb_alu', imm: 'mb_imm', pc4: 'mb_pc4', csr: 'mb_csr' }[ms] || 'mb_alu', HOT, true);
        blk('mbm', { on: true });
      }
      if (k === 'alu' || k === 'alui' || k === 'auipc' || k === 'load' || k === 'store') {
        blk('alu', { on: true }); on('alu_op');
        on(k === 'auipc' ? 'pcA' : 'opA', ec);
        on(k === 'alu' ? 'opB' : 'immB', ec);
        blk('muxPA', { on: true }); blk('muxPB', { on: true });
        on('pA', ec); on('pB', ec); on('alu_out', ec); val('alu_out', v.alu);
      }
      if (k === 'branch' || k === 'jal' || k === 'jalr') {
        if (k === 'branch') { on('opA_br', ec); on('opB_br', ec); }
        var verdict = ev.redirect ? (k === 'jalr' ? 'JALR: redirect' : 'mispredicted') : (ev.exfire ? 'as predicted' : 'held');
        blk('br', { on: true, badge: (k === 'branch' ? (ev.taken ? 'taken, ' : 'not taken, ') : '') + verdict });
        // The resolved target matters only when fetch is redirected to it.
        var toTarget = ev.redirect && t.pcsrc === 1;
        if (k === 'jalr') { on('opA_j', ec); on('imm_j', ec); on('j_out', ec); blk('jadd', { on: true }); blk('tmux', { on: true }); }
        else if (toTarget) { on('tgt_id', ec); blk('tmux', { on: true }); }
        if (ev.exfire && k !== 'jalr') {
          on('train', ec);
          if (!F.blocks.bp || !F.blocks.bp.on) blk('bp', { on: true, badge: 'trained' });
        }
      }
      if (k === 'load' || k === 'store') {
        on('opA_dn', ec); on('imm_p', ec); on('probe', ec); val('probe', v.pra); blk('padd', { on: true });
        blk('dcache', { on: true, badge: 'tag probe' });
      }
      if (k === 'store') on('store', ec);
      if (k === 'mul') { on('opA_m', ec); on('opB_m', ec); on('pp', ec); blk('mulpp', { on: true }); }
      if (k === 'div') {
        var groups = divGroups(e);
        if (dv.state === 'idle') { on('opA_d', ec); on('opB_d', ec); }
        blk('div', { on: true, badge: dv.state === 'idle' && dv.reuse ? 'reuse · ' + (/^rem/.test(e.text) ? 'remainder' : 'quotient') : dv.state === 'idle' ? (dv.hold ? 'capture · ' + groups + (groups === 1 ? ' group' : ' groups') : 'capture · done') :
          dv.state === 'busy' ? 'group ' + (groups - dv.left + 1) + ' of ' + groups : 'done · waiting' });
        if (dv.hold) on('div_hold', HOT, true);
        if (ev.exfire) { on('div_x', ec); if (v.dvt !== undefined) val('div_x', v.dvt); }
      }
      if (k === 'csr') on('csr_ex', ec);
    }

    // MEM
    var m = S.mem;
    if (m) {
      var mc = col(m), src = WB_SRC[m.cls];
      if (m.cls === 'load' || m.cls === 'store') {
        var waiting = ev.mem_stall;
        on('d_addr', waiting ? WAIT : mc); val('d_addr', v.dad);
        if (m.cls === 'store') { on('d_wd', waiting ? WAIT : mc); }
        blk('dcache', waiting ? { wait: true, badge: (ev.dstate ? DBADGE[ev.dstate] : 'miss') } : { on: true, badge: 'hit' });
        if (waiting) { on('stall', WAIT, true); }
        if (m.cls === 'load' && !waiting) { on('d_rd', mc); val('d_rd', v.drd); on('ld_wb', mc); blk('ldx', { on: true }); }
        if (ev.dbus) { on('dbeat', WAIT); }
      }
      if (src === 'alu') on('alu_m', mc);
      if (src === 'pc4') on('bundle3', mc);
      if (src === 'imm') on('imm_wb', mc);
      if (src === 'csr') on('csr_wb', mc);
      if (src === 'mul') { var low = /^mul /.test(m.text); on(low ? 'pp_m' : 'pp_h', mc); on('mul_wb', mc); val('mul_wb', v.mul); blk('mulsel', { on: true, badge: low ? 'low word' : 'high word' }); }
      if (src === 'div') { on('div_m', mc); if (v.dvm !== undefined) val('div_m', v.dvm); on('div_wb', mc); val('div_wb', v.memwbn); blk('divfix', { on: true, badge: ev.div && ev.div.mneg ? 'negate' : 'no change' }); }
      if (src && !(m.cls === 'load' && ev.mem_stall)) { on('wb_out', mc); val('wb_out', v.memwbn); blk('wbmux', { on: true }); }
    } else if (ev.dbus) {
      on('dbeat', WAIT); blk('dcache', { wait: true, badge: DBADGE[ev.dstate] || 'busy' });
    }

    // WB
    var w = S.wb;
    if (w) {
      var wc = col(w);
      on('wb_in', wc); blk('wbblk', { on: true });
      if (ev.wb_write) {
        on('wb_rf', wc); val('wb_rf', ev.wb_write[1]);
        var rfb = ev.wb_write[0] ? 'x' + ev.wb_write[0] + ' ← ' + hex(ev.wb_write[1]) : 'x0: dropped';
        F.blocks.rf = { on: true, badge: rfb };
      }
    }
    if (F.wires.ibeat || F.wires.dbeat) blk('fabric', { on: true });
    return F;
  };

  var CAUSES = { 0: 'instruction address misaligned', 1: 'instruction access fault', 2: 'illegal instruction', 3: 'breakpoint', 4: 'load address misaligned', 5: 'load access fault', 6: 'store address misaligned', 7: 'store access fault', 11: 'environment call from M-mode' };
  function causeText(n) { return (CAUSES[n] || 'cause ' + n) + ' (mcause ' + n + ')'; }

  model.isEvent = function (trace, c) {
    var ev = trace.cycles[c].ev, p = c > 0 ? trace.cycles[c - 1].ev : {};
    return !!ev.trap || ev.redirect || ev.bubble || ev.fwdA === 'mem' || ev.fwdA === 'wb' || ev.fwdB === 'mem' || ev.fwdB === 'wb' ||
      (ev.mem_stall && !p.mem_stall) || (ev.if === 'miss' && p.if !== 'miss') || ev.pred || divEvent(trace, c);
  };
  // A divide's capture cycle and the cycle it leaves EX.
  // Why a divide on the same registers as the one ahead did not reuse its
  // result: that divide wrote one of the sources (decode's divide_reuse rule).
  function noReuse(e, m, w) {
    var p = m ? m : w;
    if (!p || p.cls !== 'div' || p.rs1 !== e.rs1 || p.rs2 !== e.rs2 || (p.rd !== e.rs1 && p.rd !== e.rs2)) return '';
    return ' It cannot reuse the result of `' + p.text + '`: that divide overwrote `x' + p.rd + '`, so the operands differ' + (p === w ? ', and the new value reaches EX only from WB, after one bubble.' : '.');
  }

  function divEvent(trace, c) {
    var t = trace.cycles[c], ex = t.slots.ex === null || t.slots.ex === undefined ? null : trace.dyn[t.slots.ex];
    return !!(ex && ex.cls === 'div' && t.ev.div && (t.ev.div.state === 'idle' || t.ev.exfire));
  };

  function tx(d) { return d ? d.text : ''; }
  model.narrate = function (trace, c) {
    var t = trace.cycles[c], ev = t.ev, dyn = trace.dyn;
    var S = {};
    ['id', 'ex', 'mem', 'wb'].forEach(function (k) { S[k] = t.slots[k] === null || t.slots[k] === undefined ? null : dyn[t.slots[k]]; });
    var fd = fetchDyn(trace, t.c);
    var lines = [];
    var head = ['Cycle ' + t.c + ' · '];
    var any = false;
    [['IF', fd], ['ID', S.id], ['EX', S.ex], ['MEM', S.mem], ['WB', S.wb]].forEach(function (p) {
      if (p[1]) { head.push(p[0] + ' '); head.push({ text: p[1].text, color: col(p[1]) }); any = true; }
    });
    if (!any) head.push('pipeline empty');
    lines.push(head);
    var say = [];
    var e = S.ex, m = S.mem, w = S.wb, d = S.id;
    if (ev.trap) {
      var faulting = ev.trap.stage === 'if' ? null : S[ev.trap.stage];
      say.push('Trap: ' + (faulting ? '`' + faulting.text + '` in ' + ev.trap.stage.toUpperCase() : 'the fetch at `' + hex(t.pc) + '`') + ' raises ' + causeText(ev.trap.cause) +
        '. It does not retire; it and the younger instructions are discarded, mepc and mcause are written, and fetch restarts at mtvec.');
    }
    if (ev.sleep) say.push('Asleep after WFI: fetch is off until an enabled interrupt is pending. This bench raises no interrupts.');
    if (ev.redirect && e) {
      if (e.cls === 'jalr') say.push('`' + e.text + '` leaves EX: JALR always redirects, here to `' + hex(t.npc) + '`. The younger instructions in IF/ID and the fetch are discarded.');
      else say.push('`' + e.text + '` resolves in EX: ' + (ev.taken ? 'taken' : 'not taken') + ', but the predictor said ' + (ev.taken ? 'not taken' : 'taken') + '. Fetch redirects to `' + hex(t.npc) + '`; the younger instructions in IF/ID and the fetch are discarded.');
    } else if (e && e.cls === 'branch' && ev.exfire) {
      say.push('`' + e.text + '` resolves in EX ' + (ev.taken ? 'taken' : 'not taken') + ', as predicted: no redirect.');
    }
    if (e && (ev.fwdA === 'mem' || ev.fwdA === 'wb' || ev.fwdB === 'mem' || ev.fwdB === 'wb')) {
      var parts = [];
      if (ev.fwdA === 'mem' || ev.fwdA === 'wb') parts.push('`x' + e.rs1 + '` from ' + (ev.fwdA === 'mem' ? 'MEM (`' + tx(m) + '`)' : 'WB (`' + tx(w) + '`)'));
      if (ev.fwdB === 'mem' || ev.fwdB === 'wb') parts.push('`x' + e.rs2 + '` from ' + (ev.fwdB === 'mem' ? 'MEM (`' + tx(m) + '`)' : 'WB (`' + tx(w) + '`)'));
      say.push('Forwarding: `' + e.text + '` in EX takes ' + parts.join(' and ') + '.');
    }
    var dv = ev.div || {};
    if (ev.bubble && d && e && e.cls === 'div' && dv.hold) {
      say.push('`' + d.text + '` needs `x' + e.rd + '` from `' + e.text + '`. It waits in ID while the divider holds EX anyway; when the divide leaves, EX gets one bubble and the value later forwards from WB.');
    } else if (ev.bubble && d && e) {
      say.push('`' + d.text + '` needs `x' + e.rd + '` from `' + e.text + '`, whose result is ready only at the end of MEM. The hazard unit keeps it in ID for one more cycle and sends a bubble to EX; when it reaches EX, the value forwards from WB.');
    }
    if (!e && c > 0 && trace.cycles[c - 1].ev.bubble) say.push('EX holds the bubble inserted last cycle; nothing executes.');
    if (m && ev.mem_stall) say.push('D-cache miss on `' + m.text + '` (`' + hex(t.v.dad) + '`): ' + (DSTATE[ev.dstate] || 'waiting') + '. MEM, EX and ID hold; WB still drains.');
    else if (m && (m.cls === 'load' || m.cls === 'store')) say.push('`' + m.text + '` completes in MEM: D-cache hit (tag probed in EX).');
    if (e && e.cls === 'mul') say.push('`' + e.text + '` in EX: one 33×33 signed multiply of the forwarded operands forms the 64-bit product, captured at the EX/MEM edge.');
    if (m && m.cls === 'mul') say.push('`' + m.text + '` in MEM: the ' + (/^mul /.test(m.text) ? 'low' : 'high') + ' word of the product is selected (`' + hex(t.v.mul) + '`) for write-back.');
    if (e && e.cls === 'div') {
      var gN = divGroups(e), qr = /^rem/.test(e.text) ? 'remainder' : 'quotient';
      var xfer = ' EX selects the ' + qr + (t.v.dvt !== undefined ? ' (`' + hex(t.v.dvt) + '`)' : '') + ' and its sign, and the EX/MEM edge loads both, so the next divide cannot change them.';
      var leaves = ev.exfire ? xfer : '';
      if (dv.state === 'idle' && dv.reuse) say.push('`' + e.text + '` follows a divide on the same registers whose destination is neither source, so decode marked it to reuse the result: the divider keeps its quotient and remainder and only selects the ' + (/^rem/.test(e.text) ? 'remainder' : 'quotient') + ' and its sign. It needs one EX cycle.' + leaves);
      else if (dv.state === 'idle' && !dv.hold) say.push('`' + e.text + '` has a zero divisor: the divider loads the RISC-V result at capture (quotient all ones, remainder the dividend), so it needs one EX cycle.' + leaves);
      else if (dv.state === 'idle' && parseInt(t.v.opa, 16) === 0) say.push('`' + e.text + '` has a zero dividend: capture skips every group, and the result is ready next cycle. EX holds until then; ID/EX and an occupied IF/ID hold behind it.');
      else if (dv.state === 'idle') say.push('`' + e.text + '` enters the divider: capture takes the operand magnitudes and skips the dividend’s leading zero 3-bit groups, leaving ' + gN + ' group' + (gN === 1 ? '' : 's') + ', one per cycle. EX holds the divide; ID/EX and an occupied IF/ID hold behind it.' + noReuse(e, m, w));
      else if (dv.state === 'busy') say.push('Divider: group ' + (gN - dv.left + 1) + ' of ' + gN + ' for `' + e.text + '`, three quotient bits this cycle.' + (dv.hold ? ' EX holds the divide, and the stages behind it wait.' : ev.exfire ? ' It is the last group.' + xfer : ' It is the last group; the divide waits in EX for the stage ahead.'));
      else say.push('`' + e.text + '` has its result' + (ev.exfire ? '.' + xfer : '; it waits in EX for the stage ahead.'));
    }
    if (m && m.cls === 'div') say.push('`' + m.text + '` in MEM: EX/MEM holds its ' + (/^rem/.test(m.text) ? 'remainder' : 'quotient') + ' magnitude (`' + hex(t.v.dvm !== undefined ? t.v.dvm : t.v.memwbn) + '`), and MEM ' + (dv.mneg ? 'negates it' : 'leaves it unchanged') + ' (`' + hex(t.v.memwbn) + '`) for write-back. Like a multiply, it forwards only from WB.');
    var line = function (x) { return parseInt(x, 16) >>> 3; };
    if (ev.redirect) { /* fetch is discarded; covered above */ }
    else if (ev.if === 'miss' && ev.refill && line(ev.refill) !== line(t.pc)) say.push('The I-cache is still finishing the refill of `' + hex(ev.refill) + '`, requested before the redirect. Lookups cannot hit until it completes, so the fetch of `' + hex(t.pc) + '` waits; older instructions keep moving.');
    else if (ev.if === 'miss' && ev.refill) say.push('I-cache miss at `' + hex(t.pc) + '`: its 8-byte line is being refilled. IF waits; older instructions keep moving.');
    else if (ev.if === 'miss') say.push('I-cache miss at `' + hex(t.pc) + '`: the refill request is registered at the next edge.');
    if (ev.redirect && !fd) say.push('This cycle’s fetch at `' + hex(t.pc) + '` is discarded; the recovery PC is fetched next' + (ev.refill ? ', after the I-cache finishes the refill of `' + hex(ev.refill) + '` already on the instruction channel.' : '.'));
    if (ev.pred && !ev.redirect && fd) say.push('Predictor: the instruction at `' + hex(t.pc) + '` is a taken branch in its table, so fetch goes to `' + hex(t.v.bpt) + '` next.');
    if (w && ev.wb_write) say.push(ev.wb_write[0] ? 'WB writes `x' + ev.wb_write[0] + '` ← `' + hex(ev.wb_write[1]) + '` on the falling edge.' : 'WB: `' + w.text + '` targets x0; the write is dropped.');
    if (!say.length) say.push('No hazards this cycle.');
    lines.push(say.join(' '));
    return lines.map(function (l) { return typeof l === 'string' ? [l] : l; });
  };

  model.chart = function (trace) {
    var L = { if: 'F', id: 'D', ex: 'X', mem: 'M', wb: 'W' };
    var lo = trace.cycles[0].c, hi = trace.cycles[trace.cycles.length - 1].c;
    var shown = trace.dyn.filter(function (d) { return Object.keys(d.cells).some(function (k) { return k >= lo && k <= hi; }); });
    trace.rowIds = shown.map(function (d) { return d.id; });
    var rows = shown.map(function (d) {
      var cells = {}, keys = Object.keys(d.cells).map(Number).sort(function (a, b) { return a - b; });
      var prev = null;
      keys.forEach(function (k) {
        var st = d.cells[k];
        var stall = st === prev;
        var sq = (d.fate === 'squashed' || d.fate === 'trap') && k === d.left;
        cells[k] = { text: L[st], color: col(d), cls: (stall ? 'stall' : '') + (sq ? ' sq' : ''), title: { if: 'fetch', id: 'decode', ex: 'execute', mem: 'memory', wb: 'write-back' }[st] + (stall ? ' (held)' : '') + (sq ? (d.fate === 'trap' ? ', then trapped: ' + causeText(d.cause) : ', then discarded') : '') };
        prev = st;
      });
      var first = keys[0] || 0;
      return { pc: hex(d.pc).replace('0x', ''), text: d.text, cells: cells, jump: (keys.filter(function (k) { return d.cells[k] === 'ex'; })[0]) || first, cls: d.fate === 'squashed' ? 'squashed' : d.fate === 'trap' ? 'squashed trapped' : '' };
    });
    return { title: 'Pipeline occupancy', corner: 'instruction \\ cycle', hint: 'F D X M W = IF, ID, EX, MEM, WB. Outlined cells repeat a stage (held). Struck-through rows were discarded: fetched on a wrong path, or (marked trap) faulted.', rows: rows,
      legend: [['k-fwd', 'forwarding, redirect, bubble'], ['k-wait', 'cache miss or refill'], ['k-ctl', 'control signal']] };
  };
  model.currentRows = function (trace, c) {
    var t = trace.cycles[c], out = [];
    ['id', 'ex', 'mem', 'wb'].forEach(function (k) { if (t.slots[k] !== null && t.slots[k] !== undefined) out.push(t.slots[k]); });
    var fd = fetchDyn(trace, t.c);
    if (fd) out.push(fd.id);
    return out.map(function (id) { return (trace.rowIds || []).indexOf(id); }).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
  };
  // The second pass of the demo (warm caches) starts at cycle 79; open on a full pipeline in it.
  model.startCycle = 95;

  window.PrismCoreDiagrams.define('base', model);
})();
