const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect, root, processMetrics } = require('./fixtures.cjs');
const python = path.join(root, '.venv/Scripts/python.exe');

function backendMember(electronApp) {
  const children = processMetrics(electronApp.process().pid).filter(member => /^python(?:w)?\.exe$/i.test(member.name));
  // Windows virtual environments have a small launcher parent plus the actual
  // interpreter; packaged Python has just the interpreter. Count serving leaves.
  const interpreters = children.filter(member => processMetrics(member.pid).filter(child => /^python(?:w)?\.exe$/i.test(child.name)).length === 1);
  expect(interpreters).toHaveLength(1);
  return interpreters[0];
}

function controlOwned(member, operation) {
  // PID and birth time both match before fault injection; no broad process-name kill.
  execFileSync(python, ['-c',
    'import psutil,sys; p=psutil.Process(int(sys.argv[1])); assert abs(p.create_time()-float(sys.argv[2])) < 0.01; getattr(p,sys.argv[3])()',
    String(member.pid), String(member.started), operation,
  ], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
}

async function waitReady(page) {
  await expect.poll(() => page.evaluate(async () => (await window.nocai.system.getDiagnostics()).backend.state).catch(() => 'renderer-loading'),
    { timeout: 90000 }).toBe('ready');
}

test('backend death rejects an in-flight request, recovers once, and cleans old model processes', async ({ page, electronApp }) => {
  await waitReady(page);
  const original = backendMember(electronApp);
  const oldTree = processMetrics(original.pid);
  controlOwned(original, 'suspend');
  try {
    await page.evaluate(() => {
      window.__nocRecoveryRequest = 'pending';
      void window.nocai.system.getHealth().then(
        () => { window.__nocRecoveryRequest = 'resolved'; },
        () => { window.__nocRecoveryRequest = 'rejected'; },
      );
    });
    await expect.poll(() => page.evaluate(() => window.__nocRecoveryRequest)).toBe('pending');
    controlOwned(original, 'kill');
    await expect.poll(() => page.evaluate(() => window.__nocRecoveryRequest), { timeout: 15000 }).toBe('rejected');
    // Socket closure can reject the request before Electron receives the child
    // exit event. Observe a new process before accepting the new ready state.
    await expect.poll(() => processMetrics(electronApp.process().pid).some(member =>
      /^python(?:w)?\.exe$/i.test(member.name) && member.started > original.started),
    { timeout: 30000, message: 'Automatic recovery must start a replacement backend' }).toBe(true);
    await waitReady(page);
    const replacement = backendMember(electronApp);
    expect(replacement.pid).not.toBe(original.pid);
    for (const member of oldTree) {
      await expect.poll(() => processMetrics(member.pid).filter(current => current.started === member.started).length,
        { message: 'The crashed backend must not leave an old inference child behind', timeout: 20000 }).toBe(0);
    }
    const diagnostics = await page.evaluate(() => window.nocai.system.getDiagnostics());
    expect(diagnostics.recentErrors.some(entry => entry.component === 'backend' && entry.event === 'exit')).toBe(true);
    expect(diagnostics.backend.restartAttempts).toBeLessThanOrEqual(3);
    await expect(page.getByText('Create your administrator', { exact: true })).toBeVisible();
  } finally {
    const stillOwned = processMetrics(original.pid).some(member => member.pid === original.pid && member.started === original.started);
    if (stillOwned) controlOwned(original, 'resume');
    for (const member of [...oldTree].reverse()) {
      if (processMetrics(member.pid).some(current => current.pid === member.pid && current.started === member.started)) controlOwned(member, 'kill');
    }
  }
});

test('a renderer crash restores the interface and records a diagnostic without duplicating the backend', async ({ page, electronApp }) => {
  await waitReady(page);
  await expect(page.getByText('Create your administrator', { exact: true })).toBeVisible();
  const original = backendMember(electronApp);
  const rendererPid = await electronApp.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.once('render-process-gone', (_event, details) => { global.__rendererExit = details; });
    return contents.getOSProcessId();
  });
  const renderer = processMetrics(electronApp.process().pid).find(member => member.pid === rendererPid);
  expect(renderer).toBeTruthy();
  // Exercise Chromium's real crash path explicitly: external termination under
  // the automation debugger can leave the target without a renderer-exit event.
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  // Playwright retains the crashed target's action scope. Query the replacement
  // renderer through Electron while the application's own reload recreates it.
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }, oldPid) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return {
      replaced: contents.getOSProcessId() !== oldPid,
      crashed: contents.isCrashed(),
      loading: contents.isLoading(),
      exitReason: global.__rendererExit?.reason,
    };
  }, rendererPid), { timeout: 30000 }).toEqual({ replaced: true, crashed: false, loading: false, exitReason: expect.any(String) });
  await expect.poll(() => processMetrics(renderer.pid).filter(member =>
    member.pid === renderer.pid && member.started === renderer.started).length,
  { timeout: 15000, message: 'The original renderer process must exit after fault injection' }).toBe(0);
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
    'Boolean(window.nocai) && document.body.innerText.includes("Create your administrator")',
  )).catch(() => false), { timeout: 30000 }).toBe(true);
  const current = backendMember(electronApp);
  expect(current.pid).toBe(original.pid);
  expect(current.started).toBe(original.started);
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
    'window.nocai.system.getDiagnostics().then(d => d.recentErrors.some(e => e.event === "render-process-gone"))',
  )),
    { timeout: 30000 }).toBe(true);
});

test('concurrent restart clicks share one replacement service and preserve readiness', async ({ page, electronApp }) => {
  await waitReady(page);
  const original = backendMember(electronApp);
  const results = await page.evaluate(() => Promise.all(Array.from({ length: 6 }, () => window.nocai.system.restartBackend())));
  expect(results.every(result => result.success === true)).toBe(true);
  await waitReady(page);
  expect(backendMember(electronApp).pid).not.toBe(original.pid);
  expect(processMetrics(original.pid).filter(member => member.started === original.started)).toHaveLength(0);
});
