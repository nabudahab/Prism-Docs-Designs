// Evaluate the built designs in headless Chrome: every representative page at
// desktop, tablet and phone widths, in both themes, plus the interactive tools.
//
//   node designs/tools/audit.cjs [design ...]      (default: every design in designs/dist)
//
// Prints one JSON report per design. A check that fails is listed with the
// page and viewport it failed on; nothing is fixed or hidden here.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

// DESIGNS_DIST points at another build output (python3 designs/build.py --out ...).
const dist = path.resolve(process.env.DESIGNS_DIST || path.resolve(__dirname, '../dist'));
const designs = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dist).filter(name => fs.existsSync(path.join(dist, name, 'index.html')));

const PAGES = [
  '#/', '#/guides', '#/guides/getting-started', '#/guides/configuration', '#/guides/peripherals', '#/guides/manifests',
  '#/tutorials/instantiate-core', '#/tutorials/custom-tile', '#/architecture', '#/architecture/datapath/singlecycle',
  '#/architecture/datapath/base', '#/architecture/datapath/hazard3', '#/architecture/caches', '#/architecture/caches/coherent',
  '#/architecture/coherent-bus', '#/architecture/system-bus', '#/architecture/system-bus/uart', '#/architecture/accelerators',
  '#/reference/address-map', '#/reference/address-map/uart', '#/reference/peripherals', '#/reference/peripherals/i2c',
  '#/reference/platformio', '#/tools/peripheral-docs', '#/tools/peripheral-docs-contract', '#/roadmap', '#/no-such-page'
];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 }, { name: 'laptop', width: 1280, height: 720 },
  { name: 'tablet', width: 820, height: 1180, mobile: true }, { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'small phone', width: 320, height: 640, mobile: true }
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-audit-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank']);
let socket, sequence = 0, events = [];
const pending = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function call(method, params = {}) {
  return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function open(site, hash, view, theme) {
  events = [];
  await call('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: !!view.mobile });
  await call('Emulation.setTouchEmulationEnabled', { enabled: !!view.mobile });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme || 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Page.navigate', { url: 'about:blank' });
  await call('Page.navigate', { url: 'file://' + path.join(site, 'index.html') + hash });
  for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete" && !!document.querySelector("#main > *")').catch(() => false)) break; await sleep(40); }
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
  await sleep(120);
}

// Runs in the page. Layout, structure and accessible-name checks.
const PAGE_CHECK = `(() => {
  const out = { problems: [] };
  const doc = document.documentElement;
  if (doc.scrollWidth > innerWidth + 1) out.problems.push('page scrolls sideways by ' + (doc.scrollWidth - innerWidth) + 'px');
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const h1 = [...document.querySelectorAll('h1')].filter(visible);
  if (h1.length !== 1) out.problems.push(h1.length + ' visible h1 headings');
  if (!document.querySelector('main')) out.problems.push('no main landmark');
  const name = el => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map(id => (document.getElementById(id) || {}).textContent || '').join(' ') || el.textContent || el.getAttribute('title') || el.value || el.getAttribute('placeholder') || '').trim();
  const unnamed = [...document.querySelectorAll('a[href], button, [role="tab"], summary')].filter(visible).filter(el => !name(el));
  if (unnamed.length) out.problems.push(unnamed.length + ' controls without an accessible name, e.g. ' + unnamed[0].outerHTML.slice(0, 90));
  const fields = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(visible)
    .filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'));
  if (fields.length) out.problems.push(fields.length + ' form fields without a label, e.g. ' + fields[0].outerHTML.slice(0, 90));
  // Shell controls only: the tools keep their own compact controls.
  if (matchMedia('(pointer: coarse)').matches) {
    const small = [...document.querySelectorAll('header a, header button, nav:not(.page-contents):not(.layer-tabs):not(.core-picker):not(.cache-tabs):not(.peripheral-guide-nav) a, nav button, nav summary')]
      .filter(el => !el.closest('main')).filter(visible).filter(el => { const r = el.getBoundingClientRect(); return r.height < 40 || r.width < 40; });
    if (small.length) out.problems.push(small.length + ' navigation targets under 40px, e.g. ' + small[0].outerHTML.slice(0, 80).replace(/\\s+/g, ' '));
  }
  const wide = [...document.querySelectorAll('main *')].filter(el => !el.closest('.table-scroll, pre, .cd, .cx, .coh, .sb, svg, .layer-tabs, .page-contents, .ce-source')).filter(visible)
    .filter(el => el.getBoundingClientRect().right > innerWidth + 1);
  if (wide.length) out.problems.push(wide.length + ' elements extend past the screen edge, e.g. ' + wide[0].outerHTML.slice(0, 80));
  out.title = document.title;
  return out;
})()`;

// Text measure of a reading page: characters that fit one full line of body prose.
const MEASURE = `(() => {
  const p = [...document.querySelectorAll('.guide-body > p')].find(el => el.textContent.length > 160 && !el.querySelector('code'));
  if (!p) return null;
  const probe = document.createElement('span'); probe.style.cssText = 'white-space:nowrap;position:absolute;visibility:hidden';
  const text = p.textContent; probe.textContent = text; p.appendChild(probe);
  const perChar = probe.getBoundingClientRect().width / text.length; probe.remove();
  const s = getComputedStyle(p);
  return { charsPerLine: Math.round(p.getBoundingClientRect().width / perChar), fontSize: parseFloat(s.fontSize), lineHeight: +(parseFloat(s.lineHeight) / parseFloat(s.fontSize)).toFixed(2) };
})()`;

// Contrast of the text colours each design defines, against its page colour.
const CONTRAST = `(() => {
  const probe = document.createElement('span'); probe.style.transition = 'none'; document.body.appendChild(probe);
  const rgb = value => { probe.style.color = value; return getComputedStyle(probe).color.match(/[\\d.]+/g).slice(0, 3).map(Number); };
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); };
  const v = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = {};
  ['--ink', '--muted', '--link', '--c-cache', '--c-bus', '--c-mmio', '--c-system', '--ok', '--caution', '--error'].forEach(name => { out[name] = ratio(v(name), v('--paper')); });
  out['--muted on --sunken'] = ratio(v('--muted'), v('--sunken'));
  probe.remove();
  return out;
})()`;

// The interactive tools: mounted, and the core simulator runs a program.
const TOOLS = {
  '#/architecture/datapath/base': `(async () => {
    const out = { diagram: !!document.querySelector('.core-diagram svg'), editor: !!document.querySelector('.ce-source'), sim: !!window.PrismSim };
    const slider = document.querySelector('.core-diagram [aria-label="Cycle"]');
    if (slider) { slider.value = 12; slider.dispatchEvent(new Event('input')); out.seek = /cycle\\s+12/i.test(document.querySelector('.core-diagram').textContent); }
    const run = document.querySelector('.core-editor-slot .ce-run'), status = document.querySelector('.core-editor-slot .ce-status');
    if (run && status) {
      const before = status.textContent; run.click();
      for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 100)); if (status.textContent !== before && run.textContent === 'Run') break; }
      out.ran = status.textContent.trim().slice(0, 120);
    }
    return out;
  })()`,
  '#/architecture/caches': `(() => ({ explorer: !!document.querySelector('.cache-explorer-slot > *'), controls: document.querySelectorAll('.cache-explorer-slot button').length }))()`,
  '#/architecture/caches/coherent': `(() => ({ coherence: !!document.querySelector('.cache-coherence-slot > *'), controls: document.querySelectorAll('.cache-coherence-slot button').length }))()`,
  '#/architecture/system-bus': `(() => ({ bus: !!document.querySelector('.system-bus-slot svg, .system-bus-slot .sb'), controls: document.querySelectorAll('.system-bus-slot button').length, registers: document.querySelectorAll('.peripheral-controls tbody tr').length }))()`,
  '#/architecture': `(() => { const parts = document.querySelectorAll('.arch-part[data-part], .arch-seam'); const b = document.querySelector('.arch-part[data-part="fabric"]'); if (b) b.click(); return { parts: parts.length, detail: (document.querySelector('#arch-detail h3') || {}).textContent }; })()`,
  '#/reference/address-map': `(async () => { const input = document.getElementById('region-search'); input.value = '0x40020008'; input.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 300)); return { regions: document.querySelectorAll('.region').length, lookup: (document.querySelector('.lookup') || {}).textContent, hit: document.querySelectorAll('tr.hit').length }; })()`,
  '#/tools/peripheral-docs': `(() => ({ form: !!document.querySelector('.generator-form'), inputs: document.querySelectorAll('.generator-form input, .generator-form select').length }))()`,
  '#/reference/platformio': `(() => ({ options: document.querySelectorAll('tbody tr').length }))()`
};

// Keyboard: the skip link comes first, and the design's search opens and finds a register.
const KEYBOARD = `(async () => {
  const out = {};
  document.body.focus();
  const first = [...document.querySelectorAll('a[href], button, input, select, summary, [tabindex="0"]')].find(el => el.getBoundingClientRect().width >= 0 && getComputedStyle(el).visibility !== 'hidden');
  out.firstFocusable = first ? (first.className || first.id || first.tagName) : null;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const input = document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
  out.searchOpensWithSlash = !!input;
  if (input) {
    input.value = 'uart.status'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const option = document.querySelector('[role="option"]');
    out.searchFirstResult = option ? option.textContent.trim().replace(/\\s+/g, ' ').slice(0, 70) : null;
    input.value = '0x40020008'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    out.addressLookup = ((document.querySelector('[role="option"]') || {}).textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
  }
  return out;
})()`;

async function main() {
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    chrome.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
    chrome.on('error', reject); chrome.on('exit', code => reject(new Error('Chrome exited ' + code)));
  });
  const targets = await (await fetch('http://127.0.0.1:' + new URL(endpoint).port + '/json/list')).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => socket.on('open', r));
  socket.on('message', b => {
    const m = JSON.parse(b);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') events.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).split('\n')[0]);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') events.push('console: ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 160));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') events.push('log: ' + m.params.entry.text.slice(0, 120));
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Log.enable');

  for (const design of designs) {
    const site = path.join(dist, design);
    const report = { design, pagesChecked: 0, failures: [], tools: {}, contrast: {}, measure: {}, keyboard: {} };
    for (const view of VIEWPORTS) {
      for (const hash of PAGES) {
        await open(site, hash, view);
        if (/datapath|caches|system-bus/.test(hash)) await sleep(350);
        const result = await evaluate(PAGE_CHECK);
        report.pagesChecked++;
        result.problems.concat(events).forEach(problem => report.failures.push(view.name + ' ' + hash + ': ' + problem));
        if (view.name === 'desktop' && TOOLS[hash]) report.tools[hash] = await evaluate(TOOLS[hash]);
        if (hash === '#/guides/configuration') report.measure[view.name] = await evaluate(MEASURE);
      }
    }
    for (const theme of ['light', 'dark']) {
      await open(site, '#/reference/address-map/uart', VIEWPORTS[0], theme);
      report.contrast[theme] = await evaluate(CONTRAST);
      const dark = await evaluate(PAGE_CHECK);
      dark.problems.concat(events).forEach(problem => report.failures.push(theme + ' theme: ' + problem));
    }
    await open(site, '#/guides/firmware', VIEWPORTS[0]);
    report.keyboard = await evaluate(KEYBOARD);
    console.log(JSON.stringify(report, null, 1));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => { try { socket && socket.close(); } catch (_) { /* closing */ } chrome.kill(); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300); });
