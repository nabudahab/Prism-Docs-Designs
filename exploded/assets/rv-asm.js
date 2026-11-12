/* Portable RV32 assembler. No execution, relaxation, compressed instructions,
   or external dependencies. Addresses are resolved before bytes are emitted. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrismAsm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const profiles = {
    hazard3: { isa: 'rv32im_zicsr_zifencei', description: 'RV32IM + Zicsr + Zifencei + halt macro. No compressed mnemonics.' },
    base: { isa: 'rv32im_zicsr_zifencei', description: 'RV32IM + Zicsr + Zifencei + halt macro.' },
    singlecycle: { isa: 'rv32i_zicsr_zifencei', description: 'RV32I + Zicsr + Zifencei + halt macro.' }
  };
  const abi = 'zero ra sp gp tp t0 t1 t2 s0 s1 a0 a1 a2 a3 a4 a5 a6 a7 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11 t3 t4 t5 t6'.split(' ');
  const csrs = { fflags: 1, frm: 2, fcsr: 3, sstatus: 0x100, sie: 0x104, stvec: 0x105, scounteren: 0x106, sscratch: 0x140, sepc: 0x141, scause: 0x142, stval: 0x143, sip: 0x144, satp: 0x180,
    mstatus: 0x300, misa: 0x301, medeleg: 0x302, mideleg: 0x303, mie: 0x304, mtvec: 0x305, mcounteren: 0x306, mstatush: 0x310, mcountinhibit: 0x320,
    mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344, mtinst: 0x34a, mtval2: 0x34b,
    mcycle: 0xb00, minstret: 0xb02, mcycleh: 0xb80, minstreth: 0xb82, cycle: 0xc00, time: 0xc01, instret: 0xc02, cycleh: 0xc80, timeh: 0xc81, instreth: 0xc82,
    mvendorid: 0xf11, marchid: 0xf12, mimpid: 0xf13, mhartid: 0xf14, mconfigptr: 0xf15 };
  for (let i = 0; i < 16; i++) csrs['pmpcfg' + i] = 0x3a0 + i;
  for (let i = 0; i < 64; i++) csrs['pmpaddr' + i] = 0x3b0 + i;
  for (let i = 3; i < 32; i++) {
    csrs['hpmcounter' + i] = 0xc00 + i; csrs['hpmcounter' + i + 'h'] = 0xc80 + i;
    csrs['mhpmcounter' + i] = 0xb00 + i; csrs['mhpmcounter' + i + 'h'] = 0xb80 + i; csrs['mhpmevent' + i] = 0x320 + i;
  }
  function fail(message, column) { const e = new Error(message); e.column = column; throw e; }
  function reg(s) {
    const n = /^x(?:[0-9]|[12][0-9]|3[01])$/.test(s) ? +s.slice(1) : s === 'fp' ? 8 : abi.indexOf(s);
    if (n < 0) fail('Unknown register "' + s + '"'); return n;
  }
  function range(n, min, max, name) {
    if (!Number.isSafeInteger(n) || n < min || n > max) fail(name + ' must be between ' + min + ' and ' + max);
    return n;
  }
  function signed(n) { return n | 0; }
  function low(n) { return (n << 20) >> 20; }
  function high(n) { return ((signed(n) - low(n)) / 4096) & 0xfffff; }
  function split(s, delimiter) {
    const out = []; let start = 0, quote = '', depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === delimiter && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    if (quote || depth) fail('Unclosed quote or parenthesis');
    out.push(s.slice(start).trim()); return out;
  }
  // GNU strings: byte escapes, octal and hexadecimal; UTF-8 for literal text.
  function stringBytes(s) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) fail('Expected a double-quoted string');
    const out = [], text = s.slice(1, -1);
    for (let i = 0; i < text.length; i++) {
      let c = text[i];
      if (c === '\\') {
        c = text[++i];
        const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92, "'": 39 };
        if (c in escapes) out.push(escapes[c]);
        else if (/[0-7]/.test(c)) { const m = text.slice(i).match(/^[0-7]{1,3}/)[0]; out.push(parseInt(m, 8) & 255); i += m.length - 1; }
        else if (c === 'x') { const m = text.slice(i + 1).match(/^[\da-fA-F]+/); if (!m) fail('Expected hexadecimal string escape'); out.push(parseInt(m[0], 16) & 255); i += m[0].length; }
        else fail('Unsupported string escape \\' + c);
      } else {
        const cp = text.codePointAt(i); if (cp > 0xffff) i++;
        if (cp < 128) out.push(cp);
        else if (cp < 2048) out.push(0xc0 | cp >> 6, 0x80 | cp & 63);
        else if (cp < 65536) out.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
        else out.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
      }
    }
    return out;
  }
  // A small integer-expression parser, never eval(). BigInt keeps bit operations
  // and address differences exact before RV32 field range checks.
  function expression(text, lookup, reloc) {
    const tokens = []; const re = /\s*(%[a-z_]+|0[xX][\da-fA-F]+|0[bB][01]+|\d+[bf]\b|\d+|[A-Za-z_.$][\w.$]*|'(?:[^'\\]|\\.)'|<<|>>|[()+\-~*/%&|^])/gy;
    let pos = 0, m;
    while (pos < text.length) { re.lastIndex = pos; m = re.exec(text); if (!m) { if (!text.slice(pos).trim()) break; fail('Invalid expression "' + text + '"'); } tokens.push(m[1]); pos = re.lastIndex; }
    let at = 0;
    const precedence = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
    function parse(min) {
      let t = tokens[at++], v;
      if (t === '+' || t === '-' || t === '~') { v = parse(7); if (t === '-') v = -v; if (t === '~') v = ~v; }
      else if (t === '(') { v = parse(0); if (tokens[at++] !== ')') fail('Expected closing parenthesis'); }
      else if (t && t[0] === '%' && t.length > 1) { if (tokens[at++] !== '(') fail('Expected relocation parentheses'); v = parse(0); if (tokens[at++] !== ')') fail('Expected closing parenthesis'); v = BigInt(reloc(t, Number(v))); }
      else if (t && /^\d/.test(t) && !/^\d+[bf]$/.test(t)) { // 1b/2f are local labels; 0x1f and 0x0b are numbers
        if (/^0[0-7]+$/.test(t)) v = BigInt('0o' + t.slice(1)); else v = BigInt(t);
      } else if (t && t[0] === "'") v = BigInt(stringBytes('"' + t.slice(1, -1).replace(/"/g, '\\"') + '"')[0]);
      else if (t && /^[\w.$]/.test(t)) v = BigInt(lookup(t));
      else fail('Expected an integer expression');
      while (at < tokens.length && (precedence[tokens[at]] || 0) > min) {
        const op = tokens[at++], rhs = parse(precedence[op]);
        if ((op === '/' || op === '%') && rhs === 0n) fail('Division by zero in expression');
        if ((op === '<<' || op === '>>') && (rhs < 0n || rhs > 63n)) fail('Expression shift must be between 0 and 63');
        switch (op) { case '+': v += rhs; break; case '-': v -= rhs; break; case '*': v *= rhs; break; case '/': v /= rhs; break; case '%': v %= rhs; break; case '&': v &= rhs; break; case '|': v |= rhs; break; case '^': v ^= rhs; break; case '<<': v <<= rhs; break; case '>>': v >>= rhs; break; }
      }
      return v;
    }
    const result = parse(0); if (at !== tokens.length) fail('Unexpected expression token "' + tokens[at] + '"');
    const n = Number(result); if (!Number.isSafeInteger(n)) fail('Expression exceeds the exact integer range'); return n;
  }
  function assemble(source, options) {
    const result = { ok: false, errors: [], warnings: [], segments: [], listing: [], symbols: {} };
    const requestedProfile = (options || {}).profile || 'base';
    const profile = requestedProfile === 'hazard3_ahb' ? 'hazard3' : requestedProfile;
    const nodes = [], definitions = Object.create(null), locals = [], sections = ['.text', '.data', '.rodata', '.bss'];
    let section = '.text';
    function error(e, node) { result.errors.push({ line: node.line, column: e.column || node.column || 1, message: e.message }); }
    if (!Object.hasOwn(profiles, profile)) { error(new Error('Unknown ISA profile "' + profile + '"'), { line: 1 }); return result; }
    if (typeof source !== 'string') { error(new Error('Source must be text'), { line: 1 }); return result; }
    if (source.length > 1000000) { error(new Error('Source exceeds 1 MB'), { line: 1 }); return result; }
    // Prism assembles programs through the C preprocessor, so its sources use
    // `//` and `/* */` comments as well as `#`. Block comments become spaces,
    // keeping line and column numbers.
    let open = null;
    source = source.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)'|\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, function (m, offset) {
      if (!m.startsWith('/*')) return m; // strings, characters and line comments
      if (!m.endsWith('*/')) open = offset;
      return m.replace(/[^\n]/g, ' ');
    });
    if (open !== null) { const line = source.slice(0, open).split('\n').length; error(new Error('Unclosed /* comment'), { line }); return result; }
    source.split(/\r?\n/).forEach(function (line, index) {
      let quote = '', end = line.length;
      for (let i = 0; i < line.length; i++) {
        if (quote) { if (line[i] === '\\') i++; else if (line[i] === quote) quote = ''; }
        else if (line[i] === '"' || line[i] === "'") quote = line[i];
        else if (line[i] === '#' || (line[i] === '/' && line[i + 1] === '/')) { end = i; break; }
      }
      const ctx = { line: index + 1, column: line.search(/\S/) + 1, source: line };
      try {
        const statements = split(line.slice(0, end), ';'); let search = 0;
        for (let statement of statements) {
          if (!statement) continue;
          ctx.column = line.indexOf(statement, search) + 1; search = ctx.column - 1 + statement.length;
          let match;
          while ((match = statement.match(/^([A-Za-z_.$][\w.$]*|\d+)\s*:\s*/))) {
            const name = match[1], node = Object.assign({}, ctx, { section, label: name, address: 0 });
            if (/^\d+$/.test(name)) locals.push(node);
            else { if (definitions[name]) fail('Duplicate symbol "' + name + '"'); definitions[name] = node; }
            nodes.push(node); statement = statement.slice(match[0].length); ctx.column += match[0].length;
          }
          if (!statement) continue;
          match = statement.match(/^(\S+)(?:\s+(.*))?$/);
          const op = match[1].toLowerCase(), args = match[2] ? split(match[2], ',') : [];
          const node = Object.assign({}, ctx, { section, op, args, address: 0, size: 0 });
          if (sections.includes(op) || op === '.section') {
            const target = op === '.section' ? args[0] : op;
            if (!sections.includes(target)) fail('Unsupported section "' + target + '"');
            if (op !== '.section' && args.length) fail(op + ' takes no operands');
            section = target; continue;
          }
          if (op === '.equ' || op === '.set') {
            if (args.length !== 2 || !/^[A-Za-z_.$][\w.$]*$/.test(args[0])) fail(op + ' expects a symbol and expression');
            if (definitions[args[0]] && !definitions[args[0]].equ) fail('Duplicate symbol "' + args[0] + '"');
            node.previous = definitions[args[0]];
            node.equ = args[1]; definitions[args[0]] = node;
          }
          nodes.push(node);
        }
      } catch (e) { error(e, ctx); }
    });
    if (result.errors.length) return result;
    nodes.forEach((n, i) => { n.index = i; });
    function value(text, node, stack) {
      stack = stack || [];
      return expression(text, function (name) {
        if (name === '.') return node.address;
        if (/^\d+[bf]$/.test(name)) {
          const number = name.slice(0, -1), back = name.endsWith('b');
          const matches = locals.filter(n => n.label === number && (back ? n.index < node.index : n.index > node.index));
          const found = back ? matches[matches.length - 1] : matches[0];
          if (!found) fail('No matching local label ' + name); return found.address;
        }
        let def = definitions[name];
        while (def && def.previous && def.index >= node.index) def = def.previous;
        if (!def) fail('Undefined symbol "' + name + '"');
        if (!def.equ) return def.address;
        if (stack.includes(def)) fail('Circular symbol expression "' + name + '"');
        return value(def.equ, def, stack.concat(def));
      }, function (kind, n) {
        if (kind === '%hi') return high(n);
        if (kind === '%lo') return low(n);
        if (kind === '%pcrel_hi') return high(n - node.address);
        if (kind === '%pcrel_lo') {
          const anchor = nodes.find(a => a.op === 'auipc' && a.address === n && a.args[1] && /^%pcrel_hi\s*\(/.test(a.args[1]));
          if (!anchor) fail('%pcrel_lo must refer to a label on an AUIPC with %pcrel_hi');
          const target = anchor.args[1].slice(anchor.args[1].indexOf('(') + 1, -1); return low(value(target, anchor) - anchor.address);
        }
        fail('Unsupported relocation ' + kind);
      });
    }
    function count(n, min, max) { if (n.args.length < min || n.args.length > (max === undefined ? min : max)) fail(n.op + ' expects ' + min + (max && max !== min ? '–' + max : '') + ' operand(s)'); }
    function expansion(n, sizing) {
      const a = n.args, op = n.op, v = s => value(s, n), out = (name, args) => [[name, args]];
      const simple = { nop: ['addi', ['x0', 'x0', '0']], ret: ['jalr', ['x0', '0(ra)']] };
      if (Object.hasOwn(simple, op)) { count(n, 0); return [simple[op]]; }
      if (op === 'halt') { count(n, 0); return [['csrrwi', ['zero', 'mie', '0']], ['wfi', []]]; }
      if (op === 'li') {
        count(n, 2); let x;
        try { x = signed(range(v(a[1]), -2147483648, 4294967295, 'li value')); } catch (e) { if (sizing) return [['lui', []], ['addi', []]]; throw e; }
        if (x >= -2048 && x <= 2047) return out('addi', [a[0], 'x0', '' + x]);
        const rows = [['lui', [a[0], '' + high(x)]]];
        if (low(x)) rows.push(['addi', [a[0], a[0], '' + low(x)]]); return rows;
      }
      if (op === 'la' || op === 'call' || op === 'tail') {
        count(n, op === 'la' ? 2 : 1, op === 'call' ? 2 : undefined);
        const rd = op === 'la' ? a[0] : op === 'tail' ? 't1' : a.length === 2 ? a[0] : 'ra';
        const temp = op === 'call' && a.length === 2 ? 't1' : rd;
        const d = sizing ? 0 : signed(v(a[a.length - 1]) - n.address);
        return [['auipc', [temp, '' + high(d)]], [op === 'la' ? 'addi' : 'jalr', op === 'la' ? [rd, rd, '' + low(d)] : [op === 'tail' ? 'zero' : rd, low(d) + '(' + temp + ')']]];
      }
      if (['mv', 'not', 'neg', 'seqz', 'snez', 'sltz', 'sgtz'].includes(op)) {
        count(n, 2);
        const map = { mv: ['addi', [a[0], a[1], '0']], not: ['xori', [a[0], a[1], '-1']], neg: ['sub', [a[0], 'zero', a[1]]], seqz: ['sltiu', [a[0], a[1], '1']], snez: ['sltu', [a[0], 'zero', a[1]]], sltz: ['slt', [a[0], a[1], 'zero']], sgtz: ['slt', [a[0], 'zero', a[1]]] }; return [map[op]];
      }
      if (op === 'j' || op === 'jr') { count(n, 1); return out(op === 'j' ? 'jal' : 'jalr', ['zero', op === 'j' ? a[0] : '0(' + a[0] + ')']); }
      if (['beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz'].includes(op)) {
        count(n, 2); const base = { beqz: 'beq', bnez: 'bne', blez: 'bge', bgez: 'bge', bltz: 'blt', bgtz: 'blt' }[op];
        return out(base, op === 'blez' || op === 'bgtz' ? ['zero', a[0], a[1]] : [a[0], 'zero', a[1]]);
      }
      if (['bgt', 'ble', 'bgtu', 'bleu'].includes(op)) { count(n, 3); return out({ bgt: 'blt', ble: 'bge', bgtu: 'bltu', bleu: 'bgeu' }[op], [a[1], a[0], a[2]]); }
      if (op === 'csrr') { count(n, 2); return out('csrrs', [a[0], a[1], 'zero']); }
      if (['csrw', 'csrs', 'csrc', 'csrwi', 'csrsi', 'csrci'].includes(op)) {
        count(n, 2); return out({ csrw: 'csrrw', csrs: 'csrrs', csrc: 'csrrc', csrwi: 'csrrwi', csrsi: 'csrrsi', csrci: 'csrrci' }[op], ['zero', a[0], a[1]]);
      }
      return out(op, a);
    }
    function directiveSize(n) {
      const a = n.args, op = n.op, v = s => value(s, n);
      if (n.equ) return 0;
      if (op === '.option') {
        // Demos declare the extension already selected by their profile; Zmmul is a subset of M.
        if (a.length === 2 && a[0] === 'arch' && (a[1] === '+m' || a[1] === '+zmmul')) { if (profile === 'singlecycle') fail('Singlecycle implements RV32I: ' + (a[1] === '+m' ? 'M' : 'Zmmul') + ' is not available'); return 0; }
        count(n, 1); if (!['norvc', 'norelax'].includes(a[0])) fail(a[0] === 'rvc' ? 'Compressed instructions are not available; use .option norvc' : 'Unsupported .option ' + a[0]); return 0; }
      if (op === '.globl' || op === '.global') { if (!a.length || a.some(x => !/^[A-Za-z_.$][\w.$]*$/.test(x))) fail('Expected symbol names'); return 0; }
      if (['.word', '.half', '.byte'].includes(op)) { if (!a.length) fail(op + ' needs at least one value'); return a.length * ({ '.word': 4, '.half': 2, '.byte': 1 }[op]); }
      if (['.ascii', '.asciz', '.string'].includes(op)) { if (!a.length) fail(op + ' needs a string'); return a.reduce((sum, s) => sum + stringBytes(s).length + (op !== '.ascii' ? 1 : 0), 0); }
      if (op === '.space' || op === '.zero') { count(n, 1, 2); if (a[1]) range(v(a[1]), -128, 255, 'Fill byte'); return range(v(a[0]), 0, 32768, 'Space size'); }
      if (['.align', '.p2align', '.balign'].includes(op)) {
        count(n, 1, 3); let align = v(a[0]);
        if (op !== '.balign') align = 2 ** range(align, 0, 15, 'Alignment exponent');
        range(align, 1, 32768, 'Alignment'); if ((align & (align - 1)) !== 0) fail('Alignment must be a power of two');
        n.align = align; if (a[1]) range(v(a[1]), -128, 255, 'Fill byte');
        // GNU as assumes its minimum 4-byte instruction alignment in code;
        // smaller implicit code alignments emit nothing. Explicit byte fills work.
        const pad = n.section === '.text' && align <= 4 && !a[1] ? 0 : (align - n.offset % align) % align;
        return a[2] && pad > range(v(a[2]), 0, 32768, 'Maximum alignment skip') ? 0 : pad;
      }
      fail('Unsupported directive ' + op);
    }
    // Recompute until variable-sized li and section alignment reach a fixed point.
    let bases = { '.text': 0, '.data': 0x80000000, '.rodata': 0x80000000, '.bss': 0x80000000 }, sizes, stable = false;
    for (let pass = 0; pass < 32; pass++) {
      let changed = false; sizes = Object.fromEntries(sections.map(s => [s, 0]));
      for (const n of nodes) {
        const address = bases[n.section] + sizes[n.section]; if (address !== n.address) changed = true;
        n.address = address; n.offset = sizes[n.section];
        try {
          const size = n.label ? 0 : n.op[0] === '.' ? directiveSize(n) : expansion(n, true).length * 4;
          if (size !== n.size) changed = true; n.size = size;
          sizes[n.section] += size;
          if (sizes[n.section] > 32768) fail(n.section + ' exceeds the 32 KiB memory region');
        } catch (e) { error(e, n); }
      }
      if (result.errors.length) return result;
      for (const sec of sections) {
        const alignment = nodes.reduce((max, n) => n.section === sec ? Math.max(max, n.align || 1) : max, sec === '.text' ? 4 : 1);
        sizes[sec] = Math.ceil(sizes[sec] / alignment) * alignment;
      }
      let end = 0x80000000;
      for (const sec of sections.slice(1)) {
        const align = nodes.reduce((max, n) => n.section === sec ? Math.max(max, n.align || 1) : max, 1);
        const base = Math.ceil(end / align) * align; if (base !== bases[sec]) changed = true; bases[sec] = base; end = base + sizes[sec];
      }
      if (end - 0x80000000 > 32768) { error(new Error('Data sections exceed the 32 KiB memory region'), nodes[nodes.length - 1]); return result; }
      if (!changed) { stable = true; break; }
    }
    if (sizes['.text'] > 32768) { error(new Error('.text exceeds the 32 KiB memory region'), { line: 1 }); return result; }
    if (!stable) { error(new Error('Assembly layout did not converge; use constant sizes'), { line: 1 }); return result; }
    function encode(op, a, n) {
      const ctx = Object.assign({}, n, { op, args: a }), v = s => value(s, n), r = reg;
      const imm = s => range(signed(range(v(s), -2147483648, 4294967295, 'Immediate')), -2048, 2047, 'Immediate');
      const I = (opcode, f, rd, rs, x) => ((x & 4095) << 20 | rs << 15 | f << 12 | rd << 7 | opcode) >>> 0;
      const memory = s => { const m = s.match(/^(.*)\(([^()]+)\)$/); if (!m) fail('Expected offset(register)'); return [r(m[2].trim()), imm(m[1].trim() || '0')]; };
      const R = { add: [0, 0], sub: [0, 32], sll: [1, 0], slt: [2, 0], sltu: [3, 0], xor: [4, 0], srl: [5, 0], sra: [5, 32], or: [6, 0], and: [7, 0], mul: [0, 1], mulh: [1, 1], mulhsu: [2, 1], mulhu: [3, 1], div: [4, 1], divu: [5, 1], rem: [6, 1], remu: [7, 1] };
      if (profile === 'singlecycle' && (op.startsWith('mul') || ['div', 'divu', 'rem', 'remu'].includes(op))) fail('Singlecycle implements RV32I: ' + op.toUpperCase() + ' is not available');
      if (Object.hasOwn(R, op)) { count(ctx, 3); return (R[op][1] << 25 | r(a[2]) << 20 | r(a[1]) << 15 | R[op][0] << 12 | r(a[0]) << 7 | 0x33) >>> 0; }
      const immediates = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
      if (Object.hasOwn(immediates, op)) { count(ctx, 3); return I(0x13, immediates[op], r(a[0]), r(a[1]), imm(a[2])); }
      if (['slli', 'srli', 'srai'].includes(op)) { count(ctx, 3); return I(0x13, op === 'slli' ? 1 : 5, r(a[0]), r(a[1]), range(v(a[2]), 0, 31, 'Shift amount') | (op === 'srai' ? 1024 : 0)); }
      if (op === 'lui' || op === 'auipc') { count(ctx, 2); return (range(v(a[1]), 0, 0xfffff, 'Upper immediate') << 12 | r(a[0]) << 7 | (op === 'lui' ? 0x37 : 0x17)) >>> 0; }
      if (['lb', 'lh', 'lw', 'lbu', 'lhu'].includes(op)) { count(ctx, 2); const [rs, x] = memory(a[1]); return I(3, { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 }[op], r(a[0]), rs, x); }
      if (['sb', 'sh', 'sw'].includes(op)) { count(ctx, 2); const [rs, x] = memory(a[1]); return ((x & 0xfe0) << 20 | r(a[0]) << 20 | rs << 15 | { sb: 0, sh: 1, sw: 2 }[op] << 12 | (x & 31) << 7 | 0x23) >>> 0; }
      const branch = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
      if (Object.hasOwn(branch, op)) {
        count(ctx, 3); const x = range(v(a[2]) - n.address, -4096, 4094, 'Branch displacement'); if (x % 2) fail('Branch target must be 2-byte aligned');
        return ((x & 4096) << 19 | (x & 0x7e0) << 20 | r(a[1]) << 20 | r(a[0]) << 15 | branch[op] << 12 | (x & 30) << 7 | (x & 2048) >> 4 | 0x63) >>> 0;
      }
      if (op === 'jal') {
        count(ctx, 1, 2); const rd = a.length === 1 ? 1 : r(a[0]), x = range(v(a[a.length - 1]) - n.address, -1048576, 1048574, 'Jump displacement'); if (x % 2) fail('Jump target must be 2-byte aligned');
        return ((x & 0x100000) << 11 | (x & 0x7fe) << 20 | (x & 0x800) << 9 | x & 0xff000 | rd << 7 | 0x6f) >>> 0;
      }
      if (op === 'jalr') {
        count(ctx, 1, 3); let rd = 1, rs, x = 0;
        if (a.length === 1) { if (a[0].includes('(')) [rs, x] = memory(a[0]); else rs = r(a[0]); }
        else { rd = r(a[0]); if (a.length === 2) { if (a[1].includes('(')) [rs, x] = memory(a[1]); else rs = r(a[1]); } else { rs = r(a[1]); x = imm(a[2]); } }
        return I(0x67, 0, rd, rs, x);
      }
      const system = { ecall: 0x00000073, ebreak: 0x00100073, mret: 0x30200073, wfi: 0x10500073, 'fence.i': 0x100f };
      if (Object.hasOwn(system, op)) { count(ctx, 0); return system[op]; }
      if (op === 'fence') {
        if (a.length !== 0 && a.length !== 2) fail('fence expects no operands or predecessor, successor');
        function bits(s) { if (!/^i?o?r?w?$/.test(s) || !s) fail('Fence sets must be nonempty ordered iorw letters'); return (s.includes('i') ? 8 : 0) | (s.includes('o') ? 4 : 0) | (s.includes('r') ? 2 : 0) | (s.includes('w') ? 1 : 0); }
        return ((a.length ? bits(a[0]) << 4 | bits(a[1]) : 255) << 20 | 0xf) >>> 0;
      }
      const csr = { csrrw: 1, csrrs: 2, csrrc: 3, csrrwi: 5, csrrsi: 6, csrrci: 7 };
      if (Object.hasOwn(csr, op)) { count(ctx, 3); const address = Object.hasOwn(csrs, a[1]) ? csrs[a[1]] : v(a[1]); return I(0x73, csr[op], r(a[0]), op.endsWith('i') ? range(v(a[2]), 0, 31, 'CSR immediate') : r(a[2]), range(address, 0, 4095, 'CSR address')); }
      if (/^c\./.test(op)) fail('Compressed instructions are not available');
      fail('Unknown or unsupported instruction "' + op + '" for ' + profiles[profile].isa);
    }
    const code = new Uint8Array(sizes['.text']), data = new Uint8Array(bases['.bss'] + sizes['.bss'] - 0x80000000);
    function emit(n, offset, x, size) {
      const address = n.address + offset, bytes = n.section === '.text' ? code : data, at = address - (n.section === '.text' ? 0 : 0x80000000);
      for (let i = 0; i < size; i++) bytes[at + i] = x >>> (i * 8) & 255;
      result.listing.push({ address, word: x >>> 0, size, line: n.line, source: n.source });
    }
    for (const n of nodes) {
      if (n.label) continue;
      try {
        if (n.op[0] !== '.') {
          if (n.section !== '.text') fail('Instructions must be in .text');
          if (n.address % 4) fail('Instruction address must be 4-byte aligned; use .balign 4');
          expansion(n, false).forEach(([op, args], i) => emit(n, i * 4, encode(op, args, Object.assign({}, n, { address: n.address + i * 4 })), 4));
        } else if (['.word', '.half', '.byte'].includes(n.op)) {
          const size = { '.word': 4, '.half': 2, '.byte': 1 }[n.op];
          n.args.forEach((s, i) => { const x = range(value(s, Object.assign({}, n, { address: n.address + i * size })), -(2 ** (size * 8 - 1)), 2 ** (size * 8) - 1, 'Data value'); if (n.section === '.bss' && x) fail('.bss only accepts zero data'); emit(n, i * size, x & (size === 4 ? -1 : 2 ** (size * 8) - 1), size); });
        } else if (['.ascii', '.asciz', '.string'].includes(n.op)) {
          let offset = 0; for (const s of n.args) { const bytes = stringBytes(s); if (n.op !== '.ascii') bytes.push(0); for (const b of bytes) { if (n.section === '.bss' && b) fail('.bss only accepts zero data'); emit(n, offset++, b, 1); } }
        } else if (n.size) {
          const alignment = ['.align', '.p2align', '.balign'].includes(n.op), fill = n.args[1] ? value(n.args[1], n) & 255 : 0;
          if (n.section === '.bss' && fill) fail('.bss only accepts zero data');
          // GNU fills executable alignment with 32-bit NOPs (leading zero bytes
          // if the location itself is unaligned); explicit fill is a byte.
          for (let i = 0; i < n.size;) {
            if (alignment && n.section === '.text' && !n.args[1] && n.size - i >= 4 && (n.size - i) % 4 === 0) { emit(n, i, 0x13, 4); i += 4; }
            else if (alignment && n.section === '.text' && !n.args[1] && (n.size - i) % 4 === 2) { emit(n, i, 1, 2); i += 2; }
            else { emit(n, i, fill, 1); i++; }
          }
        }
      } catch (e) {
        if (!e.column) { const bad = e.message.match(/"([^"]+)"/); if (bad && n.source.includes(bad[1])) e.column = n.source.indexOf(bad[1]) + 1; }
        error(e, n);
      }
    }
    for (const sec of sections) {
      const last = nodes.filter(n => n.section === sec).pop();
      if (!last) continue;
      const used = last.offset + last.size;
      const tail = Object.assign({}, last, { address: bases[sec] + used });
      let remaining = sizes[sec] - used, offset = 0;
      while (remaining > 0) {
        const size = sec === '.text' && remaining % 4 === 0 ? 4 : sec === '.text' && remaining % 4 === 2 ? 2 : 1;
        emit(tail, offset, sec === '.text' ? size === 4 ? 0x13 : size === 2 ? 1 : 0 : 0, size);
        offset += size; remaining -= size;
      }
    }
    for (const [name, n] of Object.entries(definitions)) {
      try { Object.defineProperty(result.symbols, name, { value: n.equ ? value(n.equ, n, [n]) : n.address, enumerable: true }); } catch (e) { error(e, n); }
    }
    result.ok = !result.errors.length;
    if (result.ok) result.segments = [{ base: 0, bytes: code }, { base: 0x80000000, bytes: data }];
    else result.listing = [];
    return result;
  }
  profiles.hazard3_ahb = profiles.hazard3;
  return { assemble, profiles };
});
