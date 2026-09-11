import { app, BrowserWindow, ipcMain as electronIpcMain, dialog, shell, session } from 'electron';
import { BackendSupervisor } from './backend-supervisor';
import { DiagnosticJournal, sanitizeDiagnostic } from './diagnostics';
import { assertTrustedSender, isTrustedRendererUrl, validateDirectoryToOpen, validateExternalUrl, validateProfileOverride, validateProxyRequest } from './security-policy';
import { IPC } from '../shared/ipc-contract';
import type {
  ChatLoadPayload,
  ChatSendPayload,
  KnowledgeUploadPayload,
  RenamePayload,
  ReprocessPayload,
} from '../shared/ipc-contract';
import { basename, extname, isAbsolute, join, resolve } from 'path';
import { spawn, SpawnOptions } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { pathToFileURL } from 'url';
const isDev = !app.isPackaged;
const isolatedProfile = process.env.NOC_AI_TEST_PROFILE || process.env.NOC_AI_DATA_DIR;
if (isolatedProfile) app.setPath('userData', validateProfileOverride(isolatedProfile));
const useDevServer = isDev && process.env.NOC_AI_SMOKE_TEST !== '1';
const rendererUrl = useDevServer ? 'http://localhost:5173/' : pathToFileURL(join(__dirname, '../renderer/index.html')).href;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ReturnType<typeof spawn> | null = null;
let backendToken: string | null = null;
let sessionToken: string | null = null;
let backendPort: number | null = null;
let isShuttingDown = false;
let lastRendererRecoveryAt = 0;
let unresponsiveDialogOpen = false;
let backendStartupPromise: Promise<void> | null = null;
const nativeFetch = globalThis.fetch;
let journal: DiagnosticJournal | null = null;
let loggingFailed = false;
const activeGenerations = new Map<string, AbortController>();
const approvedReadPaths = new Map<string, number>();
const approvedWritePaths = new Map<string, number>();

function rememberNativePath(map: Map<string, number>, path: string): void {
  if (!isAbsolute(path)) throw new Error('Choose an absolute local file path.');
  if (map.size >= 100) map.delete(map.keys().next().value!);
  map.set(resolve(path).toLowerCase(), Date.now());
}

function requireBackupPath(map: Map<string, number>, value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || extname(value).toLowerCase() !== '.zip') throw new Error('Choose a ZIP backup archive using the file picker.');
  const key = resolve(value).toLowerCase();
  const selectedAt = map.get(key);
  if (selectedAt === undefined || Date.now() - selectedAt > 10 * 60 * 1000) throw new Error('Choose the backup location again using the file picker.');
  map.delete(key);
  return resolve(value);
}

function recordDiagnostic(component: string, event: string, message: unknown): void {
  try { journal?.record(component, event, message); }
  catch {
    loggingFailed = true;
    console.error('Local diagnostic journal is not writable. Check the application data folder.');
  }
}

const supervisor = new BackendSupervisor({
  start: async (signal) => { await startBackend(signal); await checkBackendHealth(signal); },
  stop: stopBackend,
  stateChanged: (state, error) => {
    recordDiagnostic('backend', state, error || `Backend ${state}`);
    mainWindow?.webContents.send('backend:status', {
      status: ['failed', 'degraded'].includes(state) ? 'error' : state === 'ready' ? 'ready' : 'starting',
      state, error: error ? sanitizeDiagnostic(error, [backendToken || '', sessionToken || '']) : undefined,
      recoverable: state !== 'stopping',
    });
  },
});

const ipcMain = {
  handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void {
    electronIpcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event, mainWindow, rendererUrl);
      try { return await listener(event, ...args); }
      catch (error) {
        const message = sanitizeDiagnostic(error, [backendToken || '', sessionToken || '']);
        recordDiagnostic('desktop', 'request-failed', `${channel}: ${message}`);
        throw new Error(message);
      }
    });
  },
};

