// Review tool for the design prototypes: screenshots and page measurements
// from headless Chrome over the DevTools protocol. Opens the built site from
// file://, so it needs no server.
//
//   node designs/tools/shot.cjs <spec.json | inline JSON>
//
// spec: { site: 'designs/dist/<name>', out: 'designs/build/shots/<name>',
//         shots: [{ name, hash, width?, height?, mobile?, theme?, full?, wait?, eval?, before? }] }
// `before` runs in the page before the capture; `eval` runs after it and its
// value is printed with the shot's console errors and horizontal overflow.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const arg = process.argv[2];
const spec = JSON.parse(fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg);
const site = path.resolve(spec.site), out = path.resolve(spec.out);
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shot-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank']);
let socket, sequence = 0, events = [];
const pending = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

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
    else if (m.method === 'Runtime.exceptionThrown') events.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) events.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description).join(' '));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') events.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Log.enable');
  const report = [];
  for (const shot of spec.shots) {
    events = [];
    const width = shot.width || 1440, height = shot.height || 900, mobile = !!shot.mobile;
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: shot.dsf || (mobile ? 2 : 1), mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await call('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: shot.theme === 'dark' ? 'dark' : 'light' },
      { name: 'prefers-reduced-motion', value: shot.motion ? 'no-preference' : 'reduce' }] });
    await call('Page.navigate', { url: 'about:blank' });
    await call('Page.navigate', { url: 'file://' + path.join(site, 'index.html') + (shot.hash || '#/') });
    for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete" && !!document.querySelector("#main > *")').catch(() => false)) break; await sleep(50); }
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
    await sleep(shot.wait || 250);
    if (shot.before) { await evaluate(shot.before); await sleep(shot.wait || 250); }
    const metrics = await evaluate('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight })');
    const params = { format: 'png' };
    if (shot.full) {
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width, height: Math.min(metrics.sh, shot.maxHeight || 6000), scale: 1 };
    }
    const png = await call('Page.captureScreenshot', params);
    fs.writeFileSync(path.join(out, shot.name + '.png'), Buffer.from(png.data, 'base64'));
    const entry = { name: shot.name, overflowX: metrics.sw > metrics.iw ? metrics.sw - metrics.iw : 0, height: metrics.sh };
    if (shot.eval) entry.eval = await evaluate(shot.eval);
    if (events.length) entry.events = events.slice(0, 8);
    report.push(entry);
  }
  console.log(JSON.stringify(report, null, 1));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => { try { socket && socket.close(); } catch (_) { /* closing */ } chrome.kill(); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300); });
