/* Prism peripheral documentation engine. Metadata supplies geometry; the lexer
   copies the selected module's adjacent line-comment header without interpreting
   behavior. Headers remain JSON metadata; the preview and script-free export
   render the register reference without a duplicate module-header section. */
(function (root) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const TOML = node ? require('./vendor/smol-toml-1.9.1.cjs') : root.PrismTOML;
  const MAX = 1024 * 1024;
  const KEYWORDS = new Set(('alignas alignof asm auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile wchar_t while restrict and and_eq bitand bitor compl not not_eq or or_eq xor xor_eq concept requires co_await co_return co_yield consteval constinit char8_t char16_t char32_t decltype dynamic_cast static_cast const_cast thread_local static_assert typeid final override').split(' '));
  const NOTICE = {
    header_absent: 'No adjacent // module header was found.',
    header_separated_by_blank_line: 'A blank line separates the header from the module; the header was not copied.',
    header_block_comment_unsupported: 'Block-comment module headers are not copied by this version.',
    header_stopped_at_directive: 'Header copying stopped at a tool directive.',
    retired_register_form: 'Retired standalone register input was read; use interfaces.software in new descriptions.',
    component_name_differs: 'The component name differs from the register layout name.',
    region_binding_unverified: 'The map binding names a different register-description file; verify the selected pairing.'
  };
  function fail(message) { throw new Error(message); }
  function context(name, action) {
    try { return action(); }
    catch (error) { fail(name + ': ' + error.message); }
  }
  function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(v, key) { return Object.prototype.hasOwnProperty.call(v, key); }
  function id(v) {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]*$/.test(v) || KEYWORDS.has(v)) fail('Invalid register-layout identifier: ' + String(v));
    return v;
  }
  function integer(v, low, high, what) {
    if (typeof v !== 'bigint' || v < BigInt(low) || v > BigInt(high)) fail(what + ' must be an integer in ' + low + '…' + high);
    return Number(v);
  }
  function basename(value) { return String(value).split(/[\\/]/).pop(); }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function registerIdentity(registers) {
    return stable(registers.map(r => ({ name: r.name, offset: r.offset, access: r.access,
      fields: r.fields.slice().sort((a, b) => a.name.localeCompare(b.name)) })));
  }
  function file(input) {
    if (!input || typeof input.text !== 'string' || !input.name) fail('Choose the required input file.');
    if (new TextEncoder().encode(input.text).length > MAX) fail(basename(input.name) + ': file exceeds 1 MiB');
    return { name: basename(input.name), text: input.text };
  }
  function parse(input) {
    input = file(input);
    try { return TOML.parse(input.text, { integersAsBigInt: true }); }
    catch (error) { fail(input.name + ': ' + error.message); }
  }
  function layout(data) {
    id(data.name);
    if (!object(data.interfaces)) fail('Register description requires interfaces.software');
    id(data.interfaces.software);
    if (!Array.isArray(data.registers) || !data.registers.length) fail('registers must be a nonempty array');
    let end = 0;
    const names = new Set(), macros = new Set();
    const registers = data.registers.map(reg => {
      if (!object(reg) || Object.keys(reg).some(k => !['name', 'offset', 'access', 'fields'].includes(k))) fail('Register supports only name, offset, access and fields');
      const name = id(reg.name), offset = integer(reg.offset, 0, 0xfffffffc, name + '.offset');
      if (names.has(name) || offset < end || offset % 4) fail('Duplicate, overlapping, unordered or unaligned register ' + name);
      if (!['ro', 'rw', 'wo'].includes(reg.access)) fail(name + '.access must be ro, rw or wo');
      names.add(name); end = offset + 4;
      const fields = reg.fields === undefined ? {} : reg.fields;
      if (!object(fields)) fail(name + '.fields must be a table');
      const symbols = [name.toUpperCase() + '_OFFSET'];
      let bits = 0n;
      const result = Object.entries(fields).map(([field, spec]) => {
        id(field);
        if (!object(spec) || Object.keys(spec).sort().join(',') !== 'lsb,width') fail(name + '.' + field + ' requires exactly lsb and width');
        const low = integer(spec.lsb, 0, 31, field + '.lsb');
        const width = integer(spec.width, 1, 32 - low, field + '.width');
        const mask = ((1n << BigInt(width)) - 1n) << BigInt(low);
        if (bits & mask) fail('Overlapping fields in ' + name);
        bits |= mask;
        symbols.push(name.toUpperCase() + '_' + field.toUpperCase() + '_SHIFT', name.toUpperCase() + '_' + field.toUpperCase() + '_MASK');
        return { name: field, lsb: low, width: width, mask: Number(mask) };
      });
      if (symbols.some(symbol => macros.has(symbol))) fail('Generated register macro collision');
      symbols.forEach(symbol => macros.add(symbol));
      return { name, offset, access: reg.access, fields: result };
    });
    return { name: data.name, contract: data.interfaces.software, registers };
  }
  function mmioLayout(data) {
    if (!object(data.mmio)) fail('Memory map requires [mmio]');
    const m = data.mmio, base = integer(m.base, 0, 0xffffffff, 'MMIO base');
    const bytes = integer(m.bytes, 1, 0x100000000, 'MMIO bytes');
    if (base + bytes > 0x100000000 || base % 4096 || bytes % 4096) fail('Invalid MMIO aperture');
    if (m.peripheral_stride !== 4096n) fail('MMIO peripheral_stride must be 4096');
    if (!object(m.regions)) fail('MMIO regions must be a table');
    const required = ['sysctrl', 'timer', 'irq', 'gpio_a', 'uart', 'spi', 'i2c'];
    if (required.some(name => !own(m.regions, name))) fail('Missing required MMIO reservation');
    const result = {};
    for (const [name, r] of Object.entries(m.regions)) {
      if (!/^[a-z][a-z0-9_]*$/.test(name) || ['ram', 'boot_rom', 'mmio'].includes(name) || !object(r)) fail('Invalid MMIO reservation ' + name);
      const low = integer(r.base, 0, 0xffffffff, name + '.base');
      const length = integer(r.bytes, 1, 0x100000000, name + '.bytes');
      if (length !== 4096 || low % 4096 || low < base || low + length > base + bytes) fail('Invalid MMIO reservation alignment/size: ' + name);
      if (Object.values(result).some(other => low < other.base + other.bytes && other.base < low + length)) fail('MMIO reservations overlap: ' + name);
      result[name] = { base: low, bytes: length, registers: r.registers };
    }
    return result;
  }
  function header(text, selected) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(selected || '')) fail('Select an explicit simple module name for the RTL file');
    text = text.replace(/\r\n?/g, '\n');
    let i = 0, currentLine = 0;
    const tokens = [], comments = new Set();
    while (i < text.length) {
      const start = i;
      if (text.startsWith('//', i)) {
        comments.add(currentLine);
        const next = text.indexOf('\n', i); i = next < 0 ? text.length : next; continue;
      }
      if (text.startsWith('/*', i)) {
        const next = text.indexOf('*/', i + 2);
        if (next < 0) fail('Unterminated RTL block comment');
        i = next + 2; currentLine += (text.slice(start, i).match(/\n/g) || []).length; continue;
      }
      if (text[i] === '"') {
        i++;
        let closed = false;
        while (i < text.length) {
          if (text[i] === '\\') { i += 2; }
          else if (text[i++] === '"') { closed = true; break; }
        }
        if (!closed) fail('Unterminated RTL string');
        currentLine += (text.slice(start, i).match(/\n/g) || []).length;
        continue;
      }
      if (text[i] === '\\') {
        while (i < text.length && !/\s/.test(text[i])) i++;
        tokens.push({ value: text.slice(start, i), start }); continue;
      }
      if (/[A-Za-z_]/.test(text[i])) {
        i++;
        while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) i++;
        tokens.push({ value: text.slice(start, i), start }); continue;
      }
      if (!/\s/.test(text[i])) tokens.push({ value: text[i], start });
      if (text[i] === '\n') currentLine++;
      i++;
    }
    const found = [];
    tokens.forEach((token, n) => {
      if (!['module', 'macromodule'].includes(token.value)) return;
      let next = n + 1;
      if (tokens[next] && ['automatic', 'static'].includes(tokens[next].value)) next++;
      if (tokens[next] && tokens[next].value === selected) found.push(token.start);
    });
    if (found.length !== 1) fail('Module ' + selected + ' must be declared exactly once; found ' + found.length);
    const before = text.slice(0, found[0]), line = before.split('\n').length - 1;
    const lines = text.split('\n'), codes = [];
    if (before.slice(before.lastIndexOf('\n') + 1).trim()) return { header: null, codes: ['header_absent'] };
    const directive = /^\s*\/\/\s*(?:verilator\b|synopsys\b|synthesis\b|pragma\b|translate_off\b|translate_on\b|lint_)/i;
    const block = [];
    let cursor = line - 1;
    while (cursor >= 0 && /^\s*\/\//.test(lines[cursor]) && comments.has(cursor)) {
      if (directive.test(lines[cursor])) { codes.push('header_stopped_at_directive'); break; }
      block.unshift({ line: cursor + 1, text: lines[cursor].replace(/^\s*\/\/ ?/, '').replace(/\s+$/, '') }); cursor--;
    }
    while (block.length && !block[0].text) block.shift();
    while (block.length && !block[block.length - 1].text) block.pop();
    if (!block.length) {
      if (!codes.length && cursor >= 0 && !lines[cursor].trim()) {
        while (cursor >= 0 && !lines[cursor].trim()) cursor--;
        if (cursor >= 0 && /^\s*\/\//.test(lines[cursor]) && comments.has(cursor)) codes.push('header_separated_by_blank_line');
      }
      if (!codes.length && line && /\*\/\s*$/.test(lines[line - 1])) codes.push('header_block_comment_unsupported');
      if (!codes.length) codes.push('header_absent');
      return { header: null, codes };
    }
    return { header: { text: block.map(row => row.text).join('\n'), first_line: block[0].line, last_line: block[block.length - 1].line }, codes };
  }
  async function sha(text) {
    const bytes = new TextEncoder().encode(text);
    if (root.crypto && root.crypto.subtle) {
      return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    }
    if (node) return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    fail('This browser does not provide SHA-256 for local files; open the tool in a modern browser.');
  }
  async function generate(options) {
    const registerFile = file(options.registerFile), data = parse(registerFile);
    const notices = [], sources = [];
    const notice = code => { if (!notices.some(n => n.code === code)) notices.push({ code, message: NOTICE[code] }); };
    let form = 'sdk_description';
    if (own(data, 'schema_version') || own(data, 'contract')) {
      if (data.schema_version !== 1n || typeof data.contract !== 'string') fail('Retired register form requires schema_version = 1 and contract');
      data.interfaces = { software: data.contract }; form = 'retired_registers_toml'; notice('retired_register_form');
    } else if (Object.keys(data).some(k => !['name', 'interfaces', 'registers'].includes(k)) || Object.keys(data.interfaces || {}).some(k => k !== 'software')) form = 'component_manifest';
    const content = context(registerFile.name, () => layout(data));
    async function source(kind, input) { input = file(input); sources.push({ kind, name: input.name, sha256: await sha(input.text) }); return input; }
    await source('registers', registerFile);
    let manifest = form === 'component_manifest' ? data : null, manifestFile = registerFile;
    if (options.componentFile) {
      if (manifest) fail('Choose only one component manifest');
      manifestFile = await source('component', options.componentFile); manifest = parse(manifestFile);
    }
    let component = null;
    if (manifest) {
      id(manifest.name);
      const contract = manifest.interfaces && manifest.interfaces.software;
      if (contract !== undefined && contract !== content.contract) fail(manifestFile.name + ': component software contract does not match register description');
      if (manifest.registers && registerIdentity(context(manifestFile.name, () => layout(manifest)).registers) !== registerIdentity(content.registers)) fail(manifestFile.name + ': component register description differs from selected registers');
      const top = manifest.entrypoints && manifest.entrypoints.peripheral && manifest.entrypoints.peripheral.top;
      if (top !== undefined && (typeof top !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(top))) fail('Invalid component top module');
      const bytes = manifest.register_bytes === undefined ? null : integer(manifest.register_bytes, 1, Number.MAX_SAFE_INTEGER, 'register_bytes');
      component = { name: manifest.name, top: top || null, software_contract: contract || null, register_bytes: bytes, source: manifestFile.name };
      if (manifest.name !== content.name) notice('component_name_differs');
      if (bytes !== null && content.registers[content.registers.length - 1].offset + 4 > bytes) fail(manifestFile.name + ': register layout exceeds component register_bytes window');
    }
    let region = null, baseDigest = null;
    if (options.mapFile && options.baseRegion) fail('Select a custom map or a base region, not both');
    let binding;
    if (options.mapFile) {
      const mapFile = await source('memory_map', options.mapFile), regions = context(mapFile.name, () => mmioLayout(parse(mapFile)));
      if (!options.regionName || !own(regions, options.regionName)) fail('Choose an existing region from the custom memory map');
      const r = regions[options.regionName]; binding = r.registers;
      region = { name: options.regionName, base: r.base, bytes: r.bytes, source: 'memory_map' };
    } else if (options.baseRegion) {
      const base = options.baseReference;
      const r = base && base.memory.regions.find(r => r.id === options.baseRegion);
      if (!r) fail('Unknown base-map region');
      region = { name: r.id, base: r.base, bytes: r.bytes, source: 'base_reference' };
      baseDigest = base.provenance.digest;
    }
    if (region && content.registers[content.registers.length - 1].offset + 4 > region.bytes) fail('Register layout exceeds region reservation');
    if (typeof binding === 'string' && basename(binding) !== registerFile.name) notice('region_binding_unverified');
    let moduleInfo = null;
    if (options.rtlFile) {
      const rtl = await source('rtl', options.rtlFile), extracted = context(rtl.name, () => header(rtl.text, options.moduleName));
      extracted.codes.forEach(notice);
      moduleInfo = { name: options.moduleName, source: rtl.name, header: extracted.header };
    }
    const title = options.title || null;
    if (title !== null && (typeof title !== 'string' || title.length > 200)) fail('Title must be at most 200 characters');
    const document = { schema: 'prism-peripheral-doc-v1', generator: { name: 'prism-peripheral-docs', version: '1.0.0' }, title,
      name: content.name, contract: content.contract, register_input_form: form,
      base_address: region ? region.base : null, region, component, module: moduleInfo,
      registers: content.registers, notices, sources, base_reference_digest: baseDigest };
    if (new TextEncoder().encode(JSON.stringify(document, null, 2) + '\n').length > MAX) fail('Generated JSON exceeds 1 MiB; reduce the input or copied header so the document can be reopened');
    return document;
  }
  // A deliberately bounded validator for the committed schema's keywords. It
  // fails imported documents before either renderer uses their values.
  function schemaCheck(value, spec, path, schema) {
    if (spec.$ref) return schemaCheck(value, spec.$ref.slice(2).split('/').reduce((s, key) => s[key], schema), path, schema);
    if (spec.oneOf) {
      let matches = 0;
      spec.oneOf.forEach(s => { try { schemaCheck(value, s, path, schema); matches++; } catch (_) { /* another branch */ } });
      if (matches !== 1) fail(path + ': expected exactly one allowed shape');
    }
    if (own(spec, 'const') && value !== spec.const) fail(path + ': unexpected value');
    if (spec.enum && !spec.enum.includes(value)) fail(path + ': unsupported value');
    if (spec.type) {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      if (!(Array.isArray(spec.type) ? spec.type : [spec.type]).some(t => t === actual || t === 'integer' && typeof value === 'number' && Number.isSafeInteger(value))) fail(path + ': wrong type');
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || spec.minimum !== undefined && value < spec.minimum || spec.maximum !== undefined && value > spec.maximum || spec.multipleOf && value % spec.multipleOf) fail(path + ': numeric bounds');
    }
    if (typeof value === 'string' && (spec.minLength && value.length < spec.minLength || spec.maxLength && value.length > spec.maxLength || spec.pattern && !(new RegExp(spec.pattern)).test(value))) fail(path + ': invalid string');
    if (Array.isArray(value)) {
      if (spec.minItems && value.length < spec.minItems) fail(path + ': too few entries');
      if (spec.items) value.forEach((entry, i) => schemaCheck(entry, spec.items, path + '[' + i + ']', schema));
    }
    if (object(value)) {
      (spec.required || []).forEach(key => { if (!own(value, key)) fail(path + ': missing ' + key); });
      Object.keys(value).forEach(key => {
        if (spec.properties && own(spec.properties, key)) schemaCheck(value[key], spec.properties[key], path + '.' + key, schema);
        else if (spec.additionalProperties === false) fail(path + ': unknown ' + key);
      });
    }
  }
  function validate(doc, schema) {
    schemaCheck(doc, schema, 'document', schema);
    const raw = { name: doc.name, interfaces: { software: doc.contract }, registers: doc.registers.map(r => {
      const fields = Object.create(null);
      r.fields.forEach(f => {
        if (own(fields, f.name)) fail('Duplicate field ' + f.name);
        fields[f.name] = { lsb: BigInt(f.lsb), width: BigInt(f.width) };
      });
      return { name: r.name, offset: BigInt(r.offset), access: r.access, fields };
    }) };
    const normalized = layout(raw);
    if (stable(normalized.registers) !== stable(doc.registers)) fail('Register masks or geometry are inconsistent');
    if ((doc.region ? doc.region.base : null) !== doc.base_address) fail('Base address must equal region base');
    if (doc.region && (doc.region.base + doc.region.bytes > 0x100000000 || doc.registers[doc.registers.length - 1].offset + 4 > doc.region.bytes)) fail('Registers or reservation exceed address space');
    if (!!doc.base_reference_digest !== !!(doc.region && doc.region.source === 'base_reference')) fail('Base-reference digest does not match region source');
    if (doc.component && doc.component.software_contract && doc.component.software_contract !== doc.contract) fail('Component contract mismatch');
    if (doc.component && doc.component.register_bytes !== null && doc.registers[doc.registers.length - 1].offset + 4 > doc.component.register_bytes) fail('Register layout exceeds component register_bytes window');
    doc.sources.forEach(s => { if (basename(s.name) !== s.name || /[\x00-\x1f]/.test(s.name) || /^[A-Za-z]:/.test(s.name)) fail('Sources must use file names without local paths'); });
    if (doc.component && !doc.sources.some(s => ['registers', 'component'].includes(s.kind) && s.name === doc.component.source)) fail('Component source is missing');
    if (doc.module) {
      if (!doc.sources.some(s => s.kind === 'rtl' && s.name === doc.module.source)) fail('RTL source is missing');
      if (doc.module.header && doc.module.header.last_line < doc.module.header.first_line) fail('Invalid header line range');
    }
    return doc;
  }
  function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function hex(n) { return '0x' + n.toString(16).toUpperCase().padStart(8, '0'); }
  function article(doc) {
    let text = '<article class="peripheral-document"><p class="eyebrow">Peripheral reference</p><h1>' + escape(doc.title || doc.name) + '</h1><p class="lede"><code>' + escape(doc.name) + '</code> · <code>' + escape(doc.contract) + '</code></p>';
    if (doc.component) text += '<p>Component <code>' + escape(doc.component.name) + '</code>' + (doc.component.top ? ' · top <code>' + escape(doc.component.top) + '</code>' : '') + (doc.component.register_bytes !== null ? ' · register window ' + doc.component.register_bytes + ' bytes' : '') + '</p>';
    text += '<h2>Registers</h2><div class="table-scroll stack"><table class="stack-table"><thead><tr><th>Offset</th>' + (doc.region ? '<th>Address</th>' : '') + '<th>Register</th><th>Access</th><th>Fields</th></tr></thead><tbody>';
    let end = 0;
    doc.registers.forEach(reg => {
      if (reg.offset > end) text += '<tr><td data-label="Offset"><code>' + hex(end) + '–' + hex(reg.offset - 1) + '</code></td><td colspan="' + (doc.region ? 4 : 3) + '" data-label="Gap">no register described</td></tr>';
      text += '<tr><td data-label="Offset"><code>' + hex(reg.offset) + '</code></td>' + (doc.region ? '<td data-label="Address"><code>' + hex(doc.base_address + reg.offset) + '</code></td>' : '') + '<td data-label="Register"><code>' + escape(reg.name) + '</code></td><td data-label="Access"><span class="access ' + reg.access + '">' + escape(reg.access) + '</span></td><td data-label="Fields">' + reg.fields.map(f => '<span class="field-chip">' + escape(f.name) + ' [' + (f.lsb + f.width - 1) + ':' + f.lsb + '] · lsb ' + f.lsb + ', width ' + f.width + ', mask ' + hex(f.mask) + '</span>').join(' ') + '</td></tr>';
      end = reg.offset + 4;
    });
    text += '</tbody></table></div>';
    if (doc.region) text += '<h2>Reserved region</h2><p><code>' + escape(doc.region.name) + '</code> · ' + hex(doc.region.base) + ' · ' + doc.region.bytes + ' reserved bytes · ' + escape(doc.region.source) + '</p><p class="source-line">This is an address reservation; installed devices are selected by the SoC.</p>' + (doc.base_reference_digest ? '<p class="source-line">Base reference <code>' + doc.base_reference_digest + '</code></p>' : '');
    if (doc.notices.length) text += '<h2>Notices</h2><ul>' + doc.notices.map(n => '<li><code>' + escape(n.code) + '</code>: ' + escape(n.message) + '</li>').join('') + '</ul>';
    text += '<h2>Sources</h2><ul class="doc-sources">' + doc.sources.map(s => '<li>' + escape(s.kind) + ' · <code>' + escape(s.name) + '</code><br><code>' + s.sha256 + '</code></li>').join('') + '</ul></article>';
    return text;
  }
  function html(doc, styles) {
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'"><title>' + escape(doc.title || doc.name) + ' — Prism peripheral reference</title><style>' + styles + '\n.standalone-doc{max-width:72rem;margin:0 auto}.doc-sources code{overflow-wrap:anywhere}</style></head><body><main class="standalone-doc">' + article(doc) + '</main></body></html>\n';
  }
  const api = { generate, validate, article, html, parse, layout, mmioLayout, header, sha, file, MAX };
  if (node) module.exports = api;
  else root.PrismPeripheralDocs = api;
})(typeof globalThis === 'object' ? globalThis : this);
