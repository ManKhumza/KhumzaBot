/* Execute authoritative Electron TypeScript without starting a desktop/profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'apps/desktop/electron/node_modules/typescript'));

function loadSource(file, overrides = {}, globals = {}, suffix = '') {
  const absolute = path.join(root, file);
  const source = fs.readFileSync(absolute, 'utf8') + suffix;
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name in overrides) return overrides[name];
    if (name.startsWith('.')) return loadSource(path.relative(root, path.resolve(path.dirname(absolute), name + '.ts')), overrides, globals);
    return require(name);
  };
  vm.runInNewContext(`(function(require, exports, module, __dirname) { ${output}\n})(require, exports, module, __dirname);`, { require: localRequire, exports: module.exports, module, __dirname: path.join(root, 'apps/desktop/electron/dist/electron'), process,
    console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, Headers, Request, Response, AbortSignal, AbortController, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, ...globals }, { filename: file });
  return module.exports;
}

function mainHarness() {
  const handlers = new Map();
  const calls = [];
  const frame = { url: 'file:///test/renderer/index.html' };
  const webContents = { mainFrame: frame, send() {}, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const electron = {
    app: { isPackaged: true, on() {}, getVersion: () => 'test', setPath() {}, getPath: () => '/test', requestSingleInstanceLock: () => true },
    BrowserWindow: { getAllWindows: () => [window] },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: {}, shell: { openExternal: async url => calls.push(url), openPath: async value => { calls.push(value); return ''; } }, session: {},
  };
  const main = loadSource('apps/desktop/electron/main.ts', { electron, fs: { ...fs, existsSync: () => false } }, {
    fetch: async input => { calls.push(input); return new Response('{}', { status: 200 }); },
    process: { env: {}, platform: process.platform, pid: process.pid, resourcesPath: path.join(root, 'missing-test-runtime'), on() {} },
  }, '\nexports.testHarness = (window) => { mainWindow = window; window.webContents.mainFrame.url = rendererUrl; backendPort = 12345; setupIpcHandlers(); };' +
    '\nexports.pendingStartup = (pending, port, token) => { backendStartupPromise = pending; backendPort = port; backendToken = token; supervisor.state = "ready"; };' +
    '\nexports.stopOwned = (owned) => { backendProcess = owned; backendStartupPromise = new Promise(() => {}); return stopBackend(); };');
  main.testHarness(window);
  return { handlers, calls, main, event: { sender: webContents, senderFrame: frame } };
}

test('Electron rejects executable URL protocols before invoking the operating system', async () => {
  const h = mainHarness();
  await assert.rejects(h.handlers.get('shell:openExternal')(h.event, 'file:///C:/Windows/System32/calc.exe'));
  assert.equal(h.calls.length, 0);
});

test('Electron generic proxy cannot invoke the private shutdown endpoint', async () => {
  const h = mainHarness();
  await assert.rejects(h.handlers.get('backend:request')(h.event, { method: 'POST', path: '/internal/prepare-shutdown' }));
  assert.equal(h.calls.length, 0);
});

test('Electron IPC rejects a subframe even when its URL resembles the app', async () => {
  const h = mainHarness();
  await assert.rejects(Promise.resolve().then(() => h.handlers.get('app:getVersion')({ ...h.event, senderFrame: { url: h.event.senderFrame.url } })));
});

test('A failed backend restart rejects instead of returning success', async () => {
  const h = mainHarness();
  await assert.rejects(h.handlers.get('nocai:system:restartBackend')(h.event));
});

test('Shutdown cleanup bypasses pending readiness and cannot await its own restart', async () => {
  const h = mainHarness();
  const owned = new (require('node:events').EventEmitter)();
  owned.exitCode = null; owned.signalCode = null;
  owned.stdin = { end: () => { owned.exitCode = 0; owned.emit('exit', 0); } };
  let timer;
  try {
    await Promise.race([h.main.stopOwned(owned), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Shutdown deadlocked waiting for startup')), 1000); })]);
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].endsWith('/internal/prepare-shutdown'));
  } finally { clearTimeout(timer); }
});

test('An IPC request queued during restart uses the new backend port after readiness', async () => {
  const h = mainHarness();
  let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const token = require('node:crypto').randomBytes(32).toString('hex');
  h.main.pendingStartup(pending, 21000, token);
  const request = h.handlers.get('nocai:auth:getStatus')(h.event);
  h.main.pendingStartup(pending, 22000, token);
  ready(); await request;
  assert.equal(h.calls[0], 'http://127.0.0.1:22000/api/v1/auth/status');
});

test('Navigation rejects unrelated files, web ports, credentials and app subframes', () => {
  const { isTrustedRendererUrl } = loadSource('apps/desktop/electron/security-policy.ts');
  const appUrl = 'file:///C:/application/renderer/index.html';
  assert.equal(isTrustedRendererUrl(appUrl + '#/diagnostics', appUrl), true);
  for (const value of ['file:///C:/untrusted.html', 'http://127.0.0.1:5544/', 'https://localhost:5173/', appUrl + '?injected=yes']) {
    assert.equal(isTrustedRendererUrl(value, appUrl), false);
  }
});

test('Proxy enforces canonical API routes, method restrictions and bounded JSON', () => {
  const { validateProxyRequest } = loadSource('apps/desktop/electron/security-policy.ts');
  assert.equal(validateProxyRequest('GET', '/api/v1/jobs?status=failed').path, '/api/v1/jobs?status=failed');
  assert.equal(validateProxyRequest('POST', '/api/v1/chat/completions', { message: 'test fixture' }).method, 'POST');
  for (const invalid of ['/internal/prepare-shutdown', '//example.org/api/v1/jobs', '/api/v1/../internal/prepare-shutdown', '/api/v1/chat/conversations/%2e%2e', '/api/v1/jobs#x', '/api/v1/jobs\\..']) {
    assert.throws(() => validateProxyRequest('POST', invalid));
  }
  assert.throws(() => validateProxyRequest('TRACE', '/api/v1/jobs'));
  assert.throws(() => validateProxyRequest('POST', '/api/v1/chat/completions', { message: 'a'.repeat(1024 * 1024) }));
});

test('Opening application folders cannot execute files or escape through junctions', () => {
  const { validateDirectoryToOpen } = loadSource('apps/desktop/electron/security-policy.ts');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-electron-path-'));
  try {
    const data = path.join(fixture, 'profile');
    const outside = path.join(fixture, 'outside');
    fs.mkdirSync(data); fs.mkdirSync(outside);
    const executable = path.join(data, 'not-an-executable.exe');
    fs.writeFileSync(executable, 'test fixture');
    fs.symlinkSync(outside, path.join(data, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(validateDirectoryToOpen(data, data), fs.realpathSync(data));
    assert.throws(() => validateDirectoryToOpen(executable, data));
    assert.throws(() => validateDirectoryToOpen(outside, data));
    assert.throws(() => validateDirectoryToOpen(path.join(data, 'escape'), data));
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('Supervisor coalesces concurrent starts and restarts without overlapping children', async () => {
  const { BackendSupervisor } = loadSource('apps/desktop/electron/backend-supervisor.ts');
  let live = 0; let starts = 0; let stops = 0; let maximum = 0;
  const owner = new BackendSupervisor({
    start: async () => { starts++; maximum = Math.max(maximum, ++live); await new Promise(resolve => setTimeout(resolve, 5)); },
    stop: async () => { stops++; live = 0; }, stateChanged() {},
  }, 10, 60000, 1);
  const first = owner.start();
  assert.equal(owner.start(), first);
  await Promise.all([first, owner.start(), owner.start()]);
  const restart = owner.restart();
  assert.equal(owner.restart(), restart);
  await Promise.all([restart, owner.restart()]);
  assert.equal(starts, 2); assert.equal(maximum, 1); assert.equal(live, 1); assert.equal(owner.state, 'ready');
  await owner.stop(true);
  assert.equal(live, 0); assert.equal(owner.state, 'stopped'); assert.equal(stops, 2);
  await assert.rejects(owner.start());
});

test('Stopping during startup cancels the probe and settles without a readiness deadlock', async () => {
  const { BackendSupervisor } = loadSource('apps/desktop/electron/backend-supervisor.ts');
  let live = false;
  const owner = new BackendSupervisor({
    start: async signal => { live = true; await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); },
    stop: async () => { live = false; }, stateChanged() {},
  }, 3, 60000, 1);
  const starting = owner.start();
  const observed = assert.rejects(starting);
  await owner.stop(); await observed;
  assert.equal(owner.state, 'stopped'); assert.equal(live, false);
});

test('Faulty readiness uses bounded backoff and a restart circuit breaker with child cleanup', async () => {
  const { BackendSupervisor } = loadSource('apps/desktop/electron/backend-supervisor.ts');
  let starts = 0; let stops = 0; let live = false; const states = [];
  const owner = new BackendSupervisor({
    start: async () => { assert.equal(live, false); starts++; live = true; throw new Error('Injected bind collision'); },
    stop: async () => { live = false; stops++; }, stateChanged: state => states.push(state),
  }, 3, 60000, 1);
  await assert.rejects(owner.start(), /restart limit/);
  assert.equal(starts, 3); assert.equal(stops, 3); assert.equal(live, false);
  assert.equal(owner.state, 'failed'); assert.equal(states.filter(state => state === 'backing_off').length, 2);
  await assert.rejects(owner.start()); assert.equal(starts, 3);
});

test('Failure to stop an owned process blocks replacement and reports failed state', async () => {
  const { BackendSupervisor } = loadSource('apps/desktop/electron/backend-supervisor.ts');
  let starts = 0;
  const owner = new BackendSupervisor({
    start: async () => { starts++; }, stop: async () => { throw new Error('Injected process cleanup failure'); }, stateChanged() {},
  }, 3, 60000, 1);
  await owner.start();
  await assert.rejects(owner.restart(), /cleanup failure/);
  assert.equal(starts, 1); assert.equal(owner.state, 'failed');
});

test('Diagnostic rotation is bounded, reloadable, and redacts credentials before writing', () => {
  const { DiagnosticJournal } = loadSource('apps/desktop/electron/diagnostics.ts');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-electron-log-'));
  const secret = require('node:crypto').randomBytes(32).toString('hex');
  try {
    const log = new DiagnosticJournal(fixture, 'test', () => [secret], 1024);
    for (let index = 0; index < 30; index++) log.record('backend', 'failure', `credential=${secret} Authorization=Bearer ${secret} password="random-fixture" {"content":"synthetic document body"}`);
    const files = fs.readdirSync(fixture);
    assert.ok(files.length <= 3);
    for (const file of files) {
      const contents = fs.readFileSync(path.join(fixture, file), 'utf8');
      assert.equal(contents.includes(secret), false); assert.equal(contents.includes('random-fixture'), false);
      assert.equal(contents.includes('synthetic document body'), false);
      assert.ok(Buffer.byteLength(contents) <= 1024);
    }
    assert.ok(new DiagnosticJournal(fixture, 'test', () => [secret], 1024).snapshot().length > 0);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

module.exports = { loadSource };