async function getResponseError(response: Response): Promise<Error> {
  const fallback = `Local service request failed (${response.status})`;
  let body = '';
  try {
    body = await response.text();
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
    if (typeof parsed.detail === 'string') return new Error(sanitizeDiagnostic(parsed.detail, [backendToken || '', sessionToken || '']));
    if (typeof parsed.message === 'string') return new Error(sanitizeDiagnostic(parsed.message, [backendToken || '', sessionToken || '']));
    if (Array.isArray(parsed.detail)) {
      const messages = parsed.detail
        .map((item) => typeof item === 'object' && item && 'msg' in item ? String(item.msg) : '')
        .filter(Boolean);
      if (messages.length) return new Error(messages.join('. '));
    }
  } catch {
    // A non-JSON response is handled below without exposing an HTML error page.
  }
  return new Error(fallback);
}

/** Add the private Electron-to-backend credential to every loopback call. */
async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const local = /^http:\/\/127\.0\.0\.1:(?:\d{1,5}|null)(\/.*)$/.exec(requested);
  if (!local) throw new Error('Invalid local service address.');
  const route = local[1];
  if (route !== '/health/ready') validateProxyRequest(init.method || 'GET', route);
  if (typeof init.body === 'string' && Buffer.byteLength(init.body) > 1024 * 1024) throw new Error('The request is too large.');
  if (backendStartupPromise) await backendStartupPromise;
  if (supervisor.state !== 'ready' || !backendPort || !backendToken) throw new Error(supervisor.lastError || 'The local service is not ready. Open Diagnostics to retry.');
  const headers = new Headers(init.headers);
  if (backendToken) headers.set('X-NOC-AI-Backend-Token', backendToken);
  // A queued request must use the port selected by the completed restart.
  const response = await nativeFetch(`http://127.0.0.1:${backendPort}${route}`, { ...init, headers, redirect: 'error', signal: init.signal || AbortSignal.timeout(180000) });
  if (!response.ok) throw await getResponseError(response);
  return response;
}

