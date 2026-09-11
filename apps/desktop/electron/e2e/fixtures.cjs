const { test: base, expect, _electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../../..');
const python = path.join(root, '.venv/Scripts/python.exe');

function processMetrics(pid) {
  return JSON.parse(execFileSync(python, [path.join(root, 'scripts/process_metrics.py'), String(pid)], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  }));
}

function environment(profileDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NOC_AI_') || key.startsWith('NOCAI_') || key.startsWith('ELECTRON_')) delete env[key];
  }
  Object.assign(env, {
    APPDATA: path.join(profileDir, 'Roaming'),
    LOCALAPPDATA: path.join(profileDir, 'Local'),
    NOC_AI_TEST_PROFILE: profileDir,
    NOC_AI_DATA_DIR: path.join(profileDir, 'data'),
    NOC_AI_MODELS_DIR: path.join(profileDir, 'data/models'),
    NOC_AI_KNOWLEDGE_DIR: path.join(profileDir, 'data/knowledge'),
    NOC_AI_LOGS_DIR: path.join(profileDir, 'data/logs'),
    NOC_AI_SMOKE_TEST: '1',
  });
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  return env;
}

async function launch(profileDir) {
  const executablePath = process.env.NOC_AI_PACKAGED_EXE || require('electron');
  return _electron.launch({
    executablePath,
    args: process.env.NOC_AI_PACKAGED_EXE
      ? [`--user-data-dir=${path.join(profileDir, 'electron')}`]
      : [path.join(root, 'apps/desktop/electron'), `--user-data-dir=${path.join(profileDir, 'electron')}`],
    cwd: root, env: environment(profileDir), chromiumSandbox: true, timeout: 90000,
  });
}

async function closeOwned(app) {
  const process = app.process();
  const members = processMetrics(process.pid);
  const closed = new Promise(resolve => process.once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close())).catch(() => {});
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 15000))]);
  if (process.exitCode === null) {
    execFileSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    throw new Error('Application did not close its owned process tree within 15 seconds');
  }
  for (const member of members) {
    await expect.poll(() => processMetrics(member.pid).filter(p => p.started === member.started).length,
      { message: `Owned ${member.name} process must exit`, timeout: 15000 }).toBe(0);
  }
}

const test = base.extend({
  profileDir: async ({}, use) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nocai-e2e-'));
    await use(profileDir);
    // Profiles contain only synthetic fixtures. Retain on failure for bounded diagnostics.
  },
  electronApp: async ({ profileDir }, use) => {
    const app = await launch(profileDir);
    try { await use(app); } finally { await closeOwned(app); }
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

module.exports = { test, expect, root, launch, closeOwned, processMetrics, environment };
