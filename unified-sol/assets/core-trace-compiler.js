/* Trace compiler for the core diagrams: per-cycle RTL rows -> diagram views.
 *
 * A port of qa/core-diagrams/build_traces.py, which compiles the pinned demo
 * recordings. tests/core-trace-compiler.test.cjs checks that both produce the
 * same views from the same rows. Rows come from the tracer that
 * qa/core-diagrams/tracer_patch.py adds to Prism's tile benches; the compiler
 * follows each dynamic instruction using the stage actions the RTL computed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrismTraceCompiler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sx(value, bits) {
    var m = Math.pow(2, bits);
    value = ((value % m) + m) % m;
    return value >= m / 2 ? value - m : value;
  }
  function hx(n) { return (n >>> 0).toString(16); }
  function hex8(n) { return ('0000000' + hx(n)).slice(-8); }

  var CSR_NAMES = { 0x300: 'mstatus', 0x304: 'mie', 0x305: 'mtvec', 0x341: 'mepc', 0x342: 'mcause', 0xb00: 'mcycle' };
  var ALU_R = { '0,0': 'add', '0,32': 'sub', '1,0': 'sll', '2,0': 'slt', '3,0': 'sltu', '4,0': 'xor', '5,0': 'srl', '5,32': 'sra', '6,0': 'or', '7,0': 'and' };
  var MULDIV = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
  var ALU_I = { 0: 'addi', 2: 'slti', 3: 'sltiu', 4: 'xori', 6: 'ori', 7: 'andi', 1: 'slli', 5: 'srli' };
  var BR = { 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' };
  var LD = { 0: 'lb', 1: 'lh', 2: 'lw', 4: 'lbu', 5: 'lhu' };
  var ST = { 0: 'sb', 1: 'sh', 2: 'sw' };
  var CSR_OPS = { 1: 'csrrw', 2: 'csrrs', 3: 'csrrc', 5: 'csrrwi', 6: 'csrrsi', 7: 'csrrci' };
  var SYSTEM = { 0x00000073: 'ecall', 0x00100073: 'ebreak', 0x30200073: 'mret', 0x10500073: 'wfi' };

  function get(table, key, fallback) { return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback; }

  /* Small RV32I/Zmmul/Zicsr decoder for diagram labels. */
  function decode(word, pc, profile) {
    word = word >>> 0;
    var op = word & 0x7f, rd = (word >>> 7) & 31, f3 = (word >>> 12) & 7, rs1 = (word >>> 15) & 31, rs2 = (word >>> 20) & 31, f7 = word >>> 25;
    var d = { cls: 'other', rd: 0, rs1: null, rs2: null, text: '.word 0x' + hex8(word) };
    function set(o) { for (var k in o) d[k] = o[k]; }
    var imm;
    if (op === 0x37) set({ cls: 'lui', rd: rd, text: 'lui x' + rd + ', 0x' + hx(word >>> 12) });
    else if (op === 0x17) set({ cls: 'auipc', rd: rd, text: 'auipc x' + rd + ', 0x' + hx(word >>> 12) });
    else if (op === 0x6f) {
      imm = sx(((word >>> 31) << 20) | (((word >>> 12) & 0xff) << 12) | (((word >>> 20) & 1) << 11) | (((word >>> 21) & 0x3ff) << 1), 21);
      set({ cls: 'jal', rd: rd, text: 'jal x' + rd + ', 0x' + hx(pc + imm) });
    } else if (op === 0x67) set({ cls: 'jalr', rd: rd, rs1: rs1, text: 'jalr x' + rd + ', ' + sx(word >>> 20, 12) + '(x' + rs1 + ')' });
    else if (op === 0x63) {
      imm = sx(((word >>> 31) << 12) | (((word >>> 7) & 1) << 11) | (((word >>> 25) & 0x3f) << 5) | (((word >>> 8) & 0xf) << 1), 13);
      set({ cls: 'branch', rs1: rs1, rs2: rs2, text: get(BR, f3, 'b?') + ' x' + rs1 + ', x' + rs2 + ', 0x' + hx(pc + imm) });
    } else if (op === 0x03) set({ cls: 'load', rd: rd, rs1: rs1, text: get(LD, f3, 'l?') + ' x' + rd + ', 0x' + hx((word >>> 20) & 0xfff) + '(x' + rs1 + ')' });
    else if (op === 0x23) {
      imm = (((word >>> 25) << 5) | ((word >>> 7) & 31)) & 0xfff;
      set({ cls: 'store', rs1: rs1, rs2: rs2, text: get(ST, f3, 's?') + ' x' + rs2 + ', 0x' + hx(imm) + '(x' + rs1 + ')' });
    } else if (op === 0x13) {
      imm = sx(word >>> 20, 12);
      var name = get(ALU_I, f3, 'op-imm');
      if (f3 === 5 && f7 === 0x20) name = 'srai';
      var text;
      if (name === 'addi' && rs1 === 0) text = 'li x' + rd + ', ' + imm;
      else if (f3 === 1 || f3 === 5) text = name + ' x' + rd + ', x' + rs1 + ', ' + rs2;
      else text = name + ' x' + rd + ', x' + rs1 + ', ' + imm;
      set({ cls: 'alui', rd: rd, rs1: rs1, text: text });
    } else if (op === 0x33) {
      if (f7 === 1) set({ cls: f3 < 4 ? 'mul' : 'div', rd: rd, rs1: rs1, rs2: rs2, text: MULDIV[f3] + ' x' + rd + ', x' + rs1 + ', x' + rs2 });
      else set({ cls: 'alu', rd: rd, rs1: rs1, rs2: rs2, text: get(ALU_R, f3 + ',' + f7, 'op') + ' x' + rd + ', x' + rs1 + ', x' + rs2 });
    } else if (op === 0x73) {
      if (f3 === 0) {
        var sys = get(SYSTEM, word, 'system');
        set({ cls: sys === 'wfi' || sys === 'mret' ? sys : 'system', text: sys });
      } else {
        var csr = word >>> 20;
        var cname = get(CSR_NAMES, csr, '0x' + ('00' + hx(csr)).slice(-3));
        var t;
        if (f3 === 5 && rd === 0) t = 'csrwi ' + cname + ', ' + rs1;
        else if (f3 === 1 && rd === 0) t = 'csrw ' + cname + ', x' + rs1;
        else t = get(CSR_OPS, f3, 'csr') + ' x' + rd + ', ' + cname + ', ' + (f3 >= 5 ? rs1 : 'x' + rs1);
        set({ cls: 'csr', rd: rd, rs1: f3 >= 5 ? null : rs1, text: t });
      }
    } else if (op === 0x0f) set({ cls: 'fence', text: f3 === 1 ? 'fence.i' : 'fence' });
    else if (word === 0xffffffff && profile !== 'hazard3' && profile !== 'hazard3_ahb') set({ cls: 'halt', text: 'halt' });
    if (word === 0 && profile !== 'hazard3' && profile !== 'hazard3_ahb') set({ cls: 'other', text: '0x00000000 (not program code)' });
    return d;
  }

  function fail(message) { throw new Error('Trace compiler: ' + message); }
  function num(h) { return parseInt(h, 16) >>> 0; }

  /* Base: follow each dynamic instruction through IF..WB. */
  function compileBaseDyn(rows) {
    var dyn = [], frames = [];
    var slots = { id: null, ex: null, mem: null, wb: null };
    var STAGES = ['id', 'ex', 'mem', 'wb'];
    var TRAP_STAGE = { 1: 'id', 2: 'ex', 3: 'mem', 4: 'wb' }; // exception_stage_t; 0 is fetch
    function add(pc, word, cycle) {
      var d = decode(word, pc);
      d.id = dyn.length; d.pc = pc; d.word = word; d.fetched = cycle; d.cells = {}; d.fate = 'inflight';
      dyn.push(d);
      return d.id;
    }
    rows.forEach(function (t, i) {
      var c = t.c;
      if (c !== rows[0].c + i) fail('cycle ' + c + ' out of order');
      STAGES.forEach(function (stage) {
        var valid = t[stage][0], pc = t[stage][1];
        if (valid) {
          if (slots[stage] === null) fail('cycle ' + c + ': ' + stage + ' valid but untracked');
          if (dyn[slots[stage]].pc !== num(pc)) fail('cycle ' + c + ': ' + stage + ' PC mismatch');
          dyn[slots[stage]].cells[c] = stage;
        } else if (slots[stage] !== null) fail('cycle ' + c + ': ' + stage + ' empty but tracked');
      });
      // A synchronous trap acknowledged this cycle: the faulting occupant
      // leaves without retiring (interrupts set mcause[31] and fault nothing).
      if (t.trap && !(num(t.tcause) >>> 31)) {
        var faulting = slots[TRAP_STAGE[t.tstage]];
        if (faulting !== null && faulting !== undefined) dyn[faulting].cause = num(t.tcause);
      }
      // MRET completes in EX: on the acknowledged return the RTL invalidates
      // its slot, which is architectural completion, not a squash.
      if (t.mret && slots.ex !== null && dyn[slots.ex].cls === 'mret') dyn[slots.ex].completed = true;
      var fetchPc = num(t.pc), accepted = t.ifb === 1;
      var frame = { slots: { id: slots.id, ex: slots.ex, mem: slots.mem, wb: slots.wb }, fetch_pc: fetchPc, accepted: accepted };
      frames.push(frame);
      var nxt = {};
      nxt.wb = t.memfire && slots.mem !== null ? slots.mem : null;
      nxt.mem = t.exmb === 1 ? slots.ex : (t.exmb === 0 ? slots.mem : null);
      nxt.ex = t.ifa === 1 ? slots.id : (t.ifa === 0 ? slots.ex : null);
      if (accepted) {
        var fid = add(fetchPc, t['if'][2] ? num(t['if'][2]) : 0, c);
        dyn[fid].cells[c] = 'if';
        frame.fetch_dyn = fid;
        nxt.id = fid;
      } else nxt.id = t.ifb === 0 ? slots.id : null;
      if (t.ifb === 0 && slots.id === null) nxt.id = null;
      var staying = {};
      STAGES.forEach(function (s) { if (nxt[s] !== null) staying[nxt[s]] = true; });
      STAGES.forEach(function (stage) {
        var occ = slots[stage];
        if (occ !== null && !staying[occ]) {
          dyn[occ].fate = dyn[occ].cause !== undefined ? 'trap' : (stage === 'wb' || dyn[occ].completed ? 'retired' : 'squashed');
          dyn[occ].left = c;
          dyn[occ].left_stage = stage;
        }
      });
      slots = { id: nxt.id, ex: nxt.ex, mem: nxt.mem, wb: nxt.wb };
    });
    // Fetch cells: cycles spent waiting on the I-cache for the fetched address.
    var base = rows.length ? rows[0].c : 0;
    dyn.forEach(function (d) {
      for (var c = d.fetched - 1; c >= base; c--) {
        var r = rows[c - base];
        if (!(num(r.pc) === d.pc && r.ire && r.ifb !== 1)) break;
        d.cells[c] = 'if';
      }
    });
    return { dyn: dyn, frames: frames };
  }

  var FWD = { '100': 'saved', '010': 'mem', '001': 'wb' };
  var TRAP_STAGES = { 0: 'if', 1: 'id', 2: 'ex', 3: 'mem', 4: 'wb' };
  // Base divider sequencer (source/core_tiles/base/rtl/pipeline/units/divider.sv).
  var DIV_STATES = { 0: 'idle', 1: 'busy', 2: 'done' };
  function baseEvents(t, f, dyn) {
    var s = f.slots, ev = {};
    ev['if'] = !t.ire ? 'off' : (t.ihit ? 'hit' : 'miss');
    if (t.bir) ev.refill = t.bia;
    ev.pred = t.bp === 1;
    if (s.ex !== null) {
      var d = dyn[s.ex];
      ev.fwdA = d.rs1 !== null && d.rs1 !== 0 ? get(FWD, t.fa, 'saved') : null;
      ev.fwdB = d.rs2 !== null && d.rs2 !== 0 ? get(FWD, t.fb, 'saved') : null;
      ev.redirect = !!t.redir;
      ev.taken = !!t.tk;
      ev.exfire = !!t.exfire;
    }
    ev.bubble = !!t.nop;
    ev.mem_stall = !!t.mst;
    ev.dacc = t.dre ? 'r' : (t.dwe ? 'w' : null);
    ev.dhit = !!t.dhit;
    ev.dstate = t.dst;
    ev.probe = !!t.pacc;
    ev.dbus = t.bdr ? 'r' : (t.bdw ? 'w' : null);
    ev.wb_write = t.we ? [t.wd, t.wv] : null;
    ev.squash = !!t.squash;
    if ('dvs' in t) ev.div = { state: get(DIV_STATES, t.dvs, 'idle'), left: t.dvn, hold: !!t.dvh };
    if ('dvu' in t) ev.div.reuse = !!t.dvu; // decode's divide_reuse bit
    if ('dvtn' in t) { ev.div.tneg = !!t.dvtn; ev.div.mneg = !!t.dvmn; } // sign bits: divider's EX selection, EX/MEM divide_negate
    if ('trap' in t) {
      ev.trap = t.trap ? { stage: get(TRAP_STAGES, t.tstage, 'if'), cause: num(t.tcause) } : null;
      ev.sleep = !!t.sleep;
    }
    return ev;
  }

  var BASE_VALUES = ['opa', 'opb', 'pa', 'pb', 'alu', 'bt', 'pra', 'dad', 'dwd', 'drd', 'memwbn', 'mul', 'wbv', 'bpt', 'bia', 'bda'];
  function pick(t, keys) { var o = {}; keys.forEach(function (k) { o[k] = t[k]; }); return o; }

  function compileBase(rows) {
    if (!rows.length) fail('no cycles recorded');
    var r = compileBaseDyn(rows), dyn = r.dyn;
    var cycles = rows.map(function (t, i) {
      var f = r.frames[i], v = pick(t, BASE_VALUES);
      if ('dvt' in t) v.dvt = t.dvt;
      if ('dvm' in t) v.dvm = t.dvm;
      return {
        c: t.c, pc: t.pc, npc: t.npc, slots: f.slots, fetch_dyn: f.fetch_dyn === undefined ? null : f.fetch_dyn,
        ev: baseEvents(t, f, dyn), v: v,
        id_word: t.id[2], grants: [t.ga, t.gb], ifst: t.ifst, pcsrc: t.pcsrc, exsrc: t.exsrc, memsrc: t.memsrc,
        pcen: t.pcen, tk: t.tk, mis: t.mis, memfire: t.memfire, exfire: t.exfire
      };
    });
    return { cycles: cycles, dyn: dyn };
  }

  var SC_KEYS = ['c', 'pc', 'npc', 'ins', 'fre', 'fhit', 'act', 'ret', 'exc', 'halted', 'aluop', 'rsrc', 'psrc', 'apc', 'bimm', 'rw', 'mr', 'mw', 'csr', 'sz', 'tk',
    'rs1', 'rs2', 'rd', 'r1', 'r2', 'imm', 'pa', 'pb', 'alu', 'z', 'wb', 'wen', 'dre', 'dwe', 'dhit', 'dad', 'dwd', 'drd', 'ld',
    'bir', 'bia', 'biw', 'bdr', 'bdw', 'bda', 'bdwt', 'cached'];

  /* Singlecycle: one instruction at a time; each retires or traps. */
  function compileSinglecycleDyn(rows) {
    var dyn = [], cur = null;
    rows.forEach(function (t) {
      var c = t.c;
      if (t.halted) return;
      if (cur === null) cur = { pc: num(t.pc), cells: {}, start: c };
      if (t.fre && t.fhit) cur.word = num(t.ins);
      var state;
      if (t.ret) state = 'retire';
      else if ('sleep' in t ? t.sleep : !t.fre) state = 'sleep';
      else if (!t.fre) state = 'wait';
      else if (!t.fhit) state = 'fetch';
      else if (t.dre || t.dwe) state = 'data';
      else if (t.exc) state = 'trap';
      else state = 'wait';
      cur.cells[c] = state;
      if (t.ret || t.exc) {
        var word = cur.word === undefined ? 0 : cur.word;
        var d = decode(word, cur.pc);
        d.id = dyn.length; d.pc = cur.pc; d.word = word; d.cells = cur.cells; d.fate = t.ret ? 'retired' : 'trap'; d.retire = c;
        if (!t.ret && 'ecause' in t) d.cause = t.ecause;
        dyn.push(d);
        cur = null;
      }
    });
    // The run ended mid-instruction (cycle limit) or asleep after WFI: keep
    // those cycles, without inventing a retirement.
    if (cur !== null) {
      var pending = cur.word === undefined ? { cls: 'other', rd: 0, rs1: null, rs2: null, text: '(not fetched)' } : decode(cur.word, cur.pc);
      pending.id = dyn.length; pending.pc = cur.pc; pending.word = cur.word === undefined ? null : cur.word; pending.cells = cur.cells; pending.fate = 'inflight';
      dyn.push(pending);
    }
    return dyn;
  }

  function compileSinglecycle(rows) {
    if (!rows.length) fail('no cycles recorded');
    var cycles = rows.map(function (t) {
      var e = pick(t, SC_KEYS);
      ['saved', 'ist', 'dst', 'sleep', 'ecause'].forEach(function (k) { if (k in t) e[k] = t[k]; });
      return e;
    });
    return { cycles: cycles, dyn: compileSinglecycleDyn(rows) };
  }

  /* Hazard3 passive observer. Rows precede the next rising edge.
   * CIR consumption/locking: thirdparty/hazard3/hdl/hazard3_decode.v:143-218.
   * XM enable/bubble: hazard3_core.v:1061-1086; completion: :1180-1196.
   * Never use register writes, PC changes, or fetch-PC matching as identities.
   */
  function compileHazard3(rows) {
    if (!rows.length) fail('no cycles recorded');
    var dyn = [], cycles = [], dx = null, m = null, unsupported = false, asleep = false;
    function bypass(reg, t) { return !reg ? 'x0' : reg === t.mrd ? 'xm' : reg === t.mwrd ? 'mw' : 'rf'; }
    rows.forEach(function (t, i) {
      if (t.c !== rows[0].c + i) fail('cycle ' + t.c + ' out of order');
      var len = t.len32 ? 4 : 2, raw = num(t.raw), ins = num(t.ins), pc = num(t.pc);
      if (len === 2) raw &= 65535;
      if (dx === null && !t.starved) {
        var d = decode(ins, pc, 'hazard3');
        // Unknown compressed mnemonics remain raw .half labels, but have the
        // expanded instruction's class/operands. They are ordinary occupants.
        if (len === 2) d.text = '.half 0x' + ('000' + raw.toString(16)).slice(-4);
        d.id = dyn.length; d.pc = pc; d.word = raw; d.len = len; d.cells = {}; d.fate = 'inflight';
        dyn.push(d); dx = d.id;
      }
      if (dx !== null && !t.starved && !t.uop && dyn[dx].cls !== 'zcmp' && (dyn[dx].pc !== pc || dyn[dx].word !== raw)) fail('cycle ' + t.c + ': retained D/X occupant changed without consumption/flush');
      if (t.uop) unsupported = true;
      if (dx !== null) dyn[dx].cells[t.c] = 'dx';
      if (m !== null) dyn[m].cells[t.c] = 'm';
      var zcmp = dx !== null && (t.uop || dyn[dx].cls === 'zcmp');
      if (zcmp) { dyn[dx].cls = 'zcmp'; dyn[dx].text = '.half 0x' + ('000' + dyn[dx].word.toString(16)).slice(-4) + ' (Zcmp unsupported)'; }
      var accepted = !!t.trap && !t.debugentry && !t.debugmode;
      var mret = accepted && t.mexcept === 10 && !t.irq;
      var trap = accepted && !mret ? { cause: (t.cause + (t.irq ? 0x80000000 : 0)) >>> 0, target: num(t.target), irq: !!t.irq } : null;
      var terminal = !!(t.halted && t.flushed && !t.debughalted);
      var br = !t.starved && (ins & 127) === 0x63 ? {
        taken: t.bc === 1 || (t.bc === 2 && !t.cmp) || (t.bc === 3 && !!t.cmp),
        predicted: !!t.predicted, recover: !!(t.predicted && t.recover), target: num(t.jtarget)
      } : null;
      var isdiv = !t.starved && (ins & 0xfe00407f) === 0x02004033;
      var div = isdiv ? { state: t.divreq ? 'issue' : t.divposted && !t.divdone ? 'iterate' : t.divdone ? 'done' : 'waiting', ctr: t.divctr } : null;
      var stall = [];
      [['raw',t.rawstall],['div',t.divstall],['mem',t.memstall],['trap',t.trapstall],['amo',t.amostall],['jump',t.jumpstall],['m',t.ms]].forEach(function (s) { if (s[1]) stall.push(s[0]); });
      var ev = [];
      function event(name, yes) { if (yes) ev.push(name); }
      event('fetch', t.aph); event('discard', t.discard); event('redirect', t.jump);
      event('predict', t.btbh && t.aph); event('btb_set', t.btbset && !t.btbclear); event('btb_clear', t.btbclear);
      event('mispredict', br && br.recover && t.jump); event('raw_stall', t.rawstall && !t.starved);
      // Actual local M mux; core.v:1222-1231. Only stores use this as store data.
      event('store_bypass', m !== null && [5,6,7].indexOf(t.memop) >= 0 && t.mwrd && t.mrs2 === t.mwrd);
      event('mem_wait', t.memstall || t.mbusstall);
      event('div_start', isdiv && t.divreq && t.divrdy);
      event('div_done', isdiv && t.divposted && t.divdone && !t.xs);
      event('trap', trap); event('mret', mret); event('sleep', t.sleep && !asleep); event('wake', !t.sleep && asleep); event('halt', terminal);
      cycles.push({ c: t.c, ev: ev,
        f: { addr: num(t.fetch), aph: t.aph ? {addr:num(t.ia)} : null,
          dph: t.dph ? {addr:num(t.iaddr),data:num(t.idata),err:!!t.ierr} : null, discard:!!t.discard,
          fifo:[{hw:t.fifo0hw,data:num(t.fifo0)},{hw:t.fifo1hw,data:num(t.fifo1)}], hwbuf:num(t.hwbuf), level:t.level,
          push:!!t.fpush,pop:!!t.fpop,bypass:!!t.fbypass,fill:t.ffill,
          btb:{valid:!!t.btbv,src:num(t.btbs),target:num(t.btbt),hit:!!t.btbh} },
        jump: t.jump ? {target:num(t.target),from:t.jfromm ? 'm' : 'x'} : null,
        dx: {id:dx,pc:pc,raw:raw,ins:ins,len:len,starved:!!t.starved,stall:stall,
          locked:!!t.lock,dreq:t.dreq ? {addr:num(t.daddr),ready:!!t.dready} : null,
          rs1:t.rs1,rs2:t.rs2,rd:t.rd,r1:num(t.r1),r2:num(t.r2),byp1:bypass(t.pre1,t),byp2:bypass(t.pre2,t),
          opa:num(t.opa),opb:num(t.opb),alu:num(t.alu),addr:num(t.addr),br:br,mul:!!t.mul,div:div,
          mulres:t.mul ? num(t.mulres) : null,
          csr: t.csrren || t.csrwen ? {addr:num(t.csraddr),ren:!!t.csrren,wen:!!t.csrwen,rstb:!!t.csrrstb,wstb:!!t.csrwstb,wdata:num(t.csrwdata),rdata:num(t.csrrdata)} : null,
          except:t.xexcept === 15 ? null : t.xexcept},
        m: {id:m,rd:t.mrd,result:num(t.mresult),memop:t.memop,addr:num(t.maddr),wdata:num(t.mwdata),rdata:num(t.mrdata),wen:!!t.mwen,stall:!!t.ms,except:t.mexcept === 15 ? null : t.mexcept},
        bus: {i:{read:!!t.bir,addr:num(t.bia),wait:!!t.biw,data:t.bid,err:!!t.bie},
          d:{read:!!t.bdr,write:!!t.bdw,addr:num(t.bda),mask:t.bdmask,wdata:t.bdwd,rdata:t.bdrd,wait:!!t.bdwt,err:!!t.bde}},
        trap:trap,mret:mret ? {target:num(t.target)} : null,sleep:!!t.sleep,halted:!!t.halted,flushed:!!t.flushed });
      asleep = !!t.sleep;
      if (terminal && m !== null && t.sleep) dyn[m].fate = 'retired';
      // No following row means no observed next edge; retain unfinished work.
      if (i === rows.length - 1) return;
      if (m !== null && !t.ms) {
        if (trap && !trap.irq) { dyn[m].fate = 'trap'; dyn[m].cause = trap.cause; }
        else if (t.mexcept === 15 || mret) dyn[m].fate = 'retired';
      }
      var enter = !t.ms && !t.xs && !t.starved && !t.trapsoon && !t.partial && !zcmp;
      var nextM = t.ms ? m : enter ? dx : null;
      var leaves = !!t.use || (t.jump && !t.flushbehind);
      if (leaves && dx !== null) {
        if (nextM !== dx && !zcmp) dyn[dx].fate = 'squashed';
        dx = null;
      }
      m = nextM;
    });
    var last = rows[rows.length - 1];
    var view = {cycles:cycles,dyn:dyn,program:'',stop:{reason:last.halted && last.flushed && !last.debughalted ? 'halt' : last.sleep ? 'wfi' : 'max_cycles',cycle:last.c},log:[]};
    if (unsupported) view.unsupported = ['zcmp'];
    return view;
  }

  /* One JSON object per line. A bench that stops with $fatal (for example on
     timeout) can leave its last line unflushed; only that line may be cut. */
  function parseRows(text) {
    var lines = text.split('\n');
    var partial = lines.length && lines[lines.length - 1] !== '' ? lines.pop() : null;
    var rows = lines.filter(function (l) { return l.trim(); }).map(function (l) { return JSON.parse(l); });
    if (partial !== null) {
      try { rows.push(JSON.parse(partial)); } catch (e) { /* incomplete final row */ }
    }
    return rows;
  }

  /* core: 'base' | 'singlecycle' | 'singlecycle_cached' | 'hazard3' | 'hazard3_ahb'; rows: parsed tracer lines. */
  function compile(core, rows, program) {
    var view;
    if (core === 'base') view = compileBase(rows);
    else if (core === 'hazard3' || core === 'hazard3_ahb') view = compileHazard3(rows);
    else if (core === 'singlecycle' || core === 'singlecycle_cached') view = compileSinglecycle(rows);
    else fail('unknown core ' + core);
    view.program = program || '';
    return view;
  }

  return { decode: decode, compile: compile, compileBase: compileBase, compileHazard3: compileHazard3, compileSinglecycle: compileSinglecycle, parseRows: parseRows };
});