async function cancelActiveGenerations(): Promise<void> {
  await Promise.allSettled([...activeGenerations].map(async ([id, controller]) => {
    controller.abort();
    if (backendPort && backendToken && sessionToken && supervisor.state === 'ready') {
      try {
        const response = await nativeFetch(`http://127.0.0.1:${backendPort}/api/v1/chat/stop/${encodeURIComponent(id)}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
          headers: { 'X-NOC-AI-Backend-Token': backendToken, 'Authorization': `Bearer ${sessionToken}` },
        });
        if (!response.ok) throw new Error('Generation cancellation was rejected.');
      } catch { recordDiagnostic('chat', 'cancel-failed', 'Generation cancellation could not reach the local service.'); }
    }
  }));
}

async function createWindow(): Promise<BrowserWindow> {
  // Security: Disable remote module, enable sandbox
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#000000',
      height: 32,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  const window = mainWindow;
  window.webContents.on('did-start-loading', () => { void cancelActiveGenerations(); });

  window.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') recordDiagnostic('renderer', 'console-error', `Renderer ${details.level}, line ${details.lineNumber}`);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    if (isShuttingDown || window.isDestroyed() || details.reason === 'clean-exit') return;
    recordDiagnostic('renderer', 'render-process-gone', `reason=${details.reason}, exitCode=${details.exitCode}`);
    void cancelActiveGenerations();
    const now = Date.now();
    if (now - lastRendererRecoveryAt > 15000) {
      lastRendererRecoveryAt = now;
      setTimeout(() => {
        if (!window.isDestroyed()) window.reload();
      }, 250);
      return;
    }
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'NOC AI Assistant recovered from a display failure',
      message: 'The interface stopped unexpectedly more than once.',
      detail: 'Your local data is intact. Reload the interface to continue.',
      buttons: ['Reload interface', 'Close application'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !window.isDestroyed()) window.reload();
      else if (response !== 0) void shutdown();
    });
  });

  window.on('unresponsive', () => {
    recordDiagnostic('renderer', 'unresponsive', 'The interface is not responding.');
    if (isShuttingDown || window.isDestroyed() || unresponsiveDialogOpen) return;
    unresponsiveDialogOpen = true;
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'NOC AI Assistant is taking longer than expected',
      message: 'The interface is not responding yet.',
      detail: 'A large local operation may still be running. You can wait or reload only the interface.',
      buttons: ['Wait', 'Reload interface'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      unresponsiveDialogOpen = false;
      if (response === 1 && !window.isDestroyed()) window.reload();
    });
  });

  window.on('responsive', () => recordDiagnostic('renderer', 'responsive', 'The interface is responding again.'));

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) e.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (e, url) => { if (!isTrustedRendererUrl(url, rendererUrl)) e.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', e => e.preventDefault());

  // Block new-window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(validateExternalUrl(url)).catch(() => recordDiagnostic('desktop', 'link-failed', 'The external link could not be opened.')); }
    catch { recordDiagnostic('desktop', 'link-blocked', 'An unsupported external link was blocked.'); }
    return { action: 'deny' };
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Strict CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "font-src 'self' data:; " +
          "connect-src 'self'; " +
          "frame-ancestors 'none'; " +
          "base-uri 'self'; " +
          "form-action 'none';"
        ],
      },
    });
  });

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });

  if (useDevServer) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (event) => {
    if (!isShuttingDown) {
      event.preventDefault();
      void shutdown();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function findBackendCommand(): { command: string; prefixArgs: string[]; cwd: string; llamaPath: string; bundledModelsPath: string } {
  if (app.isPackaged) {
    const command = join(process.resourcesPath, 'python', 'python.exe');
    if (!existsSync(command)) throw new Error(`Backend Python runtime not found: ${command}`);
    return {
      command,
      prefixArgs: ['-m', 'backend.main'],
      cwd: join(process.resourcesPath, 'python'),
      llamaPath: join(process.resourcesPath, 'llama', 'llama-server.exe'),
      bundledModelsPath: join(process.resourcesPath, 'models'),
    };
  }

  const projectRoot = join(__dirname, '../../../../..');
  const command = join(projectRoot, '.venv', 'Scripts', 'python.exe');
  if (!existsSync(command)) throw new Error(`Python environment not found: ${command}`);
  return {
    command,
    prefixArgs: ['-m', 'backend.main'],
    cwd: projectRoot,
    llamaPath: join(projectRoot, 'runtimes', 'llama', 'llama-server.exe'),
    bundledModelsPath: join(projectRoot, 'resources', 'models'),
  };
}

async function startBackend(signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw new Error('Backend operation cancelled.');
  if (backendProcess) throw new Error('A backend process is already owned by this application.');
  backendToken = randomBytes(32).toString('hex');
  backendPort = await getRandomPort();
  if (signal.aborted) throw new Error('Backend operation cancelled.');
  
  const backend = findBackendCommand();
  const dataDir = getDataDir();
  
  const args = [...backend.prefixArgs,
    '--port', String(backendPort),
    '--host', '127.0.0.1',
    '--data-dir', dataDir,
    '--log-level', 'info',
  ];

  const options: SpawnOptions = {
    cwd: backend.cwd,
    env: {
      ...process.env,
      NOC_AI_SESSION_TOKEN: backendToken,
      NOC_AI_DATA_DIR: dataDir,
      NOC_AI_MODELS_DIR: join(dataDir, 'models'),
      NOC_AI_KNOWLEDGE_DIR: join(dataDir, 'knowledge'),
      NOC_AI_LLAMA_SERVER_PATH: backend.llamaPath,
      NOC_AI_BUNDLED_MODELS_DIR: backend.bundledModelsPath,
      NOC_AI_PARENT_PID: String(process.pid),
      NOC_AI_PARENT_PIPE: '1',
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  recordDiagnostic('backend', 'spawn', 'Starting the bundled local service.');

  const processHandle = spawn(backend.command, args, options);
  backendProcess = processHandle;

  processHandle.stdout?.on('data', (data) => {
    recordDiagnostic('backend', 'stdout', data.toString().trim());
  });
  processHandle.stderr?.on('data', (data) => {
    recordDiagnostic('backend', 'stderr', data.toString().trim());
  });

  processHandle.on('exit', (code, signal) => {
    recordDiagnostic('backend', 'exit', `code=${code}, signal=${signal}`);
    if (backendProcess !== processHandle) return;
    backendProcess = null;
    if (!isShuttingDown && !['stopping', 'starting', 'backing_off'].includes(supervisor.state)) {
      mainWindow?.webContents.send('backend:crashed', { code, signal });
      const recovery = supervisor.crashed(`The local service stopped unexpectedly (exit ${code ?? signal}).`);
      backendStartupPromise = recovery;
      void recovery.catch(error => recordDiagnostic('backend', 'recovery-failed', error));
    }
  });

  processHandle.on('error', (err) => {
    recordDiagnostic('backend', 'spawn-error', err);
    if (backendProcess === processHandle && !processHandle.pid) backendProcess = null;
    if (mainWindow) {
      mainWindow.webContents.send('backend:error', { message: sanitizeDiagnostic(err, [backendToken || '']) });
    }
  });

  // Wait for port to be listening
  // First launch may need to copy and initialize the bundled embedding model.
  await waitForPort(backendPort!, 60000, signal);
  
  return backendPort!;
}

async function waitForPort(port: number, timeout: number, signal: AbortSignal): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (signal.aborted) throw new Error('Backend operation cancelled.');
    if (!backendProcess) {
      throw new Error('Backend exited before opening its local port');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const net = require('net');
        const socket = net.createConnection(port, '127.0.0.1');
        socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Local connection timed out.')); });
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('error', (error: Error) => { socket.destroy(); reject(error); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Port ${port} not available after ${timeout}ms`);
}

function getDataDir(): string {
  return isolatedProfile ? validateProfileOverride(isolatedProfile) : app.getPath('userData');
}

async function checkBackendHealth(signal: AbortSignal): Promise<void> {
  const maxRetries = 45; // Increased retries to 45 (45 seconds total)
  for (let i = 0; i < maxRetries; i++) {
    if (signal.aborted) throw new Error('Backend operation cancelled.');
    if (!backendProcess) throw new Error('The backend stopped before it became ready.');
    try {
      const response = await nativeFetch(`http://127.0.0.1:${backendPort}/health/ready`, {
        headers: { 'X-NOC-AI-Backend-Token': backendToken || '' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        redirect: 'error',
      });
      if (response.ok) {
        const health = await response.json() as { status?: string; ready?: boolean };
        if (health.ready === true || (health.ready !== false && health.status === 'ready')) {
          return;
        }
      }
    } catch {
      // Retry
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Backend health check timeout');
}

async function startBackendUntilReady(): Promise<void> {
  await supervisor.start();
}

async function restartBackendService(): Promise<void> {
  const restartPromise = supervisor.restart();
  backendStartupPromise = restartPromise;
  await restartPromise;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  recordDiagnostic('desktop', 'shutdown', 'Closing the application and its owned processes.');
  
  if (mainWindow) {
    mainWindow.webContents.send('app:shutting-down');
  }
  
  try { await supervisor.stop(true); }
  catch (error) {
    recordDiagnostic('desktop', 'shutdown-failed', error);
    // Closing the ownership pipe also triggers the backend parent-death cleanup.
    backendProcess?.stdin?.destroy();
    app.exit(1);
    return;
  }
  
  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }
  
  recordDiagnostic('desktop', 'clean-shutdown', 'All application-owned processes stopped.');
  app.exit(exitCode);
}

async function stopBackend(): Promise<void> {
  const owned = backendProcess;
  if (!owned) return;
  const backendPid = owned.pid;

  // Attempt graceful shutdown first
  try {
    const response = await nativeFetch(`http://127.0.0.1:${backendPort}/internal/prepare-shutdown`, {
      method: 'POST',
      headers: { 'X-NOC-AI-Backend-Token': backendToken || '' },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Cleanup returned HTTP ${response.status}.`);
  } catch (error) {
    recordDiagnostic('backend', 'cleanup-failed', error);
  }
  // EOF asks the backend ownership watcher to shut down even if HTTP cleanup failed.
  owned.stdin?.end();
  if (await waitForExit(owned, 4000)) return;

  // Force kill if still running
  if (process.platform === 'win32' && backendPid) {
    try {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/PID', String(backendPid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        const timer = setTimeout(() => { killer.kill(); reject(new Error('Owned process termination timed out.')); }, 5000);
        killer.once('error', error => { clearTimeout(timer); reject(error); });
        killer.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    } catch (killError) {
      recordDiagnostic('backend', 'terminate-failed', killError);
    }
  } else {
    try {
      owned.kill('SIGTERM');
    } catch (killError) {
      recordDiagnostic('backend', 'terminate-failed', killError);
    }
  }

  // Wait for process to exit with a reasonable timeout
  if (!await waitForExit(owned, 3000)) {
    owned.kill('SIGKILL');
    if (!await waitForExit(owned, 2000)) throw new Error('The previous backend process did not stop. Restart is blocked to prevent duplicate services.');
  }
  if (backendProcess === owned) backendProcess = null;
}

async function waitForExit(owned: ReturnType<typeof spawn>, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (owned.exitCode !== null || owned.signalCode !== null) return resolve(true);
    const exited = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      owned.off('exit', exited);
      resolve(false);
    }, timeout);
    owned.once('exit', exited);
  });
}

// IPC Handlers
function setupIpcHandlers(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion());
  
  ipcMain.handle('app:getBackendPort', () => backendPort);
  
  ipcMain.handle('backend:restart', async () => {
    await restartBackendService();
    return { success: true };
  });
  
  // Forward backend API calls
  ipcMain.handle('backend:request', async (event, { method, path, body }) => {
    const request = validateProxyRequest(method, path, body);
    const response = await fetch(`http://127.0.0.1:${backendPort}${request.path}`, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: request.body,
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }
    
    return response.json();
  });
  
  // File dialogs
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select Directory',
    });
    return result.filePaths[0];
  });
  
  ipcMain.handle('dialog:openFiles', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters || [],
      title: options?.title || 'Select Files',
    });
    if (!result.canceled) for (const path of result.filePaths) rememberNativePath(approvedReadPaths, path);
    return result.filePaths;
  });
  
  ipcMain.handle('dialog:saveFile', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      filters: options?.filters || [],
      title: options?.title || 'Save File',
      defaultPath: options?.defaultPath,
    });
    if (!result.canceled && result.filePath) rememberNativePath(approvedWritePaths, result.filePath);
    return result.filePath;
  });
  
  ipcMain.handle('shell:openExternal', async (event, url) => {
    await shell.openExternal(validateExternalUrl(url));
  });
  
  ipcMain.handle('shell:openPath', async (event, path) => {
    const error = await shell.openPath(validateDirectoryToOpen(path, getDataDir()));
    if (error) throw new Error('The application folder could not be opened.');
  });
  
  // Backend API proxy - expose all nocaiAPI methods
  ipcMain.handle('nocai:auth:getStatus', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/status`);
    return response.json();
  });

  ipcMain.handle('nocai:auth:login', async (event, credentials) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json() as { token: string };
    sessionToken = result.token;
    return result;
  });
  
  ipcMain.handle('nocai:auth:logout', async () => {
    if (!sessionToken) return { success: true };
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    sessionToken = null;
    return result;
  });
  
  ipcMain.handle('nocai:auth:getSession', async () => {
    if (!sessionToken) return null;
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/session`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:auth:changePassword', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Chat
  ipcMain.handle('nocai:chat:getConversations', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:createConversation', async (event, title) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:deleteConversation', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:renameConversation', async (event, { id, title }) => {
    const payload = { id, title } satisfies RenamePayload;
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${payload.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ title: payload.title }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:chat:updateConversation', async (event, { id, updates }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:getMessages', async (event, { conversationId, limit, offset }: ChatLoadPayload) => {
    const params = new URLSearchParams({ limit: String(limit || 50), offset: String(offset || 0) });
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${conversationId}/messages?${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:chat:sendMessage', async (event, request: ChatSendPayload) => {
    if (!request || typeof request.conversationId !== 'string' || !/^[\w-]+$/.test(request.conversationId)) throw new Error('Choose a valid conversation.');
    if (activeGenerations.size >= 4 || activeGenerations.has(request.conversationId)) throw new Error('A response is already being generated. Wait for it or select Stop.');
    const controller = new AbortController();
    activeGenerations.set(request.conversationId, controller);
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
        body: JSON.stringify({ ...request, stream: false }),
      });
      return await response.json();
    } finally {
      if (activeGenerations.get(request.conversationId) === controller) activeGenerations.delete(request.conversationId);
    }
  });

  ipcMain.handle('nocai:chat:stopGeneration', async (event, generationId) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/stop/${encodeURIComponent(generationId)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Models
  ipcMain.handle('nocai:models:listModels', async (event, role) => {
    const params = role ? `?role=${role}` : '';
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:scanDirectory', async (event, path) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:importModel', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:activateModel', async (event, { id, role }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:deactivateModel', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/${id}/deactivate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:deleteModel', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:getHardwareInfo', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/hardware`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:estimateModelRequirements', async (event, path) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Knowledge
  ipcMain.handle('nocai:knowledge:listCollections', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:createCollection', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:deleteCollection', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:knowledge:selectDocuments', async () => {
    if (!mainWindow) return [];
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Select documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported documents', extensions: ['txt', 'md', 'pdf', 'docx', 'csv', 'html', 'htm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (selection.canceled) return [];
    return selection.filePaths.flatMap((path) => {
      try {
        const stats = statSync(path);
        return stats.isFile() ? [{ path, name: basename(path), size: stats.size }] : [];
      } catch {
        return [];
      }
    });
  });
  
  ipcMain.handle('nocai:knowledge:uploadDocuments', async (event, { collectionId, filePaths }: KnowledgeUploadPayload) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections/${collectionId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ filePaths }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:listDocuments', async (event, collectionId) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections/${collectionId}/documents`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:deleteDocument', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/documents/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:reprocessDocument', async (event, { documentId: id }: ReprocessPayload) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/documents/${id}/reprocess`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:search', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Admin
  ipcMain.handle('nocai:admin:listUsers', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:createUser', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:updateUser', async (event, { id, ...req }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:deleteUser', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:listRoles', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/roles`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:getAuditLog', async (event, filter) => {
    const params = new URLSearchParams(filter as Record<string, string>);
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/audit?${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:getJobs', async (event, filter) => {
    const params = new URLSearchParams(filter as Record<string, string>);
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/jobs?${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:getHealth', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/health`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:restartBackend', async () => {
    await restartBackendService();
    return { success: true };
  });
  
  // Settings
  ipcMain.handle('nocai:settings:get', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/settings`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:settings:update', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // System
  ipcMain.handle('nocai:system:getHealth', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/health/ready`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:system:getVersion', async () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC.SYSTEM_SHUTDOWN, async () => {
    await shutdown();
  });
  
  ipcMain.handle('nocai:system:getDataPaths', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/system/data-paths`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:system:createBackup', async (event, options) => {
    const destination = requireBackupPath(approvedWritePaths, options?.destination);
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/system/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ destination, includeModels: options?.includeModels === true, includeKnowledge: options?.includeKnowledge !== false }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:system:restoreBackup', async (event, path) => {
    path = requireBackupPath(approvedReadPaths, path);
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/system/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:system:restartBackend', async () => {
    await restartBackendService();
    return { success: true };
  });

  ipcMain.handle(IPC.SYSTEM_DIAGNOSTICS, async () => getDiagnostics());
  ipcMain.handle(IPC.SYSTEM_EXPORT_DIAGNOSTICS, async () => {
    const selected = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export local diagnostics', defaultPath: `NOC-AI-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Diagnostic report', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { path: null };
    if (!journal) throw new Error('The diagnostic journal is unavailable.');
    journal.exportTo(selected.filePath, getDiagnostics());
    return { path: selected.filePath };
  });
  
  // Events (Main -> Renderer)
  // These are not handlers but events that main sends to renderer
}

function getDiagnostics() {
  return {
    version: app.getVersion(),
    backend: { state: supervisor.state, lastError: loggingFailed ? 'Diagnostic logging is not writable. Check the application data folder.' : supervisor.lastError ? sanitizeDiagnostic(supervisor.lastError, [backendToken || '', sessionToken || '']) : null, restartAttempts: supervisor.restartAttempts },
    paths: { logs: journal?.directory || join(getDataDir(), 'logs'), appData: getDataDir() },
    recentErrors: journal?.snapshot() || [],
  };
}

// App lifecycle
app.on('ready', async () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  try {
    journal = new DiagnosticJournal(join(getDataDir(), 'logs'), app.getVersion(), () => [backendToken || '', sessionToken || '']);
    const previous = journal.snapshot().at(-1);
    if (previous && previous.event !== 'clean-shutdown') recordDiagnostic('desktop', 'previous-unclean-exit', 'The previous application run did not record a clean shutdown.');
    recordDiagnostic('desktop', 'startup', 'Application starting.');
  } catch { loggingFailed = true; }
  setupIpcHandlers();
  
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  
  const startupPromise = startBackendUntilReady();
  backendStartupPromise = startupPromise;
  // Observe immediately: a spawn failure can occur while Chromium is still loading.
  void startupPromise.catch(error => recordDiagnostic('backend', 'startup-failed', error));
  try { await createWindow(); }
  catch (error) {
    recordDiagnostic('renderer', 'window-load-failed', error);
    dialog.showErrorBox('NOC AI Assistant could not open', 'The application interface could not be loaded. Reinstall the current application build. Your local data is preserved.');
    await shutdown(1);
    return;
  }
  
  // Start backend
  try {
    mainWindow?.webContents.send('backend:status', { status: 'starting' });
    await startupPromise;
    mainWindow?.webContents.send('backend:status', { status: 'ready', port: backendPort });
    mainWindow?.webContents.send('app:ready', {
      version: app.getVersion(),
      backendPort,
    });
  } catch (error) {
    recordDiagnostic('backend', 'startup-failed', error);
    mainWindow?.webContents.send('backend:status', { 
      status: 'error', 
      error: sanitizeDiagnostic(error, [backendToken || '', sessionToken || '']),
      recoverable: true
    });
  }
});

process.on('uncaughtException', error => {
  recordDiagnostic('desktop', 'uncaughtException', error);
  void shutdown(1);
});
process.on('unhandledRejection', error => {
  recordDiagnostic('desktop', 'unhandledRejection', error);
});
app.on('child-process-gone', (_event, details) => {
  recordDiagnostic('desktop', 'child-process-gone', `type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`);
});

app.on('before-quit', async (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    await shutdown();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});
